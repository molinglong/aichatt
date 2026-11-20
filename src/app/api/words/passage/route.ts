import { NextRequest, NextResponse } from 'next/server'
import { generateText } from 'ai'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { resolveStudyModel } from '@/lib/study/tagging'
import { resolvePassageWords } from '@/lib/words/passage.server'

/**
 * POST /api/words/passage —— 用「今天要背的词」生成一篇小短文（AI 生成，带缓存）
 *
 * body: { words: string[], reviewCount?: number, previewCount?: number, refresh?: boolean }
 * - 掺词：reviewCount 从「我的词」里挑已学过的（到期优先），previewCount 从计划词单里挑
 *   还没学的，一起塞进短文——背新词时顺手复习旧词、瞟一眼明天的词。
 * - 缓存：最终词集（含掺词）排序去重 hash 相同就直接复用；hits 记一次命中。
 * - refresh=true（前端「重新生成」）强制重写并覆盖同一条缓存，不堆版本。
 * 词集解析与 /papers/words 附短文共用 lib/words/passage.server.ts，两边 key 一致。
 */
// 难度下限（2026-11-17 用户反馈「零基础一点都看不懂」）：压到地板——超短句、只用基础词、
// 一句最多塞一个生词。这份提示词是难度的唯一来源，以后调难度只动这里。
const SYSTEM = [
  '你是给英语零基础的中国学生写英语短文的老师。用给定的目标词写一篇超简单的短文，规则：',
  '- 60–100 个英文单词，一段或三四段都行；目标：零基础学生能连蒙带猜读下来',
  '- 每个句子最多 8 个词，一句只说一个意思；禁止从句、被动语态、完成时；一般现在时为主',
  '- 除目标词外只用最基础的词（be 动词、人称代词、常见介词 to/in/at/on/for/with/under/near、常见动词 say/ask/know/help/want/like/need、常见形容词 good/big/small/new/old/happy/sorry）；不引入任何其他生词，写完自查每句话',
  '- 每个句子里最多放 1 个目标词（一句挤两个生词就读不懂了）；目标词尽量用原形，最多加 -s/-ed/-ing',
  '- 必须自然包含全部目标词，每个至少出现一次',
  '- 正文里把每个目标词（含变形）用 **双星号** 包起来，例如 **find**、**runs**',
  '- 场景要具体日常：教室、家里、路上、和同学聊天；不要讲大道理',
  '- 标题给英文 + 中文，英文标题也用短句',
  '- 正文后给整段中文译文，忠实、口语化',
  '输出严格 JSON，不要代码围栏、不要解释：',
  '{"title":"English title","titleZh":"中文标题","body":"...**word**...","translation":"中文译文","words":[{"w":"目标词","form":"文中的形式"}]}',
].join('\n')

const clean = (s: unknown) => String(s ?? '').trim()

function payload(
  row: {
    title: string
    titleZh: string | null
    body: string
    translation: string | null
    usedWords: unknown
    words: string[]
  },
  extras: { reviewWords: string[]; previewWords: string[] },
  cached: boolean,
) {
  return {
    title: row.title,
    titleZh: row.titleZh ?? '',
    body: row.body,
    translation: row.translation ?? '',
    words: Array.isArray(row.usedWords) ? row.usedWords : [],
    targetWords: row.words,
    reviewWords: extras.reviewWords,
    previewWords: extras.previewWords,
    cached,
  }
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  let body: { words?: unknown; reviewCount?: unknown; previewCount?: unknown; refresh?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }

  const base = Array.isArray(body.words)
    ? Array.from(
        new Set(
          body.words
            .map((w) => clean(w))
            .filter((w) => w.length > 0 && w.length <= 40),
        ),
      ).slice(0, 30)
    : []
  if (base.length < 3) {
    return NextResponse.json({ error: '至少需要 3 个词才能串成短文' }, { status: 400 })
  }

  const clampCount = (v: unknown) => Math.min(Math.max(Math.trunc(Number(v)) || 0, 0), 10)
  const reviewCount = clampCount(body.reviewCount)
  const previewCount = clampCount(body.previewCount)
  const refresh = body.refresh === true

  const { allWords, reviewWords, previewWords, key } = await resolvePassageWords(
    userId,
    base,
    reviewCount,
    previewCount,
  )

  // 1) 缓存命中：同一组词（含掺词）直接复用
  if (!refresh) {
    const hit = await prisma.wordPassage.findUnique({ where: { userId_key: { userId, key } } })
    if (hit) {
      await prisma.wordPassage.update({ where: { id: hit.id }, data: { hits: { increment: 1 } } }).catch(() => {})
      return NextResponse.json(payload(hit, { reviewWords, previewWords }, true))
    }
  }

  const model = await resolveStudyModel(userId)
  if (!model) {
    return NextResponse.json({ error: '没有可用的对话模型，请先在对话里用一次模型' }, { status: 400 })
  }

  try {
    const { text } = await generateText({
      model,
      system: SYSTEM,
      prompt: [
        '## 要用的词',
        allWords.join('、'),
        reviewWords.length ? `（其中 ${reviewWords.join('、')} 是他学过的旧词，顺带复习）` : '',
        previewWords.length ? `（其中 ${previewWords.join('、')} 是还没正式学的词，只需出现、不用刻意强调）` : '',
        '',
        '## 要求',
        `把上面 ${allWords.length} 个词全部自然地用进一篇超简单的短文：短句、只用基础词、一句最多一个生词。只输出 JSON。`,
      ]
        .filter(Boolean)
        .join('\n'),
      temperature: 0.85,
    })

    const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    let parsed: { title?: string; titleZh?: string; body?: string; translation?: string; words?: unknown[] } | null = null
    try {
      parsed = JSON.parse(raw)
      if (!parsed?.body?.trim()) parsed = null
    } catch {
      parsed = null
    }

    const data = parsed
      ? {
          title: parsed.title?.trim() || 'Today’s words',
          titleZh: parsed.titleZh?.trim() || null,
          body: parsed.body!.trim(),
          translation: parsed.translation?.trim() || null,
          usedWords: Array.isArray(parsed.words) ? JSON.parse(JSON.stringify(parsed.words.slice(0, 40))) : null,
        }
      : { title: 'Today’s words', titleZh: null, body: raw, translation: null, usedWords: null }

    // 2) 落缓存（重新生成也写这条，覆盖旧版本；hits 归零重新计）
    const saved = await prisma.wordPassage
      .upsert({
        where: { userId_key: { userId, key } },
        create: { userId, key, words: allWords, ...data },
        update: { ...data, words: allWords, hits: 0 },
      })
      .catch((err) => {
        console.error('[words/passage] cache write failed:', err)
        return null
      })

    return NextResponse.json(payload(saved ?? { ...data, words: allWords }, { reviewWords, previewWords }, false))
  } catch (err) {
    console.error('[words/passage] failed:', err)
    return NextResponse.json({ error: '生成短文失败，换个模型或稍后再试' }, { status: 500 })
  }
}
