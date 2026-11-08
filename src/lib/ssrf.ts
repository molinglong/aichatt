/**
 * SSRF 防护 —— 出站 URL 安全校验（read_url 工具与 MCP server 配置共用）。
 *
 * 仅允许 http/https 公网地址；拒绝环回/内网/链路本地等特殊网段，
 * 防止 AI 被诱导探测内网服务或云元数据端点（169.254.169.254）。
 *
 * 两条路径：read_url 等 AI 动态 URL 默认全拦；MCP server 为用户静态配置，
 * 传 allowPrivate 放行内网（详见 AssertSafeUrlOptions）。
 *
 * 边界说明：首期做 hostname 字面校验，不做 DNS 解析期校验
 * （DNS rebinding 防护需自定义 lookup，留待后期）。
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
])

const BLOCKED_SUFFIXES = ['.local', '.internal', '.lan', '.home', '.corp']

export interface AssertSafeUrlOptions {
  /**
   * 放行环回/内网/保留网段。仅限用户在设置里静态配置的服务地址（当前只有 MCP server）——
   * 这类 URL 不受 AI 影响，本机/内网自建 MCP 是正当场景；
   * AI 动态提供 URL 的出站请求（read_url 等）严禁开启。
   */
  allowPrivate?: boolean
}

/**
 * 校验 URL 是否可安全外呼。
 * @returns 不合法时返回拒绝原因（中文），合法返回 null
 */
export function assertSafeUrl(rawUrl: string, options?: AssertSafeUrlOptions): string | null {
  const allowPrivate = options?.allowPrivate === true
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return 'URL 格式无效'
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `仅支持 http/https 协议（收到 ${parsed.protocol || '未知协议'}）`
  }

  if (allowPrivate) return null

  // 去 IPv6 字面量的方括号
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return '不允许访问内网/本地地址'
  }

  // IPv4 字面量：逐段判断私有/保留网段
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    const [a, b, c] = octets
    if (octets.some((n) => Number.isNaN(n) || n > 255)) return 'IPv4 地址无效'
    const blocked =
      a === 0 || // 0.0.0.0/8 未指定
      a === 10 || // 10/8 私有
      a === 127 || // 环回
      (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
      (a === 169 && b === 254) || // 169.254/16 链路本地（含云元数据端点）
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12 私有
      (a === 192 && b === 168) || // 192.168/16 私有
      (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24 与 192.0.2/24
      (a === 198 && (b === 18 || b === 19)) || // 198.18/15 基准测试
      (a === 198 && b === 51 && c === 100) || // 198.51.100/24 TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // 203.0.113/24 TEST-NET-3
      a >= 224 // 组播与保留段
    if (blocked) return '不允许访问内网/保留地址'
  }

  // IPv6 字面量：环回/未指定/链路本地/ULA/IPv4 映射内网
  if (host.includes(':')) {
    const v6 = host.toLowerCase()
    if (
      v6 === '::1' ||
      v6 === '::' ||
      v6.startsWith('fe8') ||
      v6.startsWith('fe9') ||
      v6.startsWith('fea') ||
      v6.startsWith('feb') ||
      v6.startsWith('fc') ||
      v6.startsWith('fd') ||
      v6.startsWith('::ffff:127.') ||
      v6.startsWith('::ffff:10.') ||
      v6.startsWith('::ffff:192.168.') ||
      v6.startsWith('::ffff:169.254.')
    ) {
      return '不允许访问内网/本地地址'
    }
  }

  return null
}
