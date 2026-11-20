import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { updateItem, removeItem, restoreItem } from "@/lib/plan/scheduler"

/**
 * 今日计划单条读写删 —— /api/plan/items/[id]。
 *
 * PATCH 更新字段(勾完成/改时间/顺延都走这里);
 * PATCH { restore: true, ...patch } 撤销软删(前端把删除前快照随 patch 传回);
 * DELETE 软删(dropped),列表不出现、撤销可原样放回。
 */

export const runtime = "nodejs"

type RouteContext = { params: { id: string } }

function unauthorized() {
  return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
}

const PATCHABLE = new Set([
  "title",
  "note",
  "kind",
  "status",
  "priority",
  "estimateMin",
  "energy",
  "plannedDate",
  "startMin",
  "endMin",
  "reason",
  "done",
  "postponeCount",
])

export async function PATCH(req: Request, { params }: RouteContext) {
  const userId = await getUserId(req)
  if (!userId) return unauthorized()

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "更新参数不合法" }, { status: 400 })
  }
  const input = body as Record<string, unknown>

  try {
    // 撤销删除:前端把 dropped 前的完整快照随 patch 传回来,原样放回
    if (input.restore === true) {
      const item = await restoreItem(params.id, input, userId)
      if (!item) return NextResponse.json({ error: "条目不存在" }, { status: 404 })
      return NextResponse.json(item)
    }

    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      if (PATCHABLE.has(key)) patch[key] = value
    }
    if (!Object.keys(patch).length) {
      return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 })
    }

    const item = await updateItem(params.id, patch, userId)
    if (!item) return NextResponse.json({ error: "条目不存在" }, { status: 404 })
    return NextResponse.json(item)
  } catch (err) {
    console.error("[plan/items.PATCH] failed:", err)
    return NextResponse.json({ error: "更新失败" }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: RouteContext) {
  const userId = await getUserId(req)
  if (!userId) return unauthorized()

  try {
    const ok = await removeItem(params.id, userId)
    if (!ok) return NextResponse.json({ error: "条目不存在" }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[plan/items.DELETE] failed:", err)
    return NextResponse.json({ error: "删除失败" }, { status: 500 })
  }
}
