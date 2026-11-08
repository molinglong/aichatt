import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { encrypt } from '@/lib/crypto'
import { assertSafeUrl } from '@/lib/ssrf'
import { slugifyServerName, MCP_MAX_SERVERS } from '@/lib/ai/mcp/mcp-constants'
import { monitor } from '@/lib/monitor'

/**
 * MCP server 管理接口（设置中心「MCP 工具」分区）。
 *
 * 安全约定：
 * - 全部路由 auth() 守卫；资源操作校验归属（userId）
 * - Header 值仅接受明文写入（encrypt 落库），任何响应永不回传
 * - URL 过 SSRF 校验；server 总数有上限
 */

/** 列表项公共 select：绝不含 encryptedHeaderValue */
const LIST_SELECT = {
  id: true,
  name: true,
  slug: true,
  url: true,
  headerName: true,
  excludeTools: true,
  enabled: true,
  createdAt: true,
} as const

/** 解析 excludeTools：接受 string[]（存 JSON） */
function serializeExcludeTools(raw: unknown): string | null {
  if (raw == null) return null
  if (!Array.isArray(raw)) return null
  const arr = raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
  return JSON.stringify(arr)
}

/** 生成不与用户现有 server 冲突的 slug（冲突则追加 -2/-3…） */
async function resolveUniqueSlug(userId: string, name: string): Promise<string> {
  const base = slugifyServerName(name)
  const existing = await prisma.mcpServer.findMany({
    where: { userId },
    select: { slug: true },
  })
  const taken = new Set(existing.map((s) => s.slug))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const servers = await prisma.mcpServer.findMany({
    where: { userId: session.user.id },
    select: LIST_SELECT,
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json({ servers })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  try {
    const body = (await request.json()) as {
      name?: string
      url?: string
      headerName?: string
      headerValue?: string
      excludeTools?: unknown
    }
    const name = body.name?.trim()
    const url = body.url?.trim()
    if (!name || !url) {
      return NextResponse.json({ error: '名称与 URL 为必填项' }, { status: 400 })
    }
    if (name.length > 40) {
      return NextResponse.json({ error: '名称过长（最多 40 字）' }, { status: 400 })
    }
    // MCP URL 为用户手动配置的静态资源，放行内网/本机地址（自建 MCP server 场景）
    const blocked = assertSafeUrl(url, { allowPrivate: true })
    if (blocked) {
      monitor('mcp_ssrf_blocked', { url: url.slice(0, 120) })
      return NextResponse.json({ error: blocked }, { status: 400 })
    }

    const headerName = body.headerName?.trim() || null
    const headerValue = body.headerValue?.trim() || null
    if ((headerName && !headerValue) || (!headerName && headerValue)) {
      return NextResponse.json({ error: 'Header 名与值需成对填写' }, { status: 400 })
    }

    const count = await prisma.mcpServer.count({ where: { userId } })
    if (count >= MCP_MAX_SERVERS) {
      monitor('mcp_limit_hit', { count })
      return NextResponse.json(
        { error: `最多添加 ${MCP_MAX_SERVERS} 个 MCP 服务` },
        { status: 400 }
      )
    }

    const dup = await prisma.mcpServer.findFirst({
      where: { userId, name },
      select: { id: true },
    })
    if (dup) {
      monitor('mcp_dup_name', { name })
      return NextResponse.json({ error: '已存在同名服务' }, { status: 409 })
    }

    const slug = await resolveUniqueSlug(userId, name)
    const record = await prisma.mcpServer.create({
      data: {
        userId,
        name,
        slug,
        url,
        ...(headerName && headerValue
          ? { headerName, encryptedHeaderValue: encrypt(headerValue) }
          : {}),
        ...(serializeExcludeTools(body.excludeTools)
          ? { excludeTools: serializeExcludeTools(body.excludeTools)! }
          : {}),
      },
      select: LIST_SELECT,
    })
    monitor('mcp_created', { id: record.id, slug: record.slug })
    return NextResponse.json({ server: record })
  } catch (err) {
    console.error('[mcp/servers] POST failed:', err)
    return NextResponse.json({ error: '保存失败，请稍后重试' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  try {
    const body = (await request.json()) as {
      id?: string
      name?: string
      enabled?: boolean
      headerName?: string
      headerValue?: string
      excludeTools?: unknown
    }
    const id = body.id
    if (!id) {
      return NextResponse.json({ error: 'id 为必填项' }, { status: 400 })
    }

    const existing = await prisma.mcpServer.findFirst({
      where: { id, userId },
      select: { id: true, headerName: true },
    })
    if (!existing) {
      return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
    }

    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string' && body.name.trim()) {
      data.name = body.name.trim().slice(0, 40)
    }
    if (typeof body.enabled === 'boolean') {
      data.enabled = body.enabled
    }
    if (body.excludeTools !== undefined) {
      const serialized = serializeExcludeTools(body.excludeTools)
      data.excludeTools = serialized
    }
    // Header 更新：成对传入才更新；只传空串表示清除鉴权
    if (body.headerName !== undefined || body.headerValue !== undefined) {
      const headerName = body.headerName?.trim() || ''
      const headerValue = body.headerValue?.trim() || ''
      if (!headerName && !headerValue) {
        data.headerName = null
        data.encryptedHeaderValue = null
      } else if (headerName && headerValue) {
        data.headerName = headerName
        data.encryptedHeaderValue = encrypt(headerValue)
      } else {
        return NextResponse.json({ error: 'Header 名与值需成对填写' }, { status: 400 })
      }
    }

    const record = await prisma.mcpServer.update({
      where: { id },
      data,
      select: LIST_SELECT,
    })
    return NextResponse.json({ server: record })
  } catch (err) {
    console.error('[mcp/servers] PATCH failed:', err)
    return NextResponse.json({ error: '更新失败，请稍后重试' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  try {
    const body = (await request.json()) as { id?: string }
    if (!body.id) {
      return NextResponse.json({ error: 'id 为必填项' }, { status: 400 })
    }
    // 先校验归属再删，避免越权删除他人配置
    const existing = await prisma.mcpServer.findFirst({
      where: { id: body.id, userId: session.user.id },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
    }
    await prisma.mcpServer.delete({ where: { id: body.id } })
    monitor('mcp_deleted', { id: body.id })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[mcp/servers] DELETE failed:', err)
    return NextResponse.json({ error: '删除失败，请稍后重试' }, { status: 500 })
  }
}
