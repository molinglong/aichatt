import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

/**
 * GET /api/yellow-fish/favorites
 *
 * 商品收藏列表(在售商品快照),按收藏时间倒序。与消息收藏 Favorite 是两张表、两个入口。
 * - count=1: 只返回条数(避免拉全量)
 *
 * 鉴权:cookie session 或 Bearer(与消息收藏同口径)。
 */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const countOnly = req.nextUrl.searchParams.get("count") === "1"

  try {
    if (countOnly) {
      const count = await prisma.favoriteItem.count({ where: { userId } })
      return NextResponse.json({ count })
    }

    const rows = await prisma.favoriteItem.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 300,
    })
    return NextResponse.json(rows)
  } catch (err) {
    console.error("[yellow-fish/favorites] list failed:", err)
    return NextResponse.json({ error: "获取商品收藏列表失败" }, { status: 500 })
  }
}

/**
 * DELETE /api/yellow-fish/favorites?offOnly=1
 *
 * 一键清掉全部「已下架/删除」(status='off')的收藏,只动本地快照,不触发任何
 * goofish 请求。必须带 offOnly=1 才执行(防误清整池);单件删除走 /[id] 路由。
 */
export async function DELETE(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  if (req.nextUrl.searchParams.get("offOnly") !== "1") {
    return NextResponse.json({ error: "缺少 offOnly=1，不支持整池清空" }, { status: 400 })
  }

  try {
    const res = await prisma.favoriteItem.deleteMany({ where: { userId, status: "off" } })
    return NextResponse.json({ deleted: res.count })
  } catch (err) {
    console.error("[yellow-fish/favorites] clear off failed:", err)
    return NextResponse.json({ error: "清理下架收藏失败" }, { status: 500 })
  }
}

/**
 * POST /api/yellow-fish/favorites
 *
 * 收藏一件在售商品。入参来自实时价卡片的 listing,服务端按 (userId,itemId) 幂等:
 * 已收藏则原样返回(不刷新价格快照,保留首次收藏价)。
 * itemId 必须是数字串(goofish 商品 id);url 必填;price 仅当有限正数时落库。
 */
export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  let body: {
    itemId?: string
    title?: string
    price?: number | null
    priceDisplay?: string
    url?: string
    pic?: string
    location?: string
    seller?: string
    keyword?: string
    note?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "请求体不是合法的 JSON" }, { status: 400 })
  }

  const itemId = (body.itemId ?? "").trim()
  const url = (body.url ?? "").trim()
  const title = (body.title ?? "").trim()

  if (!/^\d{5,20}$/.test(itemId)) {
    return NextResponse.json({ error: "缺少合法的商品 id" }, { status: 400 })
  }
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "缺少合法的商品链接" }, { status: 400 })
  }

  const price =
    typeof body.price === "number" && Number.isFinite(body.price) && body.price > 0
      ? body.price
      : null

  try {
    const existing = await prisma.favoriteItem.findUnique({
      where: { userId_itemId: { userId, itemId } },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json({ id: existing.id, created: false })
    }

    const row = await prisma.favoriteItem.create({
      data: {
        userId,
        itemId,
        title: title.slice(0, 200) || "闲鱼商品",
        price,
        priceDisplay: (body.priceDisplay ?? "").trim().slice(0, 40) || null,
        url: url.slice(0, 2000),
        pic: (body.pic ?? "").trim().startsWith("http") ? (body.pic as string).slice(0, 2000) : null,
        location: (body.location ?? "").trim().slice(0, 40) || null,
        seller: (body.seller ?? "").trim().slice(0, 60) || null,
        keyword: (body.keyword ?? "").trim().slice(0, 60) || null,
        note: (body.note ?? "").trim().slice(0, 500) || null,
      },
      select: { id: true },
    })
    return NextResponse.json({ id: row.id, created: true }, { status: 201 })
  } catch (err) {
    // 并发重复收藏:唯一约束兜底,回读已有记录
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      const existing = await prisma.favoriteItem.findUnique({
        where: { userId_itemId: { userId, itemId } },
        select: { id: true },
      })
      if (existing) return NextResponse.json({ id: existing.id, created: false })
    }
    console.error("[yellow-fish/favorites] create failed:", err)
    return NextResponse.json({ error: "收藏失败，请稍后再试" }, { status: 500 })
  }
}
