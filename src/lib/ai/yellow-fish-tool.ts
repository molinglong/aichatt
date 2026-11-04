import { z } from 'zod'

/**
 * get_yellow_fish_market —— 闲鱼行情工具（isomorphic 常量模块）。
 *
 * 数据来源：本机自建的 ai-goofish-monitor 监控服务（默认 127.0.0.1:8000）的现成只读接口，
 * 反映的是「已设监控关键词」的历史抓取汇总，不是闲鱼全站实时挂牌。
 *
 * 为什么走内置工具而非 MCP：MCP 总线经 assertSafeUrl 拦截内网地址，连不上 127.0.0.1；
 * 本工具是服务端直连本机监控服务，不经过那条 SSRF 校验。
 *
 * 拆分铁律：本文件零服务端依赖，客户端 ToolCallCard 只允许 import 本模块。
 */

export const YELLOW_FISH_TOOL_NAME = 'get_yellow_fish_market'

/** 监控服务默认基址；实际以环境变量 YELLOW_FISH_MONITOR_BASE_URL 覆盖（去掉尾部斜杠）。 */
export const YELLOW_FISH_MONITOR_BASE_DEFAULT = 'http://127.0.0.1:8000'

export const YELLOW_FISH_TOOL_PROMPT = [
  '## YellowFish 行情 get_yellow_fish_market',
  '你拥有 get_yellow_fish_market 工具，读取本机闲鱼监控服务已抓到的行情汇总（均价/中位/区间/每日走势/最近商品）。规则：',
  '- 用户问某个「已监控关键词」的闲鱼行情/价格带/走势时调用它取真实数据，关键词用卖家标题里的写法（国产品牌用中文，如「小米」）。',
  '- 返回 available=false 表示监控服务未启动或该关键词没有监控任务：如实告知用户"监控服务没连上/这个关键词没在监控"，**绝不编造价格或假装查到了**。',
  '- 数据是历史抓取汇总、非全站实时挂牌；样本数、抓取时间要如实反映，样本很少或为空时说明参考价值有限。',
  '- 调用后把均价、区间、趋势、最近商品自然讲给用户即可，不要复述"我调用了工具"。',
].join('\n')

/** zod 字段集合（isomorphic，服务端工厂用 z.object 包成 inputSchema） */
export const YELLOW_FISH_INPUT_SCHEMA = {
  keyword: z
    .string()
    .min(1)
    .max(60)
    .describe('闲鱼搜索关键词，如 "iPad Pro"、"iPhone 15"；用卖家标题里的写法，国产品牌用中文'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('返回最近商品条数，默认 5；要按成色/价格分档推荐时拉到 40~80，读本机库无频率代价'),
}

// ---------------------------------------------------------------------------
// add_yellow_fish_watch —— 建监控任务闭环（写工具，带护栏）
// ---------------------------------------------------------------------------

export const YELLOW_FISH_WATCH_TOOL_NAME = 'add_yellow_fish_watch'

/** 完整闭环的最长等待（秒）：轮询现成行情出现，超时则引导用户稍后再问。 */
export const YELLOW_FISH_WATCH_POLL_SECONDS = 90

export const YELLOW_FISH_WATCH_PROMPT = [
  '## YellowFish 建监控 add_yellow_fish_watch',
  '你拥有 add_yellow_fish_watch 工具：给某个关键词在监控服务里建任务并立即抓取一次，全程自动（约 1~3 分钟）。规则：',
  '- get_yellow_fish_market 返回 available=false（该关键词没在监控）时，先问用户要不要建监控；用户同意或明确说"帮我盯着/查一下这个"就调用它。',
  '- 护栏是自动的：会查重（已有关键词任务就复用或触发重跑），不会重复建。不要在一条回复里对同一关键词调用多次。',
  '- 用户提了地区（如「只要深圳的」「本地的」）就在入参带 region，格式「省/市/区」三段（如「广东/深圳/南山区」，至少给省级，用真实行政区名，市/区不确定可以只给省）；没提地区就不要带。',
  '- 返回 available=true：把行情直接讲给用户（与 get_yellow_fish_market 相同的讲法）。',
  '- 返回 available=false 且 action=created/rerun：如实告知「监控已建好/已开爬，抓完会自动把行情发到对话里」；不要让用户手动追问，也不要编造价格。',
  '- 返回 action=already_running：告知任务正在爬，抓完会自动回报。',
].join('\n')

/** zod 字段集合（isomorphic） */
export const YELLOW_FISH_WATCH_INPUT_SCHEMA = {
  keyword: z
    .string()
    .min(1)
    .max(60)
    .describe('闲鱼搜索关键词，用卖家标题里的写法（国产品牌用中文，如 "小米平板7"）'),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('抓取页数，默认 3（页数越多样本越多但更慢）'),
  minPrice: z
    .string()
    .max(20)
    .optional()
    .describe('只看不低于该价格的商品，如 "500"'),
  maxPrice: z
    .string()
    .max(20)
    .optional()
    .describe('只看不超过该价格的商品，如 "2000"'),
  personalOnly: z
    .boolean()
    .optional()
    .describe('只看个人闲置（滤掉商家），默认 true'),
  region: z
    .string()
    .max(40)
    .optional()
    .describe('按地区筛选，格式「省/市/区」（如「广东/深圳/南山区」，至少给省级，用真实行政区名）；不填=不限地区'),
}

/** 行情子字段（与 YellowFishToolOutput 的 market/history/trend/items 同形，前端卡片复用渲染） */
export interface YellowFishWatchToolOutput {
  keyword: string
  /** created=新建并开爬 / rerun=已有任务重新触发 / reused=已有数据直接返回 / already_running=任务在跑 */
  action: 'created' | 'rerun' | 'reused' | 'already_running'
  /** true = 本次已拿到可用行情（market 等字段有值） */
  available: boolean
  /**
   * true = 爬虫仍在后台跑、本轮超时先回：前端轮询 status 接口，数据落地后自动发
   * 【监控回报】消息触发模型查行情补报。只在"任务确定在爬/已开爬"的软状态为 true；
   * 失败、空样本终态、reused 均不置位。
   */
  crawlPending?: boolean
  taskId?: number
  matchedKeyword?: string
  market?: YellowFishPriceSummary & { snapshotTime?: string | null }
  history?: YellowFishPriceSummary & { uniqueItems?: number }
  dailyTrend?: YellowFishTrendPoint[]
  recentItems?: YellowFishItemBrief[]
  note?: string
  error?: string
}

/** 价格汇总（monitor 的 snake_case 字段映射为 camelCase；无样本时各项为 null） */
export interface YellowFishPriceSummary {
  sampleCount: number
  avg: number | null
  median: number | null
  min: number | null
  max: number | null
}

/** 每日走势点 */
export interface YellowFishTrendPoint {
  day: string
  sampleCount: number
  avg: number | null
  min: number | null
  max: number | null
}

/** 最近商品条目 */
export interface YellowFishItemBrief {
  /** 1-based 序号（模型在 :::yellow-fish 推荐块里按此编号引用，前端据此 hydrate 出标题/价格/图/链接） */
  no: number
  title: string
  price: number | null
  priceDisplay: string
  link: string
  region?: string
  publishTime?: string
  /** 商品主图（已归一为 https，供卡片缩略图） */
  image?: string
  /** 卖家头像（实时搜索链路才有，监控快照缺省） */
  avatar?: string
}

/** 工具 output 形状（服务端 execute 返回，前端卡片渲染） */
export interface YellowFishToolOutput {
  keyword: string
  /** 是否成功连通监控服务并命中该关键词的监控数据 */
  available: boolean
  /** 实际匹配到的监控关键词（文件名去后缀） */
  matchedKeyword?: string
  /** 最近一次抓取的样本汇总（当前快照） */
  market?: YellowFishPriceSummary & { snapshotTime?: string | null }
  /** 时间窗口内的历史汇总 */
  history?: YellowFishPriceSummary & { uniqueItems?: number }
  dailyTrend?: YellowFishTrendPoint[]
  recentItems?: YellowFishItemBrief[]
  error?: string
  note?: string
}
