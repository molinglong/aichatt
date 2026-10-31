import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getUserId } from '@/lib/api-auth'
import { prisma } from '@/lib/db'
import { STYLE_PRESETS } from '@/lib/ai/style-presets'
import { REPLY_LENGTH_LEVELS, DEFAULT_REPLY_LENGTH } from '@/lib/ai/reply-length'
import { getMaskById } from '@/lib/ai/mask-resolve'
import { isEphemeralSession } from '@/lib/ephemeral'

export async function GET(req: Request) {
  // Bearer 优先(浏览器扩展读历史):无效 Bearer 不降级到 cookie，与 /api/chat 同口径
  const hasBearer = /^Bearer\s+/i.test(req.headers.get('authorization') ?? '')
  const session = hasBearer ? null : await auth()
  const userId = session?.user?.id ?? (await getUserId(req))
  if (!userId) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  // 会话隔离:临时会话只返回临时对话,正常会话只返回正常对话。
  // 例外:正常模式下 ?scope=ephemeral 查看隔离区(设置→用户中心 临时聊天找回专区)。
  // Bearer 令牌只属于完整账号，永远不返回临时会话。
  const ephemeral = session ? isEphemeralSession(session) : false
  const { searchParams } = new URL(req.url)
  const scope = (searchParams.get('scope') ?? '').trim().toLowerCase()
  const listEphemeral = hasBearer ? false : ephemeral || scope === 'ephemeral'
  const parsedLimit = parseInt(searchParams.get('limit') ?? '20', 10)
  const parsedOffset = parseInt(searchParams.get('offset') ?? '0', 10)
  const limit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20, 100)
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0
  const q = (searchParams.get('q') ?? '').trim()

  // 搜索范围:
  //   ?q=关键词 不为空时,匹配标题(title)或任意一条消息的内容(content);
  //   标题匹配优先,消息匹配次之。两者均使用 case-insensitive 搜索,
  //   并依靠 Message.content 上的 pg_trgm GIN 索引(见对应迁移)加速。
  //   ?type=title 仅按标题过滤(供"仅标题"模式备用)。
  const type = (searchParams.get('type') ?? '').trim().toLowerCase()
  // 面具筛选:'none' 表示无面具;其余值按原始 maskId 精确匹配(内置裸 id / user:<cuid>)。
  // 与 q 关键词为 AND 关系;只传筛选不传 q 时等于浏览该面具的全部对话。
  const maskFilter = (searchParams.get('maskId') ?? '').trim()
  const where = {
    userId,
    isEphemeral: listEphemeral,
    ...(maskFilter
      ? maskFilter === 'none'
        ? { maskId: null }
        : { maskId: maskFilter }
      : {}),
    ...(q
      ? type === 'title'
        ? { title: { contains: q, mode: 'insensitive' as const } }
        : {
            OR: [
              { title: { contains: q, mode: 'insensitive' as const } },
              {
                messages: {
                  some: {
                    content: { contains: q, mode: 'insensitive' as const },
                  },
                },
              },
            ],
          }
      : {}),
  }

  const [total, conversations] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        model: true,
        mode: true,
        maskId: true, // 列表尾随面具徽标用(ConversationItem)
        studyMode: true, // 学习会话:历史入口据此跳 /study?c=id
        updatedAt: true,
      },
      skip: offset,
      take: limit,
    }),
  ])

  return NextResponse.json({
    items: conversations,
    total,
    hasMore: offset + conversations.length < total,
  })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  // 临时模式(访客密码登录)下创建的对话一律打隔离标记,进隔离区
  const isEphemeral = isEphemeralSession(session)

  // 另存为新对话: 从对比会话克隆(用户消息 + 所选模型的回答)
  if (body.cloneFrom) {
    const source = await prisma.conversation.findFirst({
      where: { id: body.cloneFrom, userId: session.user.id, isEphemeral },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (!source) {
      return NextResponse.json({ error: '原对话不存在或已被删除' }, { status: 404 })
    }
    const targetModel = body.model || source.model
    // 纯单聊消息(无 groupId)全部保留;对比泳道消息仅保留所选模型
    const cloneMessages = source.messages.filter(
      (m) => m.role === 'user' || m.groupId == null || m.model === targetModel
    )
    const conversation = await prisma.conversation.create({
      data: {
        userId: session.user.id,
        isEphemeral,
        title: body.title || source.title || '新对话',
        model: targetModel,
        styleOffset: source.styleOffset,
        stylePreset: source.stylePreset, // 克隆时一并继承 preset(可能为 null,表示走 balanced)
        maskId: source.maskId, // 克隆时一并继承面具(可能为 null)
        replyLength: source.replyLength, // 克隆时一并继承长度档(null = standard)
        messages: {
          create: cloneMessages.map((m) => ({
            role: m.role,
            content: m.content,
            reasoning: m.reasoning,
            model: m.role === 'assistant' ? m.model : null,
            // 保留 token 统计(克隆的对话沿用原消耗记录)
            promptTokens: m.role === 'assistant' ? m.promptTokens : null,
            completionTokens: m.role === 'assistant' ? m.completionTokens : null,
          })),
        },
      },
    })
    return NextResponse.json(conversation, { status: 201 })
  }

  // 校验 stylePreset(必须为合法 preset id,否则置 null)
  const validPreset = STYLE_PRESETS.find((p) => p.id === body.stylePreset)?.id ?? null
  // 校验 maskId(必须为合法内置面具 id,否则置 null;前端可显式传 null 表示无面具)
  const validMaskId = body.maskId == null ? null : ((await getMaskById(body.maskId, session.user.id))?.ref ?? null)
  // 校验 replyLength(合法档 id;standard 与未知值一律落 null,即不额外限制篇幅)
  const validReplyLength =
    REPLY_LENGTH_LEVELS.find((l) => l.id === body.replyLength && l.id !== DEFAULT_REPLY_LENGTH)?.id ?? null
  // styleOffset 仍接受但仅作为 preset 推导的兜底
  const legacyOffset =
    typeof body.styleOffset === 'number' && Number.isFinite(body.styleOffset)
      ? Math.max(0, Math.min(100, Math.round(body.styleOffset)))
      : 50

  const conversation = await prisma.conversation.create({
    data: {
      userId: session.user.id,
      isEphemeral,
      title: body.title || '新对话',
      model: body.model || 'gpt-4o',
      styleOffset: legacyOffset,
      stylePreset: validPreset, // 新版 preset(优先);null 时应用层回退到 balanced
      maskId: validMaskId, // 面具;null 时不启用
      replyLength: validReplyLength, // 长度档;null = standard(不注入长度段)
      ...(body.mode === 'compare' ? { mode: 'compare' } : {}),
      ...(body.compareModels ? { compareModels: JSON.stringify(body.compareModels) } : {}),
    },
  })

  return NextResponse.json(conversation, { status: 201 })
}
