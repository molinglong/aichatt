import { z } from "zod"

/**
 * 学习进度查询工具（study_progress）—— 纯常量模块（isomorphic，客户端可安全 import）
 *
 * 只读聚合：背单词计划/队列、错题本复习、考前冲刺计划 三块的结构化快照。
 * 数据事实源是各自的表（UserWord/WordPlan/StudyNote/StudyPlan），本工具每次现查，
 * 永远与真实数据一致——短期记忆里的文字快照与之冲突时以本工具为准。
 *
 * 与 add_memory / manage_todo 同一协议；⚠ 本文件禁止 import prisma 等服务端依赖。
 *
 * 注入条件：!isEphemeral && !groupId && !isGameMask（与 manage_todo 同款——
 * 读的是学习数据而非记忆，不随「记忆功能」开关关停；临时模式禁读防借号套数据）。
 */

export const STUDY_PROGRESS_TOOL_NAME = "study_progress"

export const studyProgressInputSchema = z.object({})

export type StudyProgressToolInput = z.infer<typeof studyProgressInputSchema>

/** 考前冲刺今日任务项 */
export interface ExamPlanTodayItem {
  topic: string
  kind: string
  target: number
  done: boolean
}

/** 工具 output 形状（ToolCallCard 渲染与类型收窄用） */
export interface StudyProgressToolOutput {
  ok: boolean
  generatedAt: string
  words: {
    plan: {
      name: string
      list: { name: string; level: string | null; wordCount: number } | null
      cursor: number
      dailyNew: number
      dailyReview: number
    } | null
    total: number
    due: number
    newToday: number
    reviewedToday: number
    streakDays: number
  }
  wrongQuestions: {
    total: number
    due: number
    reviewedToday: number
    avgMastery: number | null
  }
  examPlan: {
    title: string
    examName: string | null
    subject: string | null
    examDate: string
    daysLeft: number
    todayItems: { total: number; done: number; list: ExamPlanTodayItem[] }
  } | null
  message?: string
}

/** 注入 system prompt 的使用规则段 */
export const STUDY_PROGRESS_TOOL_PROMPT: string = [
  "## 学习进度查询（study_progress 工具）",
  "- 用户问进度类问题（\"背单词到哪了\"\"今天复习了多少\"\"错题还剩多少\"\"离考试还有几天\"\"今天该学什么\"），或回答学习规划类问题需要真实进度时，先调用本工具再回答，不要凭印象或短期记忆文本编数字",
  "- 背单词/错题的精确数字（计划游标、到期数、今日新学）以本工具返回为准；短期记忆里的同类文字快照只是背景，两者冲突时以工具为准",
  "- 返回的数据是快照：回答时直接引用具体数字，不需要向用户复述整个 JSON",
].join("\n")
