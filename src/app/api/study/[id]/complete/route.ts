/**
 * 手动结课(幂等兜底):模型没调 finish_study 时,用户点「本题讲完了」走这里。
 * - status → completed;summary 缺省取最后一步正文的前 200 字
 * - 归档错题本(archiveStudySession 幂等)
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { archiveStudySession } from "@/lib/study/archive-session"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const session = await prisma.studySession.findFirst({ where: { id, userId } })
  if (!session) return Response.json({ error: "not_found" }, { status: 404 })

  let summary: string | null = null
  try {
    const body = (await req.json()) as { summary?: unknown }
    if (typeof body?.summary === "string" && body.summary.trim()) summary = body.summary.trim().slice(0, 600)
  } catch {
    /* 无 body 也允许 */
  }

  if (session.status !== "completed") {
    if (!summary) {
      const last = await prisma.studyStep.findFirst({
        where: { sessionId: session.id, content: { not: "" } },
        orderBy: { idx: "desc" },
        select: { content: true },
      })
      summary = last?.content.replace(/\s+/g, " ").trim().slice(0, 200) || null
    }
    await prisma.studySession
      .update({ where: { id: session.id }, data: { status: "completed", summary } })
      .catch(() => {})
  }

  const archived = await archiveStudySession(userId, session.id)
  return Response.json({ ok: true, archived })
}
