import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { ephemeralScope } from "@/lib/ephemeral"
import { formatMessageRows, sanitizeStoredContent, sanitizeStoredReasoning } from "@/lib/conversation-message-format"
import { getFavoriteIdMap } from "@/lib/favorites"

/** 更早翻页一次下发的最大行数 */
const EARLIER_PAGE_SIZE = 60

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const { id } = params
  const { searchParams } = new URL(req.url)
  const cursor = searchParams.get("cursor") ?? undefined
  const model = searchParams.get("model") ?? undefined
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 100)

  // Verify the conversation belongs to the user
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id, ...ephemeralScope(session) },
    select: { id: true },
  })

  if (!conversation) {
    return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
  }

  // 更早翻页(首屏消息分页化的续载):?before=<earlierCursorId>
  // 口径:游标 = **已下发的最早一条本身**,本次下发严格早于它的那一批。
  // 严格比较用 (createdAt, id) 元组而非单列 —— 同批写入的消息共享同一 createdAt,
  // 只比时间会把它们整批漏掉或重复下发;可见过滤(非当前模型的其他 model 回复)
  // 留在前端 page 里做,与首屏同一口径,服务端只保证"每行恰好下发一次"。
  const before = searchParams.get("before")
  if (before) {
    const beforeRow = await prisma.message.findFirst({
      where: { id: before, conversationId: id },
      select: { createdAt: true },
    })
    if (!beforeRow) {
      return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
    }
    const fetched = await prisma.message.findMany({
      where: {
        conversationId: id,
        archived: false,
        OR: [
          { createdAt: { lt: beforeRow.createdAt } },
          { createdAt: beforeRow.createdAt, id: { lt: before } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EARLIER_PAGE_SIZE + 1,
      select: {
        id: true,
        role: true,
        content: true,
        attachments: true,
        reasoning: true,
        metadata: true,
        model: true,
        groupId: true,
        streaming: true,
        promptTokens: true,
        completionTokens: true,
        createdAt: true,
      },
    })
    // 取回来的顺序是"新→旧";多取的那一行是**最旧**的一条,只用来判定"更早还有剩余",
    // 不下发 —— 若反过来先转正序再切头部,丢的就是最新那一行,它会永远消失在页缝里。
    const hasRawMore = fetched.length > EARLIER_PAGE_SIZE
    const pageRows = fetched.slice(0, hasRawMore ? EARLIER_PAGE_SIZE : fetched.length)
    pageRows.reverse()
    // 游标 = 本页最早一条;空页(游标行即全库最早)时收摊
    const earlierCursorId = pageRows[0]?.id ?? null
    // 星标状态与首屏端点同口径
    const favoriteIdMap = await getFavoriteIdMap(session.user.id, pageRows.map((row) => row.id))
    return NextResponse.json({
      messages: formatMessageRows(pageRows).map((message) => ({
        ...message,
        favoriteId: favoriteIdMap.get(message.id) ?? null,
      })),
      hasEarlier: hasRawMore && !!earlierCursorId,
      earlierCursorId,
    })
  }

  const messages = await prisma.message.findMany({
    // C 分支轻量版: 归档消息不在正常列表中展示(仅回看端点可见)
    where: { conversationId: id, archived: false, ...(model ? { model } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit + 1, // fetch one extra to determine if there's a next page
    ...(cursor
      ? {
          skip: 1, // skip the cursor itself
          cursor: { id: cursor },
        }
      : {}),
    select: {
      id: true,
      role: true,
      content: true,
      attachments: true,
      reasoning: true,
      metadata: true,
      model: true,
      // 跨端回流(ChatPanel 切回前台补拉):单聊可见过滤要靠 groupId 判定其他模型的回复
      groupId: true,
      streaming: true,
      createdAt: true,
    },
  })

  const hasMore = messages.length > limit
  const page = hasMore ? messages.slice(0, limit) : messages
  const nextCursor = hasMore ? page[page.length - 1]?.id : null
  const favoriteIdMap = await getFavoriteIdMap(session.user.id, page.map((m) => m.id))

  return NextResponse.json({
    // 这段分支不走 formatMessageRows(客户端在这里要 attachments/metadata 的原始 JSON 字符串),
    // 但正文/思考仍要过一道清洗:历史行里可能留着上游泄漏的工具调用标记(DSML)。
    messages: page.map((m) => ({
      ...m,
      content: sanitizeStoredContent(m.content),
      reasoning: sanitizeStoredReasoning(m.reasoning),
      favoriteId: favoriteIdMap.get(m.id) ?? null,
    })),
    nextCursor,
  })
}

/**
 * Archive a message and all messages after it in the conversation.
 * Used when a user edits a message — the old message and its
 * subsequent responses are archived (C 分支轻量版) before the new
 * message is sent, so the old branch stays retrievable via the
 * archived endpoint (?rootId=<messageId>) instead of being lost.
 *
 * Query: ?messageId=<id>
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const { id } = params
  const { searchParams } = new URL(req.url)
  const messageId = searchParams.get("messageId")

  if (!messageId) {
    return NextResponse.json(
      { error: "缺少参数 messageId" },
      { status: 400 }
    )
  }

  // Verify the conversation belongs to the user
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id, ...ephemeralScope(session) },
    select: { id: true },
  })

  if (!conversation) {
    return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
  }

  // Find the target message to get its createdAt timestamp
  let targetMessage = await prisma.message.findFirst({
    where: { id: messageId, conversationId: id },
    select: { id: true, createdAt: true },
  })

  if (!targetMessage) {
    // C 分支轻量版回退: 刚发送的消息在客户端持有 AI SDK 本地临时 id(与服务端 cuid 不同),
    // 直接按 id 查必 404。客户端会附带旧文本,按 内容+角色+最近10分钟 定位真实行。
    // 10 分钟窗口将误匹配风险压到几乎为零(临时 id 消息都是刚发送的)。
    const content = searchParams.get("content")
    if (content) {
      targetMessage = await prisma.message.findFirst({
        where: {
          conversationId: id,
          role: "user",
          content,
          createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true },
      })
    }
  }

  if (!targetMessage) {
    return NextResponse.json({ error: "消息不存在或已被删除" }, { status: 404 })
  }

  // C 分支轻量版: 归档代替物理删除,附件文件一并保留(旧版本图片不裂)。
  // archivedRoot 记被编辑消息的**真实数据库 id**(客户端传来的可能是本地临时 id),
  // 回看端点按它拉取旧版本链;返回 archivedRootId 供客户端作为新消息的 editedFrom。
  // archived: false —— 只归档当前存活分支;已归档行保留各自 root,
  // 否则编辑更早的消息会把旧历史链整段重挂到新 root(旧版本回看被截断)。
  await prisma.message.updateMany({
    where: {
      conversationId: id,
      createdAt: { gte: targetMessage.createdAt },
      archived: false,
    },
    data: { archived: true, archivedRoot: targetMessage.id },
  })

  return NextResponse.json({
    success: true,
    archived: true,
    archivedRootId: targetMessage.id,
  })
}

/**
 * 「仅保存」: 就地更新一条 user 消息的文本,不动后续消息、不归档、不触发重答。
 * 用于修正错别字等"不该付出截断+重答代价"的编辑。
 *
 * Body: { messageId: string; content: string; oldContent?: string }
 * - oldContent 供临时 id 回退定位(与 DELETE 同款 内容+时间窗 策略)
 * - metadata 合并 editedAt,供前端显示"已编辑"标记(不写 kind,不影响渲染分支)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const { id } = params
  const body = (await req.json().catch(() => ({}))) as {
    messageId?: unknown
    content?: unknown
    oldContent?: unknown
  }
  const messageId = typeof body.messageId === "string" ? body.messageId : ""
  const content = typeof body.content === "string" ? body.content.trim() : ""
  const oldContent = typeof body.oldContent === "string" ? body.oldContent : ""
  if (!messageId || !content) {
    return NextResponse.json(
      { error: "缺少参数 messageId 或 content" },
      { status: 400 }
    )
  }

  // 归属校验(含临时区隔离)
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id, ...ephemeralScope(session) },
    select: { id: true },
  })
  if (!conversation) {
    return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
  }

  // 仅允许编辑未归档的 user 消息;归档行属于历史版本,不可改
  let target = await prisma.message.findFirst({
    where: { id: messageId, conversationId: id, archived: false, role: "user" },
    select: { id: true, metadata: true },
  })

  if (!target && oldContent) {
    // 临时 id 回退: 与 DELETE 同策略(内容+角色+最近10分钟)
    target = await prisma.message.findFirst({
      where: {
        conversationId: id,
        archived: false,
        role: "user",
        content: oldContent,
        createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, metadata: true },
    })
  }

  if (!target) {
    return NextResponse.json({ error: "消息不存在或已被删除" }, { status: 404 })
  }

  const editedAt = new Date().toISOString()
  let metadata: string
  try {
    const parsed = target.metadata ? JSON.parse(target.metadata) : null
    const base = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
    metadata = JSON.stringify({ ...base, editedAt })
  } catch {
    metadata = JSON.stringify({ editedAt })
  }

  await prisma.message.update({
    where: { id: target.id },
    data: { content, metadata },
  })

  return NextResponse.json({ ok: true, id: target.id })
}
