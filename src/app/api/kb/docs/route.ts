/**
 * GET /api/kb/docs —— 「可翻原文」课本列表(书架数据源):自己名下 + 公共库主人名下。
 *
 * 只返回 bookKey 非空的 KnowledgeDoc(按页导入的课本);HTML/文本导入的
 * 资料没有页图,不进书架。封面/页图 URL 客户端按 bookKey 拼:
 * /kb-pages/{bookKey}/p001.webp。
 */
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { libraryScopes } from '@/lib/library-scope'
import { prisma } from '@/lib/db'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  try {
    const docs = await prisma.knowledgeDoc.findMany({
      where: { userId: { in: await libraryScopes(session.user.id) }, bookKey: { not: null } },
      orderBy: { createdAt: 'desc' },
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
    return NextResponse.json(docs)
  } catch (err) {
    console.error('[kb/docs] list failed:', err)
    return NextResponse.json({ error: '获取课本列表失败' }, { status: 500 })
  }
}
