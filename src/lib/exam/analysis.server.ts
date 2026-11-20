/**
 * 学校考试成绩聚合分析(服务端只读):
 * 分析弹层(/api/exam-records/analysis)、AI 报告生成(/api/exam-records/report)、
 * 冲刺计划丢分加权(/api/study/plan)共用同一份数据口径,改口径只动这里。
 *
 * 核心:ExamRecord(总分+勾错题)× Paper × PaperQuestion 反推逐题分值/考点/大题,
 * 考点丢分跨考试聚合后再与错题本(StudyNote)交叉——「错题本也丢+考场又丢」=真漏洞,
 * 「仅考场丢」=平时会、考场失手,两类信号含义不同。
 */
import { prisma } from '@/lib/db'
import { SUBJECT_LABELS, type NoteSubject } from '@/lib/study/subject-labels'

export interface ExamAnalysisTopicLoss {
  topic: string
  /** 跨考试累计丢分 */
  loss: number
  /** 勾错题次数(同考点多题各计一次) */
  count: number
  /** 涉及几次考试 */
  exams: number
  /** 最近一次丢分的考试日期 */
  lastDate: string
  /** both=错题本也有该考点(真漏洞);exam=仅考场丢(考场失手) */
  source: 'both' | 'exam'
}

export interface ExamAnalysisSectionLoss {
  section: string
  loss: number
  count: number
}

export interface ExamAnalysisRecord {
  id: string
  examName: string
  examType: string
  date: string
  subject: string
  paperTitle: string
  score: number
  fullScore: number
  percent: number
  rank: string | null
  wrongCount: number
  topicLoss: Array<{ topic: string; count: number; loss: number }>
}

export interface ExamAnalysisSubjectSummary {
  key: string
  subject: string
  count: number
  avgPercent: number
  latestPercent: number
  trend: 'up' | 'down' | 'flat'
}

export interface ExamAnalysis {
  records: ExamAnalysisRecord[]
  bySubject: ExamAnalysisSubjectSummary[]
  topicLossAgg: ExamAnalysisTopicLoss[]
  sectionLoss: ExamAnalysisSectionLoss[]
  /** 错题本里是否有带考点的卡(交叉标记的对照面) */
  noteTopics: string[]
}

/** 勾错题号 → 考点丢分(与 /api/exam-records、exam-record-tool 同口径;一题多考点各计一次) */
function topicLossFrom(
  pq: Array<{ number: number; score: number; topics: string[] }>,
  wrong: number[]
): Array<{ topic: string; count: number; loss: number }> {
  const wrongSet = new Set(wrong)
  const map = new Map<string, { topic: string; count: number; loss: number }>()
  for (const q of pq) {
    if (!wrongSet.has(q.number)) continue
    for (const t of q.topics) {
      const e = map.get(t) ?? { topic: t, count: 0, loss: 0 }
      e.count += 1
      e.loss += q.score
      map.set(t, e)
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 8)
}

export async function buildExamAnalysis(
  userId: string,
  opts?: { subject?: string; limit?: number }
): Promise<ExamAnalysis> {
  const rows = await prisma.examRecord.findMany({
    where: { userId, ...(opts?.subject ? { paper: { subject: opts.subject } } : {}) },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(opts?.limit ?? 100, 1), 200),
    include: { paper: { select: { title: true, subject: true, slug: true } } },
  })

  // 勾了错题的卷:批量查逐题投影(分值/考点/大题)
  const paperIds = Array.from(new Set(rows.filter((r) => r.wrongNumbers.length > 0).map((r) => r.paperId)))
  const pq = paperIds.length
    ? await prisma.paperQuestion.findMany({
        where: { paperId: { in: paperIds }, flagged: false },
        select: { paperId: true, number: true, score: true, topics: true, section: true },
      })
    : []
  const pqByPaper = new Map<string, Array<{ number: number; score: number; topics: string[]; section: string | null }>>()
  for (const q of pq) {
    const list = pqByPaper.get(q.paperId) ?? []
    list.push(q)
    pqByPaper.set(q.paperId, list)
  }

  // 错题本考点集合(交叉标记对照面;不筛掌握度,只要有卡就算「错题本也丢」)
  const notes = await prisma.studyNote.findMany({
    where: { userId, topic: { not: null } },
    select: { topic: true },
  })
  const noteTopics = Array.from(new Set(notes.map((n) => n.topic as string).filter(Boolean)))

  const records: ExamAnalysisRecord[] = rows.map((r) => ({
    id: r.id,
    examName: r.examName,
    examType: r.examType,
    date: r.date,
    subject: SUBJECT_LABELS[r.paper.subject as NoteSubject] ?? r.paper.subject,
    paperTitle: r.paper.title,
    score: r.score,
    fullScore: r.fullScore,
    percent: r.fullScore > 0 ? Math.round((r.score / r.fullScore) * 100) : 0,
    rank: r.rank,
    wrongCount: r.wrongNumbers.length,
    topicLoss: r.wrongNumbers.length > 0 ? topicLossFrom(pqByPaper.get(r.paperId) ?? [], r.wrongNumbers) : [],
  }))

  // 按科目汇总:rows 日期倒序 → 组内 [0] 最新;趋势比最近两次得分率,±1 分内视为持平
  const bySubjectMap = new Map<string, ExamAnalysisRecord[]>()
  for (const r of records) {
    const key = rows.find((x) => x.id === r.id)!.paper.subject
    const list = bySubjectMap.get(key) ?? []
    list.push(r)
    bySubjectMap.set(key, list)
  }
  const bySubject = Array.from(bySubjectMap.entries()).map(([key, list]) => {
    const avgPercent = Math.round(list.reduce((s, r) => s + r.percent, 0) / list.length)
    const latestPercent = list[0].percent
    const prevPercent = list[1]?.percent
    const trend: 'up' | 'down' | 'flat' =
      prevPercent == null ? 'flat' : latestPercent > prevPercent + 1 ? 'up' : latestPercent < prevPercent - 1 ? 'down' : 'flat'
    return { key, subject: SUBJECT_LABELS[key as NoteSubject] ?? key, count: list.length, avgPercent, latestPercent, trend }
  })

  // 考点丢分跨考试聚合(loss 降序);与错题本交叉
  const aggMap = new Map<string, { loss: number; count: number; dates: Set<string> }>()
  const sectionMap = new Map<string, { loss: number; count: number }>()
  for (const r of records) {
    if (r.topicLoss.length === 0) continue
    const pqList = pqByPaper.get(rows.find((x) => x.id === r.id)!.paperId) ?? []
    const wrongSet = new Set(rows.find((x) => x.id === r.id)!.wrongNumbers)
    for (const q of pqList) {
      if (!wrongSet.has(q.number)) continue
      const sec = q.section?.trim() || '未分组'
      const s = sectionMap.get(sec) ?? { loss: 0, count: 0 }
      s.loss += q.score
      s.count += 1
      sectionMap.set(sec, s)
    }
    for (const t of r.topicLoss) {
      const e = aggMap.get(t.topic) ?? { loss: 0, count: 0, dates: new Set<string>() }
      e.loss += t.loss
      e.count += t.count
      e.dates.add(r.date)
      aggMap.set(t.topic, e)
    }
  }
  const topicLossAgg: ExamAnalysisTopicLoss[] = Array.from(aggMap.entries())
    .map(([topic, e]) => ({
      topic,
      loss: e.loss,
      count: e.count,
      exams: e.dates.size,
      lastDate: Array.from(e.dates).sort().pop() ?? '',
      source: noteTopics.includes(topic) ? ('both' as const) : ('exam' as const),
    }))
    .sort((a, b) => b.loss - a.loss)

  const sectionLoss: ExamAnalysisSectionLoss[] = Array.from(sectionMap.entries())
    .map(([section, e]) => ({ section, ...e }))
    .sort((a, b) => b.loss - a.loss)

  return { records, bySubject, topicLossAgg, sectionLoss, noteTopics }
}

/** 冲刺计划加权用:考场丢分 TOP 考点(按累计丢分降序;可按科目过滤)。 */
export async function getExamLossTopics(userId: string, subject?: string, top = 10): Promise<string[]> {
  const analysis = await buildExamAnalysis(userId, { subject, limit: 100 })
  return analysis.topicLossAgg.slice(0, top).map((t) => t.topic)
}
