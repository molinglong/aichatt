/**
 * 学校考试成绩记录(成绩台账 + 卷库联动,design/preview-exam-score-recorder.html 方案D):
 * - GET  /api/exam-records              本用户全部成绩(学习台区块/全部成绩弹层);
 *                                        ?paperId= 或 ?slug= 过滤单卷(试卷页历次成绩卡,附考点丢分)
 * - POST /api/exam-records              记一笔(必关联卷库卷;勾错题号数组校验为该卷真实题号)
 * 删除走 /api/exam-records/[id] DELETE。
 * date 存 'YYYY-MM-DD' 字符串,免 Prisma UTC 日期偏一天坑。
 * 卷子一律先入库再关联(定案):paper 归属按 libraryScopes 合并(公共库卷可记成绩),记录本身归 userId。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { libraryScopes } from "@/lib/library-scope"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"

const EXAM_TYPES = new Set(["月考", "期中", "期末", "周测", "模拟"])

export interface TopicLoss {
  topic: string
  count: number
  loss: number
}

/** 勾错题号 → 考点丢分统计(按丢分降序,每考点聚合次数与分值;一题多考点各计一次) */
function topicLossFrom(pq: Array<{ number: number; score: number; topics: string[] }>, wrong: number[]): TopicLoss[] {
  const wrongSet = new Set(wrong)
  const map = new Map<string, TopicLoss>()
  for (const q of pq) {
    if (!wrongSet.has(q.number)) continue
    for (const t of q.topics) {
      const e = map.get(t) ?? { topic: t, count: 0, loss: 0 }
      e.count += 1
      e.loss += q.score
      map.set(t, e)
    }
  }
  return Array.from(map.values()).sort((a, b) => b.loss - a.loss).slice(0, 8)
}

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const paperId = req.nextUrl.searchParams.get("paperId")
  const slug = req.nextUrl.searchParams.get("slug")

  // 单卷过滤(试卷页历次成绩卡):slug/paperId → 卷(公共库卷也可记成绩,读路径合并归属)
  let targetPaper: { id: string; slug: string } | null = null
  if (paperId || slug) {
    targetPaper = await prisma.paper.findFirst({
      where: { ...(paperId ? { id: paperId } : { slug: slug ?? "" }), userId: { in: await libraryScopes(userId) } },
      select: { id: true, slug: true },
    })
    if (!targetPaper) return Response.json({ error: "not_found" }, { status: 404 })
  }

  const records = await prisma.examRecord.findMany({
    where: { userId, ...(targetPaper ? { paperId: targetPaper.id } : {}) },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 300,
    include: {
      paper: { select: { id: true, slug: true, title: true, subject: true, examType: true, totalScore: true } },
    },
  })

  // 单卷视图附考点丢分(勾错题号 × PaperQuestion 分值/考点;一次查询)
  if (targetPaper && records.length > 0) {
    const wrongAll = Array.from(new Set(records.flatMap((r) => r.wrongNumbers)))
    const pq = wrongAll.length
      ? await prisma.paperQuestion.findMany({
          where: { paperId: targetPaper.id, number: { in: wrongAll }, flagged: false },
          select: { number: true, score: true, topics: true },
        })
      : []
    const perRecord = new Map(records.map((r) => [r.id, topicLossFrom(pq, r.wrongNumbers)]))
    return Response.json({ records: records.map((r) => ({ ...r, topicLoss: perRecord.get(r.id) ?? [] })) })
  }

  return Response.json({ records })
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: {
    paperId?: unknown
    examType?: unknown
    examName?: unknown
    date?: unknown
    score?: unknown
    fullScore?: unknown
    rank?: unknown
    wrongNumbers?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }

  const paperId = typeof body.paperId === "string" ? body.paperId : ""
  const paper = await prisma.paper.findFirst({
    where: { id: paperId, userId: { in: await libraryScopes(userId) } },
    select: { id: true, totalScore: true },
  })
  if (!paper) return Response.json({ error: "paper_not_found" }, { status: 422 })

  const examType = typeof body.examType === "string" ? body.examType : ""
  if (!EXAM_TYPES.has(examType)) return Response.json({ error: "bad_exam_type" }, { status: 422 })

  const examName = typeof body.examName === "string" && body.examName.trim() ? body.examName.trim().slice(0, 80) : ""
  if (!examName) return Response.json({ error: "bad_exam_name" }, { status: 422 })

  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : ""
  if (!date) return Response.json({ error: "bad_date" }, { status: 422 })

  const fullScore =
    typeof body.fullScore === "number" && Number.isFinite(body.fullScore) && body.fullScore > 0
      ? Math.round(body.fullScore)
      : paper.totalScore
  const score = typeof body.score === "number" && Number.isFinite(body.score) ? Math.round(body.score) : NaN
  if (Number.isNaN(score) || score < 0 || score > fullScore) return Response.json({ error: "bad_score" }, { status: 422 })

  const rank = typeof body.rank === "string" && body.rank.trim() ? body.rank.trim().slice(0, 60) : null

  // 勾错题号:去重 + 校验为该卷真实题号(防脏数据;≤120 条)
  const rawWrong = Array.isArray(body.wrongNumbers)
    ? body.wrongNumbers.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
    : []
  const wanted = Array.from(new Set(rawWrong)).slice(0, 120)
  let wrongNumbers: number[] = []
  if (wanted.length > 0) {
    const qs = await prisma.paperQuestion.findMany({
      where: { paperId: paper.id, number: { in: wanted }, flagged: false },
      select: { number: true },
    })
    const valid = new Set(qs.map((q) => q.number))
    wrongNumbers = wanted.filter((n) => valid.has(n))
  }

  const record = await prisma.examRecord.create({
    data: { userId, paperId: paper.id, examType, examName, date, score, fullScore, rank, wrongNumbers },
  })
  return Response.json({ record })
}
