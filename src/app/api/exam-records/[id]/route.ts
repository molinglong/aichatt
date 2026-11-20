/**
 * 单条成绩记录路由:
 * - DELETE /api/exam-records/[id]  删除一笔成绩(全部成绩弹层用;只删自己的)
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await params
  const deleted = await prisma.examRecord.deleteMany({ where: { id, userId } })
  if (deleted.count === 0) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json({ ok: true })
}
