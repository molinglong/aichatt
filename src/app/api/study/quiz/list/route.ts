/**
 * GET /api/study/quiz/list - 题库列表(浏览/练习的数据源)
 * 筛选: subject / kind(choice|answer) / difficulty(basic|medium|hard) / q(题干·考点模糊);
 * cursor 分页(默认 take 50,上限 100),按创建时间倒序。
 * 全量返回含 answer —— 个人工具不做服务端隐藏,防剧透由前端折叠负责。
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { libraryScopes } from '@/lib/library-scope'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const subject = sp.get('subject') || undefined
  const kind = sp.get('kind') || undefined
  const difficulty = sp.get('difficulty') || undefined
  const q = sp.get('q')?.trim()
  const take = Math.min(Math.max(Math.trunc(Number(sp.get('take'))) || 50, 1), 100)
  const cursor = sp.get('cursor')?.trim() || undefined

  const where: Record<string, unknown> = { userId: { in: await libraryScopes(session.user.id) } }
  if (subject) where.subject = subject
  if (kind) where.kind = kind
  if (difficulty) where.difficulty = difficulty
  if (q) {
    where.OR = [
      { stem: { contains: q, mode: 'insensitive' } },
      { topic: { contains: q, mode: 'insensitive' } },
    ]
  }

  try {
    const rows = await prisma.question.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, subject: true, topic: true, kind: true, stem: true,
        answer: true, difficulty: true, source: true, sourceRef: true, createdAt: true,
      },
    })
    return NextResponse.json({
      items: rows,
      nextCursor: rows.length === take ? rows[rows.length - 1].id : null,
    })
  } catch (err) {
    console.error('[study/quiz/list] failed:', err)
    return NextResponse.json({ error: '获取题库列表失败' }, { status: 500 })
  }
}
