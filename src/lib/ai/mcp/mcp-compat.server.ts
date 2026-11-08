import { MCP_INITIAL_PROTOCOL_VERSION } from './mcp-constants'

/**
 * MCP server 协议版本兼容层（服务端专用）。
 *
 * 背景：@ai-sdk/mcp 2.x 的 legacy 初始化把协议版本硬编码为 2025-11-25
 * （initialProtocolVersion 只影响 header，不影响 initialize 请求体），
 * 部分老 server（实测 12306-mcp 0.3.10）对不认识的版本直接 400 拒绝，
 * 而不是按 MCP 规范回退到自己支持的版本。
 *
 * 解法：经 transport.fetch 注入包装，把 initialize 请求体里过新的提议版本
 * 改写为上一代广泛支持的 2025-06-18；server 应答后客户端按协商结果走
 * （2025-06-18 在 @ai-sdk/mcp 支持列表内），对新 server 无损。
 */

/** @ai-sdk/mcp 硬编码会发出的过新版本：legacy 初始化 2025-11-25、modern 探测 2026-07-28 */
const MCP_VERSION_DOWNGRADE_FROM = new Set(['2025-11-25', '2026-07-28'])

/** 生成带协议版本降级能力的 fetch 实例（每个连接独立实例即可） */
export function createMcpCompatFetch(): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === 'string') {
      try {
        const msg = JSON.parse(init.body) as {
          method?: string
          params?: { protocolVersion?: string }
        }
        if (
          msg.method === 'initialize' &&
          msg.params?.protocolVersion &&
          MCP_VERSION_DOWNGRADE_FROM.has(msg.params.protocolVersion)
        ) {
          msg.params.protocolVersion = MCP_INITIAL_PROTOCOL_VERSION
          // header 同步改写，避免个别 server 校验 mcp-protocol-version 头时出现 body/header 不一致
          const headers = new Headers(init.headers)
          if (headers.has('mcp-protocol-version')) {
            headers.set('mcp-protocol-version', MCP_INITIAL_PROTOCOL_VERSION)
          }
          init = { ...init, body: JSON.stringify(msg), headers }
        }
      } catch {
        // 非 JSON body 原样放行
      }
    }
    return fetch(input, init)
  }
}
