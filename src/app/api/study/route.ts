/**
 * 学习会话集合路由:
 * - POST /api/study          创建学习会话(题目/题图/起点/模型)
 * - GET  /api/study          会话列表(学习台左栏;withMeta=1 时附带到期卡数与薄弱考点)
 * 学习会话与聊天会话彻底分家(Conversation.studyMode 已弃用,列表侧由 GET /api/conversations 过滤)。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { isStudyStartLevel } from "@/lib/study/prompts"

export const dynamic = "force-dynamic"

/** 创建学习会话 */
export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { question?: unknown; images?: unknown; notes?: unknown; startLevel?: unknown; modelId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 })
  }

  const question = typeof body.question === "string" ? body.question.trim() : ""
  if (!question) return Response.json({ error: "question_required" }, { status: 400 })
  if (question.length > 20000) return Response.json({ error: "question_too_long" }, { status: 400 })

  const images = Array.isArray(body.images)
    ? body.images.filter((u): u is string => typeof u === "string" && u.startsWith("/")).slice(0, 6)
    : []

  const startLevel = isStudyStartLevel(body.startLevel) ? body.startLevel : "beginner"
  const modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : null
  if (!modelId) return Response.json({ error: "model_required" }, { status: 400 })
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 5000) : null

  const session = await prisma.studySession.create({
    data: { userId, question, images, startLevel, modelId, notes },
  })

  return Response.json({ session }, { status: 201 })
}

/** 会话列表(学习台左栏);withMeta=1 附带学习台首屏的到期卡数与薄弱考点 */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100)
  const offset = Number(url.searchParams.get("offset")) || 0
  const withMeta = url.searchParams.get("withMeta") === "1"

  const [items, total] = await Promise.all([
    prisma.studySession.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
      include: { steps: { orderBy: { idx: "desc" }, take: 1, select: { idx: true, content: true, streaming: true } } },
    }),
    prisma.studySession.count({ where: { userId } }),
  ])

  let meta: { dueCount: number; weak: Array<{ topic: string | null; title: string; mastery: number }> } | undefined
  if (withMeta) {
    const now = new Date()
    const [dueCount, weak] = await Promise.all([
      prisma.studyNote.count({ where: { userId, OR: [{ dueAt: { lte: now } }, { dueAt: null }] } }),
      prisma.studyNote.findMany({
        where: { userId, OR: [{ lapses: { gte: 1 } }, { mastery: { lt: 0.3 } }] },
        orderBy: { mastery: "asc" },
        take: 3,
        select: { topic: true, title: true, mastery: true },
      }),
    ])
    meta = {
      dueCount,
      weak: weak.map((n) => ({ topic: n.topic, title: n.title, mastery: n.mastery })),
    }
  }

  return Response.json({
    items: items.map((s) => ({
      id: s.id,
      question: s.question,
      startLevel: s.startLevel,
      status: s.status,
      summary: s.summary,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      stepCount: s.steps[0]?.idx != null ? s.steps[0].idx + 1 : 0,
      lastStepBrief: s.steps[0]?.content ? s.steps[0].content.slice(0, 60) : null,
      streaming: s.steps[0]?.streaming ?? false,
    })),
    total,
    hasMore: offset + items.length < total,
    ...(meta ? { meta } : {}),
  })
}
