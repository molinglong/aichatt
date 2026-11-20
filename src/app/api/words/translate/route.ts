import { NextRequest, NextResponse } from 'next/server'
import { generateText } from 'ai'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { resolveStudyModel } from '@/lib/study/tagging'

/**
 * POST /api/words/translate —— 划词翻译（英→中 / 中→英）
 *
 * 两种来源，优先本地：
 *   1. 单个英文词：先查本地字典（DictEntry），命中直接回词条释义，零 token；
 *   2. 没命中 / 整句：交给 AI，要求只给译文，词性+义项最多 3 个。
 * 返回 { translation, from: 'dict' | 'ai', entry? }
 */
const SYSTEM = [
  '你是英汉词典与翻译。规则：',
  '- 判断方向：输入是英文就译成中文；是中文就译成英文',
  '- 只输出译文本身，不要解释、不要加引号、不要罗列例句',
  '- 单词/短语：给「词性 + 简短释义」，多义项用「；」分隔，最多 3 个（如 vt. 较喜欢；偏爱）',
  '- 整句：给自然流畅的译文，一整行，不要拆成多段',
].join('\n')

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  let body: { text?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  const text = String(body.text ?? '').trim().slice(0, 200)
  if (!text) return NextResponse.json({ error: '没有选中内容' }, { status: 400 })

  // 1) 单词先查本地字典
  const isSingleWord = /^[A-Za-z][A-Za-z'’\-]*$/.test(text)
  if (isSingleWord) {
    const entry = await prisma.dictEntry.findFirst({
      where: { lemma: text.toLowerCase() },
      select: { headword: true, pos: true, trans: true, mnemonic: true, phoneticUs: true, phoneticUk: true, isPhrase: true },
    })
    if (entry?.trans) {
      return NextResponse.json({
        from: 'dict',
        translation: entry.trans,
        entry,
      })
    }
  }

  // 2) AI 兜底
  const model = await resolveStudyModel(session.user.id)
  if (!model) {
    return NextResponse.json({ error: '没有可用的对话模型，本地词典也没收录' }, { status: 400 })
  }
  try {
    const { text: out } = await generateText({
      model,
      system: SYSTEM,
      prompt: text,
      temperature: 0.2,
    })
    return NextResponse.json({ from: 'ai', translation: out.trim() })
  } catch (err) {
    console.error('[words/translate] failed:', err)
    return NextResponse.json({ error: '翻译失败，稍后再试' }, { status: 500 })
  }
}
