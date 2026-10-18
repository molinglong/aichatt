import { tool } from "ai"
import { z } from "zod"
import { executeQianfanSearch, type QianfanSearchResult } from "./search-engines/qianfan"
import {
  executeTavilySearchWithImages,
  type TavilyImageResult,
  type TavilySearchResult,
} from "./search-engines/tavily"
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
export type SearchResultItem = QianfanSearchResult | TavilySearchResult

/**
 * 结构化搜索结果项（工具 output 的一部分,前端 ToolCallCard 直接渲染）
 */
export interface FormattedSearchResult {
  title: string
  url?: string
  snippet?: string
}

/** 返回条数：仍是写死的 5（平台定向只改「从哪些站里取」，深度与条数属第一波） */
const TOP_N = 5

/* ── 图文混排：可上屏图片白名单（服务端过滤，客户端只认 [图N] 占位符）──────────
 * 模型只写 [图N]，URL 全部来自这里的输出 —— 模型没有编造链接的机会。
 * 判据来自 2026-10-11 探针实测（33 张 × 5 次抽样）：
 * - 只收 https：千帆样张 http 直链占 100%，在 https 站点下必被混合内容整批拦掉；
 * - 单图 ≤800KB：超阈图砍掉（实测 Tavily 最大 1.34MB）；探测不到体积的保留 ——
 *   白名单是质量门不是安全门，破图由前端 onError 承托条兜底；
 * - 一次最多 3 张； miaobi（百度 AI 生成配图）整域拉黑，占比不稳且无法肉眼辨识。 */
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

/** 白名单主流程：协议/域名硬过滤 → 并行体积探测 → 超阈剔除 → 截前 3 张并编号 */
async function selectEmbeddableImages(
  raw: TavilyImageResult[]
): Promise<EmbeddableImage[]> {
  const candidates = raw
    .filter((i) => {
      if (!i.url?.startsWith("https://")) return false
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
      return {
        n: i + 1,
        url: c.url,
        ...(c.description ? { description: c.description } : {}),
        host,
        ...(bytes !== undefined ? { bytes } : {}),
      }
    })
}

/** 给模型的插图协议说明（只在真拿到白名单图片时追加） */
function imageNote(images: EmbeddableImage[]): string {
  if (images.length === 0) return ""
  const nums = images.map((i) => `[图${i.n}]`).join("、")
  return `\n\n本次搜索还附带了 ${images.length} 张与结果相关的实拍图（已过安全白名单）。若配图能帮助说明，可在回答正文的合适位置单独写占位符 ${nums}（建议独占一行），系统会自动替换为图片；全篇最多用 ${images.length} 处，不要重复、不要编造其他编号或图片链接。仅介绍/说明类内容适合配图；数学推导、解题步骤、代码修复类回答不要插图。`
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

  const description =
    engine === "tavily"
      ? `联网搜索工具。当需要获取实时信息、最新新闻、当前事件、或用户明确要求搜索时使用。
输入中文或英文搜索关键词，工具会返回 Tavily 搜索结果（标题、链接、摘要）。
搜索结果会包含网页标题、URL 和内容摘要，请基于这些信息回答用户问题并注明来源。
结果可能附带已筛选的实拍图片，按返回说明以 [图N] 占位符引用，不要自己编造图片链接。
用户点名要在某个平台（如 B站/小红书/知乎）上查资料时，通过 platform 参数指定，只返回该站内容。`
      : `联网搜索工具。当需要获取实时信息、最新新闻、当前事件、或用户明确要求搜索时使用。
输入中文或英文搜索关键词，工具会返回百度搜索结果（标题、链接、摘要）。
搜索结果会包含网页标题、URL 和内容摘要，请基于这些信息回答用户问题并注明来源。
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

      const runOnce = (siteFilter: string[]) =>
        engine === "tavily"
          ? executeTavilySearchWithImages(query, apiKey, TOP_N, siteFilter)
          : executeQianfanSearch(query, apiKey, TOP_N, siteFilter).then(
              (results) => ({ results, images: [] as TavilyImageResult[] })
            )

      try {
        let { results, images: rawImages } = await runOnce(domains)
        // 零结果回退防线：站点白名单命中为 0 时，同轮降级全网重试一次，
        // 避免"小红书/抖音这类站内索引稀薄的平台"直接把能力打死。
        let fellBack = false
        if (results.length === 0 && domains.length > 0) {
          console.log(`[search] platform ${effective} returned 0 results, falling back to open web`)
          const retry = await runOnce([])
          results = retry.results
          rawImages = retry.images
          fellBack = true
        }

        // 配图白名单：只在最终那一次搜索的结果上做（回退后用回退那轮的图）
        const embeddable = engine === "tavily" ? await selectEmbeddableImages(rawImages) : []

        console.log(
          `[search] ${engine} query="${query.slice(0, 40)}" platform=${effective} fellBack=${fellBack} n=${results.length} img=${embeddable.length}`
        )

        const note =
          (fellBack
            ? `已按用户要求限定「${label}」检索但未命中站内结果，已自动回退全网检索到 ${results.length} 条。请如实告知用户这些是全网来源、并非「${label}」站内内容。`
            : domains.length > 0
              ? `本次已限定平台「${label}」，以下结果均来自该站。请基于这些结果回答并注明来源；若信息不足，如实告知，不要擅自改用其他站点的内容顶替。`
              : results.length === 0
                ? `搜索「${query}」未找到相关结果。请基于你已有的知识回答，并如实告知用户搜索结果为空。`
                : "请基于以上搜索结果回答用户的问题，并在回答中自然引用来源。如果搜索结果不充分或信息已过时，请如实告知用户。") +
          imageNote(embeddable)

        return {
          query,
          engine,
          platform: effective,
          platformLabel: label,
          ...(fellBack ? { fellBack: true } : {}),
          ...(embeddable.length > 0 ? { images: embeddable } : {}),
          results: results.map(
            (r): FormattedSearchResult => ({
              title: r.title,
              ...(r.url ? { url: r.url } : {}),
              ...(r.snippet ? { snippet: r.snippet.slice(0, 300) } : {}),
            })
          ),
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
