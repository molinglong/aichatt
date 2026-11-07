/**
 * 主对话(账号级学习管家)路由:
 * - GET  确保主对话存在(find-or-create,isMain=true + keeper 面具),返回会话元数据
 * - POST 写入一条 Ping 卡(去重窗口内同类型不重复;逻辑在 main-chat.server.ts)
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { createPing, ensureMainConversation, PING_TYPES, type PingType } from "@/lib/ai/main-chat.server"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const url = new URL(req.url)
  const modelId = url.searchParams.get("modelId") || undefined
  const session = await ensureMainConversation(userId, modelId)
  const latest = await prisma.message.findFirst({
    where: { conversationId: session.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  })
  return Response.json({ conversation: session, latest })
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { type?: unknown; payload?: unknown; modelId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 })
  }
  const type = typeof body.type === "string" && (PING_TYPES as readonly string[]).includes(body.type) ? (body.type as PingType) : null
  if (!type) return Response.json({ error: "invalid_type" }, { status: 400 })
  const payload = (body.payload && typeof body.payload === "object" ? body.payload : {}) as Record<string, unknown>
  const modelId = typeof body.modelId === "string" ? body.modelId : undefined

  const result = await createPing(userId, type, payload, modelId)
  return Response.json(result, { status: 201 })
}
