import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

/**
 * 待办 CRUD —— 供页面与外部客户端（新标签页插件快问小组件/待办 Widget）调用。
 * 与 AI 工具（manage_todo，见 lib/ai/todo-tool.server.ts）共用 Todo 表与校验口径，
 * 两边操作同一份数据。
 *
 * 鉴权：双通道（lib/api-auth）—— cookie session（页面）与
 * Authorization: Bearer <token>（外部静态页，ApiToken 表校验）。
 * middleware 对 Bearer 请求放行，token 有效性在本 handler 内校验（无效 401）。
 * 临时模式下写操作被 middleware EPHEMERAL_DENIED_PREFIXES 拦截（403），GET 放行只读。
 */

/** 待办内容校验：trim 后 1-100 字（与 manage_todo 工具一致） */
function normalizeContent(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const content = raw.trim()
  if (content.length < 1 || content.length > 100) return null
  return content
}

/** dueAt 宽松解析：非法值一律返回 null，不报错 */
function normalizeDueAt(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function GET(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const params = new URL(req.url).searchParams
  // 同步客户端按稳定 id 分页，完成状态改变不会让条目在分页中移动。
  // 普通列表继续保持原来的排序和 100 条上限，兼容已有客户端。
  if (params.get("sync") === "true") {
    const after = params.get("after")
    const rows = await prisma.todo.findMany({
      where: { userId, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" },
      take: 101,
      select: { id: true, content: true, done: true, dueAt: true },
    })
    const todos = rows.slice(0, 100)
    return NextResponse.json({
      todos,
      ownerId: userId,
      nextCursor: rows.length > 100 ? todos[todos.length - 1].id : null,
    }, { headers: { "Cache-Control": "no-store" } })
  }

  const doneParam = params.get("done")
  const todos = await prisma.todo.findMany({
    where: {
      userId,
      ...(doneParam === "true" || doneParam === "false" ? { done: doneParam === "true" } : {}),
    },
    orderBy: [{ done: "asc" }, { createdAt: "desc" }],
    take: 100,
  })

  return NextResponse.json({ todos })
}

export async function POST(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const content = normalizeContent(body.content)
  if (!content) {
    return NextResponse.json({ error: "待办内容需为 1-100 字" }, { status: 400 })
  }

  const todo = await prisma.todo.create({
    data: {
      userId,
      content,
      dueAt: normalizeDueAt(body.dueAt),
      source: "manual",
    },
  })

  return NextResponse.json(todo, { status: 201 })
}

export async function PATCH(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const id = typeof body.id === "string" ? body.id : ""
  if (!id) {
    return NextResponse.json({ error: "缺少待办 id" }, { status: 400 })
  }

  if (body.expectedOwnerId !== undefined && body.expectedOwnerId !== userId) {
    return NextResponse.json({ error: "aichatt 账号已改变，请先重新同步" }, { status: 409 })
  }

  // 构造更新数据：仅接受明确传入的字段
  const data: { done?: boolean; doneAt?: Date | null; content?: string; dueAt?: Date | null } = {}
  if (typeof body.done === "boolean") {
    data.done = body.done
    // 完成时记录时间，取消完成时清空
    data.doneAt = body.done ? new Date() : null
  }
  if (body.content !== undefined) {
    const content = normalizeContent(body.content)
    if (!content) {
      return NextResponse.json({ error: "待办内容需为 1-100 字" }, { status: 400 })
    }
    data.content = content
  }
  if (body.dueAt !== undefined) {
    data.dueAt = normalizeDueAt(body.dueAt)
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 })
  }

  try {
    // 先按 (id, userId) 校验归属再更新：找不到或不属于当前用户均 404，防越权
    const existing = await prisma.todo.findFirst({
      where: { id, userId },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: "待办不存在" }, { status: 404 })
    }
    const todo = await prisma.todo.update({ where: { id }, data })
    return NextResponse.json(todo)
  } catch (err) {
    console.error("[todos.PATCH] failed:", err)
    return NextResponse.json({ error: "更新失败" }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const id = new URL(req.url).searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "缺少待办 id" }, { status: 400 })
  }

  // 先按 (id, userId) 校验归属再删除，防越权删他人待办
  const existing = await prisma.todo.findFirst({
    where: { id, userId },
    select: { id: true },
  })
  if (!existing) {
    return NextResponse.json({ error: "待办不存在" }, { status: 404 })
  }

  await prisma.todo.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
