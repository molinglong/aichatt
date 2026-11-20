import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { newWordCardFields } from '@/lib/words/fsrs'

/**
 * POST /api/words/add —— 把划词/查词遇到的词收进「我的词」
 *
 * body: { headword, trans? }
 * - 字典里有这个词条 → 直接挂 entryId（共享释义），trans 留空
 * - 字典里没有 → 建一条自由词（entryId=null），把划词得到的释义当快照存起来
 * 幂等：同一 (userId, lemma) 只建一条，重复添加返回已有那条。
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  let body: { headword?: unknown; trans?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  const headword = String(body.headword ?? '').trim().slice(0, 80)
  if (!headword) return NextResponse.json({ error: '缺少单词' }, { status: 400 })
  const trans = typeof body.trans === 'string' ? body.trans.trim().slice(0, 500) : null

  const lemma = headword
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'.]+|[\s"'.]+$/g, '')

  try {
    const existed = await prisma.userWord.findFirst({ where: { userId, lemma }, select: { id: true } })
    if (existed) return NextResponse.json({ id: existed.id, existed: true })

    const entry = await prisma.dictEntry.findUnique({
      where: { lemma },
      select: { id: true, headword: true, trans: true },
    })

    const created = await prisma.userWord.create({
      data: {
        userId,
        entryId: entry?.id ?? null,
        headword: entry?.headword ?? headword,
        lemma,
        trans: entry ? null : trans,
        source: 'manual',
        ...newWordCardFields(),
      },
      select: { id: true },
    })
    return NextResponse.json({ id: created.id, existed: false, inDictionary: Boolean(entry) })
  } catch (err) {
    console.error('[words/add] failed:', err)
    return NextResponse.json({ error: '加入词库失败' }, { status: 500 })
  }
}
