import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import {
  aiScheduleCore,
  ScheduleError,
  scheduleBodySchema,
} from "@/lib/plan/ai-schedule"

/**
 * AI 排程端点(原 plan 服务的 Bearer sk- 令牌鉴权,见 lib/api-auth)。
 *
 * 2026-11-19 并入后只剩薄壳:选模型/key/配额/generateObject/applyGuards 全部
 * 抽进 lib/plan/ai-schedule(与「排今天」编排 /api/plan/schedule-day 共用),
 * 这里只做鉴权 + 参数校验 + 错误整形,对外契约(请求/响应形状)不变。
 */

export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const parsed = scheduleBodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: "参数不合法", detail: parsed.error.issues.slice(0, 3) },
      { status: 400 }
    )
  }

  try {
    const result = await aiScheduleCore(parsed.data, userId)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof ScheduleError) {
      return NextResponse.json(
        { error: err.message, code: err.code, detail: err.detail },
        { status: err.status }
      )
    }
    return NextResponse.json({ error: "排程失败", code: "ai_error" }, { status: 500 })
  }
}
