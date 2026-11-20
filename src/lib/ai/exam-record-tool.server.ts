/**
 * 学校考试成绩台账工具(服务端执行层):
 * createExamRecordTool(userId) 工厂闭包捕获 userId(数据主权,与 knowledge 同思路),
 * 只读查询 ExamRecord + Paper 元信息 + PaperQuestion 反推考点丢分;
 * catch 优雅降级返回 note,绝不编造成绩数据。考试口径见 /api/exam-records 路由。
 */
import { tool } from 'ai'
import { prisma } from '@/lib/db'
import { SUBJECT_LABELS, type NoteSubject } from '@/lib/study/subject-labels'
import {
  EXAM_RECORD_TOOL_NAME,
  EXAM_RECORD_TOOL_PROMPT,
  examRecordInputSchema,
  type ExamRecordToolOutput,
  type ExamRecordTopicLoss,
} from './exam-record-tool'

export { EXAM_RECORD_TOOL_NAME, EXAM_RECORD_TOOL_PROMPT }

/** 中文科目名 → 英文 key(SUBJECT_LABELS 反查;已是 key 或查不到原样返回小写) */
function normalizeSubject(subject?: string): string | undefined {
  if (!subject?.trim()) return undefined
  const raw = subject.trim().toLowerCase()
  if (raw in SUBJECT_LABELS) return raw
  const hit = (Object.entries(SUBJECT_LABELS) as Array<[NoteSubject, string]>).find(
    ([, label]) => label === subject.trim()
  )
  return hit?.[0] ?? raw
}

/** 勾错题号 → 考点丢分(与 /api/exam-records 同口径;一题多考点各计一次) */
function topicLossFrom(
  pq: Array<{ number: number; score: number; topics: string[] }>,
  wrong: number[]
): ExamRecordTopicLoss[] {
  const wrongSet = new Set(wrong)
  const map = new Map<string, ExamRecordTopicLoss>()
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

export function createExamRecordTool(userId: string) {
  return tool({
    description:
      '查询用户的学校考试成绩台账(月考/期中/期末/周测/模拟)。返回逐条成绩、按科目汇总(次数/平均得分率/趋势)与考点丢分。问成绩、趋势、薄弱科目时使用。',
    inputSchema: examRecordInputSchema,
    execute: async ({ subject, limit }): Promise<ExamRecordToolOutput> => {
      try {
        const subjectKey = normalizeSubject(subject)
        const where = { userId, ...(subjectKey ? { paper: { subject: subjectKey } } : {}) }
        const rows = await prisma.examRecord.findMany({
          where,
          orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
          take: Math.min(Math.max(limit ?? 20, 1), 50),
          include: { paper: { select: { title: true, subject: true } } },
        })
        const total = await prisma.examRecord.count({ where })

        // 考点丢分:只对勾了错题的卷批量查 PaperQuestion,一次查询
        const paperIds = Array.from(
          new Set(rows.filter((r) => r.wrongNumbers.length > 0).map((r) => r.paperId))
        )
        const pq = paperIds.length
          ? await prisma.paperQuestion.findMany({
              where: { paperId: { in: paperIds }, flagged: false },
              select: { paperId: true, number: true, score: true, topics: true },
            })
          : []
        const pqByPaper = new Map<string, Array<{ number: number; score: number; topics: string[] }>>()
        for (const q of pq) {
          const list = pqByPaper.get(q.paperId) ?? []
          list.push(q)
          pqByPaper.set(q.paperId, list)
        }

        const records = rows.map((r) => ({
          examName: r.examName,
          examType: r.examType,
          date: r.date,
          subject: SUBJECT_LABELS[r.paper.subject as NoteSubject] ?? r.paper.subject,
          paperTitle: r.paper.title,
          score: r.score,
          fullScore: r.fullScore,
          percent: r.fullScore > 0 ? Math.round((r.score / r.fullScore) * 100) : 0,
          rank: r.rank,
          topicLoss: r.wrongNumbers.length > 0 ? topicLossFrom(pqByPaper.get(r.paperId) ?? [], r.wrongNumbers) : [],
        }))

        // 按科目汇总:rows 日期倒序 → 组内 [0] 最新;趋势比最近两次得分率,±1 分内视为持平
        const bySubjectMap = new Map<string, typeof records>()
        for (const r of records) {
          const list = bySubjectMap.get(r.subject) ?? []
          list.push(r)
          bySubjectMap.set(r.subject, list)
        }
        const bySubject = Array.from(bySubjectMap.values()).map((list) => {
          const avgPercent = Math.round(list.reduce((s, r) => s + r.percent, 0) / list.length)
          const latestPercent = list[0].percent
          const prevPercent = list[1]?.percent
          const trend: 'up' | 'down' | 'flat' =
            prevPercent == null ? 'flat' : latestPercent > prevPercent + 1 ? 'up' : latestPercent < prevPercent - 1 ? 'down' : 'flat'
          return { subject: list[0].subject, count: list.length, avgPercent, latestPercent, trend }
        })

        return {
          records,
          bySubject,
          total,
          note:
            records.length === 0
              ? '成绩台账里没有匹配的记录。可建议用户在学习台「学校考试」区块点「记一次成绩」手动记录。'
              : `共 ${total} 条记录(返回最新 ${records.length} 条)。records 按日期倒序;bySubject.trend 比较最近两次得分率,±1 分以内视为持平。`,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          records: [],
          bySubject: [],
          total: 0,
          error: message,
          note: '成绩查询暂时不可用。请如实告知用户,不要编造成绩数据。',
        }
      }
    },
  })
}
