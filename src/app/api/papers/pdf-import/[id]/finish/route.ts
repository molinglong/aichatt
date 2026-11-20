/**
 * PDF 录题 · 完成并建卷(POST):
 * 未被跳过的候选整卷写 Paper+PaperQuestion(真题池),已入库且有答案的写 Question(练题池)。
 * 幂等:重复调用返回同一张卷。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { finishImport } from "@/lib/papers/pdf-import.server"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params
  try {
    const result = await finishImport(prisma, userId, id)
    return Response.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === "作业不存在") return Response.json({ error: "not_found" }, { status: 404 })
    if (msg.includes("没有可入库")) return Response.json({ error: "empty", detail: msg }, { status: 400 })
    console.error("[pdf-import] finish failed:", msg)
    return Response.json({ error: "finish_failed", detail: msg }, { status: 500 })
  }
}
