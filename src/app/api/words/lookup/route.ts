import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'

/**
 * GET /api/words/lookup?q=abandoned —— 查词（字典是全局的，登录即可查）
 *
 * 命中顺序：原形直查 → 词形反查（DictEntry.exchange 里含该词形）→ 常见后缀还原试探
 * （-s/-es/-ed/-ing/-ly/-er/-est，含双写辅音与去 e 规则）。
 * 返回 { hit, suggestions[] }：hit 是命中的词条（带「是否已在我的词」），
 * suggestions 是前缀匹配的候选（打错字时给几条参考）。
 * 不做模糊拼写纠正：那需要词频与编辑距离，等真有痛点再说。
 */
const SUFFIX_TRIES = [
  (w: string) => (w.endsWith('ies') ? w.slice(0, -3) + 'y' : null),
  (w: string) => (w.endsWith('ves') ? w.slice(0, -3) + 'f' : null),
  (w: string) => (w.endsWith('es') ? w.slice(0, -2) : null),
  (w: string) => (w.endsWith('s') ? w.slice(0, -1) : null),
  (w: string) => (w.endsWith('ied') ? w.slice(0, -3) + 'y' : null),
  (w: string) => (w.endsWith('ed') ? w.slice(0, -2) : null),
  (w: string) => (w.endsWith('ed') ? w.slice(0, -1) : null),
  (w: string) => (w.endsWith('ing') ? w.slice(0, -3) : null),
  (w: string) => (w.endsWith('ing') ? w.slice(0, -3) + 'e' : null),
  (w: string) => (w.endsWith('ly') ? w.slice(0, -2) : null),
  (w: string) => (w.endsWith('est') ? w.slice(0, -3) : null),
  (w: string) => (w.endsWith('er') ? w.slice(0, -2) : null),
  (w: string) => (w.endsWith('est') ? w.slice(0, -2) : null),
]

function normalize(q: string) {
  return q
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'.]+|[\s"'.]+$/g, '')
    .trim()
}

/** 双写辅音还原：stopp ed → stop */
function undouble(w: string) {
  return /([bcdfghjklmnpqrstvwxz])\1$/.test(w) ? w.slice(0, -1) : null
}

const ENTRY_SELECT = {
  id: true,
  headword: true,
  lemma: true,
  isPhrase: true,
  phoneticUs: true,
  phoneticUk: true,
  pos: true,
  trans: true,
  definition: true,
  exchange: true,
  examples: true,
  collocations: true,
  mnemonic: true,
  tags: true,
} as const

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const raw = req.nextUrl.searchParams.get('q') ?? ''
  const lemma = normalize(raw)
  if (!lemma) return NextResponse.json({ error: '缺少查询词' }, { status: 400 })
  if (lemma.length > 60) return NextResponse.json({ error: '查询词太长' }, { status: 400 })

  try {
    let entry = await prisma.dictEntry.findUnique({ where: { lemma }, select: ENTRY_SELECT })

    // 词形反查：exchange 形如 "p:abandoned/d:abandoned/i:abandoning/3:abandons"
    if (!entry) {
      entry = await prisma.dictEntry.findFirst({
        where: { exchange: { contains: `:${lemma}/`, mode: 'insensitive' } },
        select: ENTRY_SELECT,
      }) ?? await prisma.dictEntry.findFirst({
        where: { exchange: { contains: `:${lemma}`, mode: 'insensitive' } },
        select: ENTRY_SELECT,
      })
    }

    // 后缀还原试探
    if (!entry) {
      const guesses = new Set<string>()
      for (const f of SUFFIX_TRIES) {
        const g = f(lemma)
        if (g && g.length >= 2) {
          guesses.add(g)
          const d = undouble(g)
          if (d) guesses.add(d)
        }
      }
      if (guesses.size) {
        const found = await prisma.dictEntry.findMany({
          where: { lemma: { in: Array.from(guesses) } },
          select: ENTRY_SELECT,
          take: 1,
        })
        entry = found[0] ?? null
      }
    }

    const suggestions = entry
      ? []
      : (
          await prisma.dictEntry.findMany({
            where: { headword: { startsWith: lemma, mode: 'insensitive' } },
            select: { headword: true, lemma: true, trans: true },
            orderBy: { freqRank: 'asc' },
            take: 6,
          })
        )

    let mine: { id: string; state: number; reps: number; mastery: number; dueAt: Date | null } | null = null
    if (entry) {
      mine = await prisma.userWord.findFirst({
        where: { userId: session.user.id, lemma: entry.lemma },
        select: { id: true, state: true, reps: true, mastery: true, dueAt: true },
      })
    }

    return NextResponse.json({ query: lemma, hit: entry, inMyWords: mine, suggestions })
  } catch (err) {
    console.error('[words/lookup] failed:', err)
    return NextResponse.json({ error: '查词失败' }, { status: 500 })
  }
}
