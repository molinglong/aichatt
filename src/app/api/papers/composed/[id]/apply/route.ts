/**
 * 变更计划应用(POST /api/papers/composed/[id]/apply):
 * body.ops = propose_plan 产出的操作数组(经用户勾选/挑候选后回传)。
 * 服务端先落整卷快照再顺序执行,任一条失败不回滚(快照可整卷撤销);回执逐条返回。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { applyPlan, type PlanOp } from "@/lib/papers/compose"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params

  let body: { ops?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }
  if (!Array.isArray(body.ops)) return Response.json({ error: "need_ops" }, { status: 400 })
  // 服务端只认 PlanOp 字段,前端回传的多余字段(候选展示用)在这里剥掉
  const ops: PlanOp[] = body.ops
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({
      op: o.op as PlanOp["op"],
      slotNumber: typeof o.slotNumber === "number" ? o.slotNumber : undefined,
      paperQuestionId: typeof o.paperQuestionId === "string" ? o.paperQuestionId : undefined,
      afterNumber: typeof o.afterNumber === "number" ? o.afterNumber : undefined,
      title: typeof o.title === "string" ? o.title : undefined,
      score: typeof o.score === "number" ? o.score : undefined,
      toNumber: typeof o.toNumber === "number" ? o.toNumber : undefined,
      fromSection: typeof o.fromSection === "string" ? o.fromSection : undefined,
      toSection: typeof o.toSection === "string" ? o.toSection : undefined,
      durationMin: typeof o.durationMin === "number" ? o.durationMin : undefined,
    }))
    .filter((o) => !!o.op)

  const r = await applyPlan(userId, id, ops)
  if (!r.ok) return Response.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : 400 })
  return Response.json(r)
}
