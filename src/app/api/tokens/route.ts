import { NextResponse } from "next/server"
import { createHash, randomBytes } from "crypto"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { monitor } from "@/lib/monitor"

/**
 * API 令牌管理 —— 供设置页生成/撤销 Bearer Token（外部静态页调用 REST API 用）。
 *
 * 明文仅在创建响应中出现一次（sk- 前缀 + 32 hex），库中只存 sha256 哈希；
 * DELETE 单撤销走 ?id=（软撤销写 revokedAt 保留审计），撤销后外部页面请求返回 401；
 * 批量操作走 ?scope=（设置页 ⋯ 菜单）：
 *   active   = 全部软撤销（记录保留，可再清）
 *   revoked  = 硬删全部已撤销记录（含审计，不可恢复）
 *   all      = 先全撤销再硬删（整列清空，不可恢复）
 * 页面鉴权走 cookie session（与 /api/keys 等账户管理端点同口径）。
 */

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const tokens = await prisma.apiToken.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  })

  return NextResponse.json({ tokens })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as { name?: unknown }
  const name =
    typeof body.name === "string" && body.name.trim() && body.name.trim().length <= 30
      ? body.name.trim()
      : "新标签页"

  // 每用户有效令牌上限:防止无限堆积(撤销的不计入)
  const activeCount = await prisma.apiToken.count({
    where: { userId: session.user.id, revokedAt: null },
  })
  if (activeCount >= 5) {
    monitor("token_limit_hit", { activeCount })
    return NextResponse.json({ error: "有效令牌已达上限(5),请先撤销不用的令牌" }, { status: 400 })
  }

  const plaintext = `sk-${randomBytes(24).toString("hex")}`
  const tokenHash = createHash("sha256").update(plaintext).digest("hex")

  const token = await prisma.apiToken.create({
    data: { userId: session.user.id, name, tokenHash },
    select: { id: true, name: true, createdAt: true },
  })
  monitor("token_created", { id: token.id, nameLength: name.length })

  return NextResponse.json({ ...token, token: plaintext }, { status: 201 })
}

export async function DELETE(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }
  const userId = session.user.id

  const params = new URL(req.url).searchParams
  const id = params.get("id")
  const scope = params.get("scope")

  // 单个撤销:软撤销——先校验归属再写 revokedAt,防越权;幂等(已撤销再撤销无副作用)
  if (id) {
    const existing = await prisma.apiToken.findFirst({
      where: { id, userId, revokedAt: null },
      select: { id: true },
    })
    if (!existing) {
      monitor("token_revoke_denied", { id })
      return NextResponse.json({ error: "令牌不存在或已撤销" }, { status: 404 })
    }

    await prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } })
    monitor("token_revoked", { id })
    return NextResponse.json({ ok: true })
  }

  // 批量:全部软撤销(记录保留)
  if (scope === "active") {
    const r = await prisma.apiToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    monitor("token_bulk_revoked", { count: r.count })
    return NextResponse.json({ ok: true, count: r.count })
  }

  // 批量:硬删全部已撤销记录(含审计,不可恢复)
  if (scope === "revoked") {
    const r = await prisma.apiToken.deleteMany({
      where: { userId, revokedAt: { not: null } },
    })
    monitor("token_revoked_purged", { count: r.count })
    return NextResponse.json({ ok: true, count: r.count })
  }

  // 批量:先全撤销再硬删(整列清空,不可恢复)
  if (scope === "all") {
    const r = await prisma.$transaction([
      prisma.apiToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.apiToken.deleteMany({ where: { userId } }),
    ])
    monitor("token_all_purged", { revoked: r[0].count, deleted: r[1].count })
    return NextResponse.json({ ok: true, count: r[1].count })
  }

  return NextResponse.json({ error: "缺少令牌 id 或 scope" }, { status: 400 })
}
