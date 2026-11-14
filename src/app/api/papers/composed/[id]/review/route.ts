/**
 * 卷面审卷诊断(GET /api/papers/composed/[id]/review):
 * 确定性查库现算——考点覆盖 vs 本学科高频考频、错题本薄弱考点命中。无模型成本。
 * 诊断条(ComposedAssistant)与助手 read_diagnosis 工具共用同一份 computeReview。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { computeReview } from "@/lib/papers/compose"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Ctx) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params
  const review = await computeReview(userId, id)
  if (!review) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json(review)
}
