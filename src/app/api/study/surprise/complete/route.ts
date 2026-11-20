/**
 * POST /api/study/surprise/complete —— 突击测验回执落库 + 学习闭环回流
 *
 * - attempt 快照(含题目构成)落 SurpriseQuizAttempt,供 7 天冷却与统计
 * - 错题本源(sourceNoteId):答对/答错都写 FSRS(good/again)+ StudyNoteReviewLog
 *   (source=surprise_quiz)——突击是错题卡的又一面复习镜子
 * - 课本/事件源答错:按题干幂等键(surprise:<hash>)自动建 StudyNote
 *   (origin=surprise_quiz,dueAt=now 即进今日复习),答对不建卡
 *
 * 判分在服务端重算(right = answer === userAnswer),不信任客户端结果字段。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/api-auth'
import { prisma } from '@/lib/db'
import { scheduleReview, type FsrsInput } from '@/lib/study/fsrs'
import { captureStudyNote } from '@/lib/study/note-capture'
import type { SurpriseItem, SurpriseSource } from '@/lib/study/surprise'

const TRIGGERS = ['manual', 'demo', 'weekday_window', 'weekend', 'catchup']

const SOURCES: SurpriseSource[] = ['wrong_note', 'textbook', 'scratch']

/** 题干幂等键:同一道突击题只回流一张卡 */
function stemKey(stem: string): string {
  let h = 5381
  for (let i = 0; i < stem.length; i++) h = ((h << 5) + h + stem.charCodeAt(i)) | 0
  return `surprise:${(h >>> 0).toString(36)}`
}

interface IncomingItem extends Partial<SurpriseItem> {
  userAnswer?: string
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }

  const rawItems = Array.isArray(body.items) ? (body.items as IncomingItem[]) : []
  if (!rawItems.length || rawItems.length > 10) {
    return NextResponse.json({ error: 'bad_items' }, { status: 400 })
  }

  // 字段白名单 + 服务端判分
  const items: (SurpriseItem & { userAnswer: string; right: boolean })[] = []
  for (const raw of rawItems) {
    const source = SOURCES.includes(raw.source as SurpriseSource) ? raw.source : null
    if (!source) return NextResponse.json({ error: 'bad_items' }, { status: 400 })
    const stem = typeof raw.stem === 'string' ? raw.stem.trim().slice(0, 400) : ''
    if (!stem) return NextResponse.json({ error: 'bad_items' }, { status: 400 })
    const letters = ['A', 'B', 'C', 'D'] as const
    const answer = String(raw.answer ?? '').trim().toUpperCase()
    const userAnswer = String(raw.userAnswer ?? '').trim().toUpperCase()
    if (!(letters as readonly string[]).includes(answer)) {
      return NextResponse.json({ error: 'bad_items' }, { status: 400 })
    }
    const options = (Array.isArray(raw.options) ? raw.options : [])
      .filter((o) => !!o && typeof o.text === 'string')
      .slice(0, 4)
      .map((o, i) => ({ letter: letters[i], text: String(o.text).slice(0, 160) }))
    items.push({
      source,
      topic: typeof raw.topic === 'string' ? raw.topic.slice(0, 12) : '概念',
      stem,
      options,
      answer: answer as (typeof letters)[number],
      analysis: typeof raw.analysis === 'string' ? raw.analysis.slice(0, 200) : '',
      sourceNoteId: typeof raw.sourceNoteId === 'string' ? raw.sourceNoteId.slice(0, 64) : undefined,
      sourceRef: typeof raw.sourceRef === 'string' ? raw.sourceRef.slice(0, 80) : undefined,
      sourceChunkId: typeof raw.sourceChunkId === 'string' ? raw.sourceChunkId.slice(0, 64) : undefined,
      userAnswer,
      right: answer === userAnswer,
    })
  }

  const num = (v: unknown, lo: number, hi: number): number | null => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null
  }
  const durationSec = num(body.durationSec, 0, 7200)
  const trigger =
    typeof body.trigger === 'string' && TRIGGERS.includes(body.trigger) ? body.trigger : 'manual'

  // 1. 回执快照(冷却与统计的数据源)
  await prisma.surpriseQuizAttempt.create({
    data: {
      userId,
      trigger,
      items: items.map((i) => ({
        source: i.source,
        topic: i.topic,
        stem: i.stem,
        options: i.options,
        answer: i.answer,
        analysis: i.analysis,
        ...(i.sourceNoteId ? { sourceNoteId: i.sourceNoteId } : {}),
        ...(i.sourceRef ? { sourceRef: i.sourceRef } : {}),
        ...(i.sourceChunkId ? { sourceChunkId: i.sourceChunkId } : {}),
        userAnswer: i.userAnswer,
        right: i.right,
      })),
      total: items.length,
      correct: items.filter((i) => i.right).length,
      durationSec: durationSec ?? null,
      escaped: false,
    },
  })

  // 2. 学习闭环回流
  const reflowed: string[] = []
  for (const item of items) {
    try {
      if (item.source === 'wrong_note' && item.sourceNoteId) {
        // 错题卡双写:答对 good / 答错 again(突击=另一面复习镜子)
        const note = await prisma.studyNote.findFirst({
          where: { id: item.sourceNoteId, userId },
          select: {
            id: true, mastery: true, stability: true, difficulty: true, state: true,
            dueAt: true, lastReviewAt: true, reps: true, lapses: true,
          },
        })
        if (!note) continue
        const next = scheduleReview(note as FsrsInput, item.right ? 'good' : 'again')
        await prisma.studyNote.update({
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
        })
        await prisma.studyNoteReviewLog.create({
          data: {
            noteId: note.id,
            rating: next.ratingValue,
            masteryBefore: note.mastery,
            masteryAfter: next.mastery,
            source: 'surprise_quiz',
          },
        })
      } else if (item.source !== 'wrong_note' && !item.right) {
        // 课本/事件源答错 → 自动建卡(dueAt=now 进今日复习;同题干幂等)
        const res = await captureStudyNote({
          userId,
          sourceMessageId: stemKey(item.stem),
          origin: 'surprise_quiz',
          question: item.stem,
          analysis: `突击测验答错。正确答案:${item.answer}。${item.analysis}`,
        })
        if (res.created) reflowed.push(item.topic)
      }
    } catch (err) {
      // 单题回流失败不阻塞整卷回执,记日志继续
      console.error('[study/surprise] reflow failed:', err)
    }
  }

  return NextResponse.json({
    ok: true,
    total: items.length,
    correct: items.filter((i) => i.right).length,
    reflowed,
  })
}
