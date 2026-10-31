import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

/**
 * 手表端当前账号资料：设置页显示用户名/头像，代替明文 API Token。
 * 称呼优先级与网页一致：nickname → name（不回退邮箱前缀）。
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录" }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, nickname: true },
  })
  if (!user) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 })
  }

  return NextResponse.json({
    name: user.nickname?.trim() || user.name?.trim() || "用户",
  })
}
