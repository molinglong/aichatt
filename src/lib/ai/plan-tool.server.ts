import { tool } from "ai"
import { prisma } from "@/lib/db"
import {
  planInputSchema,
  PLAN_OPERATIONS,
  type PlanToolInput,
  type PlanToolOutput,
  type PlanToolBlock,
} from "@/lib/ai/plan-tool"
import { listForDay, createItem, updateItem, removeItem, scheduleDay } from "@/lib/plan/scheduler"
import { parseTimeInput, fmtTime } from "@/lib/plan/time"

/**
 * manage_plan 工具工厂（服务端专用，依赖 prisma；勿从客户端组件 import）。
 * 常量与 schema 在 plan-tool.ts（isomorphic），拆分原因见该文件头注释。
 *
 * 复用 lib/plan/scheduler 的全部数据访问与排程编排（与 /api/plan/items、
 * /api/plan/schedule-day 同口径），AI 写入的数据弹窗/复盘/贴纸立即可见。
 * 模糊匹配（双向 includes）仅限同一用户名下，命中多条返回 candidates
 * 交由模型向用户澄清，绝不擅自选择（manage_todo 同款纪律）。
 */
export function createPlanTool(userId: string) {
  return tool({
    description:
      "管理用户的今日计划(时间轴+待安排)和备忘录。用户问今天安排、要求记事/排时间(「3 点开会」「记一下买灯泡」)、" +
      "勾完成(「背单词写完了」)、改时间(「物理作业挪到 4 点」)、顺延(「这事儿明天再说」)、触发排程(「帮我排一下今天」)、" +
      "存/搜备忘时调用。完成/移动/删除按标题关键词模糊匹配,命中多条会返回候选项需向用户确认。",
    inputSchema: planInputSchema,
    execute: async (input: PlanToolInput): Promise<PlanToolOutput> => {
      const operation = PLAN_OPERATIONS.includes(input.operation)
        ? input.operation
        : "today"

      // 日期口径与弹窗一致:本地时区 YYYY-MM-DD
      const now = new Date()
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
        now.getDate()
      ).padStart(2, "0")}`

      try {
        if (operation === "today") return await viewToday(userId, date)
        if (operation === "add") return await addItems(userId, date, input)
        if (operation === "schedule") {
          const result = await scheduleDay(date, "all", undefined, userId)
          const view = await viewToday(userId, date)
          return {
            ...view,
            operation,
            scheduled: { added: result.added, source: result.source, note: result.note },
          }
        }
        if (operation === "memo_save") return await memoSave(userId, input)
        if (operation === "memo_search") return await memoSearch(userId, input)

        // complete / move / delete:按标题模糊匹配
        const keyword = (input.match ?? "").trim()
        if (!keyword) {
          return { ok: false, operation, message: `${operation} 需要 match 关键词` }
        }
        const items = await listForDay(date, userId)
        const hits = items.filter((i) => i.title.includes(keyword) || keyword.includes(i.title))
        if (hits.length === 0) {
          return { ok: false, operation, message: `今天没有找到带「${keyword}」的条目,可先让用户确认是否记过` }
        }
        if (hits.length > 1) {
          return {
            ok: false,
            operation,
            candidates: hits.map((h) => `${h.title}${h.startMin != null ? `(${fmtTime(h.startMin)})` : ""}`),
            message: "匹配到多条,请向用户确认是哪一条,再带更精确的关键词重试",
          }
        }
        const hit = hits[0]

        if (operation === "complete") {
          await updateItem(hit.id, { done: true, status: "done" }, userId)
          return { ok: true, operation, date, completed: [hit.title] }
        }

        if (operation === "delete") {
          await removeItem(hit.id, userId)
          return { ok: true, operation, date, deleted: [hit.title] }
        }

        // move:改时间(保持原时长)或顺延到明天
        if (input.postpone) {
          const tomorrow = new Date(now)
          tomorrow.setDate(tomorrow.getDate() + 1)
          const tmKey = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(
            tomorrow.getDate()
          ).padStart(2, "0")}`
          await updateItem(
            hit.id,
            {
              status: "inbox",
              plannedDate: tmKey,
              startMin: null,
              endMin: null,
              reason: null,
              postponeCount: (hit.postponeCount ?? 0) + 1,
            },
            userId
          )
          return {
            ok: true,
            operation,
            date,
            moved: [`「${hit.title}」已顺延到明天`],
          }
        }
        if (!input.startMin) {
          return {
            ok: false,
            operation,
            message: "move 需要新时间(startMin HH:MM)或 postpone:true(顺延到明天)",
          }
        }
        const startMin = parseTimeInput(input.startMin)
        if (startMin == null) {
          return { ok: false, operation, message: `时间「${input.startMin}」不合法,用 HH:MM(如 15:00)` }
        }
        const dur =
          hit.startMin != null && hit.endMin != null
            ? Math.max(5, hit.endMin - hit.startMin)
            : Math.max(5, hit.estimateMin || 30)
        const endMin = Math.min(24 * 60, startMin + dur)
        await updateItem(
          hit.id,
          {
            status: "planned",
            plannedDate: date,
            startMin,
            endMin,
            reason: "手动安排(AI 协助)",
            done: false,
          },
          userId
        )
        return {
          ok: true,
          operation,
          date,
          moved: [`「${hit.title}」已挪到 ${fmtTime(startMin)}–${fmtTime(endMin)}`],
        }
      } catch (err) {
        console.error("[plan-tool] execute failed:", err)
        return { ok: false, operation, error: "操作失败,请稍后重试" }
      }
    },
  })
}

async function viewToday(userId: string, date: string): Promise<PlanToolOutput> {
  const items = await listForDay(date, userId)
  const blocks: PlanToolBlock[] = items
    .filter((i) => i.startMin != null && i.endMin != null)
    .sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0))
    .map((i) => ({
      id: i.id,
      title: i.title,
      startMin: i.startMin!,
      endMin: i.endMin!,
      kind: i.kind,
      done: !!i.done,
      priority: i.priority,
      reason: i.reason,
    }))
  const inbox = items
    .filter((i) => i.status === "inbox")
    .map((i) => ({ id: i.id, title: i.title, estimateMin: i.estimateMin, priority: i.priority }))
  return { ok: true, operation: "today", date, blocks, inbox }
}

async function addItems(userId: string, date: string, input: PlanToolInput): Promise<PlanToolOutput> {
  if (!input.items?.length) {
    return { ok: false, operation: "add", message: "add 需要至少一条事项" }
  }
  const added: PlanToolOutput["added"] = []
  for (const item of input.items) {
    const title = item.title.trim()
    if (!title) continue
    const startMin = item.startMin ? parseTimeInput(item.startMin) : null
    let endMin = item.endMin ? parseTimeInput(item.endMin) : null
    if (startMin != null && endMin == null) {
      endMin = Math.min(24 * 60, startMin + (item.estimateMin ?? (item.kind === "event" ? 60 : 30)))
    }
    const created = await createItem(
      {
        title,
        kind: item.kind ?? "task",
        priority: (item.priority ?? 1) as 0 | 1 | 2,
        estimateMin:
          startMin != null && endMin != null
            ? Math.max(5, endMin - startMin)
            : (item.estimateMin ?? 30),
        plannedDate: startMin != null ? date : undefined,
        startMin,
        endMin: endMin ?? null,
      },
      userId
    )
    added.push({
      title,
      status: created.status === "planned" ? "planned" : "inbox",
      time: created.startMin != null ? fmtTime(created.startMin) : undefined,
    })
  }
  if (!added.length) {
    return { ok: false, operation: "add", message: "没有有效事项(标题不能为空)" }
  }
  return { ...(await viewToday(userId, date)), ok: true, operation: "add", date, added }
}

async function memoSave(userId: string, input: PlanToolInput): Promise<PlanToolOutput> {
  const content = (input.memoContent ?? "").trim()
  if (!content) {
    return { ok: false, operation: "memo_save", message: "memo_save 需要 memoContent" }
  }
  const row = await prisma.planMemo.create({
    data: {
      userId,
      title: (input.memoTitle ?? "").trim().slice(0, 100),
      content,
    },
    select: { id: true, title: true, content: true, pinned: true, updatedAt: true },
  })
  return {
    ok: true,
    operation: "memo_save",
    memo: { ...row, updatedAt: row.updatedAt.toISOString() },
  }
}

async function memoSearch(userId: string, input: PlanToolInput): Promise<PlanToolOutput> {
  const q = (input.memoQuery ?? "").trim()
  const rows = await prisma.planMemo.findMany({
    where: q
      ? { userId, OR: [{ title: { contains: q } }, { content: { contains: q } }] }
      : { userId },
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    take: 10,
    select: { id: true, title: true, content: true, pinned: true, updatedAt: true },
  })
  return {
    ok: true,
    operation: "memo_search",
    memos: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })),
  }
}
