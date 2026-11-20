import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { listAllScratchNotes } from "@/lib/memory/scratch"

/**
 * 短期记忆（临时便签）REST API —— 设置→记忆 页的管理出口。
 *
 * GET    全量列表（active/expired 服务端分好，前端分组展示）
 * DELETE 删除：?id= 删单条；?scope=expired 清掉全部已过期（不碰活跃条目）
 *
 * 写入口只有两个：write_scratch_memory 工具（AI 自动判记）与 upsert 覆盖语义；
 * 这里刻意不开 POST——设置页手动新增短期记忆没有场景，手动要记的走长期记忆。
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const notes = await listAllScratchNotes(session.user.id)
  const now = Date.now()
  const active = notes.filter((n) => n.expiresAt.getTime() > now)
  const expired = notes.filter((n) => n.expiresAt.getTime() <= now)

  return NextResponse.json({ active, expired })
}

export async function DELETE(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const id = searchParams.get("id")
  const scope = searchParams.get("scope")

  if (id) {
    // 只删自己名下的，防跨用户
    const deleted = await prisma.scratchNote.deleteMany({
      where: { id, userId: session.user.id },
    })
    if (deleted.count === 0) {
      return NextResponse.json({ error: "条目不存在" }, { status: 404 })
    }
    return NextResponse.json({ ok: true, deleted: 1 })
  }

  if (scope === "expired") {
    const deleted = await prisma.scratchNote.deleteMany({
      where: { userId: session.user.id, expiresAt: { lte: new Date() } },
    })
    return NextResponse.json({ ok: true, deleted: deleted.count })
  }

  return NextResponse.json({ error: "缺少 id 或 scope=expired 参数" }, { status: 400 })
}
