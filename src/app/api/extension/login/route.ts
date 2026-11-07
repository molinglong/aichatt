import { NextResponse } from "next/server"
import { createHash, randomBytes } from "crypto"
import { getUserId } from "@/lib/api-auth"
import { verifyCredentials } from "@/lib/credentials"
import { prisma } from "@/lib/db"
import { monitor } from "@/lib/monitor"

/**
 * 浏览器扩展登录 —— 账号密码换一枚扩展专属 Bearer 令牌。
 *
 * 为什么不直接复用 NextAuth cookie：扩展侧边栏是 cross-site 请求，
 * SameSite=Lax 的会话 cookie 不会随 fetch 发送；而且扩展需要长期免登录。
 * 因此登录成功后签发 ApiToken（与设置页「API 令牌」同一张表，可随时撤销），
 * 令牌名带设备标识，重复登录只保留该设备的最新一枚，避免撞上 5 枚上限。
 */

const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{6,40}$/
const EXTENSION_TOKEN_PREFIX = "扩展·"

function deviceTokenName(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : ""
  const safe = DEVICE_ID_RE.test(value) ? value.slice(0, 16) : "default"
  return `${EXTENSION_TOKEN_PREFIX}${safe}`
}

function unauthorized() {
  return NextResponse.json(
    { error: "登录已失效，请重新登录", code: "UNAUTHORIZED" },
    { status: 401 }
  )
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    identifier?: unknown
    password?: unknown
    deviceId?: unknown
  }
  const identifier =
    typeof body.identifier === "string" ? body.identifier.trim() : ""
  const password = typeof body.password === "string" ? body.password : ""

  if (!identifier || !password) {
    return NextResponse.json(
      { error: "请填写账号和密码", code: "MISSING_CREDENTIALS" },
      { status: 400 }
    )
  }
  if (identifier.length > 200 || password.length > 200) {
    return NextResponse.json(
      { error: "账号或密码格式不正确", code: "INVALID_CREDENTIALS" },
      { status: 400 }
    )
  }

  const result = await verifyCredentials(identifier, password, "extension")

  if (result.status === "rate_limited") {
    return NextResponse.json(
      { error: "尝试次数过多，请 1 分钟后再试", code: "RATE_LIMITED" },
      { status: 429 }
    )
  }
  if (result.status === "guest_password_not_allowed") {
    return NextResponse.json(
      {
        error: "扩展登录请使用账户主密码；访客密码只用于网页临时聊天",
        code: "GUEST_PASSWORD_NOT_ALLOWED",
      },
      { status: 403 }
    )
  }
  if (result.status !== "ok" || result.ephemeral) {
    return NextResponse.json(
      { error: "账号或密码错误", code: "INVALID_CREDENTIALS" },
      { status: 401 }
    )
  }

  const user = result.user
  const name = deviceTokenName(body.deviceId)

  // 同设备重复登录：先撤销旧令牌，再签发新的（明文不可恢复，只能换发）
  await prisma.apiToken.updateMany({
    where: { userId: user.id, name, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  const activeCount = await prisma.apiToken.count({
    where: { userId: user.id, revokedAt: null },
  })
  if (activeCount >= 5) {
    monitor("extension_login_token_limit", { userId: user.id })
    return NextResponse.json(
      {
        error: "有效 API 令牌已达上限（5），请先在 aichatt 设置 → API 令牌里撤销不用的令牌",
        code: "TOKEN_LIMIT",
      },
      { status: 400 }
    )
  }

  const plaintext = `sk-${randomBytes(24).toString("hex")}`
  const tokenHash = createHash("sha256").update(plaintext).digest("hex")
  const token = await prisma.apiToken.create({
    data: { userId: user.id, name, tokenHash },
    select: { id: true, name: true, createdAt: true },
  })

  monitor("extension_login", { userId: user.id, tokenId: token.id })

  return NextResponse.json({
    token: plaintext,
    tokenId: token.id,
    tokenName: token.name,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role,
    },
  })
}

/** 校验当前 Bearer 是否仍有效，并回传账号信息（面板启动时刷新登录态用）。 */
export async function GET(req: Request) {
  const userId = await getUserId(req)
  if (!userId) return unauthorized()

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, image: true, role: true },
  })
  if (!user) return unauthorized()

  return NextResponse.json({ user })
}

/** 退出登录：撤销当前 Bearer 令牌（幂等）。 */
export async function DELETE(req: Request) {
  const bearer = req.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!bearer) return unauthorized()

  const tokenHash = createHash("sha256").update(bearer).digest("hex")
  const revoked = await prisma.apiToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  if (revoked.count > 0) monitor("extension_logout", { count: revoked.count })

  return NextResponse.json({ ok: true })
}
