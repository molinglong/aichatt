import bcrypt from "bcryptjs"
import { prisma } from "./db"
import { monitor } from "./monitor"

/**
 * 账号密码校验的唯一实现 —— 网页 NextAuth 登录与浏览器扩展登录共用，
 * 避免两套限速/密码比对逻辑产生绕过路径。
 *
 * entry 决定密码通道的准入规则：
 * - web：主密码 → 完整模式；访客密码 → 临时模式（与原先登录页一致）
 * - ephemeral：只认访客密码；主密码明确拒绝（公共电脑场景防泄露）
 * - extension：只认主密码；访客密码拒绝（扩展会签发长期令牌，不能绑临时会话）
 */

export type CredentialEntry = "web" | "ephemeral" | "extension"

export type CredentialUser = {
  id: string
  email: string
  name: string | null
  image: string | null
  role: string
}

export type VerifyCredentialsResult =
  | { status: "ok"; user: CredentialUser; ephemeral: boolean }
  | { status: "invalid" }
  | { status: "rate_limited" }
  | { status: "main_password_on_ephemeral" }
  | { status: "guest_password_not_allowed" }

// ── 登录失败限速：同一 identifier 1 分钟窗口内最多 5 次失败 ──
// 防爆破访客密码后蹭 API 额度；内存级实现，进程重启即清零（可接受）
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_FAILURES = 5
const loginFailures = new Map<string, { count: number; resetAt: number }>()

function loginRateLimited(identifier: string): boolean {
  const entry = loginFailures.get(identifier)
  if (!entry || entry.resetAt < Date.now()) return false
  return entry.count >= RATE_LIMIT_MAX_FAILURES
}

function recordLoginFailure(identifier: string): void {
  const now = Date.now()
  const entry = loginFailures.get(identifier)
  if (!entry || entry.resetAt < now) {
    // 简单防 Map 膨胀：超过 1000 个 identifier 时清掉已过期窗口
    if (loginFailures.size > 1000) {
      loginFailures.forEach((value, key) => {
        if (value.resetAt < now) loginFailures.delete(key)
      })
    }
    loginFailures.set(identifier, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return
  }
  entry.count += 1
  monitor("login_failed", { identifier })
}

function clearLoginFailures(identifier: string): void {
  loginFailures.delete(identifier)
}

function toCredentialUser(user: {
  id: string
  email: string
  name: string | null
  image: string | null
  role: string
}): CredentialUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    role: user.role,
  }
}

export async function verifyCredentials(
  identifier: string,
  password: string,
  entry: CredentialEntry = "web"
): Promise<VerifyCredentialsResult> {
  if (!identifier || !password) return { status: "invalid" }

  // 登录标识兼容邮箱与用户名：先按 email 查，查不到再按 name 兜底
  const rateLimitKey = identifier.toLowerCase()
  if (loginRateLimited(rateLimitKey)) {
    monitor("login_rate_limited", { identifier: rateLimitKey })
    return { status: "rate_limited" }
  }

  const user =
    (await prisma.user.findUnique({ where: { email: identifier } })) ??
    (await prisma.user.findFirst({ where: { name: identifier } }))

  if (!user) {
    recordLoginFailure(rateLimitKey)
    return { status: "invalid" }
  }

  // 1) 主密码优先比对 → 完整模式
  if (user.passwordHash && (await bcrypt.compare(password, user.passwordHash))) {
    if (entry === "ephemeral") {
      monitor("login_ephemeral_entry_main_password", { identifier: rateLimitKey })
      return { status: "main_password_on_ephemeral" }
    }
    clearLoginFailures(rateLimitKey)
    return { status: "ok", user: toCredentialUser(user), ephemeral: false }
  }

  // 2) 访客密码比对 → 临时模式（guestPasswordHash 为空=未启用，永不命中）
  if (user.guestPasswordHash && (await bcrypt.compare(password, user.guestPasswordHash))) {
    if (entry === "extension") {
      monitor("login_extension_guest_denied", { identifier: rateLimitKey })
      return { status: "guest_password_not_allowed" }
    }
    clearLoginFailures(rateLimitKey)
    monitor("login_guest_ok", { identifier: rateLimitKey })
    return { status: "ok", user: toCredentialUser(user), ephemeral: true }
  }

  recordLoginFailure(rateLimitKey)
  return { status: "invalid" }
}
