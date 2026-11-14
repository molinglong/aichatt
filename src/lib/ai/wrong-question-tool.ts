/**
 * 错题本存入工具（save_wrong_question）—— 纯常量模块（isomorphic）
 *
 * ⚠ 本文件禁止 import prisma/ai 等服务端依赖（ToolCallCard 只需要工具名与输出类型，
 * 混入会连 pg 一起打进客户端 bundle 报 fs 错误）；
 * 工厂在 wrong-question-tool.server.ts，建卡统一口径在 lib/study/note-capture.ts。
 *
 * 触发纪律：用户明确要求把题存入错题本（指令式），AI 不主动替用户存。
 * 与 record_practice（题库练题答错自动进本）互补：本工具覆盖聊天讲题场景——
 * 截图问答、AI 现场出的题、对话中讨论的任何题。
 */
import { z } from 'zod'

export const SAVE_WRONG_QUESTION_TOOL_NAME = 'save_wrong_question'

/** 学科枚举与 SUBJECT_LABELS 受控词表一致（subject-labels.ts / tagging.ts） */
export const saveWrongQuestionInputSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      '完整题干原文（选择题含每个选项行，保留 $...$ 公式与图说明），从对话上文逐字提取，不得编造'
    ),
  userAnswer: z
    .string()
    .max(1000)
    .optional()
    .describe('用户的作答原话（通常是错误答案）；用户还没作答就不传'),
  correctAnswer: z
    .string()
    .max(1000)
    .optional()
    .describe('正确答案（简短结论）；对话里还没得出正确答案就不传'),
  analysis: z
    .string()
    .max(2000)
    .optional()
    .describe('关键错因/解法一句话，复习卡背面展示'),
  subject: z
    .enum(['math', 'english', 'chinese', 'physics', 'chemistry', 'biology', 'history', 'geography', 'politics', 'other'])
    .optional()
    .describe('学科；不确定就不传，后台会自动打标'),
  topic: z
    .string()
    .max(12)
    .optional()
    .describe('考点短语，如「正弦定理」；不确定就不传'),
})

export type SaveWrongQuestionToolInput = z.infer<typeof saveWrongQuestionInputSchema>

export interface SaveWrongQuestionToolOutput {
  /** StudyNote.id；失败时为空串 */
  id: string
  /** true=新建卡；false=幂等命中（此前已存过）或失败 */
  created: boolean
  title: string
  note: string
  error?: string
}

/** 注入 system prompt 的使用规则段 */
export const SAVE_WRONG_QUESTION_TOOL_PROMPT: string = [
  '## 错题本存入（save_wrong_question 工具）',
  '- 用户明确要求把题目加入/收进/存入错题本（"这题我错了帮我加入""记到错题本""这道题存一下"）时调用本工具立即落库，不要只口头答应',
  '- 题干 question 从对话上文逐字提取（选择题含每个选项行、保留公式记法）；上下文里找不到题目时先请用户把题目发来（文字或截图），不要编造或省略题干',
  '- 用户已说出自己的答案就传 userAnswer；对话里已得出正确答案就传 correctAnswer；解析 analysis 只写一句关键错因/解法，没有把握不要编',
  '- subject/topic 能明确判断再传，不确定就不传（后台会自动打标）',
  '- 返回 created=true 后一句话确认（从考点/错因角度），不要重复贴出完整题目与解析；created=false 告知用户这道题此前已存过',
  '- 用户没有要求存错题时不要主动替用户存；学习模式讲题结束的自动归档由系统处理，与本工具无关',
].join('\n')

/** 临时模式降级提示（工具不注入，避免模型虚构已存入） */
export const SAVE_WRONG_QUESTION_DISABLED_PROMPT: string = [
  '## 错题本（临时模式不可用）',
  '当前处于临时聊天模式，错题本等长期数据不可写入。用户要求存错题时，',
  '请如实告知临时模式下无法操作，可退出临时模式后再试；不要虚构已存入。',
].join('\n')
