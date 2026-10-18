import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import {
  activateMemory,
  markKeptBoth,
  supersedeMemories,
  MEMORY_STATUS_ACTIVE,
} from "@/lib/memory/store"

/**
 * POST /api/memories/resolve —— 用户对一组矛盾记忆的裁决
 *
 * body: { keepId: string, conflictIds: string[], mode: "supersede" | "keep-both" }
 *  - supersede：keepId 生效，conflictIds 全部标记为被它取代（不物理删，可再恢复）
 *  - keep-both：双方都保持生效，并把对端记进 conflictPeers —— 之后不再重复提示这组冲突
 *
 * 为什么要给用户这一层：本地判定只认槽位/常识互斥，判不出"其实是两回事"的表述
 * （例："杭州人"与"现居上海"本可共存）。误判不能靠删数据解决，只能让用户改判。
 */
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }
  const userId = session.user.id

  const body = await req.json().catch(() => ({}))
  const keepId = typeof body.keepId === "string" ? body.keepId : ""
  const rawIds: unknown[] = Array.isArray(body.conflictIds) ? body.conflictIds : []
  const conflictIds: string[] = rawIds.filter((id): id is string => typeof id === "string")
  const mode = body.mode === "keep-both" ? "keep-both" : "supersede"

  if (!keepId && mode === "supersede") {
    return NextResponse.json({ error: "缺少 keepId" }, { status: 400 })
  }
  if (mode === "supersede" && conflictIds.length === 0) {
    return NextResponse.json({ error: "没有要取代的条目" }, { status: 400 })
  }

  // 归属校验：一次把涉及的 id 全查出来，任一不属于本账号就整笔拒绝
  const involvedIds: string[] = []
  ;[keepId].concat(conflictIds).forEach((id) => {
    if (id && involvedIds.indexOf(id) === -1) involvedIds.push(id)
  })
  const owned = await prisma.memory.findMany({
    where: { userId, id: { in: involvedIds } },
    select: { id: true },
  })
  if (owned.length !== involvedIds.length) {
    return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
  }

  if (mode === "keep-both") {
    const touched = await markKeptBoth(userId, involvedIds)
    return NextResponse.json({ mode, resolved: touched })
  }

  await activateMemory(userId, keepId)
  const superseded = await supersedeMemories(
    conflictIds.filter((id) => id !== keepId),
    keepId
  )
  return NextResponse.json({ mode, keepId, superseded, status: MEMORY_STATUS_ACTIVE })
}
