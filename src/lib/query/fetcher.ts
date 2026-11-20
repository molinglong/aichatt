'use client'

import { getErrorMessage } from '@/lib/chat-errors'

/**
 * 通用 fetch helper,用于 React Query 的 queryFn。
 *
 * 设计要点:
 * 1) 默认 `credentials: include`,Next.js 即使配 next-auth 也得显式带 cookie 才会话保持
 * 2) 401 / 403 抛一类专门的 AuthorizationError,组件里可以单独判断
 *    (例:catch 到后路由跳转 /login 而不是显示通用错误)
 * 3) 非 2xx 响应 throw Error(message),统一走 Toast 提示,排查时只看一处
 * 4) 支持 abort signal(React Query 会自己传)
 */
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export class AuthorizationError extends HttpError {
  constructor(status: 401 | 403, message = '未授权') {
    super(status, message)
    this.name = 'AuthorizationError'
  }
}

export class NotFoundError extends HttpError {
  constructor(message = '资源不存在') {
    super(404, message)
    this.name = 'NotFoundError'
  }
}

export interface FetchJsonOptions extends Omit<RequestInit, 'body'> {
  /** JSON body——会自动 stringify + 标 Content-Type */
  json?: unknown
  /** 自定义超时(毫秒),默认 20s。0 表示不超时 */
  timeoutMs?: number
  /** 是否静默吞 4xx(不抛 NotFoundError,直接返回 undefined) */
  swallowNotFound?: boolean
}

/**
 * 一次 fetch 然后 JSON 解析。
 *
 * 用法:
 *   fetchJson<MyData>('/api/foo', { json: { x: 1 } })
 *   fetchJson<MyData>('/api/foo')
 */
export async function fetchJson<T = unknown>(
  url: string,
  opts: FetchJsonOptions = {}
): Promise<T> {
  const { json, timeoutMs = 20_000, swallowNotFound, headers, ...rest } = opts

  const init: RequestInit = {
    credentials: 'include',
    ...rest,
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    // 带 json 默认 POST:显式传了 method 的调用不受影响;漏传 method 时若按默认 GET 发 body,
    // fetch 规范会直接抛「GET cannot have body」,表现为静默失败(录题切题驱动曾踩此坑)
    ...(json !== undefined && rest.method === undefined ? { method: 'POST' as const } : {}),
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  }

  // 超时控制——AbortController
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const userSignal = init.signal
  if (userSignal) {
    if (userSignal.aborted) controller.abort()
    else userSignal.addEventListener('abort', () => controller.abort())
  }
  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  }

  let res: Response
  try {
    // 服务端渲染/hydration 阶段没有 window.location,相对 URL 需要带 base 才能 new URL();
    // 这里在 server-side runtime 用环境变量 + Request headers 拼绝对地址。
    // 浏览器端不需要这一步,直接传相对 URL 即可。
    const isServer = typeof window === 'undefined'
    const finalUrl =
      isServer && url.startsWith('/')
        ? buildServerAbsoluteUrl(url)
        : url
    res = await fetch(finalUrl, { ...init, signal: controller.signal })
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId)
    if ((err as { name?: string } | null)?.name === 'AbortError') {
      throw new HttpError(0, '请求已取消或超时')
    }
    // 网络错误:沿用 ai-sdk 的 chat-errors 友好提示体系
    const info = getErrorMessage(err instanceof Error ? err : new Error(String(err)))
    throw new HttpError(0, info.message)
  }
  if (timeoutId) clearTimeout(timeoutId)

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      // 401/403 单独抛出,组件可以判断走 "/login" 跳转
      let detail = ''
      try {
        const data = await res.clone().json().catch(() => null)
        detail = typeof data?.error === 'string' ? data.error : ''
      } catch {}
      throw new AuthorizationError(res.status, detail || '请重新登录')
    }
    if (res.status === 404 && swallowNotFound) {
      return undefined as T
    }
    if (res.status === 404) {
      throw new NotFoundError()
    }
    let detail = ''
    try {
      const data = await res.clone().json().catch(() => null)
      detail = typeof data?.error === 'string' ? data.error : ''
    } catch {}
    throw new HttpError(res.status, detail || `请求失败 (HTTP ${res.status})`)
  }

  // 204 / 空 body 处理
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(res.status, '响应不是合法 JSON')
  }
}

/**
 * 把服务端的相对路径(如 /api/providers)拼成可 fetch 的绝对 URL。
 * 优先级:
 *   1) VERCEL_URL (Vercel 部署)
 *   2) NEXT_PUBLIC_APP_URL (用户/部署自定义)
 *   3) PORT 或 3000 (本地开发兜底,用 127.0.0.1)
 * HTTPS 在 prod 用 https:, 本地用 http:。
 *
 * 只在 server-side 调,浏览器端 fetchJson 不会走这里。
 */
function buildServerAbsoluteUrl(path: string): string {
  const envBase =
    process.env.VERCEL_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`
  const isVercel = !!process.env.VERCEL_URL
  const protocol = isVercel || process.env.NODE_ENV === 'production' ? 'https:' : 'http:'
  const host = envBase.replace(/^https?:\/\//, '')
  // 保证 path 以 / 开头
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${protocol}//${host}${normalized}`
}

/**
 * 从 'YYYY-MM-DD...' 这种 ISO 串、Date、或 number 统一转 Date。
 * 用于缓存数据反序列化过程中保持时间字段类型一致。
 */
export function toDate(value: Date | string | number | null | undefined): Date | undefined {
  if (value == null) return undefined
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}
