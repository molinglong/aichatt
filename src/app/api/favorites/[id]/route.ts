import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

/**
 * DELETE /api/favorites/[id] - 取消收藏(仅本人记录,非本人视为不存在)。
 * 与错题本删除完全独立:不动 StudyNote / 复习流水。
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  try {
    const result = await prisma.favorite.deleteMany({
      where: { id: params.id, userId },
    })
    if (result.count === 0) {
      return NextResponse.json({ error: "收藏不存在或已被删除" }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[favorites] delete failed:", err)
    return NextResponse.json({ error: "取消收藏失败" }, { status: 500 })
  }
}
