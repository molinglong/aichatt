/**
 * 课程窗口 · 最近打开(localStorage 版)
 *
 * 记录口径:
 * - 只记 B 站课程页(视 video / 课程 cheese / 合集 list / UP 空间),其它地址仍可打开但不入列表;
 * - URL 归一化去追踪参数(vd_source/spm_id_from 等)再按 url 去重,时间刷新置顶;
 * - 标题异步补:先落 URL 派生兜底标签,再由 /api/course/meta 补真实标题并回写。
 *
 * 锁定期白名单与 Rust cb_whitelisted 同口径(hosts + www 路径前缀),
 * 前端只用来在锁定态过滤入口,真正拦截仍在 Rust 侧。
 */

export interface CourseRecent {
  url: string
  /** 真实标题(可能后补);缺省时 UI 用 fallbackLabel */
  title?: string
  /** B 站封面图(展示端加 no-referrer 绕过图床防盗链);缺省用渐变兜底 */
  cover?: string
  /** 记录时间(ms) */
  ts: number
}

const KEY = 'aichatt.course.recents.v1'
const MAX = 8

const DROP_PARAMS = [
  'vd_source',
  'spm_id_from',
  'from_source',
  'from_spmid',
  'share_source',
  'share_medium',
  'share_plat',
  'share_session_id',
  'share_tag',
  'unique_k',
  'bbid',
]

const ALLOW_HOSTS = ['www.bilibili.com', 'space.bilibili.com', 'player.bilibili.com', 'b23.tv']
const ALLOW_PREFIXES = ['/video/', '/list/', '/space/', '/cheese/']
const LOCALE_SEGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'th', 'vi', 'id', 'es', 'pt', 'fr', 'de', 'ru', 'it']

export function normalizeCourseUrl(input: string): string {
  const s = input.trim()
  if (!s) return ''
  const withScheme = s.includes('://') ? s : `https://${s}`
  try {
    const u = new URL(withScheme)
    for (const p of DROP_PARAMS) u.searchParams.delete(p)
    u.hash = ''
    return u.toString()
  } catch {
    return withScheme
  }
}

export function courseHost(url: string): string {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname
  } catch {
    return ''
  }
}

export function isBilibiliInput(input: string): boolean {
  const host = courseHost(input)
  return host === 'bilibili.com' || host.endsWith('.bilibili.com')
}

/** 锁定期可放行(镜像 src-tauri/src/course_browser.rs cb_whitelisted) */
export function isCourseUrlAllowedWhenLocked(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (!ALLOW_HOSTS.includes(u.hostname)) return false
  if (u.hostname !== 'www.bilibili.com') return true
  let path = u.pathname
  for (const loc of LOCALE_SEGS) {
    if (path.startsWith(`/${loc}/`)) {
      path = path.slice(loc.length + 1)
      break
    }
    if (path === `/${loc}`) {
      path = '/'
      break
    }
  }
  return ALLOW_PREFIXES.some((p) => path.startsWith(p))
}

export function courseUrlKind(url: string): 'video' | 'cheese' | 'list' | 'space' | 'other' {
  try {
    const u = new URL(url)
    if (u.hostname === 'space.bilibili.com' || u.pathname.startsWith('/space/')) return 'space'
    if (u.pathname.includes('/video/')) return 'video'
    if (u.pathname.includes('/cheese/')) return 'cheese'
    if (u.pathname.includes('/list/')) return 'list'
    return 'other'
  } catch {
    return 'other'
  }
}

/** 没有真实标题时的兜底标签(短、可截断) */
export function courseFallbackLabel(url: string): string {
  const kind = courseUrlKind(url)
  const path = (() => {
    try {
      return new URL(url).pathname
    } catch {
      return url
    }
  })()
  if (kind === 'video') {
    const bv = path.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1]
    return bv ? `视频 · ${bv}` : 'B 站视频'
  }
  if (kind === 'cheese') {
    const ep = path.match(/\/cheese\/play\/(ep\d+)/i)?.[1] ?? path.match(/\/cheese\/([^/]+)/i)?.[1]
    return ep ? `课程 · ${ep}` : 'B 站课程'
  }
  if (kind === 'list') {
    const id = path.match(/\/list\/([^/]+)/i)?.[1]
    return id ? `合集 · ${id}` : 'B 站合集'
  }
  if (kind === 'space') return 'UP 主空间'
  return courseHost(url).replace(/^www\./, '') || 'B 站页面'
}

export function readCourseRecents(): CourseRecent[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (x): x is CourseRecent =>
          !!x && typeof x.url === 'string' && x.url.length > 0 && typeof x.ts === 'number'
      )
      .slice(0, MAX)
  } catch {
    return []
  }
}

function write(list: CourseRecent[]): CourseRecent[] {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    /* 隐私模式/配额满:内存里照常显示 */
  }
  return list.slice(0, MAX)
}

/** 记录一次打开(返回新列表)。非 B 站地址不入列表。 */
export function recordCourseRecent(prev: CourseRecent[], url: string, title?: string): CourseRecent[] {
  if (!isBilibiliInput(url)) return prev
  // 只记内容页(视频/课程/合集/UP 空间);搜索、历史、稍后再看这类入口页不进列表
  const kind = courseUrlKind(url)
  if (kind !== 'video' && kind !== 'cheese' && kind !== 'list' && kind !== 'space') return prev
  const norm = normalizeCourseUrl(url)
  if (!norm) return prev
  const hit = prev.find((r) => r.url === norm)
  const entry: CourseRecent = {
    url: norm,
    ts: Date.now(),
    title: title ?? hit?.title,
    cover: hit?.cover,
  }
  return write([entry, ...prev.filter((r) => r.url !== norm)])
}

/** 补标题/封面(meta 接口回来后写回,顺序不变) */
export function patchCourseRecent(
  list: CourseRecent[],
  url: string,
  patch: { title?: string; cover?: string }
): CourseRecent[] {
  let changed = false
  const next = list.map((r) => {
    if (r.url !== url) return r
    const title = patch.title ?? r.title
    const cover = patch.cover ?? r.cover
    if (title === r.title && cover === r.cover) return r
    changed = true
    return { ...r, title, cover }
  })
  return changed ? write(next) : list
}

export function updateCourseRecentTitle(
  list: CourseRecent[],
  url: string,
  title: string
): CourseRecent[] {
  const next = list.map((r) => (r.url === url ? { ...r, title } : r))
  write(next)
  return next
}

/** 列表里的时间文案(本地时区) */
export function formatRecentTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const dayKey = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = Math.round((today.getTime() - target.getTime()) / 86_400_000)
  if (diff <= 0) return `今天 ${hm}`
  if (diff === 1) return `昨天 ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}