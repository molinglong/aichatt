/**
 * 重组卷加题候选：
 * - GET /api/papers/composed/[id]/candidates?kind=&score=&section=&q=
 *   桶模式(kind 必传):同 section+kind+score 优先,不足退 兜底桶(kind+score);
 *   搜索模式(q 必传):题干/选项关键词,全池范围。二者必居其一。
 * 只返回池内题(有官方答案/未拉黑/自检过),排除本卷已用,截 20 条。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { listCandidates } from "@/lib/papers/compose"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Ctx) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params

  const sp = req.nextUrl.searchParams
  const kind = sp.get("kind") ?? undefined
  const section = sp.get("section") ?? undefined
  const scoreRaw = sp.get("score")
  const q = sp.get("q") ?? undefined
  if (!kind && !q) return Response.json({ error: "need_kind_or_q" }, { status: 400 })

  const candidates = await listCandidates(userId, id, {
    section,
    kind,
    score: scoreRaw != null && scoreRaw !== "" ? Number(scoreRaw) : undefined,
    q,
  })
  if (!candidates) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json({ candidates })
}
