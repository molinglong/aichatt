import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { libraryScopes } from '@/lib/library-scope'

/**
 * GET /api/study/variant?noteId= - 同考点变式题(复习流「再来一道同考点」)
 * 按错题卡的 subject+topic 从题库捞一道未做过的选择题(kind=choice,答案齐备,排除原题);
 * 题库该考点没有可捞题时返回 { found:false }(考点打标 apply 落库后命中率会持续上升)。
 * 变式判分在前端完成,不入 FSRS;答错可一键存错题本(POST /api/study/notes)。
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  const noteId = req.nextUrl.searchParams.get('noteId')?.trim()
  if (!noteId) {
    return NextResponse.json({ error: '缺少 noteId' }, { status: 400 })
  }

  try {
    const note = await prisma.studyNote.findFirst({
      where: { id: noteId, userId },
      select: { subject: true, topic: true, sourceQuestionId: true },
    })
    if (!note) {
      return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
    }
    if (!note.topic) {
      return NextResponse.json({ found: false, reason: 'no_topic' })
    }

    // 候选池小(同考点),直接取一批在内存随机挑一道
    const pool = await prisma.question.findMany({
      where: {
        userId: { in: await libraryScopes(userId) },
        subject: note.subject ?? 'other',
        topic: note.topic,
        kind: 'choice',
        answer: { not: '' },
        ...(note.sourceQuestionId ? { id: { not: note.sourceQuestionId } } : {}),
      },
      select: { id: true, stem: true, answer: true, topic: true, sourceRef: true },
      take: 12,
    })
    if (pool.length === 0) {
      return NextResponse.json({ found: false, reason: 'empty_pool' })
    }
    const q = pool[Math.floor(Math.random() * pool.length)]

    // 答案行首字母(A-H)供前端客观判分;解析正文原样透出
    const letterMatch = q.answer.trim().match(/^([A-H])(?![A-Za-z])/)
    return NextResponse.json({
      found: true,
      question: {
        id: q.id,
        stem: q.stem,
        topic: q.topic,
        sourceRef: q.sourceRef,
        answerLetter: letterMatch ? letterMatch[1] : null,
        analysis: q.answer,
      },
    })
  } catch (err) {
    console.error('[study/variant] failed:', err)
    return NextResponse.json({ error: '获取变式题失败' }, { status: 500 })
  }
}
