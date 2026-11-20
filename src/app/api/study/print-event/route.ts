/**
 * POST /api/study/print-event —— 打印事件上报（今晚测验的数据源）
 *
 * 计数点 = 打印对话框真实弹出（beforeprint），打印按钮 / Ctrl+P 皆覆盖；
 * 打开打印页未弹对话框不计。物理张数与校外复印感知不到，口径即 App 内
 * 触发的打印对话框次数（已拍板）。起步只接组卷（kind=composed），
 * targetId 必须是本人名下的组卷，防垃圾行；word-sheet/passage 预留。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/api-auth'
import { prisma } from '@/lib/db'

const KINDS = ['composed', 'word-sheet', 'passage']

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { kind?: unknown; targetId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }
  const kind = typeof body.kind === 'string' ? body.kind : ''
  const targetId = typeof body.targetId === 'string' ? body.targetId : ''
  if (!KINDS.includes(kind) || !targetId) {
    return NextResponse.json({ error: 'need_kind_targetId' }, { status: 400 })
  }
  if (kind === 'composed') {
    const own = await prisma.composedPaper.findFirst({
      where: { id: targetId, userId },
      select: { id: true },
    })
    if (!own) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  await prisma.printEvent.create({ data: { userId, kind, targetId } })
  return NextResponse.json({ ok: true })
}

/**
 * GET /api/study/print-event?since=<本地零点毫秒> —— 打印足迹聚合(拟卷页足迹卡数据源)
 *
 * 今日口径与今晚测验同源:客户端本地零点 since(近 48h 校验防全表扫)。
 * today.all = since 以来全部 kind 打印次数;today.composed = 其中拟卷(今晚测验监察对象)。
 * todayCounts = 今日按 kind:targetId 的次数(足迹卡「今日 N 次」用,超出 today 的行不标次数)。
 * recent = 最近 8 条事件(composed 带卷名;word-sheet/passage 暂无写入方,预留展示位)。
 */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const sinceMs = Number(req.nextUrl.searchParams.get('since') || 0)
  const since = new Date(sinceMs)
  if (!(sinceMs > 0) || Number.isNaN(since.getTime()) || Date.now() - since.getTime() > 48 * 3600_000) {
    return NextResponse.json({ error: 'bad_since' }, { status: 400 })
  }

  const dayEvents = await prisma.printEvent.findMany({
    where: { userId, createdAt: { gte: since } },
    select: { kind: true, targetId: true },
  })
  const todayCounts: Record<string, number> = {}
  let todayComposed = 0
  for (const e of dayEvents) {
    todayCounts[`${e.kind}:${e.targetId}`] = (todayCounts[`${e.kind}:${e.targetId}`] ?? 0) + 1
    if (e.kind === 'composed') todayComposed++
  }

  const recent = await prisma.printEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { id: true, kind: true, targetId: true, createdAt: true },
  })
  const composedIds = Array.from(new Set(recent.filter((r) => r.kind === 'composed').map((r) => r.targetId)))
  const papers = composedIds.length
    ? await prisma.composedPaper.findMany({
        where: { id: { in: composedIds }, userId },
        select: { id: true, title: true },
      })
    : []
  const titleMap = new Map(papers.map((p) => [p.id, p.title]))

  return NextResponse.json({
    today: { all: dayEvents.length, composed: todayComposed },
    todayCounts,
    recent: recent.map((r) => ({
      id: r.id,
      kind: r.kind,
      targetId: r.targetId,
      createdAt: r.createdAt.toISOString(),
      title: titleMap.get(r.targetId) ?? null,
    })),
  })
}
