import { NextResponse } from "next/server"
import { prisma } from "@/lib/db"

/**
 * 手表设备码授权 - 第三步：手表轮询。
 * pending → 继续等；approved → 返回一次性 Token 并立即消费；
 * expired/consumed → 手表提示刷新或重新登录。
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const code = (new URL(req.url).searchParams.get("code") ?? "").trim().toUpperCase()
  if (!code) {
    return NextResponse.json({ error: "缺少授权码" }, { status: 400 })
  }

  const record = await prisma.deviceAuthCode.findUnique({ where: { code } })
  if (!record) return NextResponse.json({ status: "expired" })
  if (record.status === "consumed") return NextResponse.json({ status: "consumed" })
  if (record.expiresAt.getTime() < Date.now()) return NextResponse.json({ status: "expired" })

  if (record.status === "approved" && record.plainToken) {
    const token = record.plainToken
    await prisma.deviceAuthCode.update({
      where: { code },
      data: { status: "consumed", plainToken: null },
    })
    return NextResponse.json({ status: "approved", token })
  }

  return NextResponse.json({ status: "pending" })
}
