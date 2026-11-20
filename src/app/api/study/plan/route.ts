import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { libraryScopes } from '@/lib/library-scope'
import { planDeterministically, planWithAI, type PlannerTopic } from '@/lib/study/plan-planner.server'
import { NOTE_SUBJECTS } from '@/lib/study/tagging'
import { getExamLossTopics } from '@/lib/exam/analysis.server'

/**
 * GET  /api/study/plan - 当前生效(active)的冲刺计划 + 按日任务;无则 { plan: null }
 * POST /api/study/plan - 创建并生成排期(body: { examName, examDate, subject? }):
 *   错题本按考点聚合出候选池 → AI 编排(沿用最近对话模型)→ 失败降级确定性摊排;
 *   旧 active 计划整体置 active=false(历史保留)。
 * DELETE /api/study/plan - 结束当前计划(active=false,不删历史)。
 */

/** 日期序列化成「本地 YYYY-MM-DD」:直接 JSON 化会变 UTC,UTC+8 的本地 0 点会偏回前一天 */
function fmtDate(d: Date): string {
  const dt = new Date(d)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

/** 错题本+题库聚合成候选池:每考点 { 掌握度均,卡数,可重做数,题库可变式数 } */
async function collectTopics(userId: string, subject?: string | null): Promise<PlannerTopic[]> {
  const notes = await prisma.studyNote.findMany({
    where: { userId, topic: { not: null }, ...(subject ? { subject } : {}) },
    select: { topic: true, mastery: true, sourceQuestionId: true },
  })
  const topics = Array.from(new Set(notes.map((n) => n.topic as string)))
  if (topics.length === 0) return []
  const variantCounts = await prisma.question.groupBy({
    by: ['topic'],
    where: { userId: { in: await libraryScopes(userId) }, kind: 'choice', answer: { not: '' }, topic: { in: topics }, ...(subject ? { subject } : {}) },
    _count: { _all: true },
  })
  const variantMap = new Map(variantCounts.map((v) => [v.topic, v._count._all]))
  const agg = new Map<string, PlannerTopic>()
  for (const n of notes) {
    const key = n.topic as string
    const cur = agg.get(key) ?? { topic: key, masteryAvg: 0, cards: 0, redo: 0, variants: variantMap.get(key) ?? 0 }
    cur.masteryAvg += n.mastery
    cur.cards++
    if (n.sourceQuestionId) cur.redo++
    agg.set(key, cur)
  }
  return Array.from(agg.values()).map((t) => ({ ...t, masteryAvg: t.cards > 0 ? t.masteryAvg / t.cards : 0 }))
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  try {
    const plan = await prisma.studyPlan.findFirst({
      where: { userId: session.user.id, active: true },
      orderBy: { createdAt: 'desc' },
      include: {
        items: { orderBy: [{ date: 'asc' }, { kind: 'asc' }] },
      },
    })
    if (!plan) return NextResponse.json({ plan: null })
    return NextResponse.json({
      plan: {
        ...plan,
        examDate: fmtDate(plan.examDate),
        items: plan.items.map((it) => ({ ...it, date: fmtDate(it.date) })),
      },
    })
  } catch (err) {
    console.error('[study/plan GET] failed:', err)
    return NextResponse.json({ error: '获取冲刺计划失败' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  let body: { examName?: string; examDate?: string; subject?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  const examName = (body.examName ?? '').trim().slice(0, 40) || null
  const examDateRaw = body.examDate ? new Date(`${body.examDate}T00:00:00`) : null
  if (!examDateRaw || Number.isNaN(examDateRaw.getTime())) {
    return NextResponse.json({ error: '考试日期不合法' }, { status: 400 })
  }
  // 排期日 = 今天起至考试前一天;考试就是今天/已过期 → 至少留 1 天
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const examDay = new Date(examDateRaw); examDay.setHours(0, 0, 0, 0)
  const days = Math.max(1, Math.min(Math.round((examDay.getTime() - today.getTime()) / 86_400_000), 21))
  const subject = body.subject && (NOTE_SUBJECTS as readonly string[]).includes(body.subject) ? body.subject : null

  try {
    const topics = await collectTopics(userId, subject)
    if (topics.length === 0) {
      return NextResponse.json({ error: '错题本里还没有带考点标签的卡,先学几道题再来排冲刺计划' }, { status: 400 })
    }

    // 考场丢分加权(闭环②):学校考试勾错题聚合出的丢分 TOP 考点,若错题本里有同名考点卡,
    // 把 masteryAvg 视为减半再递减(丢分越多压越低)——AI 排期与确定性摊排(按 masteryAvg 升序
    // 轮转)都会把这些考点提前。无卡的丢分考点排不进计划(任务需要卡),由成绩分析弹层的
    // 考点诊断引导用户先学。失败只跳过加权,不阻塞排期。
    try {
      const lossTopics = await getExamLossTopics(userId, subject ?? undefined, 10)
      if (lossTopics.length > 0) {
        const rank = new Map(lossTopics.map((t, i) => [t, i]))
        for (const t of topics) {
          const i = rank.get(t.topic)
          if (i != null) t.masteryAvg = Math.max(0, t.masteryAvg * (0.5 - i * 0.03))
        }
      }
    } catch (err) {
      console.error('[study/plan POST] exam-loss boost skipped:', err)
    }

    // AI 优先(方案A);失败/欠费/JSON 不合法 → 确定性兜底,功能永不阻塞
    const items = (await planWithAI(userId, topics, days, examName)) ?? planDeterministically(topics, days)
    if (items.length === 0) {
      return NextResponse.json({ error: '候选池是空的(缺可重做/可变式素材),先攒几张错题卡' }, { status: 400 })
    }

    // 标题:考试名 + 学科;同事务里旧计划退役
    const subjectLabel = subject ? ({ math: '数学', english: '英语', chinese: '语文', physics: '物理', chemistry: '化学', biology: '生物', history: '历史', geography: '地理', politics: '政治', other: '' } as Record<string, string>)[subject] ?? '' : ''
    const title = `${examName ?? '考前冲刺'}${subjectLabel ? ` · ${subjectLabel}` : ''}`.slice(0, 40)

    const [, plan] = await prisma.$transaction([
      prisma.studyPlan.updateMany({ where: { userId, active: true }, data: { active: false } }),
      prisma.studyPlan.create({
        data: {
          userId,
          title,
          examName,
          examDate: examDay,
          subject,
          active: true,
          items: {
            create: items.map((it) => ({
              userId,
              date: it.date,
              topic: it.topic,
              kind: it.kind,
              target: it.target,
            })),
          },
        },
        include: { items: { orderBy: [{ date: 'asc' }, { kind: 'asc' }] } },
      }),
    ])
    return NextResponse.json({
      plan: {
        ...plan,
        examDate: fmtDate(plan.examDate),
        items: plan.items.map((it) => ({ ...it, date: fmtDate(it.date) })),
      },
    })
  } catch (err) {
    console.error('[study/plan POST] failed:', err)
    return NextResponse.json({ error: '生成冲刺计划失败' }, { status: 500 })
  }
}

export async function DELETE() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  try {
    await prisma.studyPlan.updateMany({
      where: { userId: session.user.id, active: true },
      data: { active: false },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[study/plan DELETE] failed:', err)
    return NextResponse.json({ error: '结束计划失败' }, { status: 500 })
  }
}
