import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getUserId } from '@/lib/api-auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { deleteReferencedFiles } from '@/lib/uploads'
import { getMaskById } from '@/lib/ai/mask-resolve'
import { ephemeralScope } from '@/lib/ephemeral'
import {
  alignStartToRoundHead,
  formatMessageRows,
  type MessageRow,
} from '@/lib/conversation-message-format'
import { getFavoriteIdMap } from '@/lib/favorites'

/** 首屏尾部窗口条数:长会话不再全量下发,更早部分由前端"查看更早消息"续载 */
const MESSAGE_TAIL = 80
/** 轮对齐截断的缓冲行数:窗口头部可能落在半轮中间,多取几条供前端回退到整轮起点 */
const TRIM_BUFFER = 40

/**
 * GET /api/conversations/[id]
 *
 * 返回单个会话的数据,包括消息列表。
 * 设计目的:让 /chat/c/[id] 可以是 Client Component,
 * 这样 Tauri 桌面端静态导出时,该页不再依赖 Server runtime。
 *
 * 长会话首屏分页(单聊):只下发最近 MESSAGE_TAIL 条(轮对齐:从一条 user 起头),
 * 更早的消息带 earlierCount/earlierCursorId 返回,前端经 GET .../messages?before= 续载。
 * 对比模式保持全量——泳道按 model 过滤消息,尾部窗口会让各泳道的轮数不对齐,
 * 且对比会话轮数天然少(一轮多模型同发),全量拉取代价可控。
 *
 * 返回结构:
 * {
 *   id, title, model, mode, styleOffset,
 *   compareModels: string[],   // 已 JSON.parse 过的数组(对比模式)
 *   messages: Array<{
 *     id, role, content, reasoning?, model?, groupId?,
 *     attachments: Attachment[],   // 已 JSON.parse
 *     promptTokens?, completionTokens?, createdAt
 *   }>,
 *   totalMessageCount: number,     // 未归档消息总数
 *   earlierCount: number,          // 未下发(可续载)的消息数
 *   hasEarlier: boolean,
 *   earlierCursorId: string | null, // 前端"查看更早"的游标 = 已下发最早一条本身
 * }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  // Bearer 优先(浏览器扩展读历史):无效 Bearer 不降级到 cookie
  const hasBearer = /^Bearer\s+/i.test(req.headers.get('authorization') ?? '')
  const session = hasBearer ? null : await auth()
  const userId = session?.user?.id ?? (await getUserId(req))
  if (!userId) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const { id } = params
  // 双向隔离:临时会话只能访问临时对话,反之亦然(防 id 直达穿透);
  // Bearer 令牌只属于完整账号，强制只看正常对话
  const scope = session ? ephemeralScope(session) : { isEphemeral: false }

  // A 流式恢复: 超时兜底——超过 10 分钟仍处于 streaming 的草稿行视为已中断,
  // 定格为普通消息,避免前端无限轮询(快照周期 600ms,正常生成远短于该阈值)。
  // 对比模式无草稿行,此 updateMany 无副作用。
  await prisma.message.updateMany({
    where: {
      conversationId: id,
      streaming: true,
      createdAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
    },
    data: { streaming: false },
  })

  const conversation = await prisma.conversation.findFirst({
    where: {
      id,
      userId,
      ...scope,
    },
    select: {
      id: true,
      title: true,
      model: true,
      mode: true,
      styleOffset: true,
      stylePreset: true,
      replyLength: true,
      maskId: true,
      compareModels: true,
      studyMode: true, // 学习会话:普通聊天页据此在 /chat/c/[id] 原地渲染学习流
    },
  })

  if (!conversation) {
    return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
  }

  const isCompare = (conversation.mode ?? 'single') === 'compare'

  // C 分支轻量版: 归档消息不在正常列表中展示(仅回看端点可见)
  const activeWhere = { conversationId: id, archived: false }
  const totalMessageCount = await prisma.message.count({ where: activeWhere })

  const messageSelect = {
    id: true,
    role: true,
    content: true,
    reasoning: true,
    model: true,
    groupId: true,
    streaming: true,
    attachments: true,
    metadata: true,
    promptTokens: true,
    completionTokens: true,
    createdAt: true,
  } satisfies Record<keyof MessageRow, boolean>

  // 单聊尾部窗口:倒序取最近 MESSAGE_TAIL+TRIM_BUFFER 行再翻回正序,
  // 起点做轮对齐;对比模式全量下发(见顶部注释)。
  // 排序一律带 (createdAt, id) 元组:同批写入的多条消息共享同一时间戳,
  // 单列排序的并列次序不确定,翻页游标的元组比较会算错边界。
  let rows: MessageRow[]
  let windowStart = 0
  if (isCompare || totalMessageCount <= MESSAGE_TAIL) {
    rows = await prisma.message.findMany({
      where: activeWhere,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: messageSelect,
    })
  } else {
    const tail = await prisma.message.findMany({
      where: activeWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MESSAGE_TAIL + TRIM_BUFFER,
      select: messageSelect,
    })
    tail.reverse()
    windowStart = alignStartToRoundHead(tail, Math.max(0, tail.length - MESSAGE_TAIL))
    rows = tail.slice(windowStart)
  }

  // 游标 = 已下发窗口的最早一条**本身**;翻页端点只取严格早于它的行,
  // 于是「窗口 + 逐页」恰好覆盖全量,不漏不重。
  // 窗口已含全部未归档行(短会话/对比/对齐回退吃满了缓冲)时不暴露更早入口。
  const hasEarlier = !isCompare && totalMessageCount > rows.length
  const earlierCursorId = hasEarlier ? rows[0]?.id ?? null : null
  const earlierCount = Math.max(0, totalMessageCount - rows.length)

  // 收藏状态回填:消息操作栏的星标靠 favoriteId 判断是否已收藏。
  // 与更早翻页/前台补拉端点同口径,否则翻页后老消息状态会错。
  const favoriteIdMap = await getFavoriteIdMap(userId, rows.map((row) => row.id))
  const messages = formatMessageRows(rows).map((message) => ({
    ...message,
    favoriteId: favoriteIdMap.get(message.id) ?? null,
  }))

  let compareModels: string[] = []
  if (conversation.compareModels) {
    try {
      const parsed = JSON.parse(conversation.compareModels)
      if (Array.isArray(parsed)) compareModels = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      // ignore
    }
  }

  // E 对比模式投票: 返回最新一轮投票(对比模式回显高亮用)
  const latestVote = await prisma.compareVote.findFirst({
    where: { conversationId: id, userId },
    orderBy: { updatedAt: 'desc' },
    select: { groupId: true, votedModel: true },
  })

  return NextResponse.json({
    id: conversation.id,
    title: conversation.title,
    model: conversation.model,
    mode: conversation.mode ?? 'single',
    styleOffset: conversation.styleOffset ?? 0,
    stylePreset: conversation.stylePreset ?? null, // 新版 preset(null = balanced)
    replyLength: conversation.replyLength ?? null, // 长度档(null = standard,不额外限制篇幅)
    maskId: conversation.maskId ?? null, // 面具(null = 无面具)
    studyMode: conversation.studyMode, // 学习模式会话(前端改道学习室)
    compareModels,
    latestVote: latestVote ?? null,
    messages,
    totalMessageCount,
    earlierCount,
    hasEarlier,
    earlierCursorId,
  })
}

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  model: z.string().min(1).optional(),
  compareModels: z.array(z.string().min(1)).optional(),
  // 转换为单聊时 mode='single'
  mode: z.enum(['single', 'compare']).optional(),
  // 面具:null 清除;字符串必须是合法内置面具 id(将来兼容 user:<cuid>)
  maskId: z.string().min(1).nullable().optional(),
})

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const { id } = params

  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id, ...ephemeralScope(session) },
  })

  if (!conversation) {
    return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
  }

  const body = await req.json()
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: '请求参数不正确', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // maskId 显式传入时校验合法性(未知 id 返回 400);null 表示清除面具
  let maskIdUpdate: string | null | undefined = undefined
  if (parsed.data.maskId !== undefined) {
    if (parsed.data.maskId === null) {
      maskIdUpdate = null
    } else if (await getMaskById(parsed.data.maskId, session.user.id)) {
      maskIdUpdate = parsed.data.maskId
    } else {
      return NextResponse.json({ error: '所选面具不存在' }, { status: 400 })
    }
  }

  const updated = await prisma.conversation.update({
    where: { id },
    data: {
      title: parsed.data.title,
      model: parsed.data.model,
      mode: parsed.data.mode,
      ...(maskIdUpdate !== undefined ? { maskId: maskIdUpdate } : {}),
      ...(parsed.data.compareModels
        ? { compareModels: JSON.stringify(parsed.data.compareModels) }
        : {}),
      // 转为单聊时清除对比模型列表
      ...(parsed.data.mode === 'single' ? { compareModels: null } : {}),
    },
    select: { id: true, title: true, model: true, mode: true, maskId: true, updatedAt: true },
  })

  return NextResponse.json(updated)
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const { id } = params

  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id, ...ephemeralScope(session) },
  })

  if (!conversation) {
    return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
  }

  // 删除前收集会话内消息引用的附件文件(消息会随会话级联删除)
  const messages = await prisma.message.findMany({
    where: { conversationId: id, attachments: { not: null } },
    select: { attachments: true },
  })

  await prisma.conversation.delete({ where: { id } })

  // 库删除完成后清理磁盘文件
  for (const m of messages) {
    await deleteReferencedFiles(m.attachments)
  }

  return NextResponse.json({ success: true })
}
