/**
 * 考试场单条路由:
 * - GET   /api/papers/attempts/[id]  进行中→作答载荷(剥答案);已交卷→报告载荷(含答案+判分快照)。
 * - PATCH /api/papers/attempts/[id]  存进度(仅 ongoing;answers 全量覆盖,服务端收敛键值与体量)。
 *   客户端防抖 800ms 调一次;断点续考靠它。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { loadAttemptReport, loadAttemptRun, readAnswers } from "@/lib/papers/attempt"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await params
  const run = await loadAttemptRun(userId, id)
  if (run && run.attempt.status === "ongoing") return Response.json(run)

  const report = await loadAttemptReport(userId, id)
  if (!report) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json(report)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await params
  const attempt = await prisma.paperAttempt.findFirst({
    where: { id, userId },
    select: { id: true, status: true },
  })
  if (!attempt) return Response.json({ error: "not_found" }, { status: 404 })
  if (attempt.status !== "ongoing") return Response.json({ error: "already_submitted" }, { status: 409 })

  let body: { answers?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }

  const answers = readAnswers(body.answers)
  await prisma.paperAttempt.update({ where: { id }, data: { answers } })
  return Response.json({ ok: true, saved: Object.keys(answers).length })
}

/** 放弃进行中的考试(入口卡「放弃」;已交卷不可删——报告与成绩记录保留) */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await params
  const deleted = await prisma.paperAttempt.deleteMany({ where: { id, userId, status: "ongoing" } })
  if (deleted.count === 0) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json({ ok: true })
}
