/**
 * 试卷库列表路由:
 * - GET /api/papers  可读卷库列表(学校考试记录卡的关联卷选择器用)
 * 读路径口径见 library-scope.ts:管理员名下卷为全站公共资产,合并归属只读。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { libraryScopes } from "@/lib/library-scope"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const rows = await prisma.paper.findMany({
    where: { userId: { in: await libraryScopes(userId) } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      title: true,
      subject: true,
      examType: true,
      year: true,
      totalScore: true,
      questionCount: true,
    },
  })
  return Response.json({ papers: rows })
}
