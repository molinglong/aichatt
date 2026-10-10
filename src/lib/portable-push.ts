/**
 * 浏览器侧「一键推送线上」—— 本地 dev 实例把会话直接灌进远端实例的导入端点。
 *
 * 场景:不知不觉在本地聊完了,手机连的是线上,想让线上也有这些会话。
 * 第零波是「导出文件 → 去对面实例上传」,通道已经验证可靠;这一波只是把
 * 这两步在浏览器里连起来:本地 export 端点拿 bundle(同源 cookie) →
 * 远端 import 端点带 Bearer sk- 令牌写入(令牌在远端 设置→API 令牌 生成)。
 *
 * 口径:
 * - 不存密码。令牌是远端签发的可撤销凭证,本地只存地址;令牌是否落本地
 *   由用户勾选决定(localStorage),默认只留在内存,刷新就要重填。
 * - 推送一律「先预演后实推」:preview 清单(将新建/已存在/他人记录)先给用户看,
 *   与第零波导入同一套判据,不另发明口径。
 * - 分块:远端单次导入上限 200 条/本地单次导出上限 200 条,两侧都按 200 切,
 *   超过 200 条的历史会自动分批逐块推,进度按块汇报。
 */

/** 目标实例描述:地址不含尾斜杠,令牌为 sk- 明文(仅创建时可见的那一串) */
export interface RemoteTarget {
  baseUrl: string
  token: string
}

export type ProbeStatus = 'ok' | 'unauthorized' | 'not-upgraded' | 'unreachable'

export interface ProbeResult {
  status: ProbeStatus
  /** 人话说明,UI 直接展示 */
  message: string
}

export interface PushReportItem {
  outcome: string
  id?: string
  title: string
  reason?: string
  messages?: number
  strippedAttachments?: number
  maskDropped?: boolean
}

interface ImportResponseBody {
  reports?: PushReportItem[]
  created?: number
  duplicate?: number
  foreign?: number
  invalid?: number
  skippedInvalid?: number
  error?: string
}

/**
 * 本机记住的推送目标（单一事实源：设置页写这两个键，历史列表右键也读这两个键）。
 * 令牌只在「记住令牌」勾选时才落本地，默认刷新即失。
 */
export const PUSH_URL_KEY = 'aichat.push.url'
export const PUSH_TOKEN_KEY = 'aichat.push.token'

/** 去掉用户粘贴时顺手带上的尾斜杠/路径,拼出干净的 API 根 */
export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  try {
    const u = new URL(s)
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

/**
 * 读本机记住的推送目标：地址与令牌都齐才返回，否则 null。
 * 历史列表右键「推送到线上（这一条）」复用设置页那份凭证，不另存第二套口径。
 */
export function readPushTarget(): RemoteTarget | null {
  if (typeof window === 'undefined') return null
  try {
    const baseUrl = normalizeBaseUrl(localStorage.getItem(PUSH_URL_KEY) ?? '')
    const token = (localStorage.getItem(PUSH_TOKEN_KEY) ?? '').trim()
    if (!baseUrl || !token) return null
    return { baseUrl, token }
  } catch {
    return null
  }
}

/** 本地导出端点拿 bundle(同源 cookie 会话):ids 一批,上限随端点契约 200 */
async function fetchLocalBundle(ids: string[]): Promise<unknown> {
  const res = await fetch('/api/conversations/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  const data = (await res.json().catch(() => null)) as
    | { bundle?: unknown; exported?: number; error?: string }
    | null
  if (!res.ok || !data?.bundle) {
    throw new Error(typeof data?.error === 'string' ? data.error : `本地导出失败（HTTP ${res.status}）`)
  }
  return data.bundle
}

/** 远端当前列表里的全部会话 id,翻页拿齐(列表端点单页上限 100) */
export async function fetchAllLocalConversationIds(): Promise<string[]> {
  const ids: string[] = []
  for (let offset = 0; offset < 5000; offset += 100) {
    const res = await fetch(`/api/conversations?limit=100&offset=${offset}`)
    if (!res.ok) throw new Error(`读取本地对话列表失败（HTTP ${res.status}）`)
    const data = (await res.json().catch(() => null)) as
      | { items?: Array<{ id: string }> }
      | null
    const page = data?.items ?? []
    ids.push(...page.map((c) => c.id))
    if (page.length < 100) break
  }
  return ids
}

/**
 * 向远端 import 端点发一个包。preview 两种都会走到远端的同一套判据。
 * 网络失败/非 JSON 响应统一收成人话错误。
 */
async function postToRemote(
  target: RemoteTarget,
  bundle: unknown,
  preview: boolean
): Promise<ImportResponseBody> {
  const res = await fetch(`${target.baseUrl}/api/conversations/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${target.token.trim()}`,
    },
    body: JSON.stringify({ bundle, preview }),
  })
  const data = (await res.json().catch(() => null)) as ImportResponseBody | null
  if (!res.ok) {
    throw new Error(
      typeof data?.error === 'string' ? data.error : `远端返回 HTTP ${res.status}`
    )
  }
  return data ?? {}
}

/**
 * 连通性/令牌/版本三态探测。
 * 判据:向远端 import 端点 POST 一个故意不完整的包 ——
 *   400 = 端点存在且令牌已被接受(校验顺序在 parse 之前)→ 一切就绪;
 *   401 = 令牌无效;404/重定向 = 远端还是旧版(没有 import 端点);
 *   fetch 本身抛 = 地址不可达或 CORS 被拦。
 * 故意坏包不写库,探测零副作用。
 */
export async function probeRemote(target: RemoteTarget): Promise<ProbeResult> {
  const base = normalizeBaseUrl(target.baseUrl)
  if (!base) return { status: 'unreachable', message: '地址格式不对，例：https://chat.yuban.icu' }
  if (!target.token.trim())
    return { status: 'unauthorized', message: '还没有填令牌(在目标实例 设置→API 令牌 生成)' }

  const junkBundle = {
    kind: 'aichat.conversation-bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    conversations: [],
  }
  try {
    const res = await fetch(`${base}/api/conversations/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.token.trim()}`,
      },
      body: JSON.stringify({ bundle: junkBundle }),
    })
    if (res.status === 401) {
      return { status: 'unauthorized', message: '令牌无效或已被撤销，请在目标实例重新生成' }
    }
    if (res.status === 400) {
      return { status: 'ok', message: '线上实例可达，令牌有效，可以推送' }
    }
    if (res.status === 404 || res.redirected || !(res.headers.get('content-type') ?? '').includes('json')) {
      return {
        status: 'not-upgraded',
        message: '这个地址像是旧版实例（还没有对话搬运端点），请先把新版部署上去',
      }
    }
    return { status: 'ok', message: `远端返回 HTTP ${res.status}，端点看似可用，可直接预演试试` }
  } catch (err) {
    return {
      status: 'unreachable',
      message: `连不上 ${base}（${err instanceof Error ? err.message : '网络或跨域被拦'}）`,
    }
  }
}

/** 预演:把远端会怎么处理这个包摊开,不落库 */
export async function previewPush(
  target: RemoteTarget,
  ids: string[]
): Promise<PushReportItem[]> {
  const bundle = await fetchLocalBundle(ids)
  const data = await postToRemote(target, bundle, true)
  return data.reports ?? []
}

export interface PushBatchResult {
  reports: PushReportItem[]
  created: number
  duplicate: number
  foreign: number
  invalid: number
}

/** 实推一批(≤200 条):远端逐条独立事务,回报每条去向 */
export async function pushBatch(target: RemoteTarget, ids: string[]): Promise<PushBatchResult> {
  const bundle = await fetchLocalBundle(ids)
  const data = await postToRemote(target, bundle, false)
  return {
    reports: data.reports ?? [],
    created: data.created ?? 0,
    duplicate: data.duplicate ?? 0,
    foreign: data.foreign ?? 0,
    invalid: data.invalid ?? 0,
  }
}

/** 把 id 列表按 size 切块 */
export function chunkIds(ids: string[], size: number): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}
