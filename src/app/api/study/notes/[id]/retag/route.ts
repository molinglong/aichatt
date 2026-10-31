import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { resolveStudyModel, tagNote } from '@/lib/study/tagging'

/** POST /api/study/notes/[id]/retag - 重新打标(subject=null 的卡手动重试) */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  const note = await prisma.studyNote.findFirst({
    where: { id: params.id, userId },
    select: { id: true, content: true, analysis: true },
  })
  if (!note) {
    return NextResponse.json({ error: '内容不存在或已被删除' }, { status: 404 })
  }

  const model = await resolveStudyModel(userId)
  if (!model) {
    return NextResponse.json({ error: '当前没有可用模型，请先配置模型 Key' }, { status: 503 })
  }
  const tags = await tagNote(model, note.content, note.analysis)
  if (!tags) {
    return NextResponse.json({ error: '标注失败，请稍后重试' }, { status: 502 })
  }

  const updated = await prisma.studyNote.update({
    where: { id: note.id },
    data: { subject: tags.subject, topic: tags.topic, title: tags.title },
    select: { subject: true, topic: true, title: true },
  })
  return NextResponse.json(updated)
}
