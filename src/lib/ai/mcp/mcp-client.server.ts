import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import type { Tool } from 'ai'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { assertSafeUrl } from '@/lib/ssrf'
import {
  buildMcpToolName,
  MCP_INITIAL_PROTOCOL_VERSION,
  MCP_MAX_SERVERS,
  MCP_MAX_TOOLS_PER_SERVER,
  MCP_MAX_TOOLS_TOTAL,
  type McpPromptToolInfo,
} from './mcp-constants'
import { createMcpCompatFetch } from './mcp-compat.server'

/**
 * MCP 桥接 —— 服务端专用（勿客户端 import：含 @ai-sdk/mcp / prisma / crypto）。
 *
 * 职责：加载用户启用的 MCP server → 建立连接（5s 超时）→ 拉取工具集
 * → 按 excludeTools 过滤 → 重命名加 `mcp_<slug>_` 前缀 → 汇总。
 * 任何 server 失败只记入 failures（供降级提示），绝不抛错阻塞聊天主流程。
 */

const CONNECT_TIMEOUT_MS = 5_000

export interface McpLoadResult {
  /** 已重命名的工具集，直接展开进 streamText 的 tools */
  tools: Record<string, Tool>
  /** 注入 system prompt 的工具清单（server 分组） */
  promptInfos: McpPromptToolInfo[]
  /** 连接失败的 server 显示名（降级提示用） */
  failures: string[]
  /** 已建立的连接，流结束后统一 close */
  clients: MCPClient[]
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

function parseExcludeTools(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 加载用户全部已启用 MCP server 的工具集。整体失败静默降级（返回空结果）。 */
export async function loadMcpToolsForUser(userId: string): Promise<McpLoadResult> {
  const result: McpLoadResult = { tools: {}, promptInfos: [], failures: [], clients: [] }

  let servers: Array<{
    name: string
    slug: string
    url: string
    headerName: string | null
    encryptedHeaderValue: string | null
    excludeTools: string | null
  }> = []
  try {
    servers = await prisma.mcpServer.findMany({
      where: { userId, enabled: true },
      orderBy: { createdAt: 'asc' },
      take: MCP_MAX_SERVERS,
    })
  } catch (err) {
    console.error('[mcp] Failed to load servers:', err)
    return result
  }
  if (servers.length === 0) return result

  let totalTools = 0

  await Promise.allSettled(
    servers.map(async (server) => {
      // SSRF 校验：MCP server URL 同样不允许指向内网
      // MCP URL 是用户静态配置，放行内网（本机自建 MCP server 场景）
      const blocked = assertSafeUrl(server.url, { allowPrivate: true })
      if (blocked) {
        result.failures.push(`${server.name}（${blocked}）`)
        return
      }

      const headers: Record<string, string> = {}
      if (server.headerName && server.encryptedHeaderValue) {
        try {
          headers[server.headerName] = decrypt(server.encryptedHeaderValue)
        } catch {
          result.failures.push(`${server.name}（鉴权头解密失败）`)
          return
        }
      }

      const client = await withTimeout(
        createMCPClient({
          transport: {
            type: 'http',
            url: server.url,
            headers,
            initialProtocolVersion: MCP_INITIAL_PROTOCOL_VERSION,
            fetch: createMcpCompatFetch(),
          },
        }),
        CONNECT_TIMEOUT_MS,
        `MCP「${server.name}」连接`
      )
      result.clients.push(client)

      const toolset = await withTimeout(
        client.tools(),
        CONNECT_TIMEOUT_MS,
        `MCP「${server.name}」工具列表`
      )

      const exclude = parseExcludeTools(server.excludeTools)
      let serverToolCount = 0
      let skippedByCap = 0

      for (const [name, t] of Object.entries(toolset)) {
        if (exclude.includes(name)) continue
        if (serverToolCount >= MCP_MAX_TOOLS_PER_SERVER || totalTools >= MCP_MAX_TOOLS_TOTAL) {
          skippedByCap++
          continue
        }
        const full = buildMcpToolName(server.slug, name)
        result.tools[full] = t as Tool
        totalTools++
        serverToolCount++
        const description = (t as { description?: string }).description
        result.promptInfos.push({
          serverName: server.name,
          toolName: full,
          ...(description ? { description } : {}),
        })
      }
      if (skippedByCap > 0) {
        console.warn(
          `[mcp] Server "${server.name}" has ${skippedByCap} tools skipped (cap ${MCP_MAX_TOOLS_PER_SERVER}/server, ${MCP_MAX_TOOLS_TOTAL}/total)`
        )
      }
      console.log(`[mcp] Server "${server.name}" attached ${serverToolCount} tools`)
    })
  )

  return result
}

/** 关闭全部 MCP 连接（流结束后调用；失败静默，不影响响应收尾） */
export async function closeMcpClients(clients: MCPClient[]): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.close()))
}

/** 单个 server 的工具清单（下拉菜单用）：原始工具名（未重命名未过滤），excludeTools 单独返回供前端合并计算 */
export interface McpServerInventory {
  id: string
  name: string
  enabled: boolean
  excludeTools: string[]
  tools: Array<{ name: string; description?: string }>
  /** 连接失败原因（仅 enabled server 可能出现） */
  error?: string
}

/**
 * 拉取用户全部 server（含停用）的工具清单，供输入框下拉菜单逐工具开关。
 * 只读 listTools 不生成 execute，轻于 loadMcpToolsForUser；连接即用即关。
 * 单个 server 失败只记 error，不影响其它 server。
 */
export async function listMcpToolInventory(userId: string): Promise<McpServerInventory[]> {
  let servers: Array<{
    id: string
    name: string
    url: string
    headerName: string | null
    encryptedHeaderValue: string | null
    excludeTools: string | null
    enabled: boolean
  }> = []
  try {
    servers = await prisma.mcpServer.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: MCP_MAX_SERVERS,
    })
  } catch (err) {
    console.error('[mcp] Failed to load server inventory:', err)
    return []
  }
  if (servers.length === 0) return []

  const inventory = servers.map<McpServerInventory>((s) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    excludeTools: parseExcludeTools(s.excludeTools),
    tools: [],
  }))

  await Promise.allSettled(
    servers.map(async (server, i) => {
      const item = inventory[i]!
      if (!server.enabled) return // 停用 server 不连接，前端展示为已停用分组

      let client: MCPClient | null = null
      try {
        // MCP URL 是用户静态配置，放行内网（本机自建 MCP server 场景）
      const blocked = assertSafeUrl(server.url, { allowPrivate: true })
        if (blocked) {
          item.error = blocked
          return
        }
        const headers: Record<string, string> = {}
        if (server.headerName && server.encryptedHeaderValue) {
          try {
            headers[server.headerName] = decrypt(server.encryptedHeaderValue)
          } catch {
            item.error = '鉴权头解密失败'
            return
          }
        }
        client = await withTimeout(
          createMCPClient({
            transport: {
              type: 'http',
              url: server.url,
              headers,
              initialProtocolVersion: MCP_INITIAL_PROTOCOL_VERSION,
              fetch: createMcpCompatFetch(),
            },
          }),
          CONNECT_TIMEOUT_MS,
          `MCP「${server.name}」连接`
        )
        const toolResult = await withTimeout(
          client.listTools(),
          CONNECT_TIMEOUT_MS,
          `MCP「${server.name}」工具列表`
        )
        item.tools = (toolResult.tools ?? [])
          .slice(0, MCP_MAX_TOOLS_PER_SERVER)
          .map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) }))
      } catch (err) {
        item.error = err instanceof Error ? err.message : String(err)
      } finally {
        if (client) await client.close().catch(() => {})
      }
    })
  )

  return inventory
}
