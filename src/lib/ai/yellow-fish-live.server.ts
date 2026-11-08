import { execFile } from 'child_process'
import { tool } from 'ai'
import { z } from 'zod'
import {
  YELLOW_FISH_LIVE_TOOL_NAME,
  YELLOW_FISH_LIVE_TIMEOUT_MS,
  YELLOW_FISH_LIVE_RATE_WINDOW_MS,
  YELLOW_FISH_LIVE_RATE_MAX,
  YELLOW_FISH_LIVE_INPUT_SCHEMA,
  type YellowFishLiveToolOutput,
  type YellowFishLiveListing,
} from './yellow-fish-live-tool'
import { goofishCliPath, looksLikeAuthFailure } from './yellow-fish-cookie.server'

/** cookie 失效时的统一引导文案（工具 note + 卡片共用口径） */
const COOKIE_EXPIRED_NOTE =
  'YellowFish 登录态已失效（实时价靠本机 goofish-cli 的登录 cookie）。' +
  '告知用户：到「设置 → YellowFish」点「扫码修复登录」——会弹出登录窗口，闲鱼 App 扫码或输账号密码均可（10 分钟内有效）。' +
  '修复前实时价不可用，不要反复重试。监控快照 get_yellow_fish_market 不受影响，可先用。不要编造价格。'

/**
 * get_yellow_fish_live 工具工厂 —— goofish-cli 桥（真实浏览器路径的闲鱼实时搜索）。
 *
 * 纪律（2026-10-31 定案）：只读、低频 —— 本进程内滑动窗口 10 分钟最多 2 次（硬编码），
 * 搜索走 Playwright + 系统 Chrome（goofish-cli 内置，非本工具职责），主号 cookie。
 * CLI 侧坑：GBK 控制台直跑输出 ¥ 会 UnicodeEncodeError → 必须 PYTHONUTF8=1（子进程 env 注入）。
 * 失败降级：如实报错并引导退回 get_yellow_fish_market 快照，绝不编造。
 */

/** CLI 实际路径（env 可覆盖） */
const liveCliPath = goofishCliPath

/**
 * 二期桥（2026-11-07）：非空 = 实时搜索转发到家里电脑的 goofish-bridge HTTP 服务
 * （VPS 部署形态：VPS 上没有 goofish.exe，经 frp 隧道 18001 回源本机）；空 = 本机 execFile（原行为不变）。
 * 桥把 CLI stderr 原样透传，登录失效判定（looksLikeAuthFailure）口径与直跑一致。
 */
const LIVE_BRIDGE_URL = (process.env.YELLOW_FISH_LIVE_BRIDGE_URL || '').trim().replace(/\/+$/, '')
const LIVE_BRIDGE_TOKEN = process.env.YELLOW_FISH_LIVE_BRIDGE_TOKEN || ''

/** 进程内限频状态（dev 热重载会清零，已知边界；生产稳定） */
const rateStamps: number[] = []
function rateLimitedNow(): boolean {
  const now = Date.now()
  while (rateStamps.length && now - rateStamps[0] > YELLOW_FISH_LIVE_RATE_WINDOW_MS) rateStamps.shift()
  return rateStamps.length >= YELLOW_FISH_LIVE_RATE_MAX
}
function recordRate(): void {
  rateStamps.push(Date.now())
}

/** "¥1,199" / "1199" / "1.5万" → 数值（与 monitor 口径一致的容错） */
function parseLivePrice(raw: unknown): number | null {
  if (raw == null) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const text = String(raw).trim().replace(/¥/g, '').replace(/,/g, '')
  if (!text || text === '-' || text === 'N/A') return null
  if (text.endsWith('万')) {
    const wan = Number(text.slice(0, -1))
    return Number.isFinite(wan) ? wan * 10000 : null
  }
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

interface GoofishItem {
  rank?: unknown
  item_id?: unknown
  title?: unknown
  url?: unknown
  price?: unknown
  original_price?: unknown
  location?: unknown
  seller_nick?: unknown
  /** 封面图（CLI 本地补丁字段，2026-11-04；升级 CLI 丢失时降级为占位图） */
  pic_url?: unknown
  user_avatar_url?: unknown
  result_kind?: unknown
}

interface GoofishSearchJson {
  items?: GoofishItem[]
  result_kind?: unknown
  recommendations_present?: unknown
  complete?: unknown
  errors?: unknown
}

/** 桥模式:POST /search。200=CLI 原始 JSON;非 ok 抛「goofish-cli 失败: …」
 * （桥透传 CLI stderr,auth 失效文本原样带给上层 looksLikeAuthFailure,口径与直跑一致） */
async function runBridgeSearch(keyword: string, limit: number): Promise<GoofishSearchJson> {
  const res = await fetch(`${LIVE_BRIDGE_URL}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': LIVE_BRIDGE_TOKEN },
    body: JSON.stringify({ keyword, limit }),
    signal: AbortSignal.timeout(YELLOW_FISH_LIVE_TIMEOUT_MS + 15_000),
  })
  let payload: { ok?: boolean; data?: GoofishSearchJson; error?: string }
  try {
    payload = (await res.json()) as { ok?: boolean; data?: GoofishSearchJson; error?: string }
  } catch {
    throw new Error(`goofish-cli 失败: 桥响应不是 JSON(HTTP ${res.status})`)
  }
  if (!payload?.ok) throw new Error(`goofish-cli 失败: ${payload?.error || `HTTP ${res.status}`}`)
  return (payload.data ?? {}) as GoofishSearchJson
}

/** spawn goofish.exe search items --format json；stdout 解 JSON，失败抛错 */
function runGoofishSearch(query: string, limit: number): Promise<GoofishSearchJson> {
  const cli = liveCliPath()
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      ['search', 'items', query, '--limit', String(limit), '--format', 'json'],
      {
        timeout: YELLOW_FISH_LIVE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const brief = (stderr || err.message || '').toString().slice(0, 160)
          reject(new Error(`goofish-cli 失败: ${brief}`))
          return
        }
        try {
          resolve(JSON.parse(stdout.toString()) as GoofishSearchJson)
        } catch {
          reject(new Error(`goofish-cli 输出不是 JSON: ${stdout.toString().slice(0, 120)}`))
        }
      },
    )
  })
}

export function createYellowFishLiveTool() {
  return tool({
    description:
      '搜索闲鱼「现在挂着的」在售商品（真实浏览器路径，约 20 条采样，30 秒级延迟）。' +
      '当用户要当下实时价格、或监控快照过旧时调用；有硬限频（10 分钟 2 次），不要连续调用。',
    inputSchema: z.object(YELLOW_FISH_LIVE_INPUT_SCHEMA),
    execute: async ({ keyword, limit }): Promise<YellowFishLiveToolOutput> => {
      const kw = (keyword || '').trim()
      const n = limit ?? 20
      if (!kw) {
        return { keyword: kw, available: false, error: '关键词为空', note: '请提供闲鱼搜索关键词。' }
      }

      // 限频闸：超窗直接拦（不发起真实搜索，保护主号）
      if (rateLimitedNow()) {
        return {
          keyword: kw,
          available: false,
          rateLimited: true,
          note:
            `实时搜索触发限频（10 分钟内已搜 ${YELLOW_FISH_LIVE_RATE_MAX} 次，保护账号的低频纪律）。` +
            '请告知用户稍后再搜，或先用 get_yellow_fish_market 的监控快照参考。不要编造价格。',
        }
      }
      recordRate()

      let data: GoofishSearchJson
      try {
        data = LIVE_BRIDGE_URL ? await runBridgeSearch(kw, n) : await runGoofishSearch(kw, n)
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误'
        const cookieExpired = looksLikeAuthFailure(message)
        console.error(`[${YELLOW_FISH_LIVE_TOOL_NAME}] search failed`, kw, message)
        return {
          keyword: kw,
          available: false,
          ...(cookieExpired ? { cookieExpired: true } : {}),
          error: message,
          note: cookieExpired
            ? COOKIE_EXPIRED_NOTE
            : `闲鱼实时搜索失败（${message}）。可建议用户改用 get_yellow_fish_market 的监控快照，或稍后重试。如实说明，不要编造价格。`,
        }
      }

      const rawItems = Array.isArray(data.items) ? data.items : []
      const listings: YellowFishLiveListing[] = rawItems.map((it, i) => {
        const priceDisplay = typeof it.price === 'string' ? it.price : ''
        const itemUrl = typeof it.url === 'string' ? it.url : ''
        // 商品 id：CLI 已解析出 item_id 直接用；兜底再从 url 的 id= 参数抠数字
        const itemId =
          (typeof it.item_id === 'string' && it.item_id) ||
          (typeof it.item_id === 'number' ? String(it.item_id) : '') ||
          /id=(\d+)/.exec(itemUrl)?.[1] ||
          ''
        return {
          no: i + 1,
          itemId,
          price: parseLivePrice(it.price),
          priceDisplay,
          title: typeof it.title === 'string' ? it.title : '',
          location: typeof it.location === 'string' ? it.location : undefined,
          seller: typeof it.seller_nick === 'string' ? it.seller_nick : undefined,
          url: itemUrl,
          pic: typeof it.pic_url === 'string' && it.pic_url ? it.pic_url : undefined,
          avatar:
            typeof it.user_avatar_url === 'string' && it.user_avatar_url
              ? it.user_avatar_url
              : undefined,
          originalPrice: typeof it.original_price === 'string' ? it.original_price : undefined,
          isSearch: it.result_kind === 'search',
        }
      })

      const searchItems = listings.filter((l) => l.isSearch && l.price != null)
      const prices = searchItems.map((l) => l.price as number).sort((a, b) => a - b)
      const median = prices.length
        ? prices.length % 2
          ? prices[(prices.length - 1) / 2]
          : Math.round(((prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) * 100) / 100
        : null
      const searchCount = listings.filter((l) => l.isSearch).length
      const recommendationHeavy = listings.length > 0 && searchCount / listings.length < 0.5
      // 兜底：CLI JSON 跑完但 errors 里带登录墙信息（内部未抛 AuthRequiredError 的路径）
      const errorsText = Array.isArray(data.errors) ? data.errors.map(String).join('\n') : ''
      const cookieExpired = !!errorsText && looksLikeAuthFailure(errorsText)

      if (!searchItems.length) {
        return {
          keyword: kw,
          available: false,
          listings: listings.length ? listings : undefined,
          recommendationHeavy,
          ...(cookieExpired ? { cookieExpired: true } : {}),
          note: cookieExpired
            ? COOKIE_EXPIRED_NOTE
            : '搜索跑完了但没有真实搜索结果样本（可能是纯推荐流或被风控软拦截）。' +
              '如实告知用户没拿到有效在售价，不要编造。',
        }
      }

      return {
        keyword: kw,
        available: true,
        stats: {
          sampleCount: prices.length,
          searchCount,
          min: prices[0],
          median,
          max: prices[prices.length - 1],
        },
        listings,
        recommendationHeavy,
        note:
          `以上是「现在挂着」的 ${prices.length} 条在售采样（挂牌价非成交价，非全量行情）。` +
          (recommendationHeavy
            ? '注意：推荐流占比高（泛搜噪音大），结论可信度有限，建议用户用更具体的词（带容量/型号）重搜。'
            : '挂牌价可能有引流饵，结合标题交叉判断，别拿最低价当行情。'),
      }
    },
  })
}
