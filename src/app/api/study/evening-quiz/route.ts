/**
 * GET /api/study/evening-quiz?since=<ms> —— 今晚测验队列
 *
 * 判定口径（已拍板）：客户端本地日界（since，本地零点毫秒）以来在 App 内
 * 打印过、且尚未有今晚测验回执的组卷。有回执的卷当天剔除；全卷无答案的
 * 卷测不了，不进队列。origCount = 有答案的槽位数（choice 自动判分、
 * answer 展示答案自判），无答案槽跳过。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/api-auth'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const sinceMs = Number(req.nextUrl.searchParams.get('since') || 0)
  const since = new Date(sinceMs)
  // since 必须是近 48h 内的毫秒值，防全表扫
  if (!(sinceMs > 0) || Number.isNaN(since.getTime()) || Date.now() - since.getTime() > 48 * 3600_000) {
    return NextResponse.json({ error: 'bad_since' }, { status: 400 })
  }

  const events = await prisma.printEvent.findMany({
    where: { userId, kind: 'composed', createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: { targetId: true, createdAt: true },
  })
  if (!events.length) return NextResponse.json({ papers: [] })

  const stat = new Map<string, { printCount: number; lastPrintAt: string }>()
  for (const e of events) {
    const iso = e.createdAt.toISOString()
    const s = stat.get(e.targetId) ?? { printCount: 0, lastPrintAt: iso }
    s.printCount++
    if (iso > s.lastPrintAt) s.lastPrintAt = iso
    stat.set(e.targetId, s)
  }

  const tested = await prisma.eveningTest.findMany({
    where: { userId, createdAt: { gte: since } },
    select: { composedId: true },
  })
  const testedSet = new Set(tested.map((t) => t.composedId))
  const ids = Array.from(stat.keys()).filter((id) => !testedSet.has(id))
  if (!ids.length) return NextResponse.json({ papers: [] })

  const papers = await prisma.composedPaper.findMany({
    where: { id: { in: ids }, userId },
    select: {
      id: true,
      title: true,
      subject: true,
      slots: {
        select: {
          paperQuestionId: true,
          inlineStem: true,
          inlineAnswer: true,
          paperQuestion: { select: { answer: true } },
        },
      },
    },
  })

  const out = papers
    .map((p) => {
      const origCount = p.slots.filter(
        (s) => s.paperQuestion?.answer != null || s.inlineAnswer != null
      ).length
      const meta = stat.get(p.id)
      return {
        id: p.id,
        title: p.title,
        subject: p.subject,
        printCount: meta?.printCount ?? 0,
        lastPrintAt: meta?.lastPrintAt ?? '',
        origCount,
      }
    })
    .filter((p) => p.origCount > 0)
    .sort((a, b) => (a.lastPrintAt < b.lastPrintAt ? 1 : -1)) // 最近打印的先测（记忆最新鲜）

  return NextResponse.json({ papers: out })
}
