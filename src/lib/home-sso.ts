import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * home 作为身份源：aichatt 只接受 home 签发的一次性 code，
 * 按邮箱认领已有 aichatt 用户，不共享密码、不共享 cookie 域。
 */

const CODE_TTL_S = 60
const STATE_TTL_S = 10 * 60

type HomeCode = { typ: "home_code"; uid: string; email: string; exp: number }
type HomeState = { typ: "home_state"; next: string; exp: number }

function secret(): string {
  const value = process.env.HOME_SSO_SECRET
  if (!value || value.length < 16) throw new Error("HOME_SSO_SECRET 未配置")
  return value
}

function sign(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig = createHmac("sha256", secret()).update(body).digest("base64url")
  return `${body}.${sig}`
}

function verify<T>(token: string | undefined): T | null {
  if (!token) return null
  const [body, sig] = token.split(".")
  if (!body || !sig) return null

  const expected = createHmac("sha256", secret()).update(body).digest("base64url")
  const actual = Buffer.from(sig)
  const want = Buffer.from(expected)
  if (actual.length !== want.length || !timingSafeEqual(actual, want)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      exp?: number
    }
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null
    return payload as T
  } catch {
    return null
  }
}

export function verifyHomeCode(code: string | undefined): { uid: string; email: string } | null {
  const payload = verify<HomeCode>(code)
  if (!payload || payload.typ !== "home_code" || !payload.email) return null
  if (typeof payload.uid !== "string" || !payload.uid) return null
  return { uid: payload.uid, email: payload.email }
}

export function signHomeState(next: string): string {
  return sign({
    typ: "home_state",
    next,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_S,
  })
}

export function verifyHomeState(state: string | undefined): { next: string } | null {
  const payload = verify<HomeState>(state)
  if (!payload || payload.typ !== "home_state") return null
  const next =
    typeof payload.next === "string" && payload.next.startsWith("/") && !payload.next.startsWith("//")
      ? payload.next
      : "/chat"
  return { next }
}

export function homeAuthorizeUrl(state: string): string {
  const base = (process.env.HOME_BASE_URL || "http://localhost:5173").replace(/\/+$/, "")
  const redirectUri =
    process.env.HOME_CALLBACK_URL || "http://localhost:3000/api/auth/home/callback"

  const url = new URL(`${base}/oauth/authorize`)
  url.searchParams.set("client_id", "aichatt")
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("state", state)
  return url.toString()
}

export const HOME_CODE_TTL_S = CODE_TTL_S
