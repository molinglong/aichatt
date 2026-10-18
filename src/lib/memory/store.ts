import { prisma } from "@/lib/db"
import type { Memory } from "@/generated/prisma/client"

/**
 * 记忆存储层：记忆相关的 Prisma 读写集中于此，
 * 上层（extractor / dedupe / API 路由 / 工具）不直接触碰 prisma.memory
 *
 * 取代语义（矛盾消解）：被矛盾的旧条目**不物理删除**，改为 status='superseded' 并记下
 * supersededBy=胜者 id。这样注入端一律只读 active（脏数据不污染 prompt），
 * 而用户随时能在设置里把误判的那条恢复回来。
 */

/** 记忆生效状态 */
export const MEMORY_STATUS_ACTIVE = "active"
export const MEMORY_STATUS_SUPERSEDED = "superseded"

/** 供冲突判定/替换使用的精简行 */
export interface MemoryFact {
  id: string
  content: string
  category: string
  status: string
  updatedAt: Date
}

/**
 * 拉取记忆精简行。默认只取 active（写入管线的比较对象永远是"当前生效的记忆"，
 * 已取代的历史条目不再参与去重/矛盾判定，否则恢复一次就重新被吃掉）。
 */
export async function listMemoryFacts(
  userId: string,
  opts?: { status?: "active" | "all" }
): Promise<MemoryFact[]> {
  return prisma.memory.findMany({
    where: { userId, ...(opts?.status === "all" ? {} : { status: MEMORY_STATUS_ACTIVE }) },
    select: { id: true, content: true, category: true, status: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  })
}

/** @deprecated 用语义更明确的 listMemoryFacts 代替；保留是因为 index.ts 曾导出该名 */
export async function listAllMemoryFacts(userId: string): Promise<Pick<Memory, "id" | "content">[]> {
  return prisma.memory.findMany({
    where: { userId, status: MEMORY_STATUS_ACTIVE },
    select: { id: true, content: true },
  })
}

/** 拉取生效中的记忆正文，供提取时作为"已有记忆"上下文 */
export async function listMemoryContents(userId: string): Promise<string[]> {
  const rows = await prisma.memory.findMany({
    where: { userId, status: MEMORY_STATUS_ACTIVE },
    select: { content: true },
  })
  return rows.map((r) => r.content)
}

/** 写入一条记忆（source 决定它是自动提取/手动添加/导入） */
export async function createMemory(
  userId: string,
  input: {
    category: string
    content: string
    source: "auto" | "manual" | "imported"
    sourceDetail?: string | null
  }
): Promise<Memory> {
  return prisma.memory.create({
    data: {
      userId,
      category: input.category,
      content: input.content,
      source: input.source,
      sourceDetail: input.sourceDetail ?? null,
      status: MEMORY_STATUS_ACTIVE,
    },
  })
}

/** 标记一批记忆已被 winner 取代（不删数据，可恢复） */
export async function supersedeMemories(
  ids: string[],
  winnerId: string
): Promise<number> {
  if (!ids.length) return 0
  const result = await prisma.memory.updateMany({
    where: { id: { in: ids } },
    data: { status: MEMORY_STATUS_SUPERSEDED, supersededBy: winnerId },
  })
  return result.count
}

/**
 * 恢复一条被取代的记忆，并反向把原胜者标记为被它取代。
 *
 * 恢复语义 = "这句才是对的，那句作废"，所以必须成对写：只把自己置 active，
 * 会让两条互斥记忆同时生效，冲突又回到 prompt 里。
 */
export async function restoreMemory(
  userId: string,
  id: string
): Promise<{ ok: boolean; reason?: string }> {
  const self = await prisma.memory.findFirst({ where: { id, userId } })
  if (!self) return { ok: false, reason: "not_found" }
  if (self.status !== MEMORY_STATUS_SUPERSEDED) return { ok: true }

  await prisma.memory.update({
    where: { id },
    data: { status: MEMORY_STATUS_ACTIVE, supersededBy: null },
  })

  const winnerId = self.supersededBy
  if (winnerId) {
    const winner = await prisma.memory.findFirst({ where: { id: winnerId, userId } })
    if (winner && winner.status === MEMORY_STATUS_ACTIVE) {
      await prisma.memory.update({
        where: { id: winnerId },
        data: { status: MEMORY_STATUS_SUPERSEDED, supersededBy: id },
      })
    }
  }
  return { ok: true }
}

/**
 * 直接置为生效（用户在冲突卡片里选「以这条为准」时用）。
 * 与 restoreMemory 的区别：这里不做反向取代，胜者由调用方紧接着用 supersedeMemories 指定。
 */
export async function activateMemory(userId: string, id: string): Promise<boolean> {
  const row = await prisma.memory.findFirst({ where: { id, userId }, select: { id: true } })
  if (!row) return false
  await prisma.memory.update({
    where: { id },
    data: { status: MEMORY_STATUS_ACTIVE, supersededBy: null, conflictPeers: null },
  })
  return true
}

/**
 * 裁决「都保留」：把对端 id 记进 conflictPeers，之后不再重复提示这组冲突。
 * 双方都保持 active（用户明确知情后要两条一起用，例如"杭州人 + 现居上海"）。
 */
export async function markKeptBoth(
  userId: string,
  ids: string[]
): Promise<number> {
  let touched = 0
  for (const id of ids) {
    const row = await prisma.memory.findFirst({ where: { id, userId } })
    if (!row) continue
    const peers = ids.filter((other) => other !== id)
    const mergedList: string[] = []
    const merged = new Set<string>(
      [...(row.conflictPeers ? row.conflictPeers.split(",") : []), ...peers].filter(Boolean)
    )
    merged.forEach((peer) => mergedList.push(peer))
    await prisma.memory.update({
      where: { id },
      data: { conflictPeers: mergedList.join(",") },
    })
    touched++
  }
  return touched
}

/** 清除若干条记忆的裁决标记（改了内容后冲突要重新提示） */
export async function clearConflictPeers(userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return
  await prisma.memory.updateMany({
    where: { userId, id: { in: ids } },
    data: { conflictPeers: null },
  })
}

/**
 * 物理删除一条记忆，并把"被它取代"的旧记忆救回来。
 *
 * 不做这步会造孤儿：删掉胜者后，被它压住的条目仍挂着指向已删行的 supersededBy，
 * 永远注入不进去，用户在设置里也看不到它们（分组还在，但恢复语义已坏）。
 */
export async function deleteMemory(
  userId: string,
  id: string
): Promise<{ ok: boolean; revived: number }> {
  const row = await prisma.memory.findFirst({ where: { id, userId }, select: { id: true } })
  if (!row) return { ok: false, revived: 0 }

  const victims = await prisma.memory.findMany({
    where: { userId, status: MEMORY_STATUS_SUPERSEDED, supersededBy: id },
    select: { id: true },
  })

  await prisma.memory.delete({ where: { id } })

  if (victims.length > 0) {
    await prisma.memory.updateMany({
      where: { id: { in: victims.map((v) => v.id) } },
      data: { status: MEMORY_STATUS_ACTIVE, supersededBy: null },
    })
  }
  return { ok: true, revived: victims.length }
}

/** 按主键批量物理删除（仅用户在设置里主动删除时调用） */
export async function deleteMemoriesByIds(ids: string[]): Promise<number> {
  if (!ids.length) return 0
  const result = await prisma.memory.deleteMany({
    where: { id: { in: ids } },
  })
  return result.count
}
