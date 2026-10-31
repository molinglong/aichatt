import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

/**
 * 手表端长期记忆开关（Bearer 或 cookie）。
 * 只读开关状态与条数，不暴露记忆正文——手表屏幕不适合编辑记忆。
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请检查 API 令牌" }, { status: 401 })
  }

  const [user, count] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { memoryEnabled: true } }),
    prisma.memory.count({ where: { userId, status: "active" } }),
  ])

  return NextResponse.json({
    enabled: user?.memoryEnabled ?? true,
    count,
  })
}

export async function PATCH(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请检查 API 令牌" }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 })
  }

  await prisma.user.update({
    where: { id: userId },
    data: { memoryEnabled: body.enabled },
  })

  return NextResponse.json({ ok: true, enabled: body.enabled })
}
