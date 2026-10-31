import { tool } from "ai"
import { z } from "zod"
import { executeQianfanSearchWithImages, type QianfanSearchResult } from "./search-engines/qianfan"
import {
  executeTavilySearchWithImages,
  type TavilySearchResult,
} from "./search-engines/tavily"
import { executeDeepseekSearch, type DeepseekSearchResult } from "./search-engines/deepseek"
import { type SearchEngineId } from "./search-engines"
import {
  SEARCH_PLATFORM_IDS,
  UGC_PLATFORMS,
  getSearchPlatform,
  platformDomains,
  type SearchPlatformId,
} from "./search-platforms"

/**
 * 统一搜索结果格式（各引擎的 execute 函数返回此类型）
 */
export type SearchResultItem =
  | QianfanSearchResult
  | TavilySearchResult
  | DeepseekSearchResult

/**
 * 结构化搜索结果项（工具 output 的一部分,前端 ToolCallCard 直接渲染）
 */
export interface FormattedSearchResult {
  title: string
  url?: string
  snippet?: string
}

/**
 * 返回条数：全网仍 5 条，平台定向放到 8 条（第零波留白的「深度与条数」这一支）。
 * 定向时用户是冲着某站来的，5 条里混进 1~2 条反爬壳页就没得选了；8 条配合
 * SNIPPET_MAX_CHARS 仍在可接受的上下文体积内。
 */
const TOP_N_OPEN = 5
const TOP_N_PLATFORM = 8

/**
 * 喂给模型的摘要上限。旧的 300 字硬截断正好砍在游戏攻略长帖的步骤中段——
 * 2026-10-25 实测千帆站内摘要平均 550~930 字、Tavily 400~920 字，
 * 也就是说引擎明明给了全文级别的摘要，工具自己把它截成了碎片。
 */
const SNIPPET_MAX_CHARS = 700

/**
 * 反爬壳页特征（只看标题）：命中即丢弃。这类结果 URL 看着正常、点开是 Cloudflare
 * 挑战页，喂给模型等于让它引用一条打不开的来源。实测来源：Tavily 定向 B站 返回过
 * title="Just a moment..." 一条（scripts/tmp-probe-game-platforms.mjs）。
 * 只匹配标题不匹配 URL——URL 里含 verify 的正规页面不少，误杀代价更大。
 */
const SHELL_TITLE_PATTERNS: readonly RegExp[] = [
  /just a moment/i,
  /attention required/i,
  /access denied/i,
  /安全验证|人机验证|访问验证|验证中心/,
  /^\s*(403|404|error)\b/i,
]

function isAntiBotShell(item: SearchResultItem): boolean {
  return SHELL_TITLE_PATTERNS.some((re) => re.test(item.title ?? ""))
}

/* ── 图文混排：可上屏图片白名单（服务端过滤，客户端只认 [图N] 占位符）──────────
 * 模型只写 [图N]，URL 全部来自这里的输出 —— 模型没有编造链接的机会。
 * 判据来自 2026-10-11 探针实测（33 张 × 5 次抽样），2026-10-12 补协议改写验证：
 * - 统一 https：千帆样张 http 直链占 100%，https 站点下必被混合内容整批拦掉；
 *   实测这些 CDN 双协议全通（http→https 改写后 18/18 可达、magic bytes 全是真图），
 *   所以先改写再校验，免图代理的带宽成本；
 * - 单图 ≤800KB：超阈图砍掉（实测 Tavily 最大 1.34MB）；探测不到体积的保留 ——
 *   白名单是质量门不是安全门，破图由前端 onError 承托条兜底；
 * - 一次最多 3 张； miaobi（百度 AI 生成配图）整域拉黑，占比不稳且无法肉眼辨识。 */
interface RawImageCandidate {
  url: string
  /** Tavily 给的英文图注 */
  description?: string
  /** 千帆给的标题（中文，兜底当图注） */
  title?: string
}

/** http→https 协议改写：非 http(s) 返回空串（入池前丢弃） */
function normalizeImageUrl(url: string): string {
  if (url.startsWith("https://")) return url
  if (url.startsWith("http://")) return `https://${url.slice(7)}`
  return ""
}

export interface EmbeddableImage {
  /** 占位符编号，正文写 [图N] 即被替换为该图 */
  n: number
  url: string
  description?: string
  host: string
  bytes?: number
}

const IMG_MAX_BYTES = 800 * 1024
const IMG_MAX_COUNT = 3
const IMG_HOST_DENYLIST = [/miaobi/i]
/** 与真实浏览器同 UA：部分图床对无 UA/脚本 UA 直接 403，会导致体积探测误杀 */
const IMG_PROBE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"

/** 探测图片体积：GET + 拿到响应头立刻 abort（Range: 0-0，body 基本为 0 字节）。
 *  只报 content-length / content-range 总长；探测失败返回 undefined（保留候选）。 */
async function probeImageBytes(url: string): Promise<number | undefined> {
  const ctrl = new AbortController()
  try {
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(url, {
      headers: { "User-Agent": IMG_PROBE_UA, Range: "bytes=0-0" },
      signal: ctrl.signal,
      redirect: "follow",
    })
    let total: number | undefined
    const contentRange = res.headers.get("content-range") // "bytes 0-0/12345"
    const rangeTotal = contentRange?.split("/")[1]
    if (rangeTotal && /^\d+$/.test(rangeTotal)) {
      total = Number(rangeTotal)
    } else {
      const cl = res.headers.get("content-length")
      // 服务器忽略 Range 返回 200 时，content-length 即全尺寸
      if (cl && /^\d+$/.test(cl) && res.status === 200) total = Number(cl)
    }
    clearTimeout(timer)
    ctrl.abort()
    return total
  } catch {
    return undefined
  }
}

/** 白名单主流程：协议改写+域名硬过滤 → 并行体积探测 → 超阈剔除 → 截前 3 张并编号 */
async function selectEmbeddableImages(
  raw: RawImageCandidate[]
): Promise<EmbeddableImage[]> {
  const candidates = raw
    .map((i) => ({ ...i, url: normalizeImageUrl(i.url) }))
    .filter((i) => {
      if (!i.url) return false
      return !IMG_HOST_DENYLIST.some((re) => re.test(i.url))
    })
    .slice(0, 6)
  if (candidates.length === 0) return []

  const sizes = await Promise.all(candidates.map((c) => probeImageBytes(c.url)))
  return candidates
    .map((c, i) => ({ c, bytes: sizes[i] }))
    .filter(({ bytes }) => bytes === undefined || bytes <= IMG_MAX_BYTES)
    .slice(0, IMG_MAX_COUNT)
    .map(({ c, bytes }, i) => {
      let host = ""
      try {
        host = new URL(c.url).hostname
      } catch {
        host = ""
      }
      // Tavily 的英文 description 优先，千帆只有中文 title 兜底
      const desc = c.description || c.title
      return {
        n: i + 1,
        url: c.url,
        ...(desc ? { description: desc } : {}),
        host,
        ...(bytes !== undefined ? { bytes } : {}),
      }
    })
}

/** 给模型的插图协议说明（只在真拿到白名单图片时追加） */
function imageNote(images: EmbeddableImage[]): string {
  if (images.length === 0) return ""
  const nums = images.map((i) => `[图${i.n}]`).join("、")
  return `\n\n本次搜索还附带了 ${images.length} 张与结果相关的图片（已过安全白名单）。若配图能帮助说明，可在回答正文的合适位置单独写占位符 ${nums}（建议独占一行），系统会自动替换为图片；全篇最多用 ${images.length} 处，不要重复、不要编造其他编号或图片链接。仅介绍/说明类内容适合配图；数学推导、解题步骤、代码修复类回答不要插图。`
}

/**
 * 创建联网搜索工具（AI SDK tool）
 *
 * execute 返回结构化对象:
 * - 模型侧阅读 note 指引 + results 明细作答;
 * - 前端 ToolCallCard 从 tool part 的 output 里直接取 results 渲染来源列表。
 *
 * 平台定向（第零波）三态：
 * - 'auto'（默认，与改造前行为一致）：schema 暴露可选 `platform`，由模型按问题自判；
 * - 用户显式选定（'all' 或具体平台 id）：**直接把 `platform` 参数从 schema 里摘掉**——
 *   收窄能力面比在提示词里叮嘱「别传」更可靠，模型连误传的机会都没有；
 * - 平台零结果自动回退全网，回退发生在这一层（execute 内）：此处同时握有
 *   单次调用结果与聚合结果，对模型和 route 全透明；route 只管装 Key，不适合做回退。
 *
 * @param engine        搜索引擎 ID
 * @param apiKey        对应引擎的 API Key（解密后原文）
 * @param userPlatform  用户在输入区选定的平台口径，默认 'auto'（不干涉模型）
 * @returns AI SDK tool 对象
 */
export function createWebSearchTool(
  engine: SearchEngineId,
  apiKey: string,
  userPlatform: SearchPlatformId = "auto"
) {
  // 用户已定口径（含"全网"）→ 平台由服务端说了算，模型不参与
  const userDecided = userPlatform !== "auto"
  const platformMenu = UGC_PLATFORMS.map((p) => `${p.id}=${p.label}(${p.tip})`).join("、")

  // 本轮检索结果缓存：同一 query（忽略首尾/连续空白与大小写）重复调用时直接回放上次结果，
  // 并附上一句止损说明。模型偶尔会换标点/空格反复提交同一条查询，结果不会变，却把
  // 步数预算耗光；回放而不是返回空结果，避免它把"重复"误判成"搜索失败"再换措辞重试。
  const searchedQueries = new Map<
    string,
    { results: FormattedSearchResult[]; images: EmbeddableImage[] }
  >()

  // 引擎名 + 配图声明:两个带图引擎(tavily/qianfan)都声明,deepseek 无图不声明
  const engineName = engine === "tavily" ? "Tavily" : engine === "deepseek" ? "DeepSeek" : "百度"
  const imageLine =
    engine === "deepseek"
      ? ""
      : "\n结果可能附带已筛选的相关图片，按返回说明以 [图N] 占位符引用，不要自己编造图片链接。"
  const description = `联网搜索工具。当需要获取实时信息、最新新闻、当前事件、或用户明确要求搜索时使用。
输入中文或英文搜索关键词，工具会返回${engineName}搜索结果（标题、链接、摘要）。
搜索结果会包含网页标题、URL 和内容摘要，请基于这些信息回答用户问题并注明来源。${imageLine}
用户点名要在某个平台（如 B站/小红书/知乎）上查资料时，通过 platform 参数指定，只返回该站内容。`

  return tool({
    description,
    inputSchema: z.object({
      query: z
        .string()
        .describe("搜索关键词，使用用户提问的语言，尽量简洁准确"),
      ...(userDecided
        ? {}
        : {
            platform: z
              .enum(SEARCH_PLATFORM_IDS)
              .optional()
              .describe(
                `平台定向，仅在用户明确希望在某个站内查资料时传（如问 B站评论区、小红书笔记、知乎回答）。可选值：${platformMenu}。不传或传 all = 全网检索。`
              ),
          }),
    }),
    execute: async (input) => {
      // schema 是条件构造的（用户已定口径时不带 platform），联合类型下直接解构会让
      // platform 推成 {}；这里按两种形态的公共契约显式取值，不靠推断。
      const query = (input as { query: string }).query
      const modelPlatform = (input as { platform?: SearchPlatformId }).platform
      // 生效口径：用户选定 > 模型自判 > 全网
      const effective: SearchPlatformId = userDecided ? userPlatform : (modelPlatform ?? "all")
      const domains = platformDomains(effective)
      const label = getSearchPlatform(effective).label

      // 重复查询：回放上次结果 + 明确要求立即作答（不再打上游）
      const cacheKey = `${effective}::${query.replace(/\s+/g, " ").trim().toLowerCase()}`
      const cached = searchedQueries.get(cacheKey)
      if (cached) {
        return {
          query,
          engine,
          platform: effective,
          platformLabel: label,
          ...(cached.images.length > 0 ? { images: cached.images } : {}),
          results: cached.results,
          note: "这条查询本轮已经搜过，结果不会变化，以下为上次结果。请立即基于已有结果和你的知识作答，不要再重复搜索；信息不足就如实告知用户。",
        }
      }

      const runOnce = async (siteFilter: string[]) => {
        const topN = siteFilter.length > 0 ? TOP_N_PLATFORM : TOP_N_OPEN
        if (engine === "tavily") {
          return executeTavilySearchWithImages(query, apiKey, topN, siteFilter)
        }
        if (engine === "deepseek") {
          const results = await executeDeepseekSearch(query, apiKey, topN, siteFilter)
          return { results, images: [] as RawImageCandidate[] }
        }
        // 千帆:网页+图片同请求取回(图片多为 http 直链,协议改写在白名单里统一做)
        return executeQianfanSearchWithImages(query, apiKey, topN, siteFilter)
      }

      // 反爬壳过滤：过滤发生在回退判定之前，所以满屏壳页也会正确触发全网回退，
      // 而不是把 5 条打不开的挑战页当成"命中站内"交给模型。
      const stripShells = <T extends SearchResultItem>(items: T[]) => {
        const kept = items.filter((i) => !isAntiBotShell(i))
        return { kept, dropped: items.length - kept.length }
      }

      try {
        let { results: rawResults, images: rawImages } = await runOnce(domains)
        let { kept: results, dropped: shellDropped } = stripShells(rawResults)
        // 零结果回退防线：站点白名单命中为 0 时，同轮降级全网重试一次，
        // 避免"小红书/抖音这类站内索引稀薄的平台"直接把能力打死。
        let fellBack = false
        if (results.length === 0 && domains.length > 0) {
          console.log(`[search] platform ${effective} returned 0 usable results (shellDropped=${shellDropped}), falling back to open web`)
          const retry = await runOnce([])
          const retryStriped = stripShells(retry.results)
          results = retryStriped.kept
          shellDropped += retryStriped.dropped
          rawImages = retry.images
          fellBack = true
        }

        // 配图白名单：只在最终那一次搜索的结果上做（回退后用回退那轮的图）
        const embeddable = await selectEmbeddableImages(rawImages)

        console.log(
          `[search] ${engine} query="${query.slice(0, 40)}" platform=${effective} fellBack=${fellBack} n=${results.length} shell=${shellDropped} img=${embeddable.length}`
        )

        const shellHint =
          shellDropped > 0
            ? `另有 ${shellDropped} 条命中被识别为反爬/空壳页（如站点验证页），已剔除、不在下方结果里。`
            : ""

        const note =
          shellHint +
          (fellBack
            ? `已按用户要求限定「${label}」检索但未命中站内结果，已自动回退全网检索到 ${results.length} 条。请如实告知用户这些是全网来源、并非「${label}」站内内容。`
            : domains.length > 0
              ? `本次已限定平台「${label}」，以下结果均来自该站。请基于这些结果回答并注明来源；若信息不足，如实告知，不要擅自改用其他站点的内容顶替。`
              : results.length === 0
                ? `搜索「${query}」未找到相关结果。不要再换措辞重复搜同一个问题；请立即基于你已有的知识回答，并如实告知用户这次没有检索到官方/权威数据。`
                : "请基于以上搜索结果回答用户的问题，并在回答中自然引用来源。如果搜索结果不充分或信息已过时，请如实告知用户。") +
          imageNote(embeddable)

        const formatted = results.map(
          (r): FormattedSearchResult => ({
            title: r.title,
            ...(r.url ? { url: r.url } : {}),
            ...(r.snippet ? { snippet: r.snippet.slice(0, SNIPPET_MAX_CHARS) } : {}),
          })
        )
        searchedQueries.set(cacheKey, { results: formatted, images: embeddable })

        return {
          query,
          engine,
          platform: effective,
          platformLabel: label,
          ...(fellBack ? { fellBack: true } : {}),
          ...(embeddable.length > 0 ? { images: embeddable } : {}),
          results: formatted,
          note,
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "未知搜索错误"
        console.error(`[${engine}-search]`, message)
        return {
          query,
          engine,
          platform: effective,
          platformLabel: label,
          results: [] as FormattedSearchResult[],
          error: message,
          note: `联网搜索失败: ${message}。请基于你已有的知识回答用户问题，并告知用户搜索暂时不可用。`,
        }
      }
    },
  })
}
