import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { deriveSpellRating, scheduleWord, type WordRating } from '@/lib/words/fsrs'

/**
 * POST /api/words/review —— 提交一张单词卡的评级
 * body: { userWordId, card: 'flip' | 'spell', rating?: 1-4, correct?: boolean, elapsedMs?: number }
 * - flip 卡：直接吃用户 4 档自评（rating 必填）
 * - spell 卡：吃程序判分（correct + 用时），由服务端换算评级，避免前端"自评放水"
 *   hint=true（拼写时点了发音）＝不是独立回忆：即使拼对也按「忘记」结算（Alan 式口径）
 * → FSRS 排期 + 掌握度更新 + WordReviewLog 落库（scheduledDays 用于后续校准阈值）
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  let body: { userWordId?: string; card?: string; rating?: number; correct?: boolean; elapsedMs?: number; hint?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  if (!body.userWordId) {
    return NextResponse.json({ error: '缺少 userWordId' }, { status: 400 })
  }

  const card = body.card === 'spell' ? 'spell' : 'flip'
  let rating: WordRating | null = null
  if (card === 'spell') {
    if (typeof body.correct !== 'boolean') {
      return NextResponse.json({ error: '拼写卡需要 correct 判定' }, { status: 400 })
    }
    // 用了发音提示 = 没独立想起来：拼对也记忘记,FSRS 次日再查(当天内重复只算练习,由前端控制不再提交)
    rating = body.hint && body.correct ? 1 : deriveSpellRating(body.correct, Math.max(0, body.elapsedMs ?? 0))
  } else {
    const r = Number(body.rating)
    if (r !== 1 && r !== 2 && r !== 3 && r !== 4) {
      return NextResponse.json({ error: '评级必须是 1-4' }, { status: 400 })
    }
    rating = r as WordRating
  }

  try {
    // 归属校验：非本人记录视为不存在
    const word = await prisma.userWord.findFirst({ where: { id: body.userWordId, userId } })
    if (!word) {
      return NextResponse.json({ error: '这个词不在你的词库里' }, { status: 404 })
    }

    const now = new Date()
    const before = word.mastery
    const next = scheduleWord(word, rating, now)
    const elapsedDays = word.lastReviewAt
      ? Math.max(0, Math.round((now.getTime() - word.lastReviewAt.getTime()) / 86_400_000))
      : null

    const [updated] = await prisma.$transaction([
      prisma.userWord.update({
        where: { id: word.id },
        data: {
          stability: next.stability,
          difficulty: next.difficulty,
          state: next.state,
          dueAt: next.dueAt,
          lastReviewAt: next.lastReviewAt,
          reps: next.reps,
          lapses: next.lapses,
          mastery: next.mastery,
        },
      }),
      prisma.wordReviewLog.create({
        data: {
          userWordId: word.id,
          userId,
          rating: next.ratingValue,
          source: card,
          masteryBefore: before,
          masteryAfter: next.mastery,
          elapsedDays,
          scheduledDays: Math.round(next.scheduledDays),
        },
      }),
    ])

    return NextResponse.json({
      id: updated.id,
      rating: next.ratingValue,
      mastery: updated.mastery,
      masteryBefore: before,
      reps: updated.reps,
      lapses: updated.lapses,
      dueAt: updated.dueAt,
      scheduledDays: Math.round(next.scheduledDays),
    })
  } catch (err) {
    console.error('[words/review] failed:', err)
    return NextResponse.json({ error: '提交复习结果失败' }, { status: 500 })
  }
}
