/**
 * 在线做题考试场(按卷开考):
 * - POST /api/papers/[slug]/attempts  开考/续考:同卷单场——已有 ongoing 直接返回(续考),
 *   否则新建。返回进行中载荷(题目剥答案,防泄漏)。
 * - GET  /api/papers/[slug]/attempts  卷详情页入口状态:{ ongoing, last }。
 *   last 带最近一次已交卷的估分概要(入口卡「查看估分报告」用)。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { libraryScopes } from "@/lib/library-scope"
import { prisma } from "@/lib/db"
import { loadAttemptQuestions, loadAttemptRun, readAnswers, type AttemptResult } from "@/lib/papers/attempt"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { slug } = await params
  const paper = await prisma.paper.findFirst({
    where: { slug, userId: { in: await libraryScopes(userId) } },
    select: { id: true },
  })
  if (!paper) return Response.json({ error: "paper_not_found" }, { status: 404 })

  const existing = await prisma.paperAttempt.findFirst({
    where: { paperId: paper.id, userId, status: "ongoing" },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  })
  const attemptId =
    existing?.id ??
    (
      await prisma.paperAttempt.create({
        data: { userId, paperId: paper.id },
        select: { id: true },
      })
    ).id

  const payload = await loadAttemptRun(userId, attemptId)
  if (!payload) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json({ ...payload, resumed: !!existing })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { slug } = await params
  const paper = await prisma.paper.findFirst({
    where: { slug, userId: { in: await libraryScopes(userId) } },
    select: { id: true },
  })
  if (!paper) return Response.json({ error: "paper_not_found" }, { status: 404 })

  const [ongoing, last] = await Promise.all([
    prisma.paperAttempt.findFirst({
      where: { paperId: paper.id, userId, status: "ongoing" },
      orderBy: { startedAt: "desc" },
      select: { id: true, startedAt: true, answers: true, paper: { select: { durationMin: true } } },
    }),
    prisma.paperAttempt.findFirst({
      where: { paperId: paper.id, userId, status: "submitted" },
      orderBy: { submittedAt: "desc" },
      select: { id: true, submittedAt: true, createdAt: true, result: true },
    }),
  ])

  let lastSummary: { id: string; submittedAt: string; score: number; fullScore: number } | null = null
  if (last) {
    const result = last.result as AttemptResult | null
    lastSummary = {
      id: last.id,
      submittedAt: (last.submittedAt ?? last.createdAt).toISOString(),
      score: (result?.objectiveScore ?? 0) + (result?.selfScore ?? 0),
      fullScore: result ? result.objectiveMax + result.subjectiveMax : 0,
    }
  }

  return Response.json({
    ongoing: ongoing
      ? {
          id: ongoing.id,
          startedAt: ongoing.startedAt.toISOString(),
          answered: Object.keys(readAnswers(ongoing.answers)).length,
          durationMin: ongoing.paper.durationMin,
        }
      : null,
    last: lastSummary,
  })
}
