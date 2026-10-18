import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { deleteMemory, restoreMemory } from "@/lib/memory/store"

interface Params {
  params: { id: string }
}

/**
 * PATCH /api/memories/[id]
 * 两种用法：
 *  1) body.content —— 编辑正文:非空、≤200 字,同时清掉 conflictPeers 裁决标记
 *     (内容变了,原先"都保留"的裁决就不再适用,冲突要重新提示);
 *  2) body.action = "restore" —— 把一条已被取代的记忆恢复生效,并反向取代原胜者。
 *
 * 注意:编辑**不做去重**。去重(含包含关系判定)是给"新增"防止重复入库用的,
 * 套到编辑上会误伤 —— 用户只是把说错的那条改一下,只要新文本恰好包含/被包含另一条
 * 记忆的原文就会被 409 拦死,而这条报错又常被提示通道吞掉,表现为"改不进去"。
 * 同一功能语义下的重复条目交给查看/清理,不靠编辑路径拦。
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const memory = await prisma.memory.findUnique({
    where: { id: params.id },
    select: { userId: true },
  })

  if (!memory || memory.userId !== session.user.id) {
    return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
  }

  const body = await req.json().catch(() => ({}))

  // 恢复被取代的条目
  if (body.action === "restore") {
    const result = await restoreMemory(session.user.id, params.id)
    if (!result.ok) {
      return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
    }
    const updated = await prisma.memory.findUnique({ where: { id: params.id } })
    return NextResponse.json(updated)
  }

  const content = (body.content ?? "").toString().trim()
  if (!content) {
    return NextResponse.json({ error: "内容不能为空" }, { status: 400 })
  }
  if (content.length > 200) {
    return NextResponse.json({ error: "内容过长（最多 200 字）" }, { status: 400 })
  }

  const updated = await prisma.memory.update({
    where: { id: params.id },
    // 正文变了 → 原先针对旧文本的「都保留」裁决作废，重新按新内容判冲突
    data: { content, conflictPeers: null },
  })
  return NextResponse.json(updated)
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const memory = await prisma.memory.findUnique({
    where: { id: params.id },
    select: { userId: true },
  })

  if (!memory || memory.userId !== session.user.id) {
    return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
  }

  // 删除走 store：会顺带把"被本条取代"的旧记忆恢复生效，不留孤儿
  const result = await deleteMemory(session.user.id, params.id)
  if (!result.ok) {
    return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
  }

  return NextResponse.json({ success: true, revived: result.revived })
}
