import { toBigrams } from "./relevance"
import { findConflicts, type ConflictHit } from "./conflict"
import type { Memory } from "@/generated/prisma/client"
import {
  createMemory,
  listMemoryFacts,
  supersedeMemories,
  MEMORY_STATUS_ACTIVE,
  MEMORY_STATUS_SUPERSEDED,
  type MemoryFact,
} from "./store"
import type { ExtractedMemoryItem } from "./parser"

/**
 * 记忆写入管线（四条写入口共用：自动提取 / add_memory 工具 / 手动添加与导入 / MCP 工具）
 *
 * 为什么必须收口成一条：原先只有自动提取走这里，而它判矛盾只认 LLM 回传的 remove 原文，
 * add_memory 与 手动/导入 两条路只做"互相包含"去重、完全不判冲突 —— 用户显式说
 * "帮我记住我是高中生"时，库里的"27岁"不会被处理，两条互斥事实一起注入 prompt。
 *
 * 现在每条写入都做两件事：
 *  1) 去重：与生效记忆互为包含 → 跳过（ duplicates ）；
 *  2) 冲突：remove 原文命中 ∪ 本地槽位/常识互斥命中 → 旧条目标记 superseded（不物理删，可恢复）。
 * remove 原文一条没命中时打日志 —— 这类"模型改写了旧记忆措辞"以前是静默漏过的。
 */

/** 写入源：决定 UI 上的标识与 source 字段 */
export type MemoryWriteSource = "auto" | "manual" | "imported"

export interface MemoryWriteItem {
  category: string
  content: string
  /** 需要被本条取代的旧记忆原文（或其连续片段），仅自动提取会带 */
  remove?: string[]
}

export interface MemoryWriteResult {
  /** 实际落库的条数 */
  created: number
  /** 被标记为已取代的旧条数 */
  superseded: number
  /** 与已有记忆重复而跳过的内容 */
  duplicates: string[]
  /** 长度不合规被拒的内容 */
  rejected: string[]
  /** 本次命中的矛盾（供日志与 UI 提示，含本地兜底判出的） */
  conflicts: ConflictHit[]
  /** 被取代的旧条目原文（工具回执与 UI 提示要用，光有 id 用户看不懂） */
  supersededDetails: Array<{ id: string; content: string; byContent: string; reason: string }>
  /** 本次实际落库的行（API 需要把新建条目回给前端做就地插入） */
  createdRows: Memory[]
}

/** 单条内容长度门槛，与手动添加/工具入口保持一致 */
const MIN_LEN = 4
const MAX_LEN = 200

/**
 * 宽容匹配 remove 片段与已有记忆：
 * 先做标点/空白归一化后的包含判断，再退化为 bigram 重叠率 ≥ 60%
 */
function fragmentMatches(fragment: string, content: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[\s，。！？、,.!?：:；;""''（）()\-—~]/g, "")
  const f = norm(fragment)
  const c = norm(content)
  if (!f || !c) return false
  if (c.includes(f)) return true
  if (f.length < 4) return false
  const a = toBigrams(f)
  const b = toBigrams(c)
  if (!a.size) return false
  let overlap = 0
  a.forEach((g) => {
    if (b.has(g)) overlap++
  })
  return overlap / a.size >= 0.6
}

/** 互为包含视为重复（沿用旧去重口径：不做语义判断，宁可重复也不误吞） */
function isDuplicate(content: string, existingContents: string[]): boolean {
  return existingContents.some((e) => e.includes(content) || content.includes(e))
}

/**
 * 统一写入入口。items 逐条处理（后一条能看到前一条刚写入的结果），
 * 因此同一轮里"先记 27岁 再记 19岁"也会正确取代。
 */
export async function upsertMemories(
  userId: string,
  items: MemoryWriteItem[],
  meta: { source: MemoryWriteSource; sourceDetail?: string | null }
): Promise<MemoryWriteResult> {
  const snapshot: MemoryFact[] = await listMemoryFacts(userId)
  const result: MemoryWriteResult = {
    created: 0,
    superseded: 0,
    duplicates: [],
    rejected: [],
    conflicts: [],
    supersededDetails: [],
    createdRows: [],
  }

  for (const item of items) {
    const content = (item.content ?? "").trim()
    if (content.length < MIN_LEN || content.length > MAX_LEN) {
      result.rejected.push(content)
      continue
    }

    const active = snapshot.filter((m) => m.status === MEMORY_STATUS_ACTIVE)
    if (isDuplicate(content, active.map((m) => m.content))) {
      result.duplicates.push(content)
      continue
    }

    // 1) LLM 显式声明的取代对象（remove 原文/片段）
    const victimReasons = new Map<string, string>()
    let removeDeclared = 0
    for (const fragment of item.remove ?? []) {
      const trimmed = fragment.trim()
      if (!trimmed || trimmed.length < 2) continue
      removeDeclared++
      active
        .filter((v) => !victimReasons.has(v.id) && fragmentMatches(trimmed, v.content))
        .forEach((v) => victimReasons.set(v.id, "模型声明该条已被本条替换"))
    }
    // remove 声明了却一条都没命中 = 模型改写了旧记忆措辞，以前静默漏过，现在留痕
    if (removeDeclared > 0 && victimReasons.size === 0) {
      console.warn(
        `[memory] remove 未命中任何已有记忆(措辞被改写),交由本地冲突判定兜底: ${JSON.stringify(
          item.remove
        )}`
      )
    }

    // 2) 本地槽位/常识互斥兜底（remove 抓不到的语义矛盾里可判的那部分）
    const localHits = findConflicts(
      { id: "__new__", content },
      active.filter((v) => !victimReasons.has(v.id))
    )
    for (const hit of localHits) {
      victimReasons.set(hit.bId, hit.reason)
      result.conflicts.push(hit)
    }

    // 3) 新条目落库，被取代的旧条目标记（不物理删）
    const created = await createMemory(userId, {
      category: item.category || "other",
      content,
      source: meta.source,
      sourceDetail: meta.sourceDetail ?? null,
    })
    result.createdRows.push(created)
    snapshot.unshift({
      id: created.id,
      content: created.content,
      category: created.category,
      status: created.status,
      updatedAt: created.updatedAt,
    })

    if (victimReasons.size > 0) {
      const ids: string[] = []
      victimReasons.forEach((_reason, id) => ids.push(id))
      const n = await supersedeMemories(ids, created.id)
      result.superseded += n
      for (const row of snapshot) {
        const reason = victimReasons.get(row.id)
        if (!reason) continue
        row.status = MEMORY_STATUS_SUPERSEDED
        result.supersededDetails.push({ id: row.id, content: row.content, byContent: content, reason })
      }
      console.log(
        `[memory] 矛盾替换: 新条目「${content}」取代 ${n} 条旧记忆 (${ids.join(",")})`
      )
    }
    result.created += 1
  }

  return result
}

/**
 * 保存自动提取出的记忆（extractor 用的窄封装，行为与 upsertMemories 一致）
 * @deprecated 直接用语义更完整的 upsertMemories
 */
export async function saveExtractedMemories(
  userId: string,
  items: ExtractedMemoryItem[]
): Promise<{ created: number; replaced: number }> {
  const result = await upsertMemories(
    userId,
    items.map((it) => ({ category: it.category, content: it.content, remove: it.remove })),
    { source: "auto" }
  )
  return { created: result.created, replaced: result.superseded }
}
