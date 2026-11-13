/**
 * 组卷模板结构(GET /api/papers/composed/base-structures?subject=):
 * 库内真题卷的大题结构快照(按 section/kind/score 聚合),供组卷表单「模板」选择——
 * 套用 = 把结构填进大纲槽位行,仍是真题池填充、零拟题。
 * 只返回题量 ≥3 的卷;结构组按首题号排序。
 */
import { NextRequest } from "next/server"
import { Prisma } from "@/generated/prisma/client"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const subject = req.nextUrl.searchParams.get("subject") ?? ""

  const rows = await prisma.$queryRaw<
    Array<{
      slug: string
      title: string
      examType: string | null
      year: string | null
      section: string | null
      kind: string
      score: number
      n: number
      first_no: number
    }>
  >(Prisma.sql`
    SELECT p.slug, p.title, p."examType", p.year,
           pq.section, pq.kind, pq.score,
           count(*)::int AS n, min(pq.number)::int AS first_no
    FROM "PaperQuestion" pq
    JOIN "Paper" p ON p.id = pq."paperId"
    WHERE p."userId" = ${userId} AND p.subject = ${subject}
    GROUP BY p.id, p.slug, p.title, p."examType", p.year, pq.section, pq.kind, pq.score
    ORDER BY p.slug, first_no
  `)

  // 按卷聚合;题量 <3 的卷不作为模板
  const bySlug = new Map<
    string,
    {
      slug: string
      title: string
      examType: string | null
      year: string | null
      questionCount: number
      groups: Array<{ section: string | null; kind: string; score: number; count: number }>
    }
  >()
  for (const r of rows) {
    let t = bySlug.get(r.slug)
    if (!t) {
      t = { slug: r.slug, title: r.title, examType: r.examType, year: r.year, questionCount: 0, groups: [] }
      bySlug.set(r.slug, t)
    }
    t.groups.push({ section: r.section, kind: r.kind, score: r.score, count: r.n })
    t.questionCount += r.n
  }
  const templates = Array.from(bySlug.values())
    .filter((t) => t.questionCount >= 3 && t.groups.length <= 12)
    .map((t) => ({
      slug: t.slug,
      title: t.title,
      examType: t.examType,
      year: t.year,
      questionCount: t.questionCount,
      groups: t.groups,
    }))

  return Response.json({ templates })
}
