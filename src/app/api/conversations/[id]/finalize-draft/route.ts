import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { ephemeralScope } from '@/lib/ephemeral'
import { abortActiveChatRuns } from '@/lib/ai/active-chat-runs.server'

/**
 * POST /api/conversations/[id]/finalize-draft
 *
 * 客户端主动停止生成:
 *   1. 中止该会话在途的 /api/chat 生成(生成与 HTTP 连接已解耦,断开连接不再等于停止,
 *      所以停止按钮必须显式打到服务端,否则后台会继续跑完并覆盖用户已停止的半截);
 *   2. 把残留的 streaming 草稿行定格为普通消息,让前端轮询立即收口。
 * 内容保留最新快照。没有在途流(例如流已经自然结束/进程重启)时只做第 2 步。
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const { id } = params

  // 归属校验(含临时区隔离):草稿行只允许在本人同区会话内定格
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id, ...ephemeralScope(session) },
    select: { id: true },
  })
  if (!conversation) {
    return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
  }

  // 先中止在途生成,再定格草稿。顺序反过来的话,后台流可能在定格之后又写一次快照。
  const aborted = abortActiveChatRuns(id, 'user-stop')

  const result = await prisma.message.updateMany({
    where: { conversationId: id, streaming: true },
    data: { streaming: false },
  })

  return NextResponse.json({ ok: true, finalized: result.count, aborted })
}
