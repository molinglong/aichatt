import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getUserId } from '@/lib/api-auth'
import { prisma } from '@/lib/db'
import { sanitizeUploadName } from '@/lib/upload-name'
import { NOTE_SUBJECTS } from '@/lib/study/tagging'
import { captureStudyNote } from '@/lib/study/note-capture'
import { resolveStudySourceMessageId } from '@/lib/study/archive-lesson'

/** GET /api/study/notes - 错题列表(筛选:subject/topic/q 关键字;按创建时间倒序) */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  const sp = req.nextUrl.searchParams
  const subject = sp.get('subject')
  const topic = sp.get('topic')
  const q = sp.get('q')?.trim()

  const where: Record<string, unknown> = { userId }
  if (subject && (NOTE_SUBJECTS as readonly string[]).includes(subject)) where.subject = subject
  if (topic) where.topic = topic
  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { content: { contains: q, mode: 'insensitive' } },
      { topic: { contains: q, mode: 'insensitive' } },
    ]
  }

  try {
    const rows = await prisma.studyNote.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, sourceMessageId: true, sourceQuestionId: true, subject: true, topic: true,
        title: true, content: true, imageUrl: true, analysis: true, mastery: true,
        dueAt: true, lastReviewAt: true, reps: true, lapses: true, createdAt: true,
      },
    })
    return NextResponse.json(rows)
  } catch (err) {
    console.error('[study/notes] list failed:', err)
    return NextResponse.json({ error: '获取错题列表失败' }, { status: 500 })
  }
}

/** POST /api/study/notes - 存入错题(题干必填,AI 讲解可选);先落库立即返回,后台异步打标 */
export async function POST(req: NextRequest) {
  // 双通道:cookie session 或 Bearer 令牌(浏览器扩展一键存错题)
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  let body: { sourceMessageId?: string; questionText?: string; analysisText?: string; imageUrl?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  const questionText = (body.questionText ?? '').trim()
  const analysisText = (body.analysisText ?? '').trim() || null

  // 题目截图:只接受本人上传过的 /uploads 文件,防越权引用他人图片
  let imageUrl: string | null = null
  if (typeof body.imageUrl === 'string' && body.imageUrl.trim()) {
    const fileName = sanitizeUploadName(body.imageUrl)
    if (!fileName) {
      return NextResponse.json({ error: '题目截图地址不合法' }, { status: 400 })
    }
    const owned = await prisma.uploadFile.findFirst({
      where: { fileName, userId },
      select: { id: true },
    })
    if (!owned) {
      return NextResponse.json({ error: '题目截图不存在或不属于当前账号' }, { status: 400 })
    }
    imageUrl = `/uploads/${fileName}`
  }

  if (!questionText && !analysisText && !imageUrl) {
    return NextResponse.json({ error: '题目内容不能为空' }, { status: 400 })
  }

  try {
    // 学习室会话说一题一课:手动存入也映射到首条用户消息 id,
    // 与结课自动归档共用同一张卡(唯一约束兜底,重复点击不新增)。
    const sourceMessageId = body.sourceMessageId?.trim()
      ? await resolveStudySourceMessageId(userId, body.sourceMessageId.trim())
      : null
    const row = await captureStudyNote({
      userId,
      sourceMessageId,
      question: questionText,
      analysis: analysisText,
      imageUrl,
    })
    return NextResponse.json({ id: row.id, created: row.created }, { status: row.created ? 201 : 200 })
  } catch (err) {
    console.error('[study/notes] create failed:', err)
    return NextResponse.json({ error: '存入错题本失败' }, { status: 500 })
  }
}
