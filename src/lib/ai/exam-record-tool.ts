/**
 * 学校考试成绩台账工具(isomorphic 定义层):
 * 工具名/能力段文案/zod 输入/输出类型,零服务端依赖——前端 ToolCallCard 兜底卡也会 import 本文件。
 * 执行层见 exam-record-tool.server.ts(createExamRecordTool(userId)),只读查询 ExamRecord。
 */
import { z } from 'zod'

export const EXAM_RECORD_TOOL_NAME = 'exam_records'

export const EXAM_RECORD_TOOL_PROMPT = `【学校考试成绩台账】你已接入 exam_records 工具,可查询用户手动记录的学校考试成绩(月考/期中/期末/周测/模拟,含逐题勾错)。
- 触发:用户问「我最近成绩怎么样」「数学考了多少」「哪科薄弱」「成绩趋势」「期中考得如何」等成绩相关问题时调用
- 返回:逐条成绩(考试名/日期/分数/得分率/排名)、按科目汇总(次数/平均得分率/最新得分率/趋势)与考点丢分(来自勾错的题)
- 纪律:引用时给出考试名+日期+分数;结合 trend 与 topicLoss 给具体分析,不要泛泛而谈;台账为空时如实说明,建议用户在学习台「学校考试」区块点「记一次成绩」记录
- subject 参数支持英文 key(math/chinese/english/physics/chemistry/biology/history/geography/politics)或中文(数学/语文/英语…),不确定就不传查全部`

export const examRecordInputSchema = z.object({
  subject: z
    .string()
    .optional()
    .describe(
      '过滤科目:英文 key(math/chinese/english/physics/chemistry/biology/history/geography/politics)或中文(数学/语文/英语…),不传查全部'
    ),
  limit: z.number().int().min(1).max(50).optional().describe('返回条数,默认 20,最新在前'),
})

export interface ExamRecordTopicLoss {
  topic: string
  count: number
  loss: number
}

export interface ExamRecordToolRecord {
  examName: string
  examType: string
  /** 'YYYY-MM-DD'(字符串存,免时区换算) */
  date: string
  /** 中文科目名(服务端已映射) */
  subject: string
  paperTitle: string
  score: number
  fullScore: number
  /** 得分率 0-100(跨满分可比) */
  percent: number
  rank: string | null
  /** 勾错题考点丢分(按丢分降序;空=该次没勾错题) */
  topicLoss: ExamRecordTopicLoss[]
}

export interface ExamRecordSubjectSummary {
  subject: string
  count: number
  avgPercent: number
  latestPercent: number
  trend: 'up' | 'down' | 'flat'
}

export interface ExamRecordToolOutput {
  records: ExamRecordToolRecord[]
  bySubject: ExamRecordSubjectSummary[]
  total: number
  note: string
  error?: string
}
