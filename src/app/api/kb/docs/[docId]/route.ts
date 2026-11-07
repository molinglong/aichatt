/**
 * GET /api/kb/docs/[docId] —— 单本课本详情(阅读器数据源)。
 * 校验归属:只能翻自己名下的书。目录(章节导航)后续可从 chunks 聚合,v1 只给页数。
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET(
  _req: NextRequest,
  { params }: { params: { docId: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const { docId } = params
  if (!docId) {
    return NextResponse.json({ error: '缺少 docId' }, { status: 400 })
  }

  try {
    const doc = await prisma.knowledgeDoc.findFirst({
      where: { id: docId, userId: session.user.id, bookKey: { not: null } },
      select: {
        id: true,
        title: true,
        subject: true,
        grade: true,
        kind: true,
        publisher: true,
        bookKey: true,
        pageCount: true,
        chunkCount: true,
        charCount: true,
        createdAt: true,
      },
    })
    if (!doc) {
      return NextResponse.json({ error: '课本不存在或不在你名下' }, { status: 404 })
    }
    return NextResponse.json(doc)
  } catch (err) {
    console.error('[kb/docs] detail failed:', err)
    return NextResponse.json({ error: '获取课本详情失败' }, { status: 500 })
  }
}
