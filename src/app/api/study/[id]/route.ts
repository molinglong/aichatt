/**
 * 单个学习会话:
 * - GET    会话 + 全部 steps(讲义卡流数据源)。streaming 步超过 10 分钟仍未完成的
 *          (dev 重启等造成的孤儿草稿)在此定格,前端轮询自然收口。
 * - DELETE 删除会话(steps 级联)。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"

/** 孤儿草稿定格阈值:与 conversations/[id] 的兜底同口径 */
const STREAMING_STALE_MS = 10 * 60 * 1000

async function getSessionOr404(req: NextRequest, id: string) {
  const userId = await getUserId(req)
  if (!userId) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) }
  const session = await prisma.studySession.findFirst({ where: { id, userId } })
  if (!session) return { error: Response.json({ error: "not_found" }, { status: 404 }) }
  return { session }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { session, error } = await getSessionOr404(req, id)
  if (error) return error

  // 孤儿草稿定格:生成中但创建超过 10 分钟(草稿行创建于生成开始,无更新即孤儿)→ 定格
  const staleCutoff = new Date(Date.now() - STREAMING_STALE_MS)
  await prisma.studyStep.updateMany({
    where: { sessionId: session.id, streaming: true, createdAt: { lt: staleCutoff } },
    data: { streaming: false },
  })

  const steps = await prisma.studyStep.findMany({
    where: { sessionId: session.id },
    orderBy: { idx: "asc" },
  })

  // 错题卡归档状态(结课卡的「移出/恢复」按钮依据)
  const note = await prisma.studyNote.findFirst({
    where: { userId: session.userId, sourceMessageId: `study:${session.id}` },
    select: { id: true },
  })

  return Response.json({ session, steps, archivedNoteId: note?.id ?? null })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { session, error } = await getSessionOr404(req, id)
  if (error) return error
  // 生成中的会话不允许删(先停止/等完成),避免与在途写库赛跑
  const running = await prisma.studyStep.findFirst({ where: { sessionId: session.id, streaming: true } })
  if (running) return Response.json({ error: "generation_running" }, { status: 409 })
  await prisma.studySession.delete({ where: { id: session.id } })
  return Response.json({ ok: true })
}
