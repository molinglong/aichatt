import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { estimateMessagesTokens } from "@/lib/context-compression"
import { ephemeralScope } from "@/lib/ephemeral"

/**
 * GET /api/conversations/[id]/context - 上下文用量面板数据
 *
 * 返回与 context-compression 同口径的 token 估算值 + assistant 真实 usage 合计,
 * 前端配合模型 contextWindow 计算占用百分比。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const { id } = params

  // Verify the conversation belongs to the user (with ephemeral scope)
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id, ...ephemeralScope(session) },
    select: { id: true },
  })
  if (!conversation) {
    return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: id, archived: false, role: { in: ["user", "assistant"] } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      content: true,
      promptTokens: true,
      completionTokens: true,
      cacheReadTokens: true,
    },
  })

  const lastSummary = await prisma.conversationSummary.findFirst({
    where: { conversationId: id },
    orderBy: { createdAt: "desc" },
    select: { rangeEnd: true, coveredMessages: true, createdAt: true, content: true },
  })
  // 已被最新摘要覆盖(rangeEnd 含之前)的消息不再计入占用 —— 这些内容的上下文
  // 由注入的摘要替代,压缩后仪表占用才会真实下降。rangeEnd 找不到时保守全量估算。
  let coveredCount = 0
  if (lastSummary?.rangeEnd) {
    const idx = messages.findIndex((m) => m.id === lastSummary.rangeEnd)
    if (idx !== -1) coveredCount = idx + 1
  }
  const activeMessages = messages.slice(coveredCount)

  // 与压缩触发判断同口径的粗估(中文×1.6 / 英文按词×1.3)
  const estimatedTokens = estimateMessagesTokens(
    activeMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
  )
  const compressedTokens = estimateMessagesTokens(
    messages.slice(0, coveredCount).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
  )
  // assistant 消息落库的真实 usage 合计(仅部分模型/轮次有值,作为参考下限)
  const realTokens = messages.reduce(
    (sum, m) => sum + (m.promptTokens ?? 0) + (m.completionTokens ?? 0),
    0
  )

  // 本会话 prompt caching 统计(与 设置·用量页 同口径): 只统计上游报了缓存明细的
  // 轮次(cacheReadTokens 非空;0=报了但未命中,null=上游没报明细),命中量是
  // promptTokens 的子集,逐轮 clamp 防御异常报数。rounds=0 → 前端显示「未统计」。
  let cacheHitTokens = 0
  let cachePromptTokens = 0
  let cacheRounds = 0
  let cacheHitRounds = 0
  for (const m of messages) {
    if (m.cacheReadTokens == null) continue
    cacheRounds++
    const prompt = m.promptTokens ?? 0
    cachePromptTokens += prompt
    cacheHitTokens += Math.min(m.cacheReadTokens, prompt)
    if (m.cacheReadTokens > 0) cacheHitRounds++
  }


  return NextResponse.json({
    estimatedTokens,
    compressedTokens,
    realTokens,
    messageCount: messages.length,
    coveredMessages: coveredCount,
    cache: {
      hitTokens: cacheHitTokens,
      promptTokens: cachePromptTokens,
      rounds: cacheRounds,
      hitRounds: cacheHitRounds,
    },
    lastSummary: lastSummary
      ? {
          coveredMessages: lastSummary.coveredMessages,
          createdAt: lastSummary.createdAt,
          preview: lastSummary.content.slice(0, 200),
        }
      : null,
  })
}
