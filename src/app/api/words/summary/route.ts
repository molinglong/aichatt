import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { startOfToday } from '@/lib/words/plan'

/**
 * GET /api/words/summary —— 学习台「英语」入口卡的数字（只读，无副作用）。
 * 与 /api/words/queue 的区别：这里绝不推进计划游标、不建 UserWord，
 * 入口卡每次渲染都调它，必须廉价且幂等。
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  try {
    const [plan, listCount, due, todayNewDone, learning, mastered] = await Promise.all([
      prisma.wordPlan.findFirst({
        where: { userId, active: true },
        orderBy: { startedAt: 'desc' },
        include: { list: { select: { name: true, wordCount: true } } },
      }),
      prisma.dictList.count(),
      prisma.userWord.count({ where: { userId, suspended: false, dueAt: { lte: new Date() } } }),
      prisma.userWord.count({ where: { userId, source: 'plan', createdAt: { gte: startOfToday() } } }),
      prisma.userWord.count({ where: { userId, reps: { gt: 0 } } }),
      prisma.userWord.count({ where: { userId, mastery: { gte: 0.8 } } }),
    ])

    return NextResponse.json({
      hasDictionary: listCount > 0,
      listCount,
      listName: plan?.list?.name ?? null,
      listTotal: plan?.list?.wordCount ?? 0,
      cursor: plan?.cursor ?? 0,
      dailyNew: plan?.dailyNew ?? 15,
      dailyReview: plan?.dailyReview ?? 100,
      due,
      todayNewDone,
      learning,
      mastered,
    })
  } catch (err) {
    console.error('[words/summary] failed:', err)
    return NextResponse.json({ error: '读取英语学习概况失败' }, { status: 500 })
  }
}
