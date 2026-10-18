import type { Memory } from "@/generated/prisma/client"
import { suppressConflicting } from "./conflict"

/**
 * 中文/英文 bigram 提取，用于本地相关度计算
 * （dedupe 的片段宽容匹配也复用此函数）
 */
export function toBigrams(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, "")
  const set = new Set<string>()
  for (let i = 0; i < cleaned.length - 1; i++) {
    set.add(cleaned.slice(i, i + 2))
  }
  return set
}

/**
 * 注入用的记忆形状：比 Prisma 行窄，便于单测传字面量、也便于调用方只 select 需要的列。
 * status 可选（老调用点或不带该列的查询按 active 处理）。
 */
export type InjectableMemory = Pick<
  Memory,
  "id" | "content" | "category" | "source" | "updatedAt"
> & { status?: string | null }

/**
 * 选择注入系统提示词的记忆（控制每次请求的固定 token 开销）：
 * - 已被取代的记忆(status=superseded)一律不注入——它们只是留着给用户反悔的
 * - 身份信息(user_info)、偏好(preference)与手动添加的记忆始终注入
 *   ——这类信息在大多数对话中都可能用上，bigram 命中率太低会漏注入
 * - 其余记忆仅在内容与当前消息有实际相关度(bigram 命中)时注入
 * - 没有命中时用最近更新的记忆兜底填满配额,避免宽泛消息完全失去上下文
 * - 最后做一次冲突抑制：同组互斥记忆(如「27岁」与「高中生」)只注入 updatedAt 最新的一条，
 *   其余本次不注入。刻意不回填配额——宁缺勿冲，两条互斥事实一起进 prompt 会让模型瞎猜。
 */
export function getRelevantMemories(
  memories: InjectableMemory[],
  userText: string,
  limit = 10
): InjectableMemory[] {
  // 被取代的记忆先出局（存量脏数据里 status 缺失的按 active 处理）
  const active = memories.filter((m) => (m.status ?? "active") !== "superseded")
  if (active.length === 0) return []

  const isAlways = (m: InjectableMemory) =>
    m.source === "manual" || m.category === "user_info" || m.category === "preference"
  const always = active.filter(isAlways)
  const rest = active.filter((m) => !isAlways(m))

  // 与当前消息的实际相关度：bigram 命中率
  // （不再加新鲜度加分，否则闲聊如"你好"也会注入全部记忆）
  const queryBigrams = toBigrams(userText || "")
  const overlapRatio = (content: string): number => {
    if (!queryBigrams.size) return 0
    const a = toBigrams(content)
    if (!a.size) return 0
    let overlap = 0
    queryBigrams.forEach((g) => {
      if (a.has(g)) overlap++
    })
    return overlap / queryBigrams.size
  }

  const quota = Math.max(0, limit - always.length)
  const matched = rest
    .map((m) => ({ m, r: overlapRatio(m.content) }))
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r || b.m.updatedAt.getTime() - a.m.updatedAt.getTime())
    .slice(0, quota)
    .map((x) => x.m)

  // 兜底：命中不足配额时用最近更新的记忆填满，避免大量记忆因
  // 字面 bigram 不命中（语义相关但措辞不同）而完全失去注入机会
  const fill = quota - matched.length
  const recent =
    fill > 0
      ? rest
          .filter((m) => !matched.includes(m))
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, fill)
      : []

  const { kept } = suppressConflicting(
    [...always, ...matched, ...recent],
    (m) => m.updatedAt
  )
  return kept
}
