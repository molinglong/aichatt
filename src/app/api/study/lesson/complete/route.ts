import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { archiveStudyLesson, isStudyOpening } from '@/lib/study/archive-lesson'

/**
 * POST /api/study/lesson/complete - 显式结课(模型没吐完成标记时的兜底)
 * body: { conversationId, messageId }
 *
 * 把指定 assistant 消息标记为 studyCompleted(刷新后仍显示结课页),
 * 并做一次幂等自动归档;归档失败不影响结课状态。
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  let body: { conversationId?: string; messageId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  const conversationId = (body.conversationId ?? '').trim()
  const messageId = (body.messageId ?? '').trim()
  if (!conversationId) {
    return NextResponse.json({ error: '缺少 conversationId' }, { status: 400 })
  }

  // 前端流式消息 id 是 AI SDK 临时 id,与库行 id 不相等;按 id 找不到时
  // 回落到该会话最后一条 assistant 消息(学习室结课的语义就是"最后这条讲完了")。
  const select = { id: true, metadata: true } as const
  let message = messageId
    ? await prisma.message.findFirst({
        where: {
          id: messageId,
          conversationId,
          role: 'assistant',
          conversation: { userId },
        },
        select,
      })
    : null
  if (!message) {
    message = await prisma.message.findFirst({
      where: {
        conversationId,
        role: 'assistant',
        conversation: { userId },
      },
      orderBy: { createdAt: 'desc' },
      select,
    })
  }
  if (!message) {
    return NextResponse.json({ error: '消息不存在或不属于当前账号' }, { status: 404 })
  }

  // 只允许学习室会话显式结课,避免普通聊天被误标
  const firstUser = await prisma.message.findFirst({
    where: { conversationId, role: 'user' },
    orderBy: { createdAt: 'asc' },
    select: { content: true },
  })
  if (!firstUser || !isStudyOpening(firstUser.content)) {
    return NextResponse.json({ error: '当前会话不是学习模式' }, { status: 400 })
  }

  let meta: Record<string, unknown> = {}
  if (message.metadata) {
    try {
      const parsed = JSON.parse(message.metadata) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>
      }
    } catch {
      // 损坏的 metadata 直接覆盖为结课状态
    }
  }
  if (meta.studyCompleted !== true) {
    await prisma.message.update({
      where: { id: message.id },
      data: { metadata: JSON.stringify({ ...meta, studyCompleted: true }) },
    })
  }

  let noteId: string | null = null
  let created = false
  try {
    const note = await archiveStudyLesson(userId, conversationId, message.id)
    noteId = note?.id ?? null
    created = note?.created ?? false
  } catch (err) {
    console.error('[study/lesson/complete] auto-archive failed:', err)
  }

  return NextResponse.json({ ok: true, noteId, created })
}
