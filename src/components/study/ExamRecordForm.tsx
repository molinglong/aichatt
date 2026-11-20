'use client'

/**
 * 学校考试记录卡(方案 D 就地双栏工作台,design/preview-exam-score-recorder.html):
 * 左栏 = 考试信息 + 勾错题号方块板;右栏 = 实时汇总(丢分合计 / 考点丢分 / 已勾清单)。
 * 勾错只勾错的题,丢分与考点由 PaperQuestion 的分值/topics 实时反推;
 * 「按勾错算」一键回填得分,手改也行;卷子必选(先入库再记录,更换走同一搜索选择器)。
 * 移动端双栏自然叠单列。入口在学习台「学校考试」区块;深链 /study?recordExam=<slug> 预选卷子。
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, X } from 'lucide-react'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { SUBJECT_LABELS } from '@/lib/study/subject-labels'
import type { LibraryPaperItem } from './StudyHome'

interface PaperQuestionsResp {
  paper: { id: string; slug: string; title: string; subject: string; totalScore: number; questionCount: number }
  questions: Array<{ number: number; section: string | null; kind: string; score: number; topics: string[] }>
}

const EXAM_TYPES = ['月考', '期中', '期末', '周测', '模拟'] as const

interface SectionGroup {
  name: string
  range: string
  questions: PaperQuestionsResp['questions']
}

/** 连续同 section 分组(组头带题号区间;组内分值一致才显示「每题 N 分」,与卷面大题注释同口径) */
function groupBySection(questions: PaperQuestionsResp['questions']): SectionGroup[] {
  const groups: Array<{ name: string; questions: PaperQuestionsResp['questions'] }> = []
  for (const q of questions) {
    const name = q.section || '其他'
    const last = groups[groups.length - 1]
    if (last && last.name === name) last.questions.push(q)
    else groups.push({ name, questions: [q] })
  }
  return groups.map((g) => {
    const first = g.questions[0].number
    const lastNo = g.questions[g.questions.length - 1].number
    const uniform = g.questions.every((q) => q.score === g.questions[0].score)
    return {
      name: g.name,
      range: `${first === lastNo ? first : `${first}–${lastNo}`}${uniform ? ` · 每题 ${g.questions[0].score} 分` : ''}`,
      questions: g.questions,
    }
  })
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const LABEL = 'mb-1 block text-[11px] font-semibold text-content-secondary'
const INP =
  'h-9 w-full rounded-control border border-line bg-surface px-2.5 text-[13px] max-md:text-[16px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent'

export function ExamRecordForm({
  papers,
  papersError,
  onRetryPapers,
  initialSlug,
  onDone,
  onClose,
}: {
  papers: LibraryPaperItem[]
  /** 卷库接口失败:显示「加载失败·重试」,不要误导成「没有匹配的卷子」 */
  papersError?: boolean
  onRetryPapers?: () => void
  /** 试卷页「记一次成绩」深链预选的卷子 slug;选好不再重复应用 */
  initialSlug?: string | null
  onDone: () => void
  onClose: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [paperId, setPaperId] = useState<string | null>(null)
  const [examType, setExamType] = useState<(typeof EXAM_TYPES)[number]>('期中')
  const [examName, setExamName] = useState('')
  const [date, setDate] = useState(todayIso())
  const [score, setScore] = useState('')
  const [fullScore, setFullScore] = useState('')
  const [rank, setRank] = useState('')
  const [wrong, setWrong] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 选择器科目分组折叠状态(默认全展开) */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const selected = papers.find((p) => p.id === paperId) ?? null

  // Esc 收口(A3):与其他浮层口径对齐。焦点在输入框里时不响应(防打字误关);
  // 卷子选择器开着先收选择器,再按一次才收整个表单。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = document.activeElement
      const typing =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      if (typing) return
      if (pickerOpen) {
        setPickerOpen(false)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickerOpen, onClose])

  const selectPaper = (p: LibraryPaperItem) => {
    setPaperId(p.id)
    setFullScore(String(p.totalScore))
    setWrong(new Set())
    setPickerOpen(false)
    setSearch('')
  }

  const toggleGroup = (subject: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(subject)) next.delete(subject)
      else next.add(subject)
      return next
    })

  // 深链预选 + 默认展开:卷库到位后按 slug 选中(selectedPaper 时不开选择器);
  // 合并成一个 effect——两个 effect 会在 mount 批里用过期闭包把选择器重新打开
  useEffect(() => {
    if (initialSlug && papers.length > 0) {
      const p = papers.find((x) => x.slug === initialSlug)
      if (p) {
        selectPaper(p)
        return
      }
    }
    if (!paperId) setPickerOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [papers, initialSlug])

  // 逐题投影(勾错题板;flagged 已被服务端过滤)
  const { data: qData, isPending: qPending } = useQuery({
    queryKey: queryKeys.papers.questions(selected?.slug ?? '_none'),
    queryFn: ({ signal }) => fetchJson<PaperQuestionsResp>(`/api/papers/${selected!.slug}/questions`, { signal }),
    enabled: !!selected,
  })

  const sections = useMemo(() => groupBySection(qData?.questions ?? []), [qData])
  const scoreByNumber = useMemo(() => new Map((qData?.questions ?? []).map((q) => [q.number, q.score])), [qData])
  const topicByNumber = useMemo(() => new Map((qData?.questions ?? []).map((q) => [q.number, q.topics])), [qData])

  const loss = useMemo(() => Array.from(wrong).reduce((s, n) => s + (scoreByNumber.get(n) ?? 0), 0), [wrong, scoreByNumber])
  const topicLoss = useMemo(() => {
    const map = new Map<string, { count: number; loss: number }>()
    for (const q of qData?.questions ?? []) {
      if (!wrong.has(q.number)) continue
      for (const t of q.topics) {
        const e = map.get(t) ?? { count: 0, loss: 0 }
        e.count += 1
        e.loss += q.score
        map.set(t, e)
      }
    }
    return Array.from(map.entries()).sort((a, b) => b[1].loss - a[1].loss)
  }, [qData, wrong])

  const autoTotal = Number(fullScore) || selected?.totalScore || 0
  const toggleWrong = (n: number) =>
    setWrong((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })

  const filteredPapers = useMemo(() => {
    const kw = search.trim().toLowerCase()
    if (!kw) return papers
    return papers.filter((p) => p.title.toLowerCase().includes(kw))
  }, [papers, search])

  // 选择器按科目分组:35+ 张平铺太长;组头带张数,行尾不再重复科目
  const groupedPapers = useMemo(() => {
    const bySubject = new Map<string, LibraryPaperItem[]>()
    for (const p of filteredPapers) {
      const list = bySubject.get(p.subject) ?? []
      list.push(p)
      bySubject.set(p.subject, list)
    }
    return Array.from(bySubject.entries())
  }, [filteredPapers])

  const canSubmit = !!selected && !!examName.trim() && !!date && score !== '' && !saving

  const submit = async () => {
    if (!canSubmit || !selected) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/exam-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paperId: selected.id,
          examType,
          examName: examName.trim(),
          date,
          score: Number(score),
          fullScore: autoTotal || undefined,
          rank: rank.trim() || undefined,
          wrongNumbers: Array.from(wrong),
        }),
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || `HTTP ${res.status}`)
      }
      toast.success(`已记录 ${examName.trim()} · ${score} / ${autoTotal} 分`, { title: '学校考试' })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败,请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="glass-blur rounded-[14px] border border-line/60 bg-surface-glass">
      {/* 头行:标题 + 关联卷摘要 + 收起 */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0">
          <div className="text-[14.5px] font-semibold text-content-primary">记一次学校考试</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-content-muted">
            {selected ? (
              <>
                <span className="text-content-secondary">{selected.title}</span>
                {' · '}
                {SUBJECT_LABELS[selected.subject as keyof typeof SUBJECT_LABELS] ?? selected.subject} · {selected.totalScore} 分 /{' '}
                {selected.questionCount} 题 ·{' '}
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold text-accent transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  更换卷子
                </button>
              </>
            ) : (
              '先选卷子(先录入卷库),勾错题自动算丢分与考点'
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="收起"
          className="flex-none rounded-full p-1.5 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
        >
          <X size={16} />
        </button>
      </div>

      {/* 关联卷选择器:未选/点「更换」时展开;搜索 + 全量列表(35+ 张一屏滚得下) */}
      {pickerOpen && (
        <div className="mx-4 mt-3 overflow-hidden rounded-control border border-line bg-surface">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜卷名,如「数学模拟」「2024」…"
            className="h-9 w-full border-b border-line bg-transparent px-3 text-[12.5px] max-md:text-[16px] text-content-primary outline-none placeholder:text-content-muted"
          />
          <div className="max-h-44 overflow-y-auto py-1">
            {filteredPapers.length === 0 && (
              papersError ? (
                <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-content-muted">
                  卷库加载失败（网络或服务超时）。
                  <button
                    type="button"
                    onClick={onRetryPapers}
                    className="font-semibold text-accent hover:underline"
                  >
                    重试
                  </button>
                </div>
              ) : (
                <div className="px-3 py-3 text-[12px] text-content-muted">没有匹配的卷子——先把卷子录入卷库再记成绩</div>
              )
            )}
            {groupedPapers.map(([subject, items]) => (
              <div key={subject}>
                <button
                  type="button"
                  onClick={() => toggleGroup(subject)}
                  aria-expanded={!collapsedGroups.has(subject)}
                  className="flex w-full items-center gap-1 px-3 py-1.5 text-left transition-colors hover:bg-surface-subtle"
                >
                  <ChevronDown
                    className={cn('h-3 w-3 flex-none text-content-muted transition-transform', collapsedGroups.has(subject) && '-rotate-90')}
                    aria-hidden
                  />
                  <span className="text-[10.5px] font-semibold text-content-muted">
                    {SUBJECT_LABELS[subject as keyof typeof SUBJECT_LABELS] ?? subject}
                    <span className="ml-1 font-normal tabular-nums">· {items.length} 张</span>
                  </span>
                </button>
                {!collapsedGroups.has(subject) &&
                  items.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => selectPaper(p)}
                      className="flex w-full items-center gap-2 px-3 py-2 pl-7 text-left transition-colors hover:bg-surface-subtle"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] text-content-primary">{p.title}</span>
                      <span className="flex-none text-[10.5px] text-content-muted">
                        {p.totalScore} 分 / {p.questionCount} 题
                      </span>
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 双栏主体:左 = 信息 + 勾错板;右 = 实时汇总。窄屏自然叠单列 */}
      <div className="grid grid-cols-1 gap-3.5 px-4 pb-1 pt-3 lg:grid-cols-[1.45fr_1fr]">
        {/* ── 左栏 ── */}
        <div className="min-w-0">
          <div className="grid grid-cols-[1fr_132px] gap-2.5">
            <div>
              <span className={LABEL}>类型</span>
              <div className="flex flex-wrap gap-1.5">
                {EXAM_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setExamType(t)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                      examType === t
                        ? 'border-accent bg-accent-soft font-semibold text-accent'
                        : 'border-line bg-surface text-content-secondary hover:border-line-strong'
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={LABEL} htmlFor="exam-date">
                日期
              </label>
              <input id="exam-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INP} />
            </div>
          </div>

          <div className="mt-2.5">
            <label className={LABEL} htmlFor="exam-name">
              考试名称
            </label>
            <input
              id="exam-name"
              value={examName}
              onChange={(e) => setExamName(e.target.value)}
              maxLength={80}
              placeholder="如:第一学期期中考试"
              className={INP}
            />
          </div>

          <div className="mt-2.5 grid grid-cols-3 gap-2.5">
            <div>
              <label className={LABEL} htmlFor="exam-score">
                得分{' '}
                <button
                  type="button"
                  onClick={() => setScore(String(Math.max(0, autoTotal - loss)))}
                  className="text-[10.5px] font-normal text-accent transition-opacity hover:opacity-80"
                >
                  按勾错算
                </button>
              </label>
              <input id="exam-score" type="number" min={0} value={score} onChange={(e) => setScore(e.target.value)} className={INP} />
            </div>
            <div>
              <label className={LABEL} htmlFor="exam-full">
                满分
              </label>
              <input id="exam-full" type="number" min={1} value={fullScore} onChange={(e) => setFullScore(e.target.value)} className={INP} />
            </div>
            <div>
              <label className={LABEL} htmlFor="exam-rank">
                排名 <span className="font-normal text-content-muted">选填</span>
              </label>
              <input
                id="exam-rank"
                value={rank}
                onChange={(e) => setRank(e.target.value)}
                maxLength={60}
                placeholder="班级 12"
                className={INP}
              />
            </div>
          </div>

          {/* 勾错题板:大题分组的题号方块;悬停看考点,只勾错的 */}
          <div className="mt-3">
            <div className={LABEL}>
              勾错题 <span className="font-normal text-content-muted">点方块切换 · 悬停看考点 · 可跳过</span>
            </div>
            {!selected ? (
              <div className="rounded-control border-[1.5px] border-dashed border-line-strong px-3 py-3.5 text-[12px] text-content-muted">
                先在上方选一张卷子,再勾错题
              </div>
            ) : qPending ? (
              <div className="study-sk h-24 rounded-control" />
            ) : sections.length === 0 ? (
              <div className="rounded-control border-[1.5px] border-dashed border-line-strong px-3 py-3.5 text-[12px] text-content-muted">
                这张卷还没有逐题索引,只记总分即可
              </div>
            ) : (
              <div className="overflow-hidden rounded-control border border-line">
                {sections.map((sec, si) => {
                  const secLoss = sec.questions.reduce((s, q) => s + (wrong.has(q.number) ? q.score : 0), 0)
                  return (
                    <div key={si}>
                      <div className="flex items-baseline justify-between gap-2 border-b border-line bg-surface-subtle px-2.5 py-1.5 text-[11px] font-semibold text-content-secondary">
                        <span className="min-w-0 truncate">{sec.name}</span>
                        <span className="flex-none font-normal tabular-nums text-content-muted">{sec.range}</span>
                        {secLoss > 0 && (
                          <span className="ml-auto flex-none font-normal tabular-nums text-danger">勾错丢 {secLoss} 分</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5 px-2.5 py-2">
                        {sec.questions.map((q) => (
                          <button
                            key={q.number}
                            type="button"
                            title={`${q.topics[0] ?? '未打标'} · ${q.score} 分`}
                            onClick={() => toggleWrong(q.number)}
                            aria-pressed={wrong.has(q.number)}
                            className={cn(
                              'h-[26px] w-[32px] rounded-control border text-[11.5px] tabular-nums transition-colors',
                              wrong.has(q.number)
                                ? 'border-danger bg-danger font-bold text-white'
                                : 'border-line bg-surface text-content-secondary hover:border-line-strong'
                            )}
                          >
                            {q.number}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── 右栏:实时汇总 ── */}
        <div className="min-w-0">
          <div className="rounded-control border border-line bg-surface px-3 py-2.5">
            <div className="flex items-baseline gap-1">
              <b className="text-[24px] font-bold leading-tight tabular-nums text-content-primary">{Math.max(0, autoTotal - loss)}</b>
              <span className="text-[12px] text-content-muted">/ {autoTotal || '—'}</span>
              <span className="ml-auto text-[10.5px] text-content-muted">按勾错自动算</span>
            </div>
            <div className="mt-1 text-[11.5px] tabular-nums text-content-secondary">
              已勾 <b className="text-content-primary">{wrong.size}</b> 题 · 丢 <b className="text-content-primary">{loss}</b> 分
            </div>
          </div>

          <div className="mt-2.5 rounded-control border border-line bg-surface px-3 py-2.5">
            <div className="text-[11px] font-semibold text-content-secondary">
              考点丢分 <span className="font-normal text-content-muted">喂「针对我复习」</span>
            </div>
            {topicLoss.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {topicLoss.map(([t, v]) => (
                  <span
                    key={t}
                    className="rounded-full bg-danger/10 px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-danger"
                  >
                    {t} <span className="font-normal opacity-80">×{v.count} · −{v.loss}分</span>
                  </span>
                ))}
              </div>
            ) : (
              <div className="mt-1.5 text-[11px] text-content-muted">勾了错题,这里会按考点汇总丢分</div>
            )}
          </div>

          <div className="mt-2.5 rounded-control border border-line bg-surface px-3 py-2.5">
            <div className="text-[11px] font-semibold text-content-secondary">
              已勾的题 <span className="font-normal text-content-muted">点一下取消</span>
            </div>
            {wrong.size > 0 ? (
              <div className="mt-1">
                {Array.from(wrong)
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => toggleWrong(n)}
                      className="flex w-full items-center gap-2 rounded-control px-1.5 py-[3px] text-left transition-colors hover:bg-danger/10"
                    >
                      <span className="w-5 flex-none text-[11.5px] font-bold tabular-nums text-danger">{n}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-content-secondary">
                        {(topicByNumber.get(n) ?? [])[0] ?? '未打标'}
                      </span>
                      <span className="flex-none text-[10.5px] tabular-nums text-content-muted">{scoreByNumber.get(n)} 分</span>
                      <span className="flex-none text-[12px] text-content-muted" aria-hidden>
                        ×
                      </span>
                    </button>
                  ))}
              </div>
            ) : (
              <div className="mt-1 text-[11px] text-content-muted">还没勾,点左栏题号方块</div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 rounded-control border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      {/* 底栏:收起 / 保存(不勾错题 = 只记总分) */}
      <div className="flex justify-end gap-2.5 px-4 pb-3.5 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-line px-4 py-1.5 text-[12.5px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
        >
          收起
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="rounded-full bg-accent px-5 py-1.5 text-[12.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存记录'}
        </button>
      </div>
    </div>
  )
}
