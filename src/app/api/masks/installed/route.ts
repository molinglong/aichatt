import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { isDownloadableMask } from '@/lib/ai/builtin-masks-store'

/**
 * 面具面板下载记录（当前用户）。
 * - GET    列出已下载的内置面具 id
 * - POST   下载（幂等 upsert），body: { maskId }
 * - DELETE 卸载，?maskId=xxx
 *
 * 只允许写入「面具面板」目录里的 id；历史会话仍由 getBuiltinMask 正常解析，
 * 卸载不会让旧对话失效。
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const rows = await prisma.installedMask.findMany({
    where: { userId: session.user.id },
    select: { maskId: true },
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json({ maskIds: rows.map((r) => r.maskId) })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  const maskId = (body as { maskId?: unknown })?.maskId
  if (typeof maskId !== 'string' || !maskId) {
    return NextResponse.json({ error: '缺少 maskId' }, { status: 400 })
  }
  if (!isDownloadableMask(maskId)) {
    return NextResponse.json({ error: '该面具不在面具面板中' }, { status: 400 })
  }

  try {
    await prisma.installedMask.upsert({
      where: { userId_maskId: { userId: session.user.id, maskId } },
      create: { userId: session.user.id, maskId },
      update: {},
    })
    return NextResponse.json({ ok: true, maskId })
  } catch (err) {
    console.error('[masks/installed] install failed:', err)
    return NextResponse.json({ error: '下载面具失败' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const maskId = new URL(req.url).searchParams.get('maskId')
  if (!maskId) {
    return NextResponse.json({ error: '缺少 maskId' }, { status: 400 })
  }

  try {
    await prisma.installedMask.deleteMany({
      where: { userId: session.user.id, maskId },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[masks/installed] uninstall failed:', err)
    return NextResponse.json({ error: '卸载面具失败' }, { status: 500 })
  }
}
