/**
 * 闲鱼监控服务（ai-goofish-monitor）客户端 —— 服务端专用公共层。
 *
 * 供 get_yellow_fish_market（只读行情）与 add_yellow_fish_watch（建任务闭环）两个工具复用。
 * 铁律：本文件含 process.env 与网络请求，客户端组件一律不许 import。
 *
 * monitor 侧接口（本机 FastAPI，实测无需认证）：
 *   GET    /api/tasks                      → 任务列表（含 id/keyword/task_name/is_running/enabled）
 *   POST   /api/tasks/                     → 创建任务（task_name+keyword 必填，decision_mode=keyword 免 AI）
 *   POST   /api/tasks/start/{id}           → 立即启动单任务（--task-name 单任务运行，不连带他人）
 *   GET    /api/results/files              → { files: ["<关键词>_full_data.jsonl", ...] }
 *   GET    /api/results/{filename}/insights → { market_summary, history_summary, daily_trend, ... }
 *   GET    /api/results/{filename}?...     → { total_items, items: [...] }
 */

export const YELLOW_FISH_MONITOR_FETCH_TIMEOUT_MS = 8_000
export const YELLOW_FISH_FULL_DATA_SUFFIX = '_full_data.jsonl'

/** 监控服务默认基址；实际以环境变量 YELLOW_FISH_MONITOR_BASE_URL 覆盖（去掉尾部斜杠）。 */
export function monitorBase(): string {
  const raw = (process.env.YELLOW_FISH_MONITOR_BASE_URL || 'http://127.0.0.1:8000').trim()
  return raw.replace(/\/+$/, '') || 'http://127.0.0.1:8000'
}

export async function fetchJson(url: string, timeoutMs = YELLOW_FISH_MONITOR_FETCH_TIMEOUT_MS): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 带超时的 JSON POST（monitor 建任务/启动用）；失败抛错由调用方决定降级话术。 */
export async function postJson(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = YELLOW_FISH_MONITOR_FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 复刻 monitor 的 normalize_keyword_slug（不依赖 ES6 unicode 正则）：小写、空格转下划线、
 *  ASCII 可见字符仅保留字母数字/下划线/连字符（其余删除），非 ASCII（如中文）原样保留，去掉尾部下划线 */
export function normalizeKeywordSlug(keyword: string): string {
  const text = (keyword || '')
    .toLowerCase()
    .replace(/ /g, '_')
    // 对每个 ASCII 可见字符 [\x20-\x7E] 单独判断：非 [a-z0-9_-] 则删除；非 ASCII（中文等）不动
    .replace(/[ -~]/g, (ch) => (/[a-z0-9_-]/.test(ch) ? ch : ''))
    .replace(/_+$/, '')
  return text || 'unknown'
}

/** 任务/关键词的宽松归一（查重用）：小写 + 去全部空白。中文直接原样参与比较。 */
export function normKeywordLoose(keyword: string): string {
  return (keyword || '').toLowerCase().replace(/\s+/g, '')
}

/** 复刻 parse_price_value：把 "¥3,200" / "1.5万" / 数字解析为数值，异常值返回 null */
export function parsePriceValue(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100) / 100
  const text = String(value).trim().replace(/¥/g, '').replace(/,/g, '')
  if (!text || ['价格异常', '暂无', '-', 'N/A'].includes(text)) return null
  if (text.endsWith('万')) {
    const wan = Number(text.slice(0, -1))
    if (Number.isFinite(wan)) return Math.round(wan * 10000 * 100) / 100
    return null
  }
  const n = Number(text)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

/** monitor 汇总（snake_case）→ 我们的 YellowFishPriceSummary（camelCase） */
export function mapSummary(raw: Record<string, unknown> | undefined): {
  sampleCount: number
  avg: number | null
  median: number | null
  min: number | null
  max: number | null
} {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    sampleCount: typeof raw?.sample_count === 'number' ? raw.sample_count : 0,
    avg: num(raw?.avg_price),
    median: num(raw?.median_price),
    min: num(raw?.min_price),
    max: num(raw?.max_price),
  }
}

/** 在文件列表里为关键词找最佳匹配（先精确 slug，再去分隔符宽松，再前缀/包含） */
export function matchFilename(files: string[], keyword: string): string | null {
  const want = normalizeKeywordSlug(keyword)
  const baseSlug = (f: string) =>
    normalizeKeywordSlug(f.replace(YELLOW_FISH_FULL_DATA_SUFFIX, '').replace(/\.jsonl$/, ''))
  const exact = files.find((f) => baseSlug(f) === want)
  if (exact) return exact
  // 宽松：忽略下划线/连字符差异，让 "iPhone 13"(iphone_13) 命中 "iPhone13"(iphone13)
  const loose = (s: string) => s.replace(/[_-]/g, '')
  const wantLoose = loose(want)
  if (wantLoose) {
    const looseHit = files.find((f) => loose(baseSlug(f)) === wantLoose)
    if (looseHit) return looseHit
  }
  const prefix = files.find((f) => baseSlug(f).startsWith(want) || want.startsWith(baseSlug(f)))
  if (prefix) return prefix
  const contains = files.find((f) => baseSlug(f).includes(want) || want.includes(baseSlug(f)))
  return contains ?? null
}

/** 从 monitor 结果记录里防御式提取商品要点。
 * 实测：商品字段嵌套在 record["商品信息"] 下（商品标题/当前售价/商品链接/发货地区/发布时间），
 * 顶层只有 爬取时间/搜索关键字/任务名称 等；故优先读 info 子对象，再回退顶层。 */
export function mapItem(
  record: Record<string, unknown>,
  no: number,
): {
  no: number
  title: string
  price: number | null
  priceDisplay: string
  link: string
  region?: string
  publishTime?: string
  image?: string
} {
  const info = (record['商品信息'] && typeof record['商品信息'] === 'object'
    ? record['商品信息']
    : record) as Record<string, unknown>
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = info[k] ?? record[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return ''
  }
  const title = str('商品标题', 'title')
  const priceDisplay = str('当前售价', 'price')
  // 主图：优先 商品主图链接，回退 商品图片列表[0]；http 升级为 https（避免线上混合内容拦截）
  let image = str('商品主图链接', 'image')
  if (!image) {
    const list = info['商品图片列表'] ?? record['商品图片列表']
    if (Array.isArray(list) && typeof list[0] === 'string') image = list[0].trim()
  }
  const imageHttps = image.startsWith('http://') ? `https://${image.slice(7)}` : (image || undefined)
  return {
    no,
    title,
    price: parsePriceValue(info['当前售价'] ?? info['price'] ?? record['当前售价'] ?? record['price']),
    priceDisplay,
    link: str('商品链接', 'link', 'url'),
    region: str('发货地区', 'region') || undefined,
    publishTime: str('发布时间', 'publish_time') || undefined,
    image: imageHttps,
  }
}

/** 任务列表条目（防御式宽松读取，monitor 返回 dict 数组） */
export interface MonitorTaskBrief {
  id: number
  taskName: string
  keyword: string
  running: boolean
  enabled: boolean
}

export async function listMonitorTasks(base: string): Promise<MonitorTaskBrief[]> {
  const raw = (await fetchJson(`${base}/api/tasks`)) as unknown
  if (!Array.isArray(raw)) return []
  return raw.map((t) => {
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
    return {
      id: typeof o.id === 'number' ? o.id : -1,
      taskName: typeof o.task_name === 'string' ? o.task_name : '',
      keyword: typeof o.keyword === 'string' ? o.keyword : '',
      running: o.is_running === true,
      enabled: o.enabled !== false,
    }
  })
}

/** 创建 keyword 模式监控任务（不调 AI、零额度），返回新任务 id；失败抛错。 */
export async function createKeywordTask(
  base: string,
  opts: {
    keyword: string
    maxPages: number
    minPrice?: string | null
    maxPrice?: string | null
    personalOnly: boolean
    /** 地区筛选，「省/市/区」格式（如「广东/深圳/南山区」），monitor 爬虫在搜索页弹窗逐级点选；不传=不限 */
    region?: string | null
  },
): Promise<number> {
  const res = (await postJson(`${base}/api/tasks/`, {
    task_name: opts.keyword,
    keyword: opts.keyword,
    decision_mode: 'keyword',
    keyword_rules: [opts.keyword],
    max_pages: opts.maxPages,
    min_price: opts.minPrice ?? null,
    max_price: opts.maxPrice ?? null,
    personal_only: opts.personalOnly,
    region: opts.region ?? null,
    enabled: true,
  })) as { task?: { id?: unknown } }
  const id = res?.task?.id
  if (typeof id !== 'number') throw new Error('创建响应缺少任务 id')
  return id
}

/** 立即启动单任务；失败抛错（如任务被禁用会得到 monitor 的 400 文案）。 */
export async function startMonitorTask(base: string, taskId: number): Promise<void> {
  await postJson(`${base}/api/tasks/start/${taskId}`, {})
}

/** 读某关键词的现成行情（文件匹配 → insights + 最近商品）。
 * 返回 null = 没有该关键词的结果文件；hasSamples=false = 文件在但还没有效样本。 */
export async function readYellowFishMarket(
  base: string,
  keyword: string,
  limit: number,
): Promise<{
  filename: string
  matchedKeyword: string
  market: { sampleCount: number; avg: number | null; median: number | null; min: number | null; max: number | null; snapshotTime?: string | null }
  history: { sampleCount: number; avg: number | null; median: number | null; min: number | null; max: number | null; uniqueItems?: number }
  dailyTrend: Array<{ day: string; sampleCount: number; avg: number | null; min: number | null; max: number | null }>
  recentItems: ReturnType<typeof mapItem>[]
  hasSamples: boolean
} | null> {
  let files: string[]
  try {
    const listRes = (await fetchJson(`${base}/api/results/files`)) as { files?: string[] }
    files = Array.isArray(listRes?.files) ? listRes.files : []
  } catch (err) {
    // 连 results 列表都拿不到 = monitor 的结果接口不可用，交给调用方按未连通处理
    throw err
  }
  const filename = matchFilename(files, keyword)
  if (!filename) return null
  const matchedKeyword = filename.replace(YELLOW_FISH_FULL_DATA_SUFFIX, '').replace(/\.jsonl$/, '')
  const encoded = encodeURIComponent(filename)

  // 行情洞察（权威汇总）
  let insights: Record<string, unknown> | null = null
  try {
    insights = (await fetchJson(`${base}/api/results/${encoded}/insights`)) as Record<string, unknown>
  } catch {
    insights = null
  }

  // 最近商品（尽力而为，失败不阻断洞察）
  let recentItems: ReturnType<typeof mapItem>[] = []
  try {
    const itemsRes = (await fetchJson(
      `${base}/api/results/${encoded}?limit=${limit}&sort_by=crawl_time&sort_order=desc`,
    )) as { items?: Array<Record<string, unknown>> }
    recentItems = (Array.isArray(itemsRes?.items) ? itemsRes.items : []).map((rec, i) => mapItem(rec, i + 1))
  } catch {
    recentItems = []
  }

  if (!insights) {
    return {
      filename,
      matchedKeyword,
      market: { sampleCount: 0, avg: null, median: null, min: null, max: null, snapshotTime: null },
      history: { sampleCount: 0, avg: null, median: null, min: null, max: null },
      dailyTrend: [],
      recentItems,
      hasSamples: false,
    }
  }

  const marketSummary = mapSummary(insights.market_summary as Record<string, unknown>)
  const rawSnapshotTime = (insights.market_summary as Record<string, unknown>)?.snapshot_time
  const market = {
    ...marketSummary,
    snapshotTime: typeof rawSnapshotTime === 'string' ? rawSnapshotTime : null,
  }
  const historySummary = mapSummary(insights.history_summary as Record<string, unknown>)
  const rawUnique = (insights.history_summary as Record<string, unknown>)?.unique_items
  const history = {
    ...historySummary,
    uniqueItems: typeof rawUnique === 'number' ? rawUnique : undefined,
  }
  const rawTrend = Array.isArray(insights.daily_trend) ? (insights.daily_trend as Array<Record<string, unknown>>) : []
  const dailyTrend = rawTrend.map((p) => {
    const s = mapSummary(p)
    return { day: String(p.day ?? ''), sampleCount: s.sampleCount, avg: s.avg, min: s.min, max: s.max }
  })

  const hasSamples = market.sampleCount > 0 || history.sampleCount > 0
  return { filename, matchedKeyword, market, history, dailyTrend, recentItems, hasSamples }
}
