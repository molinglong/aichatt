import { z } from 'zod'

/**
 * get_yellow_fish_live —— 闲鱼实时搜索工具（isomorphic 常量模块）。
 *
 * 数据来源：本机 goofish-cli（Playwright + 系统 Chrome 真实浏览器路径，抗风控，只读纪律），
 * 返回当下真实挂牌的搜索结果（默认 20 条采样，非全量行情）。
 *
 * 使用纪律（2026-10-31 定案）：只读、低频 —— 服务端硬编码 10 分钟窗口最多 2 次，
 * 失败退回 get_yellow_fish_market 快照。主号 cookie，绝不用于高频轮询。
 *
 * 拆分铁律：本文件零服务端依赖，客户端 ToolCallCard 只允许 import 本模块。
 */

export const YELLOW_FISH_LIVE_TOOL_NAME = 'get_yellow_fish_live'

/** goofish.exe 默认路径（本机 venv；可用环境变量 YELLOW_FISH_LIVE_CLI_PATH 覆盖） */
export const YELLOW_FISH_LIVE_CLI_PATH_DEFAULT = 'C:\\Users\\shaoyunb\\tools\\goofish-cli-venv\\Scripts\\goofish.exe'

/** 单次 CLI 超时（浏览器启动+搜索实测 20~40s，放宽到 90s） */
export const YELLOW_FISH_LIVE_TIMEOUT_MS = 90_000

/** 限频：全局滑动窗口 10 分钟最多 2 次（只读纪律硬编码；进程重启清零，已知边界） */
export const YELLOW_FISH_LIVE_RATE_WINDOW_MS = 10 * 60 * 1000
export const YELLOW_FISH_LIVE_RATE_MAX = 2

export const YELLOW_FISH_LIVE_PROMPT = [
  '## YellowFish 实时价 get_yellow_fish_live',
  '你拥有 get_yellow_fish_live 工具：通过真实浏览器路径搜闲鱼「现在挂着的」在售商品（约 20 条采样）。规则：',
  '- 当用户要「现在/实时的价格」或 get_yellow_fish_market 的快照明显过旧时调用；关键搜索词用去空格带容量的写法更准（如「iPhone13 128G」）。',
  '- 工具有硬限频（10 分钟最多 2 次）：一次调用就把判断需要的词搜好，不要连续追问式调用；被限频时如实告知稍后再试。',
  '- 返回的是当下挂牌采样（非全量行情、非成交价）：结合样本数与推荐流占比（recommendationHeavy）判断可信度，向用户说明口径。',
  '- 挂牌价常见虚高引流饵（如 ¥100-650 的「几乎全新」iPhone），结合标题与 statistics 区间交叉判断，不要拿最低价当行情。',
  '- 搜到有效样本（available=true）时，正文必须用 :::yellow-fish 块按档分组呈现真实在售——这是硬性要求，漏写块语法会把整档商品退化成纯文字、丢掉全部图/价/链接卡片展示。归档铁律：isSearch=true 的真实搜索结果（推荐流参考价值低不要选）全量归类排开，不要精选掐量；同款同价同卖家的重复挂牌合并留一条（理由里可注明「另有 N 条同款在挂」）。',
  '- 每档单独一个块：单独一行 `:::yellow-fish` 开块，块内首行写档位名+一句话口径（如「🟢 全新/仅拆封 —— 货源少，价格贴近渠道价才算数」「💰 性价比之选 —— 电池 85%+ 无拆修」），之后每行一个商品：`序号｜一句话看点｜风险提示（可省）`，末尾单独一行 `:::` 收块；档与档之间空一行，不要写 markdown 标题。分档维度按商品自己选：成色档（全新/性价比/瑕疵换件）或价格档（如「1200-1800 主力机」）都行。序号必须是 listings 里真实存在的 no，图/价格/标题/链接由前端按 no 自动带出，你不要自己复述链接或价格。',
  '- 块外正文只留一句总述（如挂价区间）；某档没挑出靠谱样本就整档不出并如实说明；「瑕疵/换件」档每条必须带风险提示与核验建议。',
  '- available=false、被限频、登录过期或失败时不出 :::yellow-fish 块，如实说明即可。',
  '- 失败时如实说明，可退回 get_yellow_fish_market 的监控快照，绝不编造价格。',
  '- 返回 cookieExpired=true：闲鱼登录已过期。如实告知用户到「设置 → YellowFish」点修复按钮——会弹出登录窗口，闲鱼 App 扫码或直接输账号密码都行（窗口 10 分钟内有效）；修复前不要反复重试实时搜索；监控快照 get_yellow_fish_market 不受影响，可先用。',
].join('\n')

/** zod 字段集合（isomorphic） */
export const YELLOW_FISH_LIVE_INPUT_SCHEMA = {
  keyword: z
    .string()
    .min(1)
    .max(60)
    .describe('闲鱼搜索词；建议去空格带容量（如 "iPhone13 128G"），比泛搜噪音小'),
  limit: z
    .number()
    .int()
    .min(5)
    .max(20)
    .optional()
    .describe('采样条数，默认 20'),
}

/** 单条在售样本（精简后给模型/卡片） */
export interface YellowFishLiveListing {
  no: number
  /** goofish 商品数字 id（收藏的稳定键；CLI item_id，解析不出为空串） */
  itemId: string
  price: number | null
  priceDisplay: string
  title: string
  location?: string
  seller?: string
  url: string
  /** 封面图（CDN https 直链，来自 CLI 补丁字段 pic_url，可能缺省） */
  pic?: string
  /** 卖家头像（CLI 补丁字段 user_avatar_url，可能缺省） */
  avatar?: string
  /** 划线原价（如 "¥199" 或 "199"，可能缺省） */
  originalPrice?: string
  /** 该条是否真实搜索结果（false=推荐流，参考价值低） */
  isSearch: boolean
}

/** 工具 output 形状 */
export interface YellowFishLiveToolOutput {
  keyword: string
  /** true = 拿到有效搜索样本 */
  available: boolean
  stats?: {
    sampleCount: number
    searchCount: number
    min: number | null
    median: number | null
    max: number | null
  }
  listings?: YellowFishLiveListing[]
  /** true = 推荐流占比高（泛搜噪音大），结论可信度低 */
  recommendationHeavy?: boolean
  /** true = 被本进程限频拦下（未发起真实搜索） */
  rateLimited?: boolean
  /** true = goofish-cli 登录态失效（设置 → YellowFish 可一键修复；监控快照不受影响） */
  cookieExpired?: boolean
  note?: string
  error?: string
}
