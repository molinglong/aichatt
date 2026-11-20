/**
 * 今日计划(Plan 应用并入)共享类型。
 *
 * 原独立 plan 服务的 types.ts 并入版:去掉 external(aichatt 待办同步引用)与
 * 离线缓存字段(merged 后双端直连 Postgres,不再有 outbox/pending 概念)。
 * 字段口径与 Prisma PlanItem / 排程端点 /api/plan/schedule 完全一致。
 */

export type Kind = 'task' | 'event' | 'memo'
export type Status = 'inbox' | 'planned' | 'done' | 'dropped'
export type Energy = 'deep' | 'light' | 'any'
/** 0 普通 / 1 重要 / 2 重要且紧急 */
export type Priority = 0 | 1 | 2

export interface PlanItem {
  id: string
  title: string
  note?: string
  kind: Kind
  status: Status
  /** 0 普通 / 1 重要 / 2 重要且紧急 */
  priority: Priority
  estimateMin: number
  energy: Energy
  /** 当日分钟数,如 9:30 = 570 */
  startMin?: number
  endMin?: number
  /** 计划所属日期(YYYY-MM-DD);撤销删除时用它把条目放回原日期 */
  plannedDate?: string
  /** AI 排程理由,一句话 */
  reason?: string
  done?: boolean
  /** 连续顺延次数,>=3 触发降级提示 */
  postponeCount?: number
}

/** 「排今天」结果:source 说明走了 AI 还是空档顺排兜底 */
export interface ScheduleResponse {
  items: PlanItem[]
  added: number
  source: 'ai' | 'local'
  model?: string
  /** 降级/兜底时的原因,前端只提示一次 */
  note?: string
  deferred?: { itemId: string; reason: string }[]
}

/** 备忘录:长期沉淀的自由文本,与待办/排程完全分开(表:PlanMemo) */
export interface PlanMemo {
  id: string
  title: string
  content: string
  pinned: boolean
  createdAt: string
  updatedAt: string
}

/** 日终复盘(纯规则,不调 AI,口径同原 plan/server/review.ts) */
export interface ReviewResult {
  date: string
  planned: number
  done: number
  skipped: number
  rate: number
  plannedMinutes: number
  doneMinutes: number
  remaining: number
  postponed: { id: string; title: string; count: number }[]
  headline: string
  tips: string[]
}
