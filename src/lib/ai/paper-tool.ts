/**
 * 试卷库检索工具（search_papers）—— 纯常量模块（isomorphic，客户端可安全 import）
 *
 * ⚠ 本文件禁止 import prisma/ai 等服务端依赖（ToolCallCard 只需要
 * PAPER_SEARCH_TOOL_NAME 与输出类型，混入会连 pg 一起打进客户端 bundle 报 fs 错误）；
 * 工具工厂与检索/统计核心在 paper-tool-server.ts。
 *
 * 与 search_knowledge 同一协议：有 execute，服务端直接查库，AI SDK 拿到结果自动续写。
 * 数据源：PaperQuestion（试卷逐题索引层，由 import-exam-paper.cjs 从 PaperPage 契约解析）。
 * 触发：模型按工具 description + chat route 能力段自主决定调用（无 if-else）。
 */
import { z } from 'zod'

export const PAPER_SEARCH_TOOL_NAME = 'search_papers'

export const paperSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(60)
    .describe(
      "检索关键词，2-4 个考点词或题目关键词，如「解三角形」「命题的否定」「二次函数 单调性」；禁止传整句问题"
    ),
  subject: z
    .string()
    .max(20)
    .optional()
    .describe(
      '学科过滤(math/chinese/english/physics/chemistry/biology/history/geography/politics/other)；不确定学科就不传，查全部'
    ),
})

export type PaperSearchInput = z.infer<typeof paperSearchInputSchema>

/** 真题命中（PaperQuestion 逐题索引层投影；answer=null=官方答案缺失） */
export interface PaperQuestionHit {
  paperTitle: string
  paperSlug: string
  year: string | null
  region: string | null
  examType: string | null
  section: string | null
  number: number
  kind: string
  multiple: boolean
  score: number
  stem: string
  options: string[]
  images: string[]
  topics: string[]
  answer: string | null
}

/** 考次统计行（一题多考点各计一次的口径，note 里已说明） */
export interface PaperTopicCount {
  topic: string
  count: number
  refs: string[]
}

export interface PaperSearchOutput {
  query: string
  results: PaperQuestionHit[]
  /** 与 query 词相关的考点考次（命中考点名时可直接回答「考过几次」） */
  topicCounts: PaperTopicCount[]
  note: string
  error?: string
}

// ===================== analyze_papers 整理报告/复习规划 =====================

export const PAPER_ANALYZE_TOOL_NAME = 'analyze_papers'

export const paperAnalyzeInputSchema = z.object({
  subject: z
    .string()
    .max(20)
    .optional()
    .describe(
      '学科过滤(math/chinese/english/physics/chemistry/biology/history/geography/politics/other)；不传=全部学科'
    ),
})

export type PaperAnalyzeInput = z.infer<typeof paperAnalyzeInputSchema>

/** 单套卷的概览行（试卷清单+题型分布；整理报告的骨架数据） */
export interface PaperOverviewItem {
  slug: string
  title: string
  subject: string
  year: string | null
  region: string | null
  examType: string | null
  totalScore: number
  durationMin: number
  pageCount: number
  questions: number
  choice: number
  multiChoice: number
  answerQ: number
  /** 官方答案已回填的题数 */
  answered: number
  /** 已打考点标签的题数 */
  tagged: number
}

/** 考点考次统计行（服务端 getPaperTopicStats 的投影，chapter=课本章定位） */
export interface PaperTopicStat {
  /** 规范考点全名，如「1.3 并集、交集、补集的运算」 */
  topic: string
  /** 考了几次（一题多考点各计一次） */
  count: number
  /** 考点所属课本章节（学考提纲映射，如「第一章 集合与常用逻辑用语」） */
  chapter: string | null
  /** 出处，如「广西…数学模拟卷（一） · 第22题」 */
  refs: string[]
}

/** 错题本弱点联动行（StudyNote.topic 与考点标签模糊匹配后的聚合） */
export interface PaperWeakTopic {
  /** 匹配到的考点标签（paper 侧规范名） */
  topic: string
  /** 错题本里该考点的卡片数 */
  noteCount: number
  /** 这些卡片的平均掌握度 0-1（低=薄弱） */
  avgMastery: number
  /** 已到复习期(dueAt<=now)的卡片数 */
  dueCount: number
  /** 错题本侧的原始 topic 词（供模型向用户表述） */
  noteTopic: string
}

export interface PaperAnalyzeOutput {
  overview: PaperOverviewItem[]
  /** 考点考次排行（按考次降序，截 top 15） */
  topicStats: PaperTopicStat[]
  /** 错题本中能对上考点标签的弱点考点（无错题或对不上则为空，note 会说明） */
  weakTopics: PaperWeakTopic[]
  note: string
  error?: string
}
