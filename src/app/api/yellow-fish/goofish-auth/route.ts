import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getGoofishAuthStatus, runGoofishLogin } from '@/lib/ai/yellow-fish-cookie.server'

/**
 * goofish-cli 登录态查询/修复 —— 「设置 → YellowFish」的数据源。
 *
 * GET  auth status（服务端 60s 缓存；CLI 不在本机时 available=false，前端据此整体降级）
 * POST auth login（弹窗扫码/账密修复，窗口 10 分钟有效；成功后服务端已作废 status 缓存）
 *
 * 登录态本身是机器本机资源：任何登录用户都能看状态/触发修复（修复只是写本机
 * cookies.json，不泄漏 cookie 内容，返回里只有 unb/tracknick 等标识字段）。
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  try {
    const status = await getGoofishAuthStatus()
    return NextResponse.json(status)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '查询失败' },
      { status: 500 },
    )
  }
}

export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  try {
    const result = await runGoofishLogin()
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : '修复失败' },
      { status: 500 },
    )
  }
}
