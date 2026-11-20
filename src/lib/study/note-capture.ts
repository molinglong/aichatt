/**
 * 错题建卡统一入口(server-only):
 * 手动「存入错题本」、学习模式结课自动归档、题库练习转卡都走同一套幂等口径。
 *
 * 幂等键:sourceMessageId(学习模式统一映射到会话首条用户消息 id,一题一卡;
 * 普通聊天仍是具体消息 id)。唯一约束见 prisma schema `StudyNote_userId_sourceMessageId_key`,
 * 并发重复点击由 P2002 兜底回读已有记录。
 */
import { prisma } from '@/lib/db'
import { newCardFields } from './fsrs'
import { resolveStudyModel, tagNote } from './tagging'

export interface CaptureStudyNoteInput {
  userId: string
  sourceMessageId?: string | null
  sourceQuestionId?: string | null
  /** 建卡来源标记,写入 StudyNote.origin;缺省 manual */
  origin?: string
  /** 题干正文(必填语义:空则用占位文案) */
  question: string
  analysis?: string | null
  imageUrl?: string | null
  subject?: string | null
  topic?: string | null
  title?: string
}

export interface CaptureStudyNoteResult {
  id: string
  created: boolean
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'P2002'
}

function noteTitle(input: CaptureStudyNoteInput): string {
  const raw = (input.title ?? input.question).replace(/\s+/g, ' ').trim()
  return raw.slice(0, 40) || '错题'
}

export async function captureStudyNote(input: CaptureStudyNoteInput): Promise<CaptureStudyNoteResult> {
  const sourceMessageId = input.sourceMessageId?.trim() || null

  if (sourceMessageId) {
    const existing = await prisma.studyNote.findFirst({
      where: { userId: input.userId, sourceMessageId },
      select: { id: true },
    })
    if (existing) return { id: existing.id, created: false }
  }

  const card = newCardFields()
  try {
    const row = await prisma.studyNote.create({
      data: {
        userId: input.userId,
        sourceMessageId,
        sourceQuestionId: input.sourceQuestionId?.trim() || null,
        origin: input.origin ?? 'manual',
        // 打标前保持 null:前端显示「未标注」,而不是把失败伪装成「其他」
        subject: input.subject ?? null,
        topic: input.topic ?? null,
        title: noteTitle(input),
        content: input.question.trim() || (input.imageUrl ? '(题目见截图)' : '(本题见原对话)'),
        imageUrl: input.imageUrl ?? null,
        analysis: input.analysis?.trim() || null,
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
    tagStudyNoteInBackground(input.userId, row.id, input.question, input.analysis)
    return { id: row.id, created: true }
  } catch (err) {
    if (isUniqueViolation(err) && sourceMessageId) {
      const existing = await prisma.studyNote.findFirst({
        where: { userId: input.userId, sourceMessageId },
        select: { id: true },
      })
      if (existing) return { id: existing.id, created: false }
    }
    throw err
  }
}

/** 后台打标:失败只记日志,不阻塞建卡;前端可对 subject=null 的卡手动重试 */
export function tagStudyNoteInBackground(
  userId: string,
  noteId: string,
  question: string,
  analysis?: string | null
): void {
  void (async () => {
    try {
      const model = await resolveStudyModel(userId)
      if (!model) return
      const tags = await tagNote(model, question, analysis)
      if (!tags) return
      await prisma.studyNote.update({
        where: { id: noteId },
        data: { subject: tags.subject, topic: tags.topic, title: tags.title },
      })
    } catch (err) {
      console.error('[study/note] tagging failed:', err)
    }
  })()
}
