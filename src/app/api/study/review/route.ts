import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { scheduleReview, type ReviewRating } from '@/lib/study/fsrs'

/**
 * POST /api/study/review - 复习自评
 * body: { noteId, rating: 'again' | 'good', source?: 'redo' | 'variant' }
 * source 缺省=翻卡手动自评;redo=重做题库原题判分,variant=同考点变式判分(写入 ReviewLog.source 供统计)。
 * → FSRS 排期 + 掌握度更新 + ReviewLog 落库
 * → lapses 首次达到 2 时写入 learning_gap 长期记忆(source='manual' → 始终注入对话)
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  let body: { noteId?: string; rating?: string; source?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  const rating: ReviewRating = body.rating === 'good' ? 'good' : 'again'
  const source = body.source === 'redo' || body.source === 'variant' ? body.source : null
  if (!body.noteId) {
    return NextResponse.json({ error: '缺少 noteId' }, { status: 400 })
  }

  try {
    // 归属校验:非本人记录视为不存在
    const note = await prisma.studyNote.findFirst({
      where: { id: body.noteId, userId },
    })
    if (!note) {
      return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
    }

    const before = note.mastery
    const next = scheduleReview(note, rating)

    const [updated] = await prisma.$transaction([
      prisma.studyNote.update({
        where: { id: note.id },
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
      prisma.studyNoteReviewLog.create({
        data: {
          noteId: note.id,
          rating: next.ratingValue,
          masteryBefore: before,
          masteryAfter: next.mastery,
          source,
        },
      }),
    ])

    // B5: 遗忘达到 2 次 → 薄弱点写入长期记忆(始终注入)
    if (next.lapses >= 2 && note.lapses < 2) {
      try {
        const label = note.topic || note.title.slice(0, 12)
        const exists = await prisma.memory.findFirst({
          where: { userId, category: 'learning_gap', content: { contains: label } },
          select: { id: true },
        })
        if (!exists) {
          await prisma.memory.create({
            data: {
              userId,
              category: 'learning_gap',
              content: `用户在「${label}」考点反复出错(错题本已记录 ${next.lapses} 次遗忘),讲题时优先检查此处`,
              source: 'manual', // manual → getRelevantMemories 始终注入
            },
          })
          console.log(`[study/review] learning_gap saved: ${label}`)
        }
      } catch (err) {
        // 记忆写入失败不影响复习主流程
        console.error('[study/review] learning_gap failed:', err)
      }
    }

    return NextResponse.json({
      id: updated.id,
      mastery: updated.mastery,
      masteryBefore: before,
      reps: updated.reps,
      lapses: updated.lapses,
      dueAt: updated.dueAt,
      nextDueAt: next.dueAt,
    })
  } catch (err) {
    console.error('[study/review] failed:', err)
    return NextResponse.json({ error: '复习提交失败' }, { status: 500 })
  }
}
