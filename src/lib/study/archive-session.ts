/**
 * 学习会话结课归档(server-only):
 * StudySession 完成(模型调 finish_study 或用户手动结课)后,把整道题沉淀为
 * 一张错题卡(StudyNote),进 FSRS 复习队列。
 *
 * - 幂等键:sourceMessageId = `study:{sessionId}`(一题一卡,复用 captureStudyNote 的幂等口径)
 * - 过程自评折算:讲解中每按一次「没懂」(StudyStep.selfRating=again),新卡初始掌握度下调,
 *   让复习排期从第一面就照顾薄弱点
 */
import { prisma } from '@/lib/db'
import { captureStudyNote } from './note-capture'
import { createPing } from '@/lib/ai/main-chat.server'

const AGAIN_MASTERY_PENALTY = 0.15

/** 归档一条学习会话;幂等,重复调用返回已有卡 */
export async function archiveStudySession(userId: string, sessionId: string): Promise<{ id: string; created: boolean } | null> {
  const session = await prisma.studySession.findFirst({
    where: { id: sessionId, userId },
    include: { steps: { orderBy: { idx: 'asc' } } },
  })
  if (!session) return null

  // 讲解内容拼解析:结课总结打头,后面保留每步正文(复习卡背面 = 完整回看)
  const stepBlocks = session.steps
    .filter((s) => s.content.trim())
    .map((s) => `### 第 ${s.idx + 1} 步\n\n${s.content.trim()}`)
  const analysis = [session.summary?.trim(), ...stepBlocks].filter(Boolean).join('\n\n') || null

  // 过程自评折算:again 越多,初始掌握度越低(下限 0.05)
  const againCount = session.steps.filter((s) => s.selfRating === 'again').length
  const mastery = Math.max(0.05, 0.5 - againCount * AGAIN_MASTERY_PENALTY)

  const result = await captureStudyNote({
    userId,
    sourceMessageId: `study:${session.id}`,
    question: session.question,
    analysis,
    imageUrl: session.images[0] ?? null,
    title: session.question.replace(/\s+/g, ' ').trim(),
  })

  if (result.created && againCount > 0) {
    await prisma.studyNote
      .update({ where: { id: result.id }, data: { mastery } })
      .catch(() => {})
  }

  // 主对话 ping:结课归档通知(带回看按钮)
  await createPing(userId, 'lesson_archived', {
    sessionId: session.id,
    question: session.question,
    steps: session.steps.length,
    weak: againCount > 0,
  }).catch(() => {})

  return result
}
