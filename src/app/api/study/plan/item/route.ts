import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'

/**
 * PATCH /api/study/plan/item - 冲刺计划任务勾销
 * body: { itemId, done: boolean }
 * 归属校验走 item.userId(创建时冗余落了 userId,免 join);勾销只翻状态,不改 FSRS 排期。
 */
export async function PATCH(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  let body: { itemId?: string; done?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  if (!body.itemId) {
    return NextResponse.json({ error: '缺少 itemId' }, { status: 400 })
  }

  try {
    const item = await prisma.studyPlanItem.findFirst({
      where: { id: body.itemId, userId },
    })
    if (!item) {
      return NextResponse.json({ error: '任务不存在或已被删除' }, { status: 404 })
    }
    const updated = await prisma.studyPlanItem.update({
      where: { id: item.id },
      data: { done: !!body.done, doneAt: body.done ? new Date() : null },
    })
    return NextResponse.json({ item: updated })
  } catch (err) {
    console.error('[study/plan/item PATCH] failed:', err)
    return NextResponse.json({ error: '更新任务失败' }, { status: 500 })
  }
}
