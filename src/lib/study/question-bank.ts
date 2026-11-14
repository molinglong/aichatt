/**
 * 题库共享核心（server-only，依赖 prisma）—— 抽题、判分回传落库、存在性闸门。
 *
 * chat 工具（practice_questions / record_practice）与 REST（/api/study/quiz/practice）
 * 共用本文件，保证对话练题与页面练习两条路径的落库口径一致。
 */
import { prisma } from '@/lib/db'
import { libraryScopes } from '@/lib/library-scope'
import { newCardFields } from '@/lib/study/fsrs'
import { NOTE_SUBJECTS } from '@/lib/study/tagging'
import { monitor } from '@/lib/monitor'
import type { PracticeItem, PracticeToolInput } from '@/lib/ai/practice-tool'

const DEFAULT_COUNT = 3
const MAX_COUNT = 5
/** 候选池上限：池内洗牌保证抽题面足够，又不全表拉取 */
const POOL_LIMIT = 200

export interface DrawOptions
  extends Pick<PracticeToolInput, 'subject' | 'topic' | 'year' | 'difficulty' | 'kind' | 'count'> {}

/**
 * 按考点/年份/难度/题型过滤后随机抽题（默认 3 道，最多 5 道）。
 * 年份按 sourceRef 包含匹配（出处形如「…（2022.6真题）」）；
 * refLine 取 sourceRef 末段并前置「题库」——渲染层正则要求出处不含「·」，
 * 且「题库」前缀让前端知道这是库内原题、不再显示「收进题库」按钮。
 */
export async function drawQuestions(userId: string, opts: DrawOptions = {}): Promise<PracticeItem[]> {
  const count = Math.min(Math.max(opts.count ?? DEFAULT_COUNT, 1), MAX_COUNT)
  const rows = await prisma.question.findMany({
    where: {
      userId: { in: await libraryScopes(userId) },
      ...(opts.subject ? { subject: opts.subject } : {}),
      ...(opts.topic ? { topic: { contains: opts.topic, mode: 'insensitive' as const } } : {}),
      ...(opts.year ? { sourceRef: { contains: opts.year, mode: 'insensitive' as const } } : {}),
      ...(opts.difficulty ? { difficulty: opts.difficulty } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
    },
    select: {
      id: true,
      kind: true,
      stem: true,
      answer: true,
      topic: true,
      difficulty: true,
      sourceRef: true,
    },
    orderBy: { createdAt: 'desc' },
    take: POOL_LIMIT,
  })
  if (!rows.length) return []

  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rows[i], rows[j]] = [rows[j], rows[i]]
  }

  return rows.slice(0, count).map((r) => {
    const tail = (r.sourceRef ?? '').split('·').pop()?.trim() ?? ''
    return {
      id: r.id,
      kind: r.kind,
      stem: r.stem,
      answer: r.answer,
      topic: r.topic,
      difficulty: r.difficulty,
      refLine: tail ? `题库 ${tail}` : '题库',
    }
  })
}

export type PracticeOutcome = 'ok' | 'card-created' | 'card-existing' | 'notfound'

export interface PracticeAttemptResult {
  outcome: PracticeOutcome
  noteId?: string
}

/**
 * 判分回传落库：答错 → 由 Question 同步建错题卡（FSRS newCardFields，
 * dueAt=now 立即进今日复习队列）；同题已有错题卡则幂等复用，不重复建卡。
 * 学科/考点直接继承 Question（超出 NOTE_SUBJECTS 降级 other），不走 AI 打标——同步快速路径。
 * 答对与归属不符（非本人题目按 notfound 处理）不落库。
 */
export async function recordPracticeAttempt(
  userId: string,
  questionId: string,
  result: 'right' | 'wrong',
  userAnswer?: string
): Promise<PracticeAttemptResult> {
  const question = await prisma.question.findFirst({
    where: { id: questionId, userId: { in: await libraryScopes(userId) } },
  })
  if (!question) return { outcome: 'notfound' }
  if (result !== 'wrong') return { outcome: 'ok' }

  const existing = await prisma.studyNote.findFirst({
    where: { userId, sourceQuestionId: question.id },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) {
    monitor('practice_idempotent_reuse', { questionId: question.id, noteId: existing.id })
    return { outcome: 'card-existing', noteId: existing.id }
  }

  const ua = (userAnswer ?? '').trim().slice(0, 2000)
  const card = newCardFields()
  const row = await prisma.studyNote.create({
    data: {
      userId,
      sourceQuestionId: question.id,
      subject: (NOTE_SUBJECTS as readonly string[]).includes(question.subject)
        ? question.subject
        : 'other',
      topic: question.topic,
      title: question.stem.replace(/\s+/g, ' ').trim().slice(0, 40) || '错题',
      content: question.stem + (ua ? `\n\n我的答案:${ua}` : ''),
      analysis: question.answer + (question.sourceRef ? `\n\n> 出处:${question.sourceRef}` : ''),
      mastery: 0,
      stability: card.stability,
      difficulty: card.difficulty,
      state: card.state,
      dueAt: card.dueAt,
      reps: card.reps,
      lapses: card.lapses,
    },
    select: { id: true },
  })
  monitor('practice_card_created', { questionId: question.id, noteId: row.id })
  return { outcome: 'card-created', noteId: row.id }
}

/** 归属(自己+公共库)下是否存在题目（物理级注入闸门：没题库则练题工具完全不挂载） */
export async function hasQuestions(userId: string): Promise<boolean> {
  const row = await prisma.question.findFirst({
    where: { userId: { in: await libraryScopes(userId) } },
    select: { id: true },
  })
  return !!row
}
