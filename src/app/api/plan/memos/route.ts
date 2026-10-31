import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

/**
 * plan 应用「备忘录」CRUD —— 由 plan 服务端用 AICHATT_TOKEN(Bearer sk-) 代理调用。
 *
 * 与 /api/todos 的边界：
 * - todos 是「要做的事」，进排程、可勾完成；
 * - PlanMemo 是「要留住的话」，纯文本、可置顶、可搜索，不参与任何排程。
 * 两者共用鉴权与 userId 隔离口径，但互不读写对方的表。
 *
 * 离线策略由 plan 端负责：plan 本地 SQLite 缓存读结果、把失败的写操作放进
 * outbox 手动重放；这里只保证「在线时每次写入都返回权威行」。
 */

export const runtime = "nodejs"

const MAX_TITLE = 100
const MAX_CONTENT = 20_000
const LIST_LIMIT = 200

type MemoRow = {
  id: string
  title: string
  content: string
  pinned: boolean
  createdAt: Date
  updatedAt: Date
}

function shape(row: MemoRow) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    pinned: row.pinned,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 标题允许为空字符串；非字符串一律视为非法，避免把对象/数组写进库 */
function readTitle(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "标题格式不合法" }
  const value = raw.trim()
  if (value.length > MAX_TITLE) return { ok: false, error: `标题最多 ${MAX_TITLE} 个字` }
  return { ok: true, value }
}

function readContent(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "正文格式不合法" }
  if (raw.length > MAX_CONTENT) return { ok: false, error: `正文最多 ${MAX_CONTENT} 个字` }
  return { ok: true, value: raw }
}

function unauthorized() {
  return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
}

/** GET /api/plan/memos?q=&pinned=true|false - 置顶优先，再按更新时间倒序 */
export async function GET(req: Request) {
  const userId = await getUserId(req)
  if (!userId) return unauthorized()

  const params = new URL(req.url).searchParams
  const q = params.get("q")?.trim().slice(0, 200)
  const pinned = params.get("pinned")

  const where: Record<string, unknown> = { userId }
  if (pinned === "true" || pinned === "false") where.pinned = pinned === "true"
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { content: { contains: q, mode: "insensitive" } },
    ]
  }

  try {
    const rows = await prisma.planMemo.findMany({
      where,
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      take: LIST_LIMIT,
      select: { id: true, title: true, content: true, pinned: true, createdAt: true, updatedAt: true },
    })
    // ownerId 供 plan 端核对令牌账户与登录账户是否一致（同 /api/todos 的同步口径）
    return NextResponse.json(
      { memos: rows.map(shape), ownerId: userId },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (err) {
    console.error("[plan/memos.GET] failed:", err)
    return NextResponse.json({ error: "读取备忘录失败" }, { status: 500 })
  }
}

/**
 * POST /api/plan/memos - 新建
 * 支持客户端自带 id（离线草稿重放时用本地临时 id 换正式 id 会打乱本地引用，
 * 因此让客户端生成 cuid 风格 id，服务端只在冲突时拒绝）。
 */
export async function POST(req: Request) {
  const userId = await getUserId(req)
  if (!userId) return unauthorized()

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "新建参数不合法" }, { status: 400 })
  }
  const input = body as Record<string, unknown>

  const title = readTitle(input.title ?? "")
  if (!title.ok) return NextResponse.json({ error: title.error }, { status: 400 })
  const content = readContent(input.content ?? "")
  if (!content.ok) return NextResponse.json({ error: content.error }, { status: 400 })
  if (!title.value && !content.value.trim()) {
    return NextResponse.json({ error: "标题和正文不能都为空" }, { status: 400 })
  }

  const id = typeof input.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(input.id) ? input.id : undefined

  try {
    if (id) {
      // 重放离线草稿：同 id 已存在视为成功（幂等），避免重复点击生成多条
      const existing = await prisma.planMemo.findFirst({ where: { id, userId } })
      if (existing) return NextResponse.json(shape(existing))
      const taken = await prisma.planMemo.findUnique({ where: { id }, select: { userId: true } })
      if (taken) return NextResponse.json({ error: "备忘录 id 已被占用" }, { status: 409 })
    }

    const row = await prisma.planMemo.create({
      data: {
        ...(id ? { id } : {}),
        userId,
        title: title.value,
        content: content.value,
        pinned: input.pinned === true,
      },
      select: { id: true, title: true, content: true, pinned: true, createdAt: true, updatedAt: true },
    })
    return NextResponse.json(shape(row), { status: 201 })
  } catch (err) {
    console.error("[plan/memos.POST] failed:", err)
    return NextResponse.json({ error: "保存备忘录失败" }, { status: 500 })
  }
}

/** PATCH /api/plan/memos - 更新标题/正文/置顶；带 baseUpdatedAt 时做乐观锁 */
export async function PATCH(req: Request) {
  const userId = await getUserId(req)
  if (!userId) return unauthorized()

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "更新参数不合法" }, { status: 400 })
  }
  const input = body as Record<string, unknown>
  const id = typeof input.id === "string" ? input.id : ""
  if (!id) return NextResponse.json({ error: "缺少备忘录 id" }, { status: 400 })

  const data: { title?: string; content?: string; pinned?: boolean } = {}
  if (input.title !== undefined) {
    const title = readTitle(input.title)
    if (!title.ok) return NextResponse.json({ error: title.error }, { status: 400 })
    data.title = title.value
  }
  if (input.content !== undefined) {
    const content = readContent(input.content)
    if (!content.ok) return NextResponse.json({ error: content.error }, { status: 400 })
    data.content = content.value
  }
  if (input.pinned !== undefined) {
    if (typeof input.pinned !== "boolean") {
      return NextResponse.json({ error: "置顶状态不合法" }, { status: 400 })
    }
    data.pinned = input.pinned
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 })
  }

  try {
    // 先按 (id, userId) 校验归属：找不到与不属于自己都回 404，不泄露存在性
    const existing = await prisma.planMemo.findFirst({
      where: { id, userId },
      select: { id: true, title: true, content: true, pinned: true, createdAt: true, updatedAt: true },
    })
    if (!existing) return NextResponse.json({ error: "备忘录不存在" }, { status: 404 })

    // 离线重放时可能基于旧版本写入：不静默覆盖别处的修改，交给 plan 端提示用户
    if (typeof input.baseUpdatedAt === "string" && input.baseUpdatedAt !== existing.updatedAt.toISOString()) {
      return NextResponse.json(
        { error: "这条备忘录在别处改过", memo: shape(existing) },
        { status: 409 }
      )
    }

    const nextTitle = data.title ?? existing.title
    const nextContent = data.content ?? existing.content
    if (!nextTitle && !nextContent.trim()) {
      return NextResponse.json({ error: "标题和正文不能都为空" }, { status: 400 })
    }

    const row = await prisma.planMemo.update({
      where: { id },
      data,
      select: { id: true, title: true, content: true, pinned: true, createdAt: true, updatedAt: true },
    })
    return NextResponse.json(shape(row))
  } catch (err) {
    console.error("[plan/memos.PATCH] failed:", err)
    return NextResponse.json({ error: "更新备忘录失败" }, { status: 500 })
  }
}

/** DELETE /api/plan/memos?id= - 按唯一 id 删除；归属不符回 404 */
export async function DELETE(req: Request) {
  const userId = await getUserId(req)
  if (!userId) return unauthorized()

  const id = new URL(req.url).searchParams.get("id")
  if (!id) return NextResponse.json({ error: "缺少备忘录 id" }, { status: 400 })

  const existing = await prisma.planMemo.findFirst({ where: { id, userId }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: "备忘录不存在" }, { status: 404 })

  try {
    await prisma.planMemo.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[plan/memos.DELETE] failed:", err)
    return NextResponse.json({ error: "删除备忘录失败" }, { status: 500 })
  }
}
