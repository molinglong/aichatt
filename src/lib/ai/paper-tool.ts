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

// ===================== compose_paper 智能拟卷（真题重组卷） =====================

export const COMPOSE_PAPER_TOOL_NAME = 'compose_paper'

export const composePaperInputSchema = z.object({
  subject: z
    .string()
    .max(20)
    .describe(
      '学科(math/chinese/english/physics/chemistry/biology/history/geography/politics/other)，必填'
    ),
  baseSlug: z
    .string()
    .max(80)
    .optional()
    .describe(
      '底卷 slug(=结构模板,组卷按它的题位/题型/分值找同位题)。难度定位(学考/期末/高考)不同,底卷与抽题来源都不同——用户明确了难度/卷种时,从 analyze_papers 的试卷清单里选同难度段真题的 slug 传入;不传=自动选题量最多的卷'
    ),
  onlyChoice: z
    .boolean()
    .optional()
    .describe('用户只要选择题/想要小卷时传 true；默认 false=按底卷完整结构组卷'),
  allowAiAnswers: z
    .boolean()
    .optional()
    .describe(
      '放行 AI 参考答案题入池(默认 false=只用官方答案)。仅当该科没有(或不够)带官方答案的题、且用户明确接受「AI 参考答案(非官方,卷面会逐题标注)」时传 true;不许未经用户同意擅自传'
    ),
  slotDefs: z
    .array(
      z.object({
        section: z.string().max(30).optional().describe('大题名,如「一、选择题」;不传按题型命名'),
        kind: z.enum(['choice', 'answer']).describe('题型:choice=选择题,answer=解答/填空题'),
        score: z.number().int().min(1).max(30).describe('每题分值'),
        count: z.number().int().min(1).max(20).describe('题数'),
      })
    )
    .max(12)
    .optional()
    .describe(
      '大纲组卷模式:用户给出明确结构/大纲(如「选择10道各3分+解答3道各12分」「按学考结构,只出函数与不等式」)时,解析成槽位定义传入;传了 slotDefs 则 baseSlug 失效、整卷重摇不可用。总题数建议 ≤25;某桶真题不够时有多少放多少,缺口经 shortages 返回,要如实转告用户'
    ),
  title: z
    .string()
    .max(60)
    .optional()
    .describe('自定义卷名;不传自动命名(大纲模式生效)'),
})

export type ComposePaperInput = z.infer<typeof composePaperInputSchema>

export interface ComposePaperOutput {
  ok: boolean
  composedId?: string
  /** 卷面页地址（换/删/加题与打印都在这个页面） */
  url?: string
  title?: string
  questionCount?: number
  totalScore?: number
  durationMin?: number
  /** 当前在卷题目的来源卷名清单（来源声明用） */
  sources?: string[]
  /** 大纲模式:某桶真题池不够的缺口,如实转告用户 */
  shortages?: Array<{ kind: string; score: number; requested: number; filled: number }>
  /** 失败原因: no_pool=该科没有带官方答案的题;bad_outline=大纲槽位定义无效 */
  reason?: string
  note: string
  error?: string
}
