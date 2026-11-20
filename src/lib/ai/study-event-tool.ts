/**
 * 学习事件记录工具（record_study_event / query_study_events）—— 纯常量模块（isomorphic）
 *
 * ⚠ 本文件禁止 import prisma/ai 等服务端依赖（ToolCallCard 只需要工具名与输出类型，
 * 混入会连 pg 一起打进客户端 bundle 报 fs 错误）；
 * 工厂在 study-event-tool.server.ts，REST API 在 /api/study/events 共用本文件的
 * 标签词表与日期换算（EVENT_TAG_VALUES / dateISOToUtc）。
 *
 * 触发纪律：用户明确要求「记一下/记一笔今天学了什么」时落库，AI 不主动替用户记；
 * 「考考我这周记的单词/看看最近学了啥」走查询工具。数据与学习台「学习记录」贴纸共用 StudyEvent 表。
 */
import { z } from 'zod'

export const RECORD_STUDY_EVENT_TOOL_NAME = 'record_study_event'
export const QUERY_STUDY_EVENTS_TOOL_NAME = 'query_study_events'

/** 标签六选一：单词/背书/刷题/阅读/错题/其他（AI 自动打标，手动可选） */
export const EVENT_TAG_VALUES = ['word', 'recite', 'drill', 'read', 'mistake', 'other'] as const
export type EventTag = (typeof EVENT_TAG_VALUES)[number]

export const EVENT_TAG_LABELS: Record<EventTag, string> = {
  word: '单词',
  recite: '背书',
  drill: '刷题',
  read: '阅读',
  mistake: '错题',
  other: '其他',
}

/** 归属日 'YYYY-MM-DD'（客户端本地日；服务端不换时区，只按 UTC 零点存取 DATE） */
export const EVENT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 'YYYY-MM-DD' → UTC 零点 Date（@db.Date 列的存取口径） */
export function dateISOToUtc(iso: string): Date | null {
  if (!EVENT_DATE_RE.test(iso)) return null
  const d = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Date → 'YYYY-MM-DD'（按 UTC 读，eventDate 恒为 UTC 零点） */
export function dateUtcToISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** 今天（服务器本地日）→ 'YYYY-MM-DD'；手动补记缺省落今天 */
export function todayEventISO(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

/** 本地日（客户端时区）→ 'YYYY-MM-DD'；归属日口径在客户端，服务端只存取不换时区 */
export function localEventISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const eventItemSchema = z.object({
  text: z
    .string()
    .min(2)
    .max(160)
    .describe('一句话记录原文，如「背了 Unit 5 的 30 个单词」；从对话上文提取，不要扩写'),
  tag: z
    .enum(EVENT_TAG_VALUES)
    .optional()
    .describe('标签：word=单词 recite=背书 drill=刷题 read=阅读 mistake=错题 other=其他'),
  date: z
    .string()
    .regex(EVENT_DATE_RE)
    .optional()
    .describe('归属日 YYYY-MM-DD；默认今天；用户说「昨天/前天记了」时换算成具体日期'),
})

export const recordStudyEventInputSchema = z.object({
  events: z
    .array(eventItemSchema)
    .min(1)
    .max(5)
    .describe('一次最多记 5 条；用户一口气说了多件事就拆成多条'),
})

export type RecordStudyEventToolInput = z.infer<typeof recordStudyEventInputSchema>

export interface StudyEventToolRow {
  id: string
  /** 一句话记录 */
  text: string
  tag: string | null
  /** chat=AI 聊天快记 manual=学习台手动补一条 */
  source: string
  /** 归属日 YYYY-MM-DD */
  eventDate: string
  /** 记录时刻 ISO（仅排序用） */
  createdAt: string
}

export interface RecordStudyEventToolOutput {
  ok: boolean
  /** 实际新建的条目（服务端确认口径） */
  saved: StudyEventToolRow[]
  /** 与同日已有记录文字完全相同而被跳过的原文 */
  duplicates: string[]
  error?: string
}

export const queryStudyEventsInputSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('回看最近几天，默认 7；用户问「这周」传 7、「今天」传 1'),
  tag: z
    .enum(EVENT_TAG_VALUES)
    .optional()
    .describe('只看某一类：word=单词 recite=背书 drill=刷题 read=阅读 mistake=错题 other=其他'),
})

export type QueryStudyEventsToolInput = z.infer<typeof queryStudyEventsInputSchema>

export interface QueryStudyEventsToolOutput {
  ok: boolean
  days: number
  total: number
  /** 各标签条数（未过滤 tag 时覆盖全部出现过的标签） */
  tagCounts: Partial<Record<EventTag, number>>
  /** 按日分组（今天在前），组内按记录时间正序 */
  groups: Array<{ date: string; items: Array<{ text: string; tag: string | null }> }>
  error?: string
}

/** 注入 system prompt 的记录规则段 */
export const RECORD_STUDY_EVENT_TOOL_PROMPT: string = [
  '## 学习事件记录（record_study_event 工具）',
  '- 用户明确要求记录今天的学习（"记一下今天背了 Unit 5 的单词""帮我记着，今天刷了两套卷子""记一笔"）时调用本工具立即落库，不要只口头答应',
  '- 用户一句话里说了多件事就拆成多条（最多 5 条），每条一句话原文，text 从对话上文提取不要扩写',
  '- tag 按内容自动打标：背单词→word、背课文/古文→recite、刷题/做题→drill、阅读/看书→read、错题整理→mistake，都不像→other',
  '- 归属日：默认今天；用户说「昨天/前天记了」时换算成具体日期传 date（YYYY-MM-DD）',
  '- 返回 duplicates 非空时告知用户这些条目今天已经记过，没有重复添加；saved 后一句话确认即可，不要复述全部条目',
  '- 用户没有要求记录时不要主动替用户记；临时会话/群聊/游戏面具下本工具不可用，用户要求记录时如实告知',
].join('\n')

/** 注入 system prompt 的查询规则段 */
export const QUERY_STUDY_EVENTS_TOOL_PROMPT: string = [
  '## 学习记录查询（query_study_events 工具）',
  '- 用户问「今天/这周/最近学了什么、背了什么单词、记了哪些东西」时先调用本工具查流水再回答，不要凭记忆编造',
  '- days 按 7 天一周口径：问「今天」传 1、「这周/最近」传 7；用户点名只要某类（比如「只看单词」）传 tag',
  '- 回答引用具体条目（原文+日期），可以顺带统计（几天记了 N 条、单词占了多少）；记录为空就如实说还没记过，可以提醒用户说「记一下」即可补记',
].join('\n')

/** 临时模式降级提示（工具不注入，避免模型虚构已记录） */
export const RECORD_STUDY_EVENT_DISABLED_PROMPT: string = [
  '## 学习记录（临时模式不可用）',
  '当前处于临时聊天模式，学习记录等长期数据不可写入。用户要求记一笔时，',
  '请如实告知临时模式下无法操作，可退出临时模式后再试；不要虚构已记录。',
].join('\n')
