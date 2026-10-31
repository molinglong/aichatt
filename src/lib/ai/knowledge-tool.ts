/**
 * 课本知识库检索工具（search_knowledge）—— 纯常量模块（isomorphic，客户端可安全 import）
 *
 * ⚠ 本文件禁止 import prisma/ai 等服务端依赖（ToolCallCard 只需要
 * KNOWLEDGE_TOOL_NAME，混入会连 pg 一起打进客户端 bundle 报 fs 错误）；
 * 工具工厂与检索闸门在 knowledge-tool-server.ts。
 *
 * 与 web_search 同一协议：有 execute，服务端直接查库，AI SDK 拿到结果自动续写。
 * - 数据源：KnowledgeChunk（当前用户名下按章节切块的课本文本，content 走
 *   pg_trgm GIN 索引，contains insensitive 在 PostgreSQL 生成 ILIKE 可命中索引）
 * - 触发：模型按工具 description + chat route 能力段自主决定调用（无 if-else）
 * - 半绑定：面具的 subject 学科倾向仅作为能力段默认过滤建议，不锁死——
 *   入参 subject 仍由模型按实际问题决定。
 */
import { z } from 'zod'

export const KNOWLEDGE_TOOL_NAME = 'search_knowledge'
/** 课本目录工具:返回单元/课/框题树,专供“拟提纲/翻目录/看课本结构” */
export const KNOWLEDGE_OUTLINE_TOOL_NAME = 'list_knowledge_outline'

/** 资料类型: textbook=课本/教材原文 | material=资料(答题模板/提纲/讲义) */
export const KNOWLEDGE_KINDS = ['textbook', 'material'] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

/** 资料类型中文名(能力段与结果标注用) */
export const KNOWLEDGE_KIND_LABELS: Record<KnowledgeKind, string> = {
  textbook: '课本',
  material: '资料',
}

export const knowledgeInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(60)
    .describe("检索关键词，2-4 个学科关键词，如「相反数 定义」「矛盾 普遍性 特殊性」；禁止传整句问题"),
  subject: z
    .string()
    .max(20)
    .optional()
    .describe(
      '学科过滤(math/chinese/english/physics/chemistry/biology/history/geography/politics/other)；不确定学科就不传，查全部'
    ),
  kind: z
    .enum(KNOWLEDGE_KINDS)
    .optional()
    .describe(
      '资料类型过滤：textbook=课本/教材原文，material=资料(答题模板/提纲/讲义)。概念/公式/翻书/出题传 textbook，答题套路传 material；拿不准就不传，查全部'
    ),
})

export type KnowledgeToolInput = z.infer<typeof knowledgeInputSchema>

/** 课本目录查询入参:title 传册别/书名关键词(如“必修四”“哲学与文化”) */
export const knowledgeOutlineInputSchema = z.object({
  title: z
    .string()
    .max(60)
    .optional()
    .describe('书名或册别关键词，如「必修四」「哲学与文化」「数学 必修 第一册」；不确定就不传'),
  subject: z
    .string()
    .max(20)
    .optional()
    .describe('学科过滤(math/chinese/english/physics/chemistry/biology/history/geography/politics/other)；不确定就不传'),
  kind: z
    .enum(KNOWLEDGE_KINDS)
    .optional()
    .describe('默认 textbook；只有在列资料(答题模板/提纲)目录时才传 material'),
})

export type KnowledgeOutlineInput = z.infer<typeof knowledgeOutlineInputSchema>

export interface KnowledgeOutlineHeading {
  heading: string
  /** 该框题开头 160 字，常含目题名与导入语，供拟提纲时判断小节 */
  preview: string
}
export interface KnowledgeOutlineSection {
  section: string | null
  headings: KnowledgeOutlineHeading[]
}
export interface KnowledgeOutlineChapter {
  chapter: string | null
  sections: KnowledgeOutlineSection[]
}
export interface KnowledgeOutlineDoc {
  title: string
  grade: string | null
  subject: string
  kind: string
  chapters: KnowledgeOutlineChapter[]
}
export interface KnowledgeOutlineOutput {
  docs: KnowledgeOutlineDoc[]
  note: string
  error?: string
}

/** 学科中文名(能力段与降级文案用) */
export const KNOWLEDGE_SUBJECT_LABELS: Record<string, string> = {
  math: '数学',
  chinese: '语文',
  english: '英语',
  physics: '物理',
  chemistry: '化学',
  biology: '生物',
  history: '历史',
  geography: '地理',
  politics: '政治',
  other: '其他',
}

export interface KnowledgeHit {
  doc: string
  kind: string
  chapter: string | null
  section: string | null
  heading: string
  content: string
}

export interface KnowledgeToolOutput {
  query: string
  results: KnowledgeHit[]
  note: string
  error?: string
}
