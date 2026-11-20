import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { buildQueue } from '@/lib/words/plan'

/**
 * GET /api/words/queue —— 今日英语队列（复习到期 + 按计划推进的新词，混排）。
 * 副作用：首次访问会按计划建 UserWord 并推进词单游标（等价于点开「开始背」）。
 * 返回 items（前端只吃展示字段）+ summary（学习台入口卡的数字都取自这里）。
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  try {
    const queue = await buildQueue(session.user.id)
    return NextResponse.json(queue)
  } catch (err) {
    console.error('[words/queue] failed:', err)
    return NextResponse.json({ error: '获取今日单词队列失败' }, { status: 500 })
  }
}
