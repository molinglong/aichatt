import { NextResponse } from 'next/server'
import { createMCPClient } from '@ai-sdk/mcp'
import { auth } from '@/lib/auth'
import { assertSafeUrl } from '@/lib/ssrf'
import { MCP_INITIAL_PROTOCOL_VERSION } from '@/lib/ai/mcp/mcp-constants'
import { createMcpCompatFetch } from '@/lib/ai/mcp/mcp-compat.server'

/**
 * MCP server 连接测试：保存前先验证可达性并预览工具清单。
 *
 * POST { url, headerName?, headerValue? }
 * → { ok, serverName, tools: [{ name, description }] } 或 { ok: false, error }
 * 超时 8s；测试连接用完即关，不保留。
 */

const TEST_TIMEOUT_MS = 8_000

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${TEST_TIMEOUT_MS / 1000}s）`)), TEST_TIMEOUT_MS)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  let client: Awaited<ReturnType<typeof createMCPClient>> | null = null
  try {
    const body = (await request.json()) as {
      url?: string
      headerName?: string
      headerValue?: string
    }
    const url = body.url?.trim()
    if (!url) {
      return NextResponse.json({ ok: false, error: 'URL 为必填项' }, { status: 400 })
    }
    // 与保存接口同口径：MCP URL 为用户静态配置，放行内网/本机地址
    const blocked = assertSafeUrl(url, { allowPrivate: true })
    if (blocked) {
      return NextResponse.json({ ok: false, error: blocked }, { status: 400 })
    }

    const headers: Record<string, string> = {}
    const headerName = body.headerName?.trim()
    const headerValue = body.headerValue?.trim()
    if (headerName && headerValue) {
      headers[headerName] = headerValue
    }

    client = await withTimeout(
      createMCPClient({
        transport: {
          type: 'http',
          url,
          headers,
          initialProtocolVersion: MCP_INITIAL_PROTOCOL_VERSION,
          fetch: createMcpCompatFetch(),
        },
      }),
      '连接'
    )
    const result = await withTimeout(client.listTools(), '获取工具列表')
    const tools = (result.tools ?? []).map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
    }))

    return NextResponse.json({
      ok: true,
      serverName: client.serverInfo?.name ?? null,
      tools,
    })
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `连接超时（${TEST_TIMEOUT_MS / 1000}s）`
          : err.message
        : '连接失败'
    console.error('[mcp/servers/test]', message)
    return NextResponse.json({ ok: false, error: message }, { status: 200 })
  } finally {
    if (client) {
      await client.close().catch(() => {})
    }
  }
}
