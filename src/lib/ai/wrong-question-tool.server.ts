/**
 * 错题本存入工具——服务端工厂（server-only，依赖 prisma）。
 *
 * 常量/schema 在 wrong-question-tool.ts（isomorphic）；建卡统一走
 * lib/study/note-capture.ts 的 captureStudyNote（幂等键 sourceMessageId，
 * 与手动存入/学习归档/题库转卡同一套口径），后台 AI 打标兜底。
 *
 * sourceMessageId 用惰性 getter：工厂创建时草稿消息行尚未建立（convId /
 * draftMessageId 都在其后赋值），首次 execute 时已确定（与 writeCodeTool
 * 拿 convId 同款惰性单例）。同一 assistant 回合只建一张卡——用户在同一
 * 回合里重复说「存」，幂等命中不会重复建卡。
 */
import { tool } from 'ai'
import {
  saveWrongQuestionInputSchema,
  type SaveWrongQuestionToolOutput,
} from './wrong-question-tool'
import { captureStudyNote } from '@/lib/study/note-capture'

export function createSaveWrongQuestionTool(
  userId: string,
  getSourceMessageId: () => string | null
) {
  return tool({
    description:
      '错题本存入工具。用户明确要求把某道题添加/存入错题本时调用（如「帮我把这道题添加到错题本 这道题我做错了」）：把题干、用户的错误答案与正确解法存成一张复习卡，自动进入复习队列。用户没有要求时禁止主动调用。',
    inputSchema: saveWrongQuestionInputSchema,
    execute: async (input): Promise<SaveWrongQuestionToolOutput> => {
      try {
        // 我的答案/正确答案结构化拼进 analysis，与手动存入的「完整题目+解答」口径一致
        const answerParts = [
          input.userAnswer ? `我的答案：${input.userAnswer}` : null,
          input.correctAnswer ? `正确答案：${input.correctAnswer}` : null,
        ].filter(Boolean)
        const analysis =
          [answerParts.join('\n'), input.analysis].filter(Boolean).join('\n\n') || null
        const row = await captureStudyNote({
          userId,
          sourceMessageId: getSourceMessageId(),
          question: input.question,
          analysis,
          subject: input.subject ?? null,
          topic: input.topic ?? null,
        })
        return {
          id: row.id,
          created: row.created,
          title: input.question.replace(/\s+/g, ' ').trim().slice(0, 40) || '错题',
          note: row.created
            ? '已存入错题本。请向用户简短确认（考点/错因一句话），不要重复贴出完整题目与解析。'
            : '该题此前已存入错题本（同一条消息只建一张卡）。请如实告知用户，不要重复建卡。',
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知存入错误'
        console.error('[save-wrong-question-tool]', message)
        return {
          id: '',
          created: false,
          title: '',
          error: message,
          note: '存入错题本失败。请如实告知用户稍后重试，不要声称已存入。',
        }
      }
    },
  })
}
