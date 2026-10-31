import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { deleteReferencedFiles } from '@/lib/uploads'
import { denyIfEphemeral } from '@/lib/ephemeral'
import { sanitizeStoredContent } from '@/lib/conversation-message-format'
import { monitor } from '@/lib/monitor'

/**
 * 临时聊天隔离区管理端点(仅正常模式可用,临时模式 403)。
 *
 * GET    /api/ephemeral          列出隔离区对话(设置→用户中心 临时聊天专区)
 * GET    /api/ephemeral?id=      查看单条对话的消息预览(同一专区「查看」)
 * POST   /api/ephemeral          { action: 'restore' | 'delete', id }
 *        - restore: 转正(清 isEphemeral 标记,回到正常历史列表)
 *        - delete:  彻底删除(级联消息/摘要/投票,并清理附件文件)
 */

/** GET /api/ephemeral - 隔离区对话列表;?id= 返回单条对话消息(预览) */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const denied = denyIfEphemeral(session)
  if (denied) return denied

  // 单条查看:归属校验后返回对话信息 + 最近 50 条消息(倒序取出后正序返回)
  const previewId = req.nextUrl.searchParams.get('id')
  if (previewId) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: previewId, userId: session.user.id, isEphemeral: true },
      select: {
        id: true,
        title: true,
        model: true,
        mode: true,
        maskId: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    })
    if (!conversation) {
      return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
    }
    const messages = await prisma.message.findMany({
      where: { conversationId: previewId, archived: false },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, role: true, content: true, createdAt: true },
    })
    return NextResponse.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        model: conversation.model,
        mode: conversation.mode,
        maskId: conversation.maskId,
        updatedAt: conversation.updatedAt,
        messageCount: conversation._count.messages,
      },
      messages: messages
        .reverse()
        .map((m) => ({ ...m, content: sanitizeStoredContent(m.content) })),
    })
  }

  const conversations = await prisma.conversation.findMany({
    where: { userId: session.user.id, isEphemeral: true },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    select: {
      id: true,
      title: true,
      model: true,
      mode: true,
      maskId: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  })

  return NextResponse.json({
    items: conversations.map(({ _count, ...c }) => ({ ...c, messageCount: _count.messages })),
  })
}

/** POST /api/ephemeral - 转正或删除隔离区对话 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const denied = denyIfEphemeral(session)
  if (denied) return denied

  const body = await req.json().catch(() => ({}))
  const action = body?.action
  const id = typeof body?.id === 'string' ? body.id : ''
  if ((action !== 'restore' && action !== 'delete') || !id) {
    return NextResponse.json({ error: '请求参数不正确' }, { status: 400 })
  }

  // 归属校验:只允许操作本人隔离区内的对话
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id, isEphemeral: true },
    select: { id: true },
  })
  if (!conversation) {
    return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
  }

  if (action === 'restore') {
    monitor('ephemeral_action', { action, id })
    await prisma.conversation.update({
      where: { id },
      data: { isEphemeral: false },
    })
    return NextResponse.json({ success: true, restored: true })
  }

  // delete: 与 conversations/[id] DELETE 同一套附件清理逻辑
  monitor('ephemeral_action', { action, id })
  const messages = await prisma.message.findMany({
    where: { conversationId: id, attachments: { not: null } },
    select: { attachments: true },
  })

  await prisma.conversation.delete({ where: { id } })

  for (const m of messages) {
    await deleteReferencedFiles(m.attachments)
  }

  return NextResponse.json({ success: true, deleted: true })
}
