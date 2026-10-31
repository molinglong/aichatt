import { NextResponse } from "next/server"
import { createHash, randomBytes } from "crypto"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"

/**
 * 手表设备码授权 - 第二步：网页端（已登录）输入短码确认。
 * 校验码有效后创建一枚 API Token，并把明文暂存到 DeviceAuthCode，
 * 等手表 poll 取走时立即清空（一次性）。
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "请先登录 aichatt" }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as { code?: unknown }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : ""
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return NextResponse.json({ error: "授权码格式不对" }, { status: 400 })
  }

  const record = await prisma.deviceAuthCode.findUnique({ where: { code } })
  if (!record) {
    return NextResponse.json({ error: "授权码不存在，请核对后重试" }, { status: 404 })
  }
  if (record.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "授权码已过期，请在手表上刷新" }, { status: 410 })
  }
  if (record.status !== "pending") {
    return NextResponse.json({ error: "该授权码已被使用" }, { status: 409 })
  }

  // 同一账号的旧「手表登录」令牌先撤销：设备码登录是单设备语义，
  // 反复登录不应堆积令牌，也避免触发 5 个上限。
  await prisma.apiToken.updateMany({
    where: { userId: session.user.id, name: "手表登录", revokedAt: null },
    data: { revokedAt: new Date() },
  })

  const activeCount = await prisma.apiToken.count({
    where: { userId: session.user.id, revokedAt: null },
  })
  if (activeCount >= 5) {
    return NextResponse.json(
      { error: "有效令牌已达上限(5)，请先在设置里撤销不用的令牌" },
      { status: 400 }
    )
  }

  const plaintext = `sk-${randomBytes(24).toString("hex")}`
  const tokenHash = createHash("sha256").update(plaintext).digest("hex")

  await prisma.$transaction([
    prisma.apiToken.create({
      data: { userId: session.user.id, name: "手表登录", tokenHash },
    }),
    prisma.deviceAuthCode.update({
      where: { code },
      data: {
        userId: session.user.id,
        status: "approved",
        plainToken: plaintext,
      },
    }),
  ])

  return NextResponse.json({ ok: true })
}
