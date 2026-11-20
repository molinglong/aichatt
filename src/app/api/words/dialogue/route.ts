import { NextRequest, NextResponse } from 'next/server'
import { generateText } from 'ai'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { resolveStudyModel } from '@/lib/study/tagging'
import { passageKey } from '@/lib/words/passage.server'
import { pickSeeded } from '@/lib/words/sheet'

/**
 * POST /api/words/dialogue —— 从给定词里随机抽几个，AI 写一段两人日常对话（挖空自测用，带缓存）
 *
 * body: { words: string[], seed: number, count?: number, refresh?: boolean }
 * - 抽词：pickSeeded 按 seed 定版抽 count（默认 5）个。/papers/words 渲染时用同一个 seed +
 *   同一份词表抽出同一批词、算出同一个缓存 key——工具条「生成对话」落库后页面才读得到。
 *   两个入口各自内部先排序消除输入顺序影响，卷面打乱词序（sh=1）也不影响。
 * - 缓存：复用 WordPassage 表，key = passageKey(['__dlg__', ...抽中词])。'__dlg__' 前缀与
 *   短文 key 天然不撞——合法词条过不了导入器的字母校验，不可能等于这个前缀。
 * - 对话体：body = JSON.stringify({ lines })，usedWords 存 [{w: 原形, form: 文中形式}]。
 */
// 难度下限与短文同一条线（2026-11-17 零基础反馈）：超短句、只用基础词、一句最多一个生词。
const SYSTEM = [
  '你是给英语零基础的中国学生出英语填空练习的老师。用给定的目标词写一段两人日常对话，规则：',
  '- 6–8 句，A、B 两人交替说话；场景日常（教室、家里、路上、买东西、互相帮忙）；不要讲大道理',
  '- 每个句子最多 8 个词，一句只说一个意思；禁止从句、被动语态、完成时；一般现在时为主',
  '- 除目标词外只用最基础的词（be 动词、人称代词、常见介词 to/in/at/on/for/with/under/near、常见动词 say/ask/know/help/want/like/need、常见形容词 good/big/small/new/old/happy/sorry）；不引入任何其他生词',
  '- 每个句子里最多放 1 个目标词；目标词尽量用原形，最多加 -s/-ed/-ing',
  '- 必须自然包含全部目标词，每个目标词恰好出现一次',
  '- 对话里把每个目标词（含变形后的形式）用 **双星号** 包起来，例如 **find**、**runs**',
  '- 每句配一句忠实的中文翻译（zh），口语化',
  '- 输出严格 JSON，不要代码围栏、不要解释：',
  '{"lines":[{"who":"A","en":"... **find** ...","zh":"中文"},{"who":"B","en":"...","zh":"..."}],"words":[{"w":"find","form":"find"}]}',
  'words 按目标词在对话中出现的顺序列：w=原形，form=文中的形式。',
].join('\n')

const clean = (s: unknown) => String(s ?? '').trim()

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  let body: { words?: unknown; seed?: unknown; count?: unknown; refresh?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }

  const base = Array.isArray(body.words)
    ? Array.from(new Set(body.words.map((w) => clean(w)).filter((w) => w.length > 0 && w.length <= 40)))
    : []
  if (base.length < 3) {
    return NextResponse.json({ error: '至少需要 3 个词才能串成对话' }, { status: 400 })
  }

  const count = Math.min(Math.max(Math.trunc(Number(body.count)) || 5, 3), 8)
  const seed = Math.max(1, Math.floor(Number(body.seed)) || 1)
  const refresh = body.refresh === true

  const pick = pickSeeded(base, count, seed)
  const key = passageKey(['__dlg__', ...pick.map((w) => w.toLowerCase())])

  // 1) 缓存命中：同一 seed + 同一批词直接复用
  if (!refresh) {
    const hit = await prisma.wordPassage.findUnique({ where: { userId_key: { userId, key } } })
    if (hit) {
      let lines: unknown = null
      try {
        lines = (JSON.parse(hit.body) as { lines?: unknown })?.lines ?? null
      } catch {
        lines = null
      }
      await prisma.wordPassage.update({ where: { id: hit.id }, data: { hits: { increment: 1 } } }).catch(() => {})
      return NextResponse.json({ lines, words: pick, cached: true })
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
        pick.join('、'),
        '',
        '## 要求',
        `写一段 6–8 句的两人日常对话，把上面 ${pick.length} 个词全部自然地用进去（每个恰好一次，尽量原形），难度降到零基础也能读：短句、只用基础词、一句最多一个生词。只输出 JSON。`,
      ].join('\n'),
      temperature: 0.85,
    })

    const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    let lines: { who: string; en: string; zh: string }[] | null = null
    let usedWords: { w: string; form: string }[] = []
    try {
      const parsed = JSON.parse(raw) as {
        lines?: { who?: unknown; en?: unknown; zh?: unknown }[]
        words?: { w?: unknown; form?: unknown }[]
      }
      if (Array.isArray(parsed?.lines)) {
        const ok = parsed.lines.filter(
          (l): l is { who: string; en: string; zh: string } =>
            !!l && typeof l.en === 'string' && l.en.trim().length > 0,
        )
        if (ok.length >= 4) {
          lines = ok.map((l) => ({
            who: typeof l.who === 'string' && l.who.trim() ? l.who.trim().slice(0, 12) : 'A',
            en: l.en.trim(),
            zh: typeof l.zh === 'string' ? l.zh.trim() : '',
          }))
        }
      }
      if (Array.isArray(parsed?.words)) {
        usedWords = parsed.words
          .filter((u): u is { w: string; form: string } => !!u && typeof u.w === 'string' && typeof u.form === 'string')
          .map((u) => ({ w: u.w.trim(), form: u.form.trim() }))
          .slice(0, 20)
      }
    } catch {
      lines = null
    }
    if (!lines) {
      return NextResponse.json({ error: 'AI 返回的对话格式不对，请再点一次「生成对话」' }, { status: 502 })
    }

    // 2) 落缓存（body 存结构化 lines；hits 归零重新计）
    const data = {
      title: '今日对话',
      titleZh: null,
      body: JSON.stringify({ lines }),
      translation: null,
      usedWords: JSON.parse(JSON.stringify(usedWords)),
    }
    await prisma.wordPassage
      .upsert({
        where: { userId_key: { userId, key } },
        create: { userId, key, words: pick, ...data },
        update: { ...data, words: pick, hits: 0 },
      })
      .catch((err) => {
        console.error('[words/dialogue] cache write failed:', err)
        return null
      })

    return NextResponse.json({ lines, words: pick, cached: false })
  } catch (err) {
    console.error('[words/dialogue] failed:', err)
    return NextResponse.json({ error: '生成对话失败，换个模型或稍后再试' }, { status: 500 })
  }
}
