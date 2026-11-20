/**
 * POST /api/study/evening-quiz/complete —— 今晚测验回执落库
 *
 * 测完（releasedBy=quiz 测完即放 / fallback 兜底放行）或无锁环境跳过
 * （skip）时调用。落回执后该卷当天不再进队列；wrongQuestionIds 指向
 * PaperQuestion，留复盘入口。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/api-auth'
import { prisma } from '@/lib/db'

const RELEASED_BY = ['quiz', 'fallback', 'skip']

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }

  const num = (v: unknown, lo: number, hi: number): number | null => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null
  }

  const composedId = typeof body.composedId === 'string' ? body.composedId : ''
  const origTotal = num(body.origTotal, 1, 200)
  const origRight = num(body.origRight, 0, 200)
  if (!composedId || origTotal == null || origRight == null || origRight > origTotal) {
    return NextResponse.json({ error: 'bad_body' }, { status: 400 })
  }
  const own = await prisma.composedPaper.findFirst({
    where: { id: composedId, userId },
    select: { id: true },
  })
  if (!own) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const variantTotal = num(body.variantTotal, 0, 50) ?? 0
  const variantRight = num(body.variantRight, 0, 50) ?? 0
  const durationSec = num(body.durationSec, 0, 7200)
  const wrongQuestionIds = Array.isArray(body.wrongQuestionIds)
    ? body.wrongQuestionIds.filter((v): v is string => typeof v === 'string').slice(0, 200)
    : []
  const releasedBy =
    typeof body.releasedBy === 'string' && RELEASED_BY.includes(body.releasedBy)
      ? body.releasedBy
      : 'quiz'

  await prisma.eveningTest.create({
    data: {
      userId,
      composedId,
      origTotal,
      origRight,
      variantTotal,
      variantRight,
      wrongQuestionIds,
      durationSec,
      releasedBy,
    },
  })
  return NextResponse.json({ ok: true })
}
