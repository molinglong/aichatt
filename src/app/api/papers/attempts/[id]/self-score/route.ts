/**
 * 主观题自评(人工仲裁):PATCH /api/papers/attempts/[id]/self-score
 * body: { selfScores: { "33": 7, "34": 5 } } → 用存档作答重跑判分(回填 selfScores),
 * 重算总分区间,并同步自动生成的学校考试记录 score。仅已交卷的 attempt 可改。
 */
import { NextRequest } from "next/server"
import type { Prisma } from "@/generated/prisma/client"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { gradeAttempt, loadAttemptReport, readAnswers, type AttemptResult } from "@/lib/papers/attempt"

export const dynamic = "force-dynamic"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await params
  const attempt = await prisma.paperAttempt.findFirst({
    where: { id, userId },
    select: { id: true, status: true, paperId: true, answers: true, result: true },
  })
  if (!attempt) return Response.json({ error: "not_found" }, { status: 404 })
  if (attempt.status !== "submitted") return Response.json({ error: "not_submitted" }, { status: 409 })

  let body: { selfScores?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }
  if (!body.selfScores || typeof body.selfScores !== "object" || Array.isArray(body.selfScores)) {
    return Response.json({ error: "bad_self_scores" }, { status: 400 })
  }
  const raw = body.selfScores as Record<string, unknown>
  const selfScores: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!/^\d{1,3}$/.test(k)) continue
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) selfScores[k] = Math.round(v)
  }

  const prev = attempt.result as AttemptResult | null
  const questions = await prisma.paperQuestion.findMany({
    where: { paperId: attempt.paperId, flagged: false },
    orderBy: { number: "asc" },
    select: {
      id: true,
      number: true,
      section: true,
      kind: true,
      multiple: true,
      score: true,
      stem: true,
      options: true,
      images: true,
      topics: true,
      answer: true,
    },
  })

  const result = gradeAttempt(questions, readAnswers(attempt.answers), selfScores)
  if (prev?.autoRecordId) result.autoRecordId = prev.autoRecordId

  await prisma.paperAttempt.update({ where: { id }, data: { result: result as unknown as Prisma.InputJsonValue } })

  // 同步学校考试记录分数(总分=客观已判+自评)
  if (result.autoRecordId) {
    const paper = await prisma.paper.findUnique({
      where: { id: attempt.paperId },
      select: { totalScore: true },
    })
    await prisma.examRecord.updateMany({
      where: { id: result.autoRecordId, userId },
      data: {
        score: result.objectiveScore + result.selfScore,
        ...(paper ? { fullScore: paper.totalScore } : {}),
        wrongNumbers: result.wrongNumbers,
      },
    })
  }

  const report = await loadAttemptReport(userId, id)
  if (!report) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json(report)
}
