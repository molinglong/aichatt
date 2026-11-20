import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'

/**
 * GET /api/words/lists —— 字典里已有哪些词单（计划设置里的选择器数据源）。
 * 全局数据，不按用户过滤；顺带给出「已进我的词的条数」，用来显示进度感。
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id
  try {
    const lists = await prisma.dictList.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        slug: true,
        name: true,
        level: true,
        wordCount: true,
        items: { select: { entry: { select: { lemma: true } } } },
      },
    })
    const mine = new Set(
      (await prisma.userWord.findMany({ where: { userId }, select: { lemma: true } })).map((w) => w.lemma),
    )
    return NextResponse.json({
      lists: lists.map((l) => ({
        id: l.id,
        slug: l.slug,
        name: l.name,
        level: l.level,
        wordCount: l.wordCount,
        ownedCount: l.items.filter((i) => mine.has(i.entry.lemma)).length,
      })),
    })
  } catch (err) {
    console.error('[words/lists] failed:', err)
    return NextResponse.json({ error: '读取词单失败' }, { status: 500 })
  }
}
