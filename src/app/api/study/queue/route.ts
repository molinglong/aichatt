import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'

/**
 * GET /api/study/queue - 今日复习队列
 * 到期卡(dueAt <= now) + 新卡(dueAt 为空),上限 20 张,到期早的优先;
 * ?topic= 考点专项过滤(统计弹层「专项 ›」入口);
 * 不返回 stability/difficulty 等内部调度字段。
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const topic = req.nextUrl.searchParams.get('topic')?.trim()

  try {
    const rows = await prisma.studyNote.findMany({
      where: {
        userId: session.user.id,
        ...(topic ? { topic } : {}),
        OR: [{ dueAt: { lte: new Date() } }, { dueAt: null }],
      },
      orderBy: { dueAt: 'asc' },
      take: 20,
      select: {
        id: true, subject: true, topic: true, title: true,
        content: true, imageUrl: true, analysis: true, mastery: true,
        reps: true, lapses: true, dueAt: true, sourceQuestionId: true,
      },
    })
    return NextResponse.json(rows)
  } catch (err) {
    console.error('[study/queue] failed:', err)
    return NextResponse.json({ error: '获取复习队列失败' }, { status: 500 })
  }
}
