import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { runItemGet } from "@/lib/ai/yellow-fish-item.server"

/**
 * POST /api/yellow-fish/favorites/check  { itemId }
 *
 * 检测一件收藏商品的现状(在售/已下架)+现价,更新收藏行的 status/statusText/checkedPrice/checkedAt。
 * 每次只查一件(收藏池「查现价」按钮与打开池时的渐进体检都走这里);不做批量——
 * 批量轮询=风控暴露,违反限频纪律。unknown 不改 status 语义之外的任何字段,仅更新 checkedAt。
 */
export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  let body: { itemId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "请求体不是合法的 JSON" }, { status: 400 })
  }

  const itemId = (body.itemId ?? "").trim()
  if (!/^\d{5,20}$/.test(itemId)) {
    return NextResponse.json({ error: "缺少合法的商品 id" }, { status: 400 })
  }

  const row = await prisma.favoriteItem.findUnique({
    where: { userId_itemId: { userId, itemId } },
  })
  if (!row) {
    return NextResponse.json({ error: "该商品不在你的收藏里" }, { status: 404 })
  }

  const result = await runItemGet(itemId)

  const updated = await prisma.favoriteItem.update({
    where: { id: row.id },
    data: {
      checkedAt: new Date(),
      ...(result.kind === 'onSale'
        ? { status: 'onSale', statusText: result.statusText, checkedPrice: result.price }
        : result.kind === 'off'
          ? { status: 'off', statusText: result.statusText }
          : { status: 'unknown', statusText: result.error.slice(0, 160) }),
    },
  })

  return NextResponse.json(updated)
}
