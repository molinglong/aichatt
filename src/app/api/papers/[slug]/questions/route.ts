/**
 * 试卷逐题索引路由:
 * - GET /api/papers/[slug]/questions  PaperQuestion 投影(题号/大题/分值/考点)
 * 学校考试记录卡的勾错题板用;不含题干/答案的轻查询。
 * 读路径:登录 + 归属(自己名下或公共库主人名下均可读)。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { libraryScopes } from "@/lib/library-scope"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const userId = await getUserId(_req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { slug } = await params
  const paper = await prisma.paper.findFirst({
    where: { slug, userId: { in: await libraryScopes(userId) } },
    select: { id: true, slug: true, title: true, subject: true, totalScore: true, questionCount: true },
  })
  if (!paper) return Response.json({ error: "not_found" }, { status: 404 })

  const questions = await prisma.paperQuestion.findMany({
    where: { paperId: paper.id, flagged: false },
    orderBy: { number: "asc" },
    select: { number: true, section: true, kind: true, score: true, topics: true },
  })

  return Response.json({ paper, questions })
}
