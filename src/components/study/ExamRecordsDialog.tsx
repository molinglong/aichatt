'use client'

/**
 * 学校考试 · 成绩分析弹层(学习台「学校考试」区块「成绩分析 ›」进入)。
 * 双 Tab:
 * - 分析(给学生的直读版,图先行):成绩趋势折线图 → 各科成绩大数字卡 → 丢分最多考点条形图
 *   (红条=错题本里也有,真没学会;灰条=平时会、考试失误)→ 哪类题丢分多 → AI 报告(落库可回看)。
 * - 台账:全部成绩列表(按科目分组 + 删除),行尾 hover「小结」生成单考报告。
 * 数据口径统一在 src/lib/exam/analysis.server.ts;图表为内联 SVG(无图表库,token 口径)。
 * 骨架与 ReviewStatsDialog 同配方:桌面居中磨砂遮罩玻璃卡 + ESC/点外关,移动端全屏 + 返回键收口。
 */
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { Sparkles, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useBackToClose } from '@/hooks/useBackToClose'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import { SUBJECT_LABELS, SUBJECT_COLORS, subjectTint, type NoteSubject } from '@/lib/study/subject-labels'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import type { ExamRecordListItem } from './StudyHome'

interface AnalysisData {
  records: Array<{
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
  }>
  bySubject: Array<{ key: string; subject: string; count: number; avgPercent: number; latestPercent: number; trend: 'up' | 'down' | 'flat' }>
  topicLossAgg: Array<{ topic: string; loss: number; count: number; exams: number; lastDate: string; source: 'both' | 'exam' }>
  sectionLoss: Array<{ section: string; loss: number; count: number }>
  noteTopics: string[]
}

interface ReportItem {
  id: string
  kind: 'exam' | 'stage'
  subject: string | null
  examName: string | null
  examRecordId: string | null
  content: string
  createdAt: string
}

const TREND_LABEL = { up: '↑ 在进步', down: '↓ 在退步', flat: '→ 持平' } as const

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 成绩趋势折线图:X=考试日期(去重升序),Y=得分率%;每科目一条线(学科色),点旁标得分率 */
function TrendChart({ records }: { records: AnalysisData['records'] }) {
  const dates = Array.from(new Set(records.map((r) => r.date))).sort()
  const subjects = Array.from(new Set(records.map((r) => r.subject)))
  const w = 600
  const h = 160
  const padL = 34
  const padR = 16
  const padT = 18
  const padB = 26
  const xOf = (date: string) => padL + (dates.indexOf(date) / Math.max(1, dates.length - 1)) * (w - padL - padR)
  const yOf = (p: number) => padT + (1 - p / 100) * (h - padT - padB)
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="成绩趋势图">
        {[0, 50, 100].map((p) => (
          <g key={p}>
            <line x1={padL} x2={w - padR} y1={yOf(p)} y2={yOf(p)} stroke="rgb(var(--line))" strokeDasharray={p === 50 ? '3 4' : undefined} />
            <text x={padL - 6} y={yOf(p) + 3} textAnchor="end" fontSize="9" fill="rgb(var(--content-muted))">
              {p}
            </text>
          </g>
        ))}
        {dates.map((d) => (
          <text key={d} x={xOf(d)} y={h - 8} textAnchor="middle" fontSize="9" fill="rgb(var(--content-muted))">
            {d.slice(5)}
          </text>
        ))}
        {subjects.map((s) => {
          const pts = records.filter((r) => r.subject === s).sort((a, b) => a.date.localeCompare(b.date))
          const color = SUBJECT_COLORS[s as NoteSubject] ?? SUBJECT_COLORS.other
          const poly = pts.map((r) => `${xOf(r.date)},${yOf(r.percent)}`).join(' ')
          return (
            <g key={s}>
              {pts.length > 1 && (
                <polyline points={poly} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              )}
              {pts.map((r) => (
                <g key={r.id}>
                  <circle cx={xOf(r.date)} cy={yOf(r.percent)} r="3.5" fill={color} />
                  <text x={xOf(r.date)} y={yOf(r.percent) - 7} textAnchor="middle" fontSize="9" fontWeight="600" fill="rgb(var(--content-primary))">
                    {r.percent}
                  </text>
                </g>
              ))}
            </g>
          )
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 px-1">
        {subjects.map((s) => {
          const color = SUBJECT_COLORS[s as NoteSubject] ?? SUBJECT_COLORS.other
          return (
            <span key={s} className="flex items-center gap-1.5 text-[10.5px] text-content-secondary">
              <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
              {s}
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function ExamRecordsDialog({
  open,
  onClose,
  records,
  loading,
}: {
  open: boolean
  onClose: () => void
  records: ExamRecordListItem[]
  loading: boolean
}) {
  const isMobile = useIsMobileViewport()
  const router = useRouter()
  const queryClient = useQueryClient()
  useBackToClose(open, onClose)

  const [tab, setTab] = useState<'analysis' | 'ledger'>('analysis')
  const [generating, setGenerating] = useState<{ kind: 'exam' | 'stage'; recordId?: string } | null>(null)
  const [openReportId, setOpenReportId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || isMobile) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isMobile, onClose])

  const analysisQuery = useQuery({
    queryKey: queryKeys.examRecords.analysis(),
    queryFn: ({ signal }) => fetchJson<{ analysis: AnalysisData }>('/api/exam-records/analysis', { signal }),
    enabled: open && tab === 'analysis',
    staleTime: 60_000,
  })
  const reportsQuery = useQuery({
    queryKey: queryKeys.examRecords.reports(),
    queryFn: ({ signal }) => fetchJson<{ reports: ReportItem[] }>('/api/exam-records/report', { signal }),
    enabled: open && tab === 'analysis',
    staleTime: 60_000,
  })
  const analysis = analysisQuery.data?.analysis
  const reports = reportsQuery.data?.reports ?? []

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.examRecords.reports() })
    void queryClient.invalidateQueries({ queryKey: queryKeys.examRecords.list() })
  }

  const generate = async (kind: 'exam' | 'stage', examRecordId?: string) => {
    setGenerating({ kind, recordId: examRecordId })
    try {
      const res = await fetchJson<{ report: ReportItem }>('/api/exam-records/report', {
        method: 'POST',
        json: { kind, examRecordId },
        timeoutMs: 120_000,
      })
      invalidate()
      setOpenReportId(res.report.id)
      toast.success('报告已生成并存档', { title: '成绩分析' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成失败,请重试', { title: '成绩分析' })
    } finally {
      setGenerating(null)
    }
  }

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/exam-records/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.examRecords.list() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.examRecords.analysis() })
      toast.success('已删除这条成绩', { title: '学校考试' })
    } catch (err) {
      console.error('[exam-records] delete failed:', err)
      toast.error('删除失败,请重试', { title: '学校考试' })
    }
  }

  if (!open) return null

  const totalLoss = (analysis?.sectionLoss ?? []).reduce((s, x) => s + x.loss, 0)
  const maxTopicLoss = analysis?.topicLossAgg[0]?.loss ?? 1

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="学校考试 · 成绩分析"
      className={cn(
        'fixed inset-0 z-[200]',
        isMobile ? 'flex flex-col bg-surface' : 'flex items-start justify-center pt-[10vh] px-4'
      )}
    >
      {!isMobile && (
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="absolute inset-0 bg-black/20 backdrop-blur-[12px] saturate-150 dark:bg-white/15 dark:saturate-150"
        />
      )}

      <div
        className={cn(
          'relative z-10 flex flex-col overflow-hidden',
          isMobile
            ? 'h-full w-full bg-surface'
            : 'h-[72vh] w-full max-w-[680px] rounded-xl border border-line/60 bg-surface-glass glass-blur shadow-2xl enter-pop'
        )}
      >
        <div
          className="flex flex-none items-center gap-1 border-b border-line px-3"
          style={
            isMobile
              ? { paddingTop: 'max(12px, calc(var(--m-chrome-top, 0px) + 12px))', paddingBottom: 12 }
              : { paddingTop: 8, paddingBottom: 8 }
          }
        >
          <span className="px-2 text-xs font-semibold text-content-primary">学校考试 · 成绩分析</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* 双 Tab 切换 */}
        <div className="flex flex-none gap-1 px-4 pt-2.5">
          {(
            [
              ['analysis', '分析'],
              ['ledger', '台账'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                'rounded-full px-3.5 py-1 text-[12px] font-semibold transition-colors',
                tab === k ? 'bg-accent-soft text-accent' : 'text-content-muted hover:text-content-primary'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {tab === 'analysis' ? (
            /* ───────────── 分析 Tab(图先行,大白话) ───────────── */
            analysisQuery.isPending ? (
              <div className="grid gap-2">
                <div className="study-sk h-36 rounded-[14px]" />
                <div className="study-sk h-16 rounded-[14px]" />
                <div className="study-sk h-24 rounded-[14px]" />
              </div>
            ) : !analysis || analysis.records.length === 0 ? (
              <div className="py-10 text-center text-[13px] leading-relaxed text-content-muted">
                还没有成绩记录
                <br />
                在学习台「学校考试」区块点「记一次成绩」,录完这里就是你的分析面板
              </div>
            ) : (
              <div className="space-y-4">
                {/* 成绩趋势 */}
                <section>
                  <div className="mb-1 text-[11px] font-semibold text-content-secondary">成绩趋势</div>
                  <div className="rounded-[12px] border border-line/60 bg-surface-glass px-2 pb-2 pt-1">
                    <TrendChart records={analysis.records} />
                  </div>
                </section>

                {/* 各科成绩 */}
                <section>
                  <div className="mb-1.5 text-[11px] font-semibold text-content-secondary">各科成绩</div>
                  <div className="grid grid-cols-2 gap-2">
                    {analysis.bySubject.map((s) => {
                      const color = SUBJECT_COLORS[s.key as NoteSubject] ?? SUBJECT_COLORS.other
                      return (
                        <div key={s.key} className="rounded-[12px] border border-line/60 bg-surface-glass px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
                            <span className="text-[13px] font-semibold text-content-primary">{s.subject}</span>
                            <span
                              className={cn(
                                'ml-auto text-[10.5px] font-semibold',
                                s.trend === 'up' ? 'text-accent' : s.trend === 'down' ? 'text-danger' : 'text-content-muted'
                              )}
                            >
                              {TREND_LABEL[s.trend]}
                            </span>
                          </div>
                          <div className="mt-1.5 flex items-baseline gap-1.5">
                            <span className="text-[26px] font-bold leading-none tabular-nums text-content-primary">
                              {s.avgPercent}
                              <span className="text-[12px] font-normal text-content-muted">%</span>
                            </span>
                            <span className="text-[10.5px] leading-tight text-content-muted">
                              平均得分率
                              <br />
                              {s.count} 次考试 · 最近 {s.latestPercent}%
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>

                {/* 丢分最多的考点 */}
                <section>
                  <div className="mb-1 text-[11px] font-semibold text-content-secondary">丢分最多的考点</div>
                  <div className="mb-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-content-muted">
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-danger/75" aria-hidden />
                      真没学会(错题本里也有)
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-[rgb(var(--content-muted)/0.5)]" aria-hidden />
                      考试失误(平时会)
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {analysis.topicLossAgg.slice(0, 8).map((t) => (
                      <div key={t.topic} className="flex items-center gap-2">
                        <span className="w-[140px] flex-none truncate text-[11.5px] text-content-primary" title={t.topic}>
                          {t.topic}
                        </span>
                        <span className="relative h-4 min-w-0 flex-1 overflow-hidden rounded-[6px] bg-surface-subtle">
                          <span
                            className={cn(
                              'absolute inset-y-0 left-0 rounded-[6px]',
                              t.source === 'both' ? 'bg-danger/75' : 'bg-[rgb(var(--content-muted)/0.5)]'
                            )}
                            style={{ width: `${Math.max(6, (t.loss / maxTopicLoss) * 100)}%` }}
                          />
                        </span>
                        <span className="w-12 flex-none text-right text-[11.5px] font-bold tabular-nums text-danger">
                          −{t.loss}分
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            onClose()
                            router.push(`/papers/composed?compose=1&focusTopic=${encodeURIComponent(t.topic)}`)
                          }}
                          className="flex-none text-[11px] font-medium text-accent transition-opacity hover:opacity-80"
                        >
                          练它 ›
                        </button>
                      </div>
                    ))}
                  </div>
                </section>

                {/* 哪类题丢分多 */}
                {analysis.sectionLoss.length > 0 && (
                  <section>
                    <div className="mb-1.5 text-[11px] font-semibold text-content-secondary">哪类题丢分多</div>
                    <div className="space-y-1">
                      {analysis.sectionLoss.slice(0, 6).map((s) => (
                        <div key={s.section} className="flex items-center gap-2">
                          <span className="w-28 flex-none truncate text-[11px] text-content-secondary">{s.section}</span>
                          <span className="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-subtle">
                            <span
                              className="block h-full rounded-full bg-accent/60"
                              style={{ width: `${totalLoss > 0 ? Math.max(4, (s.loss / totalLoss) * 100) : 0}%` }}
                            />
                          </span>
                          <span className="flex-none text-[11px] tabular-nums text-content-muted">
                            {s.count} 题 −{s.loss}分
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* AI 分析报告(落库回看) */}
                <section>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-content-secondary">AI 帮你总结</span>
                    <button
                      type="button"
                      onClick={() => void generate('stage')}
                      disabled={generating != null}
                      className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1 text-[11.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                      <Sparkles size={12} aria-hidden />
                      {generating?.kind === 'stage' ? '写报告中…' : '让 AI 总结这段时期'}
                    </button>
                  </div>
                  <div className="text-[10.5px] leading-relaxed text-content-muted">
                    AI 会结合你所有考试、错题本和上面的丢分考点,告诉你「说明什么+最该做的三件事」;单次考试的「小结」在台账
                    Tab 每行。
                  </div>
                  {reportsQuery.isPending ? (
                    <div className="study-sk mt-2 h-10 rounded-[10px]" />
                  ) : reports.length === 0 ? (
                    <div className="mt-2 rounded-[10px] border-[1.5px] border-dashed border-line-strong px-3 py-3 text-[11.5px] text-content-muted">
                      还没有报告——点上面的按钮让 AI 写第一份
                    </div>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {reports.map((r) => {
                        const expanded = openReportId === r.id
                        return (
                          <div key={r.id} className="overflow-hidden rounded-[10px] border border-line/60 bg-surface">
                            <button
                              type="button"
                              onClick={() => setOpenReportId(expanded ? null : r.id)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-subtle"
                            >
                              <Sparkles size={12} className="flex-none text-accent" aria-hidden />
                              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-content-primary">
                                {r.examName ?? (r.kind === 'stage' ? '阶段总结' : '考后小结')}
                              </span>
                              <span className="flex-none rounded-full bg-surface-subtle px-2 py-0.5 text-[9.5px] text-content-secondary">
                                {r.kind === 'exam' ? '考后小结' : '阶段总结'}
                              </span>
                              <span className="flex-none text-[10.5px] tabular-nums text-content-muted">{fmtTime(r.createdAt)}</span>
                            </button>
                            {expanded && (
                              <div className="border-t border-line/60 px-3 py-2">
                                <MarkdownRenderer content={r.content} rich messageId={`exam-report-${r.id}`} />
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              </div>
            )
          ) : /* ───────────── 台账 Tab ───────────── */
          loading && records.length === 0 ? (
            <div className="grid gap-2">
              <div className="study-sk h-10 rounded-[14px]" />
              <div className="study-sk h-10 rounded-[14px]" />
              <div className="study-sk h-10 rounded-[14px]" />
            </div>
          ) : records.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-content-muted">
              还没有成绩记录,在学习台「记一次成绩」里记第一笔
            </div>
          ) : (
            <div className="space-y-3">
              {groupBySubject(records).map(({ subject, items }) => {
                const avg = Math.round((items.reduce((s, r) => s + r.score / r.fullScore, 0) / items.length) * 100)
                const color = SUBJECT_COLORS[subject as NoteSubject] ?? SUBJECT_COLORS.other
                return (
                  <div key={subject}>
                    <div className="mb-1.5 px-0.5 text-[11px] text-content-muted">
                      {SUBJECT_LABELS[subject as keyof typeof SUBJECT_LABELS] ?? subject}
                      <span className="ml-1 font-medium text-content-secondary">· {items.length} 次 · 均分 {avg}%</span>
                    </div>
                    <div className="space-y-1.5">
                      {items.map((r) => (
                        <div
                          key={r.id}
                          className="group flex items-center gap-3 rounded-[12px] border border-line/60 bg-surface-glass px-3 py-2"
                        >
                          <span
                            className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[9px] text-[11px] font-bold"
                            style={{ background: subjectTint(color, 0.12), color }}
                            aria-hidden
                          >
                            {r.score}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] font-semibold text-content-primary">{r.examName}</span>
                            <span className="mt-0.5 block truncate text-[11px] text-content-muted">
                              {r.paper.title} · {r.date}
                              {r.rank ? ` · ${r.rank}` : ''}
                            </span>
                          </span>
                          <span className="flex-none text-[13px] font-bold tabular-nums text-content-primary">
                            {r.score}
                            <span className="text-[10.5px] font-normal text-content-muted">/{r.fullScore}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => void generate('exam', r.id)}
                            disabled={generating != null}
                            className="flex-none rounded-md px-1.5 py-1 text-[10.5px] font-medium text-accent opacity-0 transition-all hover:bg-accent-soft group-hover:opacity-100 disabled:opacity-40 max-md:opacity-100"
                          >
                            {generating?.recordId === r.id ? '生成中…' : '小结'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(r.id)}
                            aria-label="删除这条成绩"
                            className="flex-none rounded-md p-1.5 text-content-muted opacity-0 transition-all hover:bg-danger-soft hover:text-danger group-hover:opacity-100 max-md:opacity-100"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 台账按科目分组:学科枚举序,组内时间倒序(接口已排) */
function groupBySubject(records: ExamRecordListItem[]): Array<{ subject: string; items: ExamRecordListItem[] }> {
  const bySubject = new Map<string, ExamRecordListItem[]>()
  for (const r of records) {
    const list = bySubject.get(r.paper.subject) ?? []
    list.push(r)
    bySubject.set(r.paper.subject, list)
  }
  return (Object.keys(SUBJECT_LABELS) as NoteSubject[])
    .filter((s) => bySubject.has(s))
    .map((s) => ({ subject: s, items: bySubject.get(s)! }))
    .concat(
      Array.from(bySubject.keys())
        .filter((s) => !(s in SUBJECT_LABELS))
        .map((s) => ({ subject: s as NoteSubject, items: bySubject.get(s)! }))
    )
}
