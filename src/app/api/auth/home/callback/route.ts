import { NextResponse } from "next/server"
import { verifyHomeState } from "@/lib/home-sso"

export const dynamic = "force-dynamic"

/** home 授权后回到这里：校验 state，把一次性 code 交给登录页完成 NextAuth 登录。 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const state = url.searchParams.get("state") || undefined
  const code = url.searchParams.get("code") || undefined
  const error = url.searchParams.get("error")

  const target = new URL("/login", url.origin)
  const parsed = verifyHomeState(state)
  if (!parsed) {
    target.searchParams.set("home_error", "state")
    return NextResponse.redirect(target)
  }

  if (error) {
    target.searchParams.set("home_error", error)
    return NextResponse.redirect(target)
  }

  if (!code) {
    target.searchParams.set("home_error", "code")
    return NextResponse.redirect(target)
  }

  target.searchParams.set("home_code", code)
  target.searchParams.set("next", parsed.next)
  return NextResponse.redirect(target)
}
