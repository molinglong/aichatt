/**
 * MCP Streamable HTTP 端点——把 aichatt 记忆库暴露为 MCP 工具,供外部 agent(如 ACode)挂载。
 * 深桥「记忆打通」的服务端:ACode 作为 MCP client 连接本端点后,
 * agent 可直接搜索/新增/列出用户的长期记忆(aichatt DB 为记忆唯一源头)。
 *
 * 鉴权:同 /api/v1/messages(x-api-key 令牌,个人访问令牌→userId,env 令牌回退管理员)。
 * 协议:MCP Streamable HTTP(JSON-RPC 2.0),无状态实现——每个 POST 独立处理,
 * 不签发会话、不维护握手状态;通知类请求 202 空体;GET(SSE)不支持返回 405。
 * 用户作用域:令牌绑定的账号(记忆按该用户隔离)。
 */
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/db"
import { upsertMemories } from "@/lib/memory/dedupe"
import { gatewayJsonError, resolveGatewayUserId } from "@/lib/api/gateway-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SERVER_INFO = { name: "aichatt-memory", version: "1.0.0" }
const PROTOCOL_VERSION = "2025-03-26"

const TOOLS = [
  {
    name: "search_memory",
    description: "在用户的 aichatt 记忆库中按关键词搜索历史记忆条目",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词(内容子串匹配)" },
        limit: { type: "number", description: "最多返回条数(默认 10,上限 50)" },
      },
      required: ["query"],
    },
  },
  {
    name: "add_memory",
    description:
      "向用户的 aichatt 记忆库添加一条长期记忆。用户明确要求「记住某事」或陈述了值得长期保留的偏好/事实时调用",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "记忆内容(简洁、明确、可独立理解)" },
        category: {
          type: "string",
          description: "分类:preference(偏好)/fact(事实)/general(默认)",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "get_profile",
    description:
      "查询当前 aichatt 账号身份(用户名/邮箱)。用户问「我是谁/我叫什么/我的账号」时调用此工具获取准确信息,不要猜测。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_recent_memories",
    description: "列出用户 aichatt 记忆库中最近更新的记忆条目",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "条数(默认 20,上限 100)" } },
    },
  },
]

async function callTool(
  userId: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string }> {
  if (!userId) return { text: "记忆库为空:无法解析账号身份。" }
  const rawLimit = Number(args.limit)
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 10, 1), 100)

  if (name === "get_profile") {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    })
    if (!user) return { text: "账号不存在。" }
    return { text: `aichatt 账号:${user.name || user.email}(邮箱 ${user.email})` }
  }

  if (name === "search_memory") {
    const query = typeof args.query === "string" ? args.query.trim() : ""
    if (!query) return { text: "搜索词为空,未执行。" }
    const rows = await prisma.memory.findMany({
      where: { userId, status: "active", content: { contains: query } },
      orderBy: { updatedAt: "desc" },
      take: limit,
    })
    if (rows.length === 0) return { text: `没有匹配「${query}」的记忆。` }
    return {
      text: rows
        .map((r) => `[${r.category}] ${r.content} (更新于 ${r.updatedAt.toISOString().slice(0, 10)})`)
        .join("\n"),
    }
  }

  if (name === "add_memory") {
    const content = typeof args.content === "string" ? args.content.trim() : ""
    if (!content) return { text: "记忆内容为空,未保存。" }
    const category =
      typeof args.category === "string" && args.category.trim() ? args.category.trim() : "general"
    // 走统一写入管线:与已有记忆矛盾的旧条目会被标记取代,不再静默共存
    const result = await upsertMemories(userId, [{ category, content }], { source: "manual" })
    if (result.duplicates.includes(content)) {
      return { text: `已有相同或相似记忆,未重复保存: ${content}` }
    }
    if (result.rejected.includes(content)) {
      return { text: "内容不合规(至少 4 字、最多 200 字),未保存。" }
    }
    const note = result.supersededDetails.length
      ? `（已取代 ${result.supersededDetails.length} 条矛盾旧记忆: ${result.supersededDetails
          .map((d) => d.content)
          .join(" / ")}）`
      : ""
    return { text: `已保存记忆 [${category}] ${content}${note}` }
  }

  if (name === "list_recent_memories") {
    const rows = await prisma.memory.findMany({
      where: { userId, status: "active" },
      orderBy: { updatedAt: "desc" },
      take: limit,
    })
    if (rows.length === 0) return { text: "记忆库目前为空。" }
    return {
      text: rows
        .map((r) => `[${r.category}] ${r.content} (更新于 ${r.updatedAt.toISOString().slice(0, 10)})`)
        .join("\n"),
    }
  }

  throw new Error(`未知工具: ${name}`)
}

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
}

/** 无状态服务器不提供 SSE 流(GET 按 MCP 规范返回 405) */
export async function GET() {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "SSE stream not supported (stateless server)" },
      id: null,
    }),
    { status: 405, headers: { "content-type": "application/json" } }
  )
}

export async function POST(req: NextRequest) {
  const userId = await resolveGatewayUserId(req)
  if (!userId) {
    return gatewayJsonError(401, "authentication_error", "invalid x-api-key")
  }

  let msg: {
    jsonrpc?: string
    id?: unknown
    method?: unknown
    params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown }
  } | null = null
  try {
    msg = await req.json()
  } catch {
    return new Response(null, { status: 400 })
  }
  if (!msg || typeof msg.method !== "string") {
    return new Response(null, { status: 400 })
  }

  const { id, method } = msg
  // 通知类(无 id 或 notifications/*):无需响应,202 空体
  if (id === undefined || id === null || method.startsWith("notifications/")) {
    return new Response(null, { status: 202 })
  }

  const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result })
  const rpcError = (code: number, message: string) =>
    Response.json({ jsonrpc: "2.0", id, error: { code, message } })

  if (method === "initialize") {
    const requested = msg.params?.protocolVersion
    return reply({
      protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    })
  }
  if (method === "ping") return reply({})
  if (method === "tools/list") return reply({ tools: TOOLS })
  if (method === "tools/call") {
    const name = typeof msg.params?.name === "string" ? msg.params.name : ""
    const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
    try {
      const r = await callTool(userId, name, args)
      return reply(toolResult(r.text))
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      return reply(toolResult(`工具执行失败: ${text}`, true))
    }
  }
  return rpcError(-32601, `Method not found: ${method}`)
}
