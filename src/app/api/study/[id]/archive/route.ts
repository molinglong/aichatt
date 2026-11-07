/**
 * 学习会话的错题卡管理:
 * - POST   (重新)归档:幂等,走 archiveStudySession(移出后想恢复也走这里,会建新卡)
 * - DELETE 移出错题本:删除 sourceMessageId = study:{sessionId} 的错题卡(复习队列同步消失)
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { archiveStudySession } from "@/lib/study/archive-session"

export const dynamic = "force-dynamic"

const noteKey = (sessionId: string) => `study:${sessionId}`

async function getSessionOr404(req: NextRequest, id: string) {
  const userId = await getUserId(req)
  if (!userId) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) }
  const session = await prisma.studySession.findFirst({ where: { id, userId } })
  if (!session) return { error: Response.json({ error: "not_found" }, { status: 404 }) }
  return { session }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { session, error } = await getSessionOr404(req, id)
  if (error || !session) return error ?? Response.json({ error: "not_found" }, { status: 404 })

  const result = await archiveStudySession(userId, session.id)
  if (!result) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json({ ok: true, noteId: result.id, created: result.created })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { session, error } = await getSessionOr404(req, id)
  if (error || !session) return error ?? Response.json({ error: "not_found" }, { status: 404 })

  const deleted = await prisma.studyNote.deleteMany({
    where: { userId, sourceMessageId: noteKey(session.id) },
  })
  return Response.json({ ok: true, removed: deleted.count })
}
