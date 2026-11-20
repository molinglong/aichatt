import type { ScratchNote } from "@/generated/prisma/client"
import { prisma } from "@/lib/db"

/**
 * 短期记忆（临时便签）读写层。
 *
 * 定位与长期记忆(Memory)的分界：短期 = 会过期的进行时态（背单词进度、备考安排、
 * 正在攻坚的内容），长期 = 不过期的完成时态（身份、偏好、习惯）。
 * - 写入一律 upsert：topic 同用户内唯一，重复写 = 覆盖更新，"背单词进度"永远只有
 *   最新一条，不堆积。
 * - 过期策略：expiresAt 在写入时落成具体时间（显式到期日 ?? 默认 14 天窗口），
 *   更新即续期；读侧只取 expiresAt > now（惰性失效，无清理任务）。
 * - 注入：随长期记忆一起进 system，量小直接全量注入（有上限截断）。
 */

/** 默认有效期（天）：每次写入/更新都从当下重新起算 */
export const SCRATCH_DEFAULT_TTL_DAYS = 14
/** 注入块的条目上限：超限只注入最近更新的前 N 条（防 AI 判记失控撑爆 prompt） */
export const SCRATCH_INJECT_LIMIT = 20
/** topic / content 长度口径（与工具 schema、REST API 三处对齐） */
export const SCRATCH_TOPIC_MAX = 30
export const SCRATCH_CONTENT_MAX = 300

export interface ScratchNoteInput {
  topic: string
  content: string
  /** ISO 8601 到期时间；省略 = 默认 14 天 */
  expiresAt?: string | null
}

export interface UpsertScratchResultRow {
  topic: string
  content: string
  expiresAt: string
  /** true = 覆盖了已有同 topic 条目 */
  replaced: boolean
}

/** 活跃条目（未过期），最近更新在前 */
export async function listActiveScratchNotes(
  userId: string,
  take = SCRATCH_INJECT_LIMIT
): Promise<ScratchNote[]> {
  return prisma.scratchNote.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { updatedAt: "desc" },
    take,
  })
}

/** 全量条目（含已过期，设置页展示/清理用），最近更新在前 */
export async function listAllScratchNotes(userId: string): Promise<ScratchNote[]> {
  return prisma.scratchNote.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  })
}

/**
 * 批量 upsert。单条非法（topic/content 越界）不整体失败，逐条跳过并在结果里反映。
 * expiresAt 解析失败按默认 TTL 处理（工具不因时间解析失败而丢内容）。
 */
export async function upsertScratchNotes(
  userId: string,
  notes: ScratchNoteInput[]
): Promise<{ saved: UpsertScratchResultRow[]; rejected: string[] }> {
  const saved: UpsertScratchResultRow[] = []
  const rejected: string[] = []

  for (const note of notes) {
    const topic = (note.topic ?? "").trim().slice(0, SCRATCH_TOPIC_MAX)
    const content = (note.content ?? "").trim().slice(0, SCRATCH_CONTENT_MAX)
    if (!topic || !content) {
      rejected.push(topic || content || "(空条目)")
      continue
    }

    const now = new Date()
    let expiresAt = now
    const explicit = note.expiresAt ? new Date(note.expiresAt) : null
    if (explicit && !Number.isNaN(explicit.getTime()) && explicit.getTime() > now.getTime()) {
      expiresAt = explicit
    } else {
      expiresAt = new Date(now.getTime() + SCRATCH_DEFAULT_TTL_DAYS * 24 * 3600 * 1000)
    }

    const row = await prisma.scratchNote.upsert({
      where: { userId_topic: { userId, topic } },
      create: { userId, topic, content, expiresAt },
      update: { content, expiresAt },
    })
    saved.push({
      topic: row.topic,
      content: row.content,
      expiresAt: row.expiresAt.toISOString(),
      replaced: row.createdAt.getTime() !== row.updatedAt.getTime(),
    })
  }

  return { saved, rejected }
}

/** 组装注入块；无条目返回空串（调用方跳过 push）。措辞不提具体工具名——主聊天与 ACode 网关共用 */
export function buildScratchMemoryPrompt(
  notes: Pick<ScratchNote, "topic" | "content">[]
): string {
  if (!notes.length) return ""
  const lines = notes.map((n) => `- [${n.topic}] ${n.content}`)
  return [
    "以下是用户的短期记忆（进行中的状态，近期对话中记录，过期自动失效）：",
    ...lines,
    "这些是进行时态的快照，与当前话题相关时直接当作已知背景使用，不必复述来源；",
    "它们可能过时——发现与用户的实际进度不符时先跟用户核实，不要拿旧进度打断用户。",
    "用户提到进度/状态有变化时，自然地跟着更新对应条目。",
  ].join("\n")
}
