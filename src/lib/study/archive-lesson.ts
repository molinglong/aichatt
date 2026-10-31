/**
 * 学习模式结课自动归档(server-only)。
 *
 * 一题一课:题干取会话首条用户消息(学习室拼的开场白),解析取最终讲解正文,
 * 题图取首条消息附件。sourceMessageId 统一用首条用户消息 id,
 * 这样自动归档、手动存入、重新生成都命中同一张卡(配合唯一约束)。
 */
import { prisma } from '@/lib/db'
import { parseFavoriteAttachments, firstImageUrl } from '@/lib/favorites'
import { captureStudyNote, type CaptureStudyNoteResult } from './note-capture'

export const STUDY_OPENING_PREFIX = '请帮我理解这道题。'

/** 学习室开场白 → 原题正文;非学习室消息返回 null */
export function questionFromStudyOpening(content: string): string | null {
  if (!content.startsWith(STUDY_OPENING_PREFIX)) return null
  const body = content
    .slice(STUDY_OPENING_PREFIX.length)
    .split('\n\n学习起点：')[0]
    .trim()
  if (!body || body === '题目见附件。') return ''
  return body
}

export function isStudyOpening(content: string): boolean {
  return content.startsWith(STUDY_OPENING_PREFIX)
}

/**
 * 手动存入时把「被点的消息 id」映射成学习模式稳定键:
 * 若该消息所在会话是学习室(首条用户消息带开场白),用首条用户消息 id;
 * 普通聊天保持原消息 id,支持一聊多题。
 */
export async function resolveStudySourceMessageId(
  userId: string,
  sourceMessageId: string
): Promise<string> {
  const msg = await prisma.message.findFirst({
    where: { id: sourceMessageId, conversation: { userId } },
    select: { conversationId: true },
  })
  if (!msg) return sourceMessageId
  const firstUser = await prisma.message.findFirst({
    where: { conversationId: msg.conversationId, role: 'user' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, content: true },
  })
  return firstUser && isStudyOpening(firstUser.content) ? firstUser.id : sourceMessageId
}

/** 结课自动归档:幂等,失败返回 null(不阻塞讲解落库) */
export async function archiveStudyLesson(
  userId: string,
  conversationId: string,
  assistantMessageId: string
): Promise<CaptureStudyNoteResult | null> {
  const [firstUser, assistant] = await Promise.all([
    prisma.message.findFirst({
      where: { conversationId, role: 'user' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, content: true, attachments: true },
    }),
    prisma.message.findFirst({
      where: { id: assistantMessageId, conversationId, role: 'assistant' },
      select: { id: true, content: true },
    }),
  ])

  if (!firstUser || !assistant?.content.trim()) return null
  const question = questionFromStudyOpening(firstUser.content)
  // 不是学习室会话(手动开的普通聊天)不自动收卡,避免污染错题本
  if (question === null) return null

  const imageUrl = firstImageUrl(parseFavoriteAttachments(firstUser.attachments))
  if (!question && !imageUrl) return null

  return captureStudyNote({
    userId,
    sourceMessageId: firstUser.id,
    question: question || '(题目见附件)',
    analysis: assistant.content,
    imageUrl,
  })
}
