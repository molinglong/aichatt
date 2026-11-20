/**
 * 交卷判分:POST /api/papers/attempts/[id]/submit
 * - 取当前作答 → 服务端判分(客观/填空;主观 pending)→ 写 result 快照 + status/durationSec;
 * - 自动生成学校考试记录(ExamRecord 类型=模拟,name=卷名·在线做题,wrongNumbers=判错题号),
 *   recordId 回写进 result.autoRecordId(自评分变更时同步 record.score);
 * - 幂等:已交卷直接返回报告载荷。
 */
import { NextRequest } from "next/server"
import type { Prisma } from "@/generated/prisma/client"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import {
  attemptDate,
  gradeAttempt,
  loadAttemptReport,
  readAnswers,
  type AttemptResult,
} from "@/lib/papers/attempt"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await params
  const attempt = await prisma.paperAttempt.findFirst({
    where: { id, userId },
    select: { id: true, status: true, startedAt: true, paperId: true, answers: true },
  })
  if (!attempt) return Response.json({ error: "not_found" }, { status: 404 })

  if (attempt.status === "submitted") {
    const report = await loadAttemptReport(userId, id)
    if (!report) return Response.json({ error: "not_found" }, { status: 404 })
    return Response.json(report)
  }

  const paper = await prisma.paper.findUnique({
    where: { id: attempt.paperId },
    select: { title: true, totalScore: true, durationMin: true },
  })
  if (!paper) return Response.json({ error: "paper_not_found" }, { status: 404 })

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

  const answers = readAnswers(attempt.answers)
  const result = gradeAttempt(questions, answers)

  // 自动学校考试记录(类型=模拟;分数=客观已判+自评,后续自评同步)
  const record = await prisma.examRecord.create({
    data: {
      userId,
      paperId: attempt.paperId,
      examType: "模拟",
      examName: `${paper.title.slice(0, 60)} · 在线做题`.slice(0, 80),
      date: attemptDate(),
      score: result.objectiveScore + result.selfScore,
      fullScore: paper.totalScore,
      wrongNumbers: result.wrongNumbers,
    },
    select: { id: true },
  })
  const resultWithRecord: AttemptResult = { ...result, autoRecordId: record.id }

  const durationSec = Math.max(
    0,
    Math.min(Math.round((Date.now() - attempt.startedAt.getTime()) / 1000), paper.durationMin * 60 * 4)
  )

  await prisma.paperAttempt.update({
    where: { id },
    data: {
      status: "submitted",
      submittedAt: new Date(),
      durationSec,
      result: resultWithRecord as unknown as Prisma.InputJsonValue,
    },
  })

  const report = await loadAttemptReport(userId, id)
  if (!report) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json(report)
}
