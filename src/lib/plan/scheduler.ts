import { prisma } from "@/lib/db"
import type { PlanItem } from "./types"
import { DAY_START, todayKey } from "./time"
import { aiScheduleCore, ScheduleError, scheduleBodySchema, type ScheduleBody } from "./ai-schedule"

/**
 * 今日计划的数据访问 + 排程编排(原 plan/server/repo.ts + schedule.ts 的 Prisma 版)。
 *
 * 排程策略沿用原口径:
 * 1. AI 优先(复用 /api/plan/schedule 的 generateObject + applyGuards 管道),它懂优先级和精力曲线;
 * 2. 无模型、报错、或一个块都没排上 ── 回退本地空档顺排。
 * 用户要的是「今天有个可行的表」,不是「一定要用 AI」。
 */

const DAY_END = 24 * 60
const LATEST_END = DAY_END - 30
/** 可用时长里至少留三成缓冲:计划排满等于注定失败 */
const BUFFER_RATIO = 0.3

function nowMinutes() {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && aEnd > bStart
}

type Row = {
  id: string
  title: string
  note: string
  kind: string
  status: string
  priority: number
  estimateMin: number
  energy: string
  plannedDate: string | null
  startMin: number | null
  endMin: number | null
  reason: string | null
  done: boolean
  postponeCount: number
}

function toItem(row: Row): PlanItem {
  return {
    id: row.id,
    title: row.title,
    note: row.note || undefined,
    kind: row.kind as PlanItem["kind"],
    status: row.status as PlanItem["status"],
    priority: row.priority as PlanItem["priority"],
    estimateMin: row.estimateMin,
    energy: row.energy as PlanItem["energy"],
    startMin: row.startMin ?? undefined,
    endMin: row.endMin ?? undefined,
    plannedDate: row.plannedDate ?? undefined,
    reason: row.reason ?? undefined,
    done: row.done,
    postponeCount: row.postponeCount,
  }
}

const SELECT = {
  id: true,
  title: true,
  note: true,
  kind: true,
  status: true,
  priority: true,
  estimateMin: true,
  energy: true,
  plannedDate: true,
  startMin: true,
  endMin: true,
  reason: true,
  done: true,
  postponeCount: true,
} as const

/** 当天条目:待安排(inbox)永远带上,已排的按 plannedDate 过滤;软删(dropped)不出 */
export async function listForDay(date: string, userId: string): Promise<PlanItem[]> {
  const rows = await prisma.planItem.findMany({
    where: { userId, status: { not: "dropped" }, OR: [{ status: "inbox" }, { plannedDate: date }] },
    orderBy: [
      // 收集箱永远排在当天计划后面(原 SQL 的 CASE WHEN 口径)
      { status: "desc" },
      { startMin: "asc" },
      { createdAt: "asc" },
    ],
    select: SELECT,
  })
  return rows.map(toItem)
}

export interface CreateItemInput {
  title: string
  note?: string
  kind?: PlanItem["kind"]
  priority?: PlanItem["priority"]
  estimateMin?: number
  energy?: PlanItem["energy"]
  /** 带时间创建时直接落成计划块(固定事件用) */
  plannedDate?: string | null
  startMin?: number | null
  endMin?: number | null
}

export async function createItem(input: CreateItemInput, userId: string): Promise<PlanItem> {
  const scheduled = input.startMin != null && input.endMin != null
  const row = await prisma.planItem.create({
    data: {
      userId,
      title: input.title,
      note: input.note ?? "",
      kind: input.kind ?? "task",
      status: scheduled ? "planned" : "inbox",
      priority: input.priority ?? 1,
      estimateMin: input.estimateMin ?? 30,
      energy: input.energy ?? "any",
      plannedDate: scheduled ? input.plannedDate ?? todayKey() : null,
      startMin: scheduled ? input.startMin! : null,
      endMin: scheduled ? input.endMin! : null,
      reason: scheduled ? "手动安排" : null,
    },
    select: SELECT,
  })
  return toItem(row)
}

const PATCH_KEYS = [
  "title",
  "note",
  "kind",
  "status",
  "priority",
  "estimateMin",
  "energy",
  "plannedDate",
  "startMin",
  "endMin",
  "reason",
  "done",
  "postponeCount",
] as const

export async function updateItem(
  id: string,
  patch: Record<string, unknown>,
  userId: string
): Promise<PlanItem | null> {
  const data: Record<string, unknown> = {}
  for (const key of PATCH_KEYS) {
    if (patch[key] !== undefined) data[key] = patch[key]
  }
  if (!Object.keys(data).length) {
    const row = await prisma.planItem.findFirst({ where: { id, userId }, select: SELECT })
    return row ? toItem(row) : null
  }
  const row = await prisma.planItem.updateMany({
    where: { id, userId, status: { not: "dropped" } },
    data: { ...data, updatedAt: new Date() },
  })
  if (!row.count) return null
  const next = await prisma.planItem.findFirst({ where: { id, userId }, select: SELECT })
  return next ? toItem(next) : null
}

/** 软删除:条目留在库里,撤销时能原样放回 */
export async function removeItem(id: string, userId: string): Promise<boolean> {
  const row = await prisma.planItem.updateMany({
    where: { id, userId },
    data: { status: "dropped", updatedAt: new Date() },
  })
  return row.count > 0
}

/** 撤销删除:写回删除前的状态与时间(前端把 dropped 前的快照随 patch 传回来) */
export async function restoreItem(
  id: string,
  patch: Record<string, unknown>,
  userId: string
): Promise<PlanItem | null> {
  const existing = await prisma.planItem.findFirst({ where: { id, userId }, select: { id: true } })
  if (!existing) return null
  const data: Record<string, unknown> = {}
  for (const key of PATCH_KEYS) {
    if (patch[key] !== undefined) data[key] = patch[key]
  }
  const row = await prisma.planItem.update({
    where: { id },
    data: { ...data, updatedAt: new Date() },
    select: SELECT,
  })
  return toItem(row)
}

function reasonFor(item: PlanItem, start: number): string {
  if (item.kind === "event") return "固定安排，不可移动"
  if (item.energy === "deep") {
    return start < 12 * 60 ? "上午精力好，安排需要专注的" : "下午整块时间，适合沉下去做"
  }
  if (start >= 19 * 60) return "晚上安排轻量任务，不硬塞深度工作"
  if (item.energy === "light") return "事务性工作，插在空档里顺手做完"
  if (item.priority === 2) return "优先级高，尽量往前放"
  return "按空档顺排，留了缓冲"
}

interface LocalScheduleOptions {
  /** 从几点开始找空档;默认沿用原来的「现在或 13:30 之后」 */
  startMin?: number
  /** 只占用可用空档的这个比例;不传则沿用旧的填满策略 */
  budgetRatio?: number
  reasonPrefix?: string
}

/** 本地启发式:不看语义,只找空档顺排。AI 不可用时的兜底 */
async function scheduleLocal(
  date: string,
  targets: PlanItem[],
  userId: string,
  opts: LocalScheduleOptions = {}
): Promise<{ added: number }> {
  const items = await listForDay(date, userId)
  const busy = items
    .filter((i) => i.startMin != null && i.endMin != null)
    .map((i) => ({ start: i.startMin!, end: i.endMin! }))

  let cursor = Math.max(opts.startMin ?? Math.max(nowMinutes(), 13 * 60 + 30), DAY_START)
  const budget =
    opts.budgetRatio == null
      ? Infinity
      : freeWindows(cursor, LATEST_END, busy.map((b) => ({ startMin: b.start, endMin: b.end })))
          .reduce((sum, w) => sum + (w.endMin - w.startMin), 0) * opts.budgetRatio
  let used = 0
  let added = 0

  for (const item of targets) {
    if (item.kind === "memo" || item.estimateMin <= 0) continue
    if (used + item.estimateMin > budget) continue

    let start = Math.max(cursor, DAY_START)
    let guard = 0
    while (guard++ < 400) {
      const conflict = busy.find((b) => overlap(start, start + item.estimateMin, b.start, b.end))
      if (!conflict) break
      start = conflict.end + 5
    }

    if (start + item.estimateMin > LATEST_END) continue

    const baseReason = reasonFor(item, start)
    await updateItem(
      item.id,
      {
        status: "planned",
        plannedDate: date,
        startMin: start,
        endMin: start + item.estimateMin,
        reason: opts.reasonPrefix ? `${opts.reasonPrefix} · ${baseReason}` : baseReason,
      },
      userId
    )

    busy.push({ start, end: start + item.estimateMin })
    cursor = start + item.estimateMin + 5
    used += item.estimateMin
    added++
  }

  return { added }
}

/** 把已占用的时间(固定事件 + 已排块)交给 AI,让它自己避开 */
function buildConstraints(items: PlanItem[], targets: PlanItem[]): ScheduleBody["constraints"] {
  const targetIds = new Set(targets.map((t) => t.id))
  const fixed = items
    .filter(
      (i) =>
        !targetIds.has(i.id) &&
        i.startMin != null &&
        i.endMin != null &&
        (i.kind === "event" || i.status === "planned")
    )
    .map((i) => ({
      id: i.id,
      title: i.title,
      startMin: i.startMin!,
      endMin: i.endMin!,
    }))

  const now = nowMinutes()
  const start = Math.max(DAY_START, Math.min(now, LATEST_END - 30))

  return {
    // 空档由程序算好再给模型:让它自己从 fixed 里推空档,它会直接放弃
    windows: freeWindows(start, LATEST_END, fixed),
    fixed,
    bufferRatio: BUFFER_RATIO,
    nowMin: now,
  }
}

/** 从 [start, end) 里扣掉所有占用,得到可用空档;小于 15 分钟的不算空档 */
function freeWindows(
  start: number,
  end: number,
  busy: { startMin: number; endMin: number }[]
): { startMin: number; endMin: number }[] {
  const sorted = [...busy].sort((a, b) => a.startMin - b.startMin)
  const windows: { startMin: number; endMin: number }[] = []
  let cursor = start

  for (const b of sorted) {
    if (b.endMin <= cursor) continue
    if (b.startMin >= end) break
    if (b.startMin > cursor) {
      windows.push({ startMin: cursor, endMin: Math.min(b.startMin, end) })
    }
    cursor = Math.max(cursor, Math.min(b.endMin, end))
    if (cursor >= end) break
  }

  if (cursor < end) windows.push({ startMin: cursor, endMin: end })
  return windows.filter((w) => w.endMin - w.startMin >= 15)
}

export interface ScheduleResult {
  items: PlanItem[]
  added: number
  source: "ai" | "local"
  model?: string
  /** 降级到本地排程时的原因,前端只用来提示一次 */
  note?: string
  deferred?: { itemId: string; reason: string }[]
}

/**
 * 排今天:AI 优先,兜底本地顺排。mode=one 只排指定的一条(空档是硬信息,直接本地算)。
 */
export async function scheduleDay(
  date: string,
  mode: "all" | "one",
  id: string | undefined,
  userId: string
): Promise<ScheduleResult> {
  const all = await listForDay(date, userId)
  const targets =
    mode === "one"
      ? all.filter((i) => i.id === id && !i.done && i.status === "inbox")
      : all.filter((i) => i.status === "inbox" && i.kind !== "memo" && !i.done)

  // 没有可排任务(可能都排好了),不打扰 AI
  if (targets.length === 0) {
    return { items: all, added: 0, source: "local", note: "没有待排任务" }
  }

  let note: string | undefined

  // 只排一条时没必要问模型:空档是硬信息,本地算完直接给,快五倍
  if (targets.length > 1) {
    try {
      const constraints = buildConstraints(all, targets)
      if (constraints.windows.length === 0) {
        return { items: all, added: 0, source: "local", note: "今天没有空档了，先留到明天" }
      }
      const body = scheduleBodySchema.parse({
        date,
        items: targets.map((t) => ({
          id: t.id,
          title: t.title,
          kind: t.kind,
          priority: t.priority,
          estimateMin: Math.max(5, Math.min(480, t.estimateMin || 30)),
          energy: t.energy,
        })),
        constraints,
      })
      const result = await aiScheduleCore(body, userId)

      const byId = new Map(targets.map((t) => [t.id, t]))
      let added = 0
      for (const block of result.blocks) {
        const item = byId.get(block.itemId)
        // AI 返回了不存在的 id 或不合法时长,直接跳过(guards 已过滤结构,这里挡语义)
        if (!item) continue
        if (block.endMin - block.startMin > item.estimateMin * 2) continue

        await updateItem(
          item.id,
          {
            status: "planned",
            plannedDate: date,
            startMin: block.startMin,
            endMin: block.endMin,
            reason: block.reason,
          },
          userId
        )
        added++
      }

      const deferred = result.deferred.filter((d) => byId.has(d.itemId))
      if (added > 0) {
        return {
          items: await listForDay(date, userId),
          added,
          source: "ai",
          model: result.model,
          deferred,
        }
      }
      // 200 但一个块都没落地:记下来方便判断是模型没排还是守卫丢的
      console.warn(
        "[plan] ai returned no usable block:",
        JSON.stringify(result).slice(0, 400)
      )
      note = "AI 没排出合适的块，已按空档顺排"
    } catch (err) {
      if (err instanceof ScheduleError && err.code === "no_model") {
        note = "未配置 AI 排程，按空档顺排"
      } else {
        console.warn("[plan] ai schedule failed, fallback to local:", err)
        note = "AI 排程暂不可用，已按空档顺排"
      }
    }
  }

  const local = await scheduleLocal(date, targets, userId)
  return {
    items: await listForDay(date, userId),
    added: local.added,
    source: "local",
    note,
  }
}
