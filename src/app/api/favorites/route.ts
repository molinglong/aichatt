import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { sanitizeStoredContent } from "@/lib/conversation-message-format"
import {
  favoriteTitle,
  firstImageUrl,
  parseFavoriteAttachments,
} from "@/lib/favorites"

/**
 * GET /api/favorites
 *
 * 收藏列表(消息快照),按创建时间倒序。
 * - q: 关键字(标题/正文,不区分大小写)
 * - role: user | assistant
 * - count=1: 只返回条数(学习抽屉的状态条用,避免为计数拉全量正文)
 *
 * 鉴权:cookie session 或 Bearer(浏览器扩展)。
 */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const q = sp.get("q")?.trim()
  const role = sp.get("role")
  const countOnly = sp.get("count") === "1"

  const where: Record<string, unknown> = { userId }
  if (role === "user" || role === "assistant") where.role = role
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { content: { contains: q, mode: "insensitive" } },
    ]
  }

  try {
    if (countOnly) {
      const count = await prisma.favorite.count({ where })
      return NextResponse.json({ count })
    }

    const rows = await prisma.favorite.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        sourceMessageId: true,
        conversationId: true,
        conversationTitle: true,
        role: true,
        title: true,
        content: true,
        attachments: true,
        imageUrl: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      rows.map((row) => ({
        ...row,
        // 列表直接消费数组;库里存的是 JSON 字符串(与 Message.attachments 同形)
        attachments: parseFavoriteAttachments(row.attachments),
        imageUrl: row.imageUrl ?? firstImageUrl(parseFavoriteAttachments(row.attachments)),
      }))
    )
  } catch (err) {
    console.error("[favorites] list failed:", err)
    return NextResponse.json({ error: "获取收藏列表失败" }, { status: 500 })
  }
}

/**
 * POST /api/favorites
 *
 * 主路径只收 sourceMessageId:正文/角色/附件/会话标题全部由服务端查消息后快照,
 * 不信任客户端正文;同一条消息重复收藏幂等返回已有记录。
 *
 * 外部客户端(浏览器扩展)的本地消息没有服务端 id,退化为客户端正文快照
 * (content + role),不做归属校验,正文限 2 万字。主应用不走向这条路径。
 */
export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  let body: {
    sourceMessageId?: string
    content?: string
    role?: string
    conversationId?: string
    conversationTitle?: string
    imageUrl?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "请求体不是合法的 JSON" }, { status: 400 })
  }

  const sourceMessageId = (body.sourceMessageId ?? "").trim()
  const rawContent = (body.content ?? "").trim()

  // ── 外部客户端路径:无服务端消息 id,直接落客户端正文快照 ──
  if (!sourceMessageId) {
    if (!rawContent) {
      return NextResponse.json({ error: "缺少消息 id 或正文" }, { status: 400 })
    }
    const role = body.role === "user" ? "user" : body.role === "assistant" ? "assistant" : null
    if (!role) {
      return NextResponse.json({ error: "role 必须是 user 或 assistant" }, { status: 400 })
    }
    const content = sanitizeStoredContent(rawContent).slice(0, 20000)
    const rawImageUrl = (body.imageUrl ?? "").trim()
    const imageUrl =
      /^\/uploads\/[\w.\-]+$/.test(rawImageUrl) || /^https?:\/\//i.test(rawImageUrl)
        ? rawImageUrl.slice(0, 2000)
        : null
    const conversationId = (body.conversationId ?? "").trim().slice(0, 64) || null
    const conversationTitle = (body.conversationTitle ?? "").trim().slice(0, 120) || null

    try {
      const row = await prisma.favorite.create({
        data: {
          userId,
          sourceMessageId: null,
          conversationId,
          conversationTitle,
          role,
          title: favoriteTitle(content),
          content,
          attachments: null,
          imageUrl,
        },
        select: { id: true },
      })
      return NextResponse.json({ id: row.id, created: true }, { status: 201 })
    } catch (err) {
      console.error("[favorites] create (external) failed:", err)
      return NextResponse.json({ error: "收藏失败，请稍后再试" }, { status: 500 })
    }
  }

  try {
    // 归属校验直接做在消息查询里:别人的消息按"不存在"处理
    const message = await prisma.message.findFirst({
      where: {
        id: sourceMessageId,
        conversation: { userId },
        role: { in: ["user", "assistant"] },
      },
      select: {
        id: true,
        role: true,
        content: true,
        attachments: true,
        conversationId: true,
        conversation: { select: { title: true } },
      },
    })

    if (!message) {
      return NextResponse.json(
        { error: "消息不存在或尚未保存，请稍后再试" },
        { status: 409 }
      )
    }

    const existing = await prisma.favorite.findFirst({
      where: { userId, sourceMessageId: message.id },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json({ id: existing.id, created: false })
    }

    const content = sanitizeStoredContent(message.content)
    const attachments = parseFavoriteAttachments(message.attachments)
    const imageUrl = firstImageUrl(attachments)

    const row = await prisma.favorite.create({
      data: {
        userId,
        sourceMessageId: message.id,
        conversationId: message.conversationId,
        conversationTitle: message.conversation.title ?? null,
        role: message.role,
        title: favoriteTitle(content),
        content,
        // 原样保存附件 JSON 字符串,读侧统一 parse
        attachments: attachments.length > 0 ? JSON.stringify(attachments) : null,
        imageUrl,
      },
      select: { id: true },
    })

    return NextResponse.json({ id: row.id, created: true }, { status: 201 })
  } catch (err) {
    // 并发重复收藏:唯一约束兜底,回读已有记录
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      const existing = await prisma.favorite.findFirst({
        where: { userId, sourceMessageId },
        select: { id: true },
      })
      if (existing) return NextResponse.json({ id: existing.id, created: false })
    }
    console.error("[favorites] create failed:", err)
    return NextResponse.json({ error: "收藏失败，请稍后再试" }, { status: 500 })
  }
}
