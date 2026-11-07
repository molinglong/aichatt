import { NextResponse } from "next/server"
import { homeAuthorizeUrl, signHomeState } from "@/lib/home-sso"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const requested = url.searchParams.get("next") || "/chat"
  const next =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/chat"

  return NextResponse.redirect(homeAuthorizeUrl(signHomeState(next)))
}
