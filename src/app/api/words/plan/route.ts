import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getActivePlan } from '@/lib/words/plan'

/**
 * GET  /api/words/plan —— 当前生效计划（首次访问会按最近导入的词单自动建一条）
 * PATCH /api/words/plan —— 改每日配额 / 换词单 / 换抽词顺序
 *   body: { dailyNew?, dailyReview?, listId?, order?, restart?: boolean }
 *   restart=true 时把游标归零（换词单后想从头背）；改配额不动游标与已学进度。
 * 取舍：计划只存游标与配额，不预生成任务行——改计划零成本，断了能续。
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  try {
    const plan = await getActivePlan(session.user.id)
    return NextResponse.json({
      id: plan.id,
      name: plan.name,
      listId: plan.listId,
      listName: plan.list?.name ?? null,
      dailyNew: plan.dailyNew,
      dailyReview: plan.dailyReview,
      order: plan.order,
      cursor: plan.cursor,
      active: plan.active,
      startedAt: plan.startedAt,
    })
  } catch (err) {
    console.error('[words/plan GET] failed:', err)
    return NextResponse.json({ error: '读取背词计划失败' }, { status: 500 })
  }
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, Math.round(n)))
}

export async function PATCH(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  let body: { dailyNew?: number; dailyReview?: number; listId?: string | null; order?: string; restart?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }

  try {
    const plan = await getActivePlan(session.user.id)
    const data: {
      dailyNew?: number
      dailyReview?: number
      listId?: string | null
      order?: string
      cursor?: number
    } = {}

    if (body.dailyNew !== undefined) {
      const v = clampInt(body.dailyNew, 0, 100)
      if (v === null) return NextResponse.json({ error: 'dailyNew 必须是数字' }, { status: 400 })
      data.dailyNew = v
    }
    if (body.dailyReview !== undefined) {
      const v = clampInt(body.dailyReview, 10, 500)
      if (v === null) return NextResponse.json({ error: 'dailyReview 必须是数字' }, { status: 400 })
      data.dailyReview = v
    }
    if (body.order !== undefined) {
      if (body.order !== 'list' && body.order !== 'freq') {
        return NextResponse.json({ error: 'order 只能是 list 或 freq' }, { status: 400 })
      }
      data.order = body.order
    }
    if (body.listId !== undefined) {
      if (body.listId) {
        const list = await prisma.dictList.findUnique({ where: { id: body.listId }, select: { id: true, name: true } })
        if (!list) return NextResponse.json({ error: '词单不存在' }, { status: 404 })
        data.listId = list.id
        // 换词单默认从头开始（新词单的 position 与旧游标没有可比性）
        if (body.restart !== false) data.cursor = 0
      } else {
        data.listId = null
      }
    }
    if (body.restart === true && body.listId === undefined) data.cursor = 0

    if (!Object.keys(data).length) {
      return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 })
    }

    const updated = await prisma.wordPlan.update({
      where: { id: plan.id },
      data,
      include: { list: true },
    })
    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      listId: updated.listId,
      listName: updated.list?.name ?? null,
      dailyNew: updated.dailyNew,
      dailyReview: updated.dailyReview,
      order: updated.order,
      cursor: updated.cursor,
      active: updated.active,
    })
  } catch (err) {
    console.error('[words/plan PATCH] failed:', err)
    return NextResponse.json({ error: '保存背词计划失败' }, { status: 500 })
  }
}
