import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'

/**
 * PATCH /api/words/mnemonic —— 写/改一个词的助记（一句话联想或口诀）
 * body: { userWordId, mnemonic }  mnemonic 传空串=删除助记
 *
 * 助记存在字典词条上（DictEntry.mnemonic），不是个人数据——同一个词只写一次，
 * 以后所有卡面都显示。自由词（字典里没有的）没有词条可挂，直接拒绝。
 * 上限 500 字：助记是提示，不是小作文。
 */
const MAX_LEN = 500

export async function PATCH(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  let body: { userWordId?: string; mnemonic?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  if (!body.userWordId) {
    return NextResponse.json({ error: '缺少 userWordId' }, { status: 400 })
  }
  const text = typeof body.mnemonic === 'string' ? body.mnemonic.trim().slice(0, MAX_LEN) : ''

  try {
    const word = await prisma.userWord.findFirst({
      where: { id: body.userWordId, userId: session.user.id },
      select: { entryId: true },
    })
    if (!word) {
      return NextResponse.json({ error: '这个词不在你的词库里' }, { status: 404 })
    }
    if (!word.entryId) {
      return NextResponse.json({ error: '字典里没有这个词条，无法存助记' }, { status: 400 })
    }

    const entry = await prisma.dictEntry.update({
      where: { id: word.entryId },
      data: { mnemonic: text || null },
      select: { mnemonic: true },
    })
    return NextResponse.json({ mnemonic: entry.mnemonic })
  } catch (err) {
    console.error('[words/mnemonic] failed:', err)
    return NextResponse.json({ error: '保存助记失败' }, { status: 500 })
  }
}
