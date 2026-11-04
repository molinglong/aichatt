import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

/**
 * DELETE /api/yellow-fish/favorites/[id] - 取消商品收藏(仅本人记录,非本人视为不存在)。
 * id 是 FavoriteItem 记录主键。与消息收藏删除完全独立,不动 Favorite 表。
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
    const result = await prisma.favoriteItem.deleteMany({
      where: { id: params.id, userId },
    })
    if (result.count === 0) {
      return NextResponse.json({ error: "收藏不存在或已被删除" }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[yellow-fish/favorites] delete failed:", err)
    return NextResponse.json({ error: "取消收藏失败" }, { status: 500 })
  }
}
