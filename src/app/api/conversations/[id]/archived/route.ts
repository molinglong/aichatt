import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { ephemeralScope } from '@/lib/ephemeral'
import { sanitizeStoredContent } from '@/lib/conversation-message-format'

/**
 * GET /api/conversations/[id]/archived?rootId=<messageId>
 *
 * C 分支轻量版: 返回某次编辑归档的旧版本消息链(时间正序)。
 * rootId 为被编辑消息的 id(归档行的 archivedRoot)。
 * 归档消息不参与正常列表/上下文/搜索,仅通过本端点回看。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const { id } = params
  const rootId = new URL(req.url).searchParams.get('rootId')
  if (!rootId) {
    return NextResponse.json({ error: '缺少参数 rootId' }, { status: 400 })
  }

  // 归属校验(含临时区隔离):只允许查看本人同区会话的归档
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id, ...ephemeralScope(session) },
    select: { id: true },
  })
  if (!conversation) {
    return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
  }

  const rows = await prisma.message.findMany({
    where: { conversationId: id, archived: true, archivedRoot: rootId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      content: true,
      attachments: true,
      model: true,
      createdAt: true,
    },
  })

  const messages = rows.map((m) => {
    let attachments: unknown[] = []
    if (m.attachments) {
      try {
        const parsed = JSON.parse(m.attachments)
        if (Array.isArray(parsed)) attachments = parsed
      } catch {
        // 损坏 JSON 返回空数组
      }
    }
    return { ...m, content: sanitizeStoredContent(m.content), attachments }
  })

  return NextResponse.json({ messages })
}
