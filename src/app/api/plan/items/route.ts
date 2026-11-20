import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { createItem, listForDay } from "@/lib/plan/scheduler"

/**
 * 今日计划条目列表 + 创建 —— /api/plan/items。
 *
 * 原 plan 独立服务的 /api/items 并入版:cookie session 直连(外部令牌通道仍由
 * getUserId 双通道兼容),数据落 PlanItem 表。快速记入的一句话解析(parseQuickAdd)
 * 在客户端完成,这里只收结构化字段;带 startMin+endMin 创建即直接落成计划块。
 */

export const runtime = "nodejs"

const MAX_TITLE = 200
const MAX_NOTE = 2_000

const KINDS = new Set(["task", "event", "memo"])
const ENERGIES = new Set(["deep", "light", "any"])

function unauthorized() {
  return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
}

/** YYYY-MM-DD 口径校验;服务端一律用本地时区日期,不接受任意字符串 */
function readDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const d = new Date(`${raw}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : raw
}

export async function GET(req: Request) {
  const userId = await getUserId(req)
  if (!userId) return unauthorized()

  const date = readDate(new URL(req.url).searchParams.get("date"))
  if (!date) return NextResponse.json({ error: "日期不合法" }, { status: 400 })

  try {
    const items = await listForDay(date, userId)
    return NextResponse.json(
      { items },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (err) {
    console.error("[plan/items.GET] failed:", err)
    return NextResponse.json({ error: "读取今日计划失败" }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const userId = await getUserId(req)
  if (!userId) return unauthorized()

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "创建参数不合法" }, { status: 400 })
  }
  const input = body as Record<string, unknown>

  const title = typeof input.title === "string" ? input.title.trim().slice(0, MAX_TITLE) : ""
  if (!title) return NextResponse.json({ error: "标题不能为空" }, { status: 400 })

  const kind = typeof input.kind === "string" && KINDS.has(input.kind) ? input.kind : "task"
  const energy = typeof input.energy === "string" && ENERGIES.has(input.energy) ? input.energy : "any"
  const priority =
    typeof input.priority === "number" && Number.isInteger(input.priority) && input.priority >= 0 && input.priority <= 2
      ? input.priority
      : 1
  const estimateMin =
    typeof input.estimateMin === "number" && Number.isFinite(input.estimateMin)
      ? Math.max(0, Math.min(480, Math.round(input.estimateMin)))
      : 30
  const note = typeof input.note === "string" ? input.note.slice(0, MAX_NOTE) : undefined

  // 带时间创建即直接落成计划块(固定事件/手动安排);时间只认当日分钟数
  const startMin =
    typeof input.startMin === "number" && Number.isInteger(input.startMin) && input.startMin >= 0 && input.startMin < 1440
      ? input.startMin
      : null
  const endMin =
    typeof input.endMin === "number" && Number.isInteger(input.endMin) && input.endMin >= 0 && input.endMin <= 1440
      ? input.endMin
      : null
  const plannedDate = readDate(input.plannedDate)

  try {
    const item = await createItem(
      {
        title,
        note,
        kind: kind as "task" | "event" | "memo",
        energy: energy as "deep" | "light" | "any",
        priority: priority as 0 | 1 | 2,
        estimateMin,
        plannedDate,
        startMin,
        endMin: startMin != null && endMin != null && endMin > startMin ? endMin : null,
      },
      userId
    )
    return NextResponse.json(item, { status: 201 })
  } catch (err) {
    console.error("[plan/items.POST] failed:", err)
    return NextResponse.json({ error: "记入失败" }, { status: 500 })
  }
}
