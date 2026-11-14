/**
 * 撤销最近一次计划应用(POST /api/papers/composed/[id]/undo):
 * 按最近快照整卷还原(槽位/卷名/时长/总分),成功后删除该快照。无快照 = nothing to undo。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { undoLastPlan } from "@/lib/papers/compose"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params
  const r = await undoLastPlan(userId, id)
  if (!r.ok) return Response.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : 400 })
  return Response.json(r)
}
