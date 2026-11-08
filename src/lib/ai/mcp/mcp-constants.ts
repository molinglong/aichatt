/**
 * MCP 工具总线桥接 —— 常量与命名规则（isomorphic）。
 *
 * 拆分铁律：服务端依赖（@ai-sdk/mcp / prisma / crypto）全在 mcp-client.server.ts，
 * 客户端 ToolCallCard 只允许 import 本模块。
 *
 * 命名空间：MCP 工具注册为 `mcp_<slug>_<toolName>`，避免与内置工具冲突。
 */

export const MCP_TOOL_PREFIX = 'mcp_'

/** 上限：防止工具清单稀释 system prompt 与模型选择能力 */
export const MCP_MAX_SERVERS = 5
export const MCP_MAX_TOOLS_PER_SERVER = 20
export const MCP_MAX_TOOLS_TOTAL = 30
export const MCP_TOOL_DESC_MAX_CHARS = 100

/**
 * initialize 协商前先提议的 MCP 协议版本。
 * @ai-sdk/mcp 2.x 默认提议最新版（2026-07-28），部分老 server（如 12306-mcp）
 * 对不认识的版本直接 400 拒绝而非按规范回退；固定提议上一代广泛支持的版本，
 * 协商后仍以 server 应答为准，对新 server 无损。
 */
export const MCP_INITIAL_PROTOCOL_VERSION = '2025-06-18'

/** server slug + 原工具名 → 完整工具名：mcp_<slug>_<tool> */
export function buildMcpToolName(serverSlug: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverSlug}_${toolName}`
}

/**
 * 由完整工具名解析展示名「服务 · 工具」；非 MCP 工具返回 null。
 * slug 不含下划线（slugify 已折叠），故首个 `_` 之后全部是原工具名。
 */
export function parseMcpToolDisplay(toolName: string): string | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('_')
  if (sep <= 0 || sep >= rest.length - 1) return rest || null
  return `${rest.slice(0, sep)} · ${rest.slice(sep + 1)}`
}

/** server 名称 → slug（小写字母数字，其余折叠为连字符） */
export function slugifyServerName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug || 'srv'
}

export interface McpPromptToolInfo {
  /** server 显示名 */
  serverName: string
  /** 已加前缀的完整工具名 */
  toolName: string
  description?: string
}

/** 生成 MCP 能力段：按 server 分组列工具清单，描述截断；failures 附降级提示 */
export function buildMcpPromptSection(
  infos: McpPromptToolInfo[],
  failures: string[]
): string {
  const lines: string[] = ['## 外部工具能力（MCP）']
  if (infos.length > 0) {
    lines.push(
      '以下工具来自用户配置的 MCP 服务，仅当任务确实需要时才调用；不要虚构不存在的工具，也不要一次调用多个不相关的工具：'
    )
    const groups: Array<{ serverName: string; items: string[] }> = []
    for (const info of infos) {
      const desc = info.description
        ? `：${info.description.slice(0, MCP_TOOL_DESC_MAX_CHARS)}${
            info.description.length > MCP_TOOL_DESC_MAX_CHARS ? '…' : ''
          }`
        : ''
      let group = groups.find((g) => g.serverName === info.serverName)
      if (!group) {
        group = { serverName: info.serverName, items: [] }
        groups.push(group)
      }
      group.items.push(`- ${info.toolName}${desc}`)
    }
    for (const g of groups) {
      lines.push(`【${g.serverName}】`, ...g.items)
    }
  }
  if (failures.length > 0) {
    lines.push(
      `注意：以下 MCP 服务本次连接失败、其工具不可用，如用户问及相关请如实告知：${failures.join('、')}。`
    )
  }
  return lines.join('\n')
}
