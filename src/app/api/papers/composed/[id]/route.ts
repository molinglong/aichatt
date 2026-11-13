/**
 * 重组卷详情/槽位操作：
 * - GET    /api/papers/composed/[id]   全量（槽位 join 题干/选项/官方答案 + 来源卷）
 * - PATCH  /api/papers/composed/[id]   槽位操作 {op: replace|remove|insert|flag|reshuffle|retitle}
 * - DELETE /api/papers/composed/[id]   删除重组卷
 * 鉴权:登录 + composedPaper.userId 归属校验（引擎内按 userId 过滤）。
 * 每次槽位写操作后返回最新全量 paper,前端直接替换状态免二次 GET。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import {
  getComposedPaper,
  replaceSlot,
  removeSlot,
  insertSlot,
  flagSlot,
  reshufflePaper,
  retitlePaper,
  retitleSection,
  updateSlotScore,
  moveSlot,
  updateDuration,
  setAllowAi,
  reorderSlots,
} from "@/lib/papers/compose"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** 引擎失败码 → HTTP 状态 */
const statusFor = (reason: string) =>
  reason === "not_found" || reason === "slot_not_found" || reason === "section_not_found"
    ? 404
    : reason === "no_candidate" || reason === "not_in_pool" || reason === "no_pool"
      ? 422
      : reason === "empty_title" ||
          reason === "bad_score" ||
          reason === "bad_duration" ||
          reason === "bad_section" ||
          reason === "bad_order"
        ? 400
        : 500

export async function GET(req: NextRequest, { params }: Ctx) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params
  const paper = await getComposedPaper(userId, id)
  if (!paper) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json(paper)
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params

  let body: {
    op?: string
    slotId?: string
    paperQuestionId?: string
    afterSlotId?: string
    title?: string
    score?: number
    toNumber?: number
    fromSection?: string
    toSection?: string
    durationMin?: number
    allow?: boolean
    orderedSlotIds?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }

  const op = body.op ?? ""
  const slotId = body.slotId ?? ""
  let result: { ok: boolean; reason?: string }
  switch (op) {
    case "replace":
      result = await replaceSlot(userId, id, slotId)
      break
    case "remove":
      result = await removeSlot(userId, id, slotId)
      break
    case "insert":
      if (!body.paperQuestionId) return Response.json({ error: "need_paperQuestionId" }, { status: 400 })
      // afterSlotId = 中途加题(插到该槽正后方);不传 = 大题组末尾(原有语义)
      result = await insertSlot(userId, id, body.paperQuestionId, typeof body.afterSlotId === "string" ? body.afterSlotId : undefined)
      break
    case "flag":
      result = await flagSlot(userId, id, slotId)
      break
    case "reshuffle":
      result = await reshufflePaper(userId, id)
      break
    case "retitle":
      result = await retitlePaper(userId, id, body.title ?? "")
      break
    case "reorder":
      if (!Array.isArray(body.orderedSlotIds) || body.orderedSlotIds.some((x) => typeof x !== "string")) {
        return Response.json({ error: "need_orderedSlotIds" }, { status: 400 })
      }
      result = await reorderSlots(userId, id, body.orderedSlotIds as string[])
      break
    case "rescore": {
      const score = body.score
      if (!body.slotId || typeof score !== "number") return Response.json({ error: "need_slotId_and_score" }, { status: 400 })
      result = await updateSlotScore(userId, id, body.slotId, score)
      break
    }
    case "move": {
      const toNumber = body.toNumber
      if (!body.slotId || typeof toNumber !== "number") return Response.json({ error: "need_slotId_and_toNumber" }, { status: 400 })
      result = await moveSlot(userId, id, body.slotId, toNumber)
      break
    }
    case "resection":
      if (typeof body.fromSection !== "string" || typeof body.toSection !== "string")
        return Response.json({ error: "need_sections" }, { status: 400 })
      result = await retitleSection(userId, id, body.fromSection, body.toSection)
      break
    case "reduration": {
      const durationMin = body.durationMin
      if (typeof durationMin !== "number") return Response.json({ error: "need_durationMin" }, { status: 400 })
      result = await updateDuration(userId, id, durationMin)
      break
    }
    case "set-allow-ai":
      if (typeof body.allow !== "boolean") return Response.json({ error: "need_allow" }, { status: 400 })
      result = await setAllowAi(userId, id, body.allow)
      break
    default:
      return Response.json({ error: "bad_op" }, { status: 400 })
  }

  if (!result.ok) {
    return Response.json({ error: result.reason ?? "op_failed" }, { status: statusFor(result.reason ?? "") })
  }
  const paper = await getComposedPaper(userId, id)
  return Response.json({ ok: true, paper })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params
  const row = await prisma.composedPaper.findFirst({ where: { id, userId }, select: { id: true } })
  if (!row) return Response.json({ error: "not_found" }, { status: 404 })
  await prisma.composedPaper.delete({ where: { id } })
  return Response.json({ ok: true })
}
