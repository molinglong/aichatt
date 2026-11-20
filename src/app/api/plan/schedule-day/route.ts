import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { scheduleDay } from "@/lib/plan/scheduler"

/**
 * 「排今天」编排端点 —— /api/plan/schedule-day。
 *
 * 与 /api/plan/schedule(AI 核心管道,原 plan 服务的令牌端点)的分工:
 * schedule-day 负责编排 —— 从 PlanItem 表取当天条目、构建可用窗口约束、
 * 调 AI 核心、把结果落库,一步返回最新列表;AI 核心本身抽在 lib/plan/ai-schedule。
 * mode=one 只排指定一条(空档是硬信息,直接本地顺排,不问模型)。
 */

export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 })
  }
  const date = typeof body.date === "string" ? body.date : ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "日期不合法" }, { status: 400 })
  }
  const mode = body.mode === "one" ? "one" : "all"
  const id = typeof body.id === "string" ? body.id : undefined

  try {
    const result = await scheduleDay(date, mode, id, userId)
    return NextResponse.json(result)
  } catch (err) {
    console.error("[plan/schedule-day] failed:", err)
    return NextResponse.json({ error: "排程失败", code: "ai_error" }, { status: 500 })
  }
}
