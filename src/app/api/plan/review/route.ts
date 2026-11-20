import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { reviewDay } from "@/lib/plan/review"

/**
 * 日终复盘 —— /api/plan/review?date=YYYY-MM-DD。
 * 纯规则统计(完成率/顺延/过时未动/待安排存量),不调 AI;口径见 lib/plan/review.ts。
 */

export const runtime = "nodejs"

export async function GET(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const date = new URL(req.url).searchParams.get("date")
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "日期不合法" }, { status: 400 })
  }

  try {
    const result = await reviewDay(date, userId)
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("[plan/review.GET] failed:", err)
    return NextResponse.json({ error: "读取复盘失败" }, { status: 500 })
  }
}
