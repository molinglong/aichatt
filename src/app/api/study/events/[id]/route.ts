import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'

/** DELETE /api/study/events/[id] - 删除一条学习记录(归属校验:非本人视为不存在) */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  try {
    const row = await prisma.studyEvent.deleteMany({
      where: { id: params.id, userId: session.user.id },
    })
    if (row.count === 0) {
      return NextResponse.json({ error: '记录不存在或已被删除' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[study/events] delete failed:', err)
    return NextResponse.json({ error: '删除学习记录失败' }, { status: 500 })
  }
}
