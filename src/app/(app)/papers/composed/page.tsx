'use client'

/**
 * /papers/composed —— 拟卷列表页(学习台「拟卷练习」区块与统计行 chip 的目的地)。
 * 数据 = GET /api/papers/composed(本用户全量,createdAt 倒序);点击条目进卷面页
 * /papers/composed/[id](打印/换题/重摇都在卷面页做)。
 * 组卷 = 方案一「就地展开」表单(design/preview-paper-compose-form.html 用户挑定):
 * 学科 + 大纲槽位行编辑 + 卷名 → POST slotDefs(引擎大纲模式,零拟题,缺口如实提示)。
 * 底卷模式(学考/高考按卷种选底卷)仍走聊天 AI。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { ChevronLeft, FileText, Loader2, Plus, X } from 'lucide-react'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { fetchJson } from '@/lib/query/fetcher'
import { providersModelsQuery, isModelAvailable, providerKeysStatusQuery } from '@/lib/query/providers'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import { SUBJECT_LABELS } from '@/lib/study/subject-labels'
import { dateRel, type ComposedPaperListItem } from '@/components/study/StudyHome'

const TOPBAR_H = 52

type SlotRow = { section: string; kind: 'choice' | 'answer'; score: number; count: number }

const KIND_LABEL: Record<SlotRow['kind'], string> = { choice: '选择题', answer: '解答/填空' }

/** 槽位行编辑器:大题名/题型/分值/题数,可增删;分值题数越界自动钳回 */
function SlotRows({ rows, onChange }: { rows: SlotRow[]; onChange: (rows: SlotRow[]) => void }) {
  const patch = (i: number, p: Partial<SlotRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...p } : r)))
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] text-content-muted">大纲（每行一个大题；某档真题不够有多少放多少，缺口提交后提示）</span>
      </div>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_72px_46px_46px_26px] items-center gap-1.5 max-md:grid-cols-[64px_46px_46px_26px]">
            <input
              value={r.section}
              onChange={(e) => patch(i, { section: e.target.value.slice(0, 30) })}
              placeholder={`大题名（${KIND_LABEL[r.kind]}）`}
              className="h-8 min-w-0 rounded-lg border border-line bg-surface px-2 text-[12px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent max-md:col-span-4"
              aria-label="大题名"
            />
            <select
              value={r.kind}
              onChange={(e) => patch(i, { kind: e.target.value as SlotRow['kind'] })}
              className="h-8 rounded-lg border border-line bg-surface px-1 text-[11.5px] text-content-primary outline-none focus:border-accent"
              aria-label="题型"
            >
              <option value="choice">选择</option>
              <option value="answer">解答</option>
            </select>
            <input
              type="number"
              min={1}
              max={30}
              value={r.score}
              onChange={(e) => patch(i, { score: Math.min(30, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
              className="h-8 rounded-lg border border-line bg-surface px-1.5 text-center text-[12px] text-content-primary outline-none focus:border-accent"
              aria-label="每题分值"
            />
            <input
              type="number"
              min={1}
              max={20}
              value={r.count}
              onChange={(e) => patch(i, { count: Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
              className="h-8 rounded-lg border border-line bg-surface px-1.5 text-center text-[12px] text-content-primary outline-none focus:border-accent"
              aria-label="题数"
            />
            <button
              type="button"
              onClick={() => onChange(rows.length > 1 ? rows.filter((_, k) => k !== i) : rows)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary disabled:opacity-40"
              disabled={rows.length <= 1}
              aria-label="删除该大题"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, { section: '', kind: rows[rows.length - 1]?.kind ?? 'choice', score: 3, count: 5 }])}
        className="mt-1.5 w-full rounded-lg border border-dashed border-line-strong py-1.5 text-[11.5px] text-content-secondary transition-colors hover:text-content-primary"
      >
        ＋ 加一个大题
      </button>
    </div>
  )
}

function ComposedListContent() {
  const router = useRouter()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.papers.composedList(),
    queryFn: ({ signal }) => fetchJson<{ papers: ComposedPaperListItem[] }>('/api/papers/composed', { signal }),
    staleTime: 30_000,
  })
  const papers = data?.papers ?? []
  // 内联题生成模型:默认公共池优先(与卷面助手同口径)
  const { data: allModels } = useQuery({ ...providersModelsQuery })
  const { data: keyProviders } = useQuery<Set<string>>({ ...providerKeysStatusQuery })
  const defaultModelId = useMemo(() => {
    if (!allModels) return null
    const avail = keyProviders ? allModels.filter((m) => isModelAvailable(m, keyProviders)) : allModels
    return avail.find((m) => m.publicPool)?.id || avail[0]?.id || null
  }, [allModels, keyProviders])

  // ── 组卷表单(方案一:就地展开) ──
  const [formOpen, setFormOpen] = useState(false)
  const [subject, setSubject] = useState('chinese')
  const [rows, setRows] = useState<SlotRow[]>([
    { section: '', kind: 'choice', score: 3, count: 5 },
    { section: '', kind: 'answer', score: 8, count: 2 },
  ])
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  // 模板:套用库内真题卷的结构快照(examType 分卷种 → 选卷 → 填充槽位行,可再手改);支持多选,结构取并集
  const [tplExamType, setTplExamType] = useState<string | null>(null)
  const [appliedSlugs, setAppliedSlugs] = useState<string[]>([])
  // 题目来源:random=真题池随机 / focus=针对我复习(按薄弱考点匹配填充)
  const [sourceMode, setSourceMode] = useState<'random' | 'focus'>('random')
  const [picks, setPicks] = useState<string[]>([])
  const [extraTopics, setExtraTopics] = useState<string[]>([])
  const [manualTopic, setManualTopic] = useState('')
  const [perTopic, setPerTopic] = useState(2)
  const [extraRandom, setExtraRandom] = useState(3)
  // 真题不够时的补齐配比:课本拟题 / AI 举一反三(来源会标注在卷面)
  const [fillTb, setFillTb] = useState(true)
  const [fillAi, setFillAi] = useState(true)
  const weakInitedRef = useRef(false)
  const tplQuery = useQuery({
    queryKey: ['papers', 'base-structures', subject],
    queryFn: ({ signal }) =>
      fetchJson<{ templates: Array<{ slug: string; title: string; examType: string | null; year: string | null; questionCount: number; groups: Array<{ section: string | null; kind: string; score: number; count: number }> }> }>(
        `/api/papers/composed/base-structures?subject=${subject}`,
        { signal }
      ),
    enabled: formOpen,
    staleTime: 60_000,
  })
  const templates = tplQuery.data?.templates ?? []
  const examTypes = Array.from(new Set(templates.map((t) => t.examType ?? '未标注')))
  const tplOfType = tplExamType ? templates.filter((t) => (t.examType ?? '未标注') === tplExamType) : []

  /** 多选模板:结构取并集——同(大题名,题型,分值)取题数最大值,不同组按首现顺序合并,≤12 行 */
  const applyTemplateSet = (selected: Array<(typeof templates)[number]>) => {
    const map = new Map<
      string,
      { section: string; kind: 'choice' | 'answer'; score: number; count: number; order: number }
    >()
    selected.forEach((t, ti) => {
      t.groups.forEach((g, gi) => {
        const key = `${g.section ?? ''}|${g.kind}|${g.score}`
        const row = { section: g.section ?? '', kind: (g.kind === 'answer' ? 'answer' : 'choice') as 'choice' | 'answer', score: Math.min(30, Math.max(1, g.score)), count: Math.min(20, Math.max(1, g.count)), order: ti * 100 + gi }
        const cur = map.get(key)
        if (cur) cur.count = Math.max(cur.count, row.count)
        else map.set(key, row)
      })
    })
    const merged = Array.from(map.values()).sort((a, b) => a.order - b.order).slice(0, 12)
    setRows(merged.map(({ section, kind, score, count }) => ({ section, kind, score, count })))
  }

  const toggleTemplate = (t: (typeof templates)[number]) => {
    const next = appliedSlugs.includes(t.slug) ? appliedSlugs.filter((s) => s !== t.slug) : [...appliedSlugs, t.slug]
    setAppliedSlugs(next)
    const selected = templates.filter((x) => next.includes(x.slug))
    if (selected.length > 0) applyTemplateSet(selected)
    else resetToCustom()
  }

  const resetToCustom = () => {
    setRows([
      { section: '', kind: 'choice', score: 3, count: 5 },
      { section: '', kind: 'answer', score: 8, count: 2 },
    ])
  }

  // ── 针对我复习:薄弱考点(来自学习台 meta.weak,按掌握度排) ──
  const weakQuery = useQuery({
    queryKey: ['study', 'weak-topics'],
    queryFn: ({ signal }) =>
      fetchJson<{ meta?: { weak?: Array<{ topic: string | null; title: string; mastery: number }> } }>(
        '/api/study?withMeta=1&limit=1',
        { signal }
      ),
    enabled: formOpen && sourceMode === 'focus',
    staleTime: 60_000,
  })
  const weakPoints = Array.from(
    new Map(
      (weakQuery.data?.meta?.weak ?? [])
        // 只取带考点词的错题:无考点的用整句标题当「考点」既难看又匹配不到题
        .filter((w) => (w.topic ?? '').trim().length >= 2)
        .map((w) => ({ label: (w.topic || '').trim(), mastery: Math.round((w.mastery ?? 0) * 100) }))
        .map((w) => ({ ...w, label: w.label.length > 14 ? `${w.label.slice(0, 14)}…` : w.label }))
        .filter((w) => w.label.length >= 2)
        .map((w) => [w.label, w])
    ).values()
  )
  const allPoints = [
    ...weakPoints,
    ...extraTopics.filter((t) => !weakPoints.some((w) => w.label === t)).map((t) => ({ label: t, mastery: null as number | null })),
  ]
  // 薄弱点首次到位时默认勾最弱的 3 个(用户手动动过选择后就不再代劳)
  useEffect(() => {
    if (sourceMode === 'focus' && !weakInitedRef.current && weakPoints.length > 0) {
      setPicks(weakPoints.slice(0, 3).map((w) => w.label))
      weakInitedRef.current = true
    }
  }, [sourceMode, weakPoints.length])
  const togglePick = (label: string) =>
    setPicks((prev) => (prev.includes(label) ? prev.filter((p) => p !== label) : [...prev, label]))

  const addManualTopic = () => {
    const t = manualTopic.trim().slice(0, 30)
    if (!t) return
    setExtraTopics((prev) => (prev.includes(t) ? prev : [...prev, t]))
    setPicks((prev) => (prev.includes(t) ? prev : [...prev, t]))
    setManualTopic('')
  }

  const submitCompose = useCallback(async () => {
    if (submitting) return
    const focusOn = sourceMode === 'focus'
    const sel = picks.filter(Boolean)
    // 针对我 + 无模板:按考点分组组卷(不用槽位行);其余场景走槽位行
    const useSlots = !focusOn || appliedSlugs.length > 0
    let defs: Array<{ section?: string; kind: 'choice' | 'answer'; score: number; count: number }> = []
    if (useSlots) {
      defs = rows
        .filter((r) => r.count > 0 && r.score > 0)
        .map((r) => ({ section: r.section.trim() || undefined, kind: r.kind, score: Math.round(r.score), count: Math.round(r.count) }))
      if (!defs.length) {
        setFormError('至少保留一个有效大题（分值/题数 ≥ 1）')
        return
      }
    }
    if (focusOn && sel.length === 0) {
      setFormError('勾选至少一个薄弱考点（或手动输入考点）')
      return
    }
    setSubmitting(true)
    setFormError(null)
    const payload: Record<string, unknown> = { subject, title: title.trim() || undefined }
    if (useSlots) payload.slotDefs = defs
    if (focusOn) {
      payload.focusTopics = sel
      if (appliedSlugs.length === 0) {
        payload.perTopic = perTopic
        payload.extraRandom = extraRandom
        payload.fillInline = { textbook: fillTb ? 9 : 0, aiVariant: fillAi ? 9 : 0 }
        payload.modelId = defaultModelId
      }
    }
    try {
      const res = await fetchJson<{ id: string; shortages: Array<{ kind: string; score: number; requested: number; filled: number }> }>(
        '/api/papers/composed',
        { method: 'POST', json: payload, timeoutMs: 30_000 }
      )
      void qc.invalidateQueries({ queryKey: queryKeys.papers.composedList() })
      const shortageNote = (res.shortages ?? [])
        .map((s) =>
          s.score === 0
            ? `${s.kind}：匹配到 ${s.filled}/${s.requested} 道`
            : `${KIND_LABEL[s.kind as SlotRow['kind']] ?? s.kind}${s.score}分 缺 ${s.requested - s.filled} 道`
        )
        .join('；')
      if (shortageNote) toast.success(`组好了（${shortageNote}）`, { title: '拟卷' })
      router.push(`/papers/composed/${res.id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '组卷失败'
      setFormError(msg === 'no_pool' ? '该科真题池还没有带官方答案的题，换个学科或先回聊天录入试卷' : msg)
      setSubmitting(false)
    }
  }, [rows, subject, title, submitting, qc, router, sourceMode, picks, appliedSlugs, perTopic, extraRandom, fillTb, fillAi, defaultModelId])

  const handleBack = useCallback(() => {
    if (window.history.length > 1) router.back()
    else router.push('/study')
  }, [router])

  return (
    <div className="relative h-full">
      {/* 顶栏(与卷面页同款骨架):返回 / 页名 */}
      <div className="absolute inset-x-0 top-0 z-10 flex min-h-[52px] items-center gap-1 border-b border-line/60 bg-surface/95 px-1.5 backdrop-blur-md max-md:pt-[var(--sat)] md:px-4">
        <button
          type="button"
          onClick={handleBack}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 py-1 text-[13px] font-medium text-content-primary md:text-sm">拟卷</div>
      </div>

      <div className="h-full overflow-y-auto pt-[calc(52px+var(--sat))]">
        <div className="mx-auto w-full max-w-[760px] px-2 pt-3 pb-[max(64px,var(--sab))] md:px-4 md:pb-16">
          {/* 摘要行 + 组卷入口(方案一:就地展开) */}
          <div className="mb-3 flex items-center gap-2 px-1">
            <p className="min-w-0 flex-1 text-[11.5px] text-content-muted">
              {isLoading
                ? '加载中…'
                : papers.length > 0
                  ? `${papers.length} 张卷 · 点击进卷面，可打印 / 换题 · 也可就地组一张`
                  : ''}
            </p>
            <button
              type="button"
              onClick={() => setFormOpen((v) => !v)}
              className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-accent px-3 text-[11.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" />
              组一张卷
            </button>
          </div>

          {/* 组卷表单(展开时插在列表上方,列表下沉) */}
          {formOpen && (
            <div className="glass-blur mb-4 rounded-[14px] border border-line/60 bg-surface-glass p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[13px] font-bold text-content-primary">组一张卷</span>
                <span className="text-[10.5px] text-content-muted">真题池填充 · 零拟题</span>
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="ml-auto rounded-md p-1 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
                  aria-label="收起表单"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex flex-col gap-3.5">
                <div>
                  <div className="mb-1.5 text-[10px] text-content-muted">学科</div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(SUBJECT_LABELS).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setSubject(key)
                          setTplExamType(null)
                          setAppliedSlugs([])
                        }}
                        className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                          subject === key
                            ? 'border-accent bg-accent-soft font-semibold text-accent'
                            : 'border-line bg-surface text-content-secondary hover:text-content-primary'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {/* 考试标准:点卷种 = 立即套用该标准下最完整真题的结构;也可再指定具体卷 */}
                <div>
                  <div className="mb-1.5 text-[10px] text-content-muted">
                    考试标准（点卷种即套用该标准下最完整真题的结构，行可再手改；也可指定具体卷）
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setTplExamType(null)
                        resetToCustom()
                      }}
                      className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                        !tplExamType
                          ? 'border-accent bg-accent-soft font-semibold text-accent'
                          : 'border-line bg-surface text-content-secondary hover:text-content-primary'
                      }`}
                    >
                      自定义
                    </button>
                    {tplQuery.isLoading && <span className="text-[11px] text-content-muted">加载模板中…</span>}
                    {examTypes.map((et) => {
                      const rep = templates
                        .filter((t) => (t.examType ?? '未标注') === et)
                        .sort((a, b) => b.questionCount - a.questionCount)[0]
                      return (
                        <button
                          key={et}
                          type="button"
                          onClick={() => {
                            setTplExamType(et)
                            if (rep) {
                              setAppliedSlugs([rep.slug])
                              applyTemplateSet([rep])
                            }
                          }}
                          className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                            tplExamType === et
                              ? 'border-accent bg-accent-soft font-semibold text-accent'
                              : 'border-line bg-surface text-content-secondary hover:text-content-primary'
                          }`}
                          title={rep ? `套用：${rep.title}（${rep.questionCount} 题）` : undefined}
                        >
                          {et}
                        </button>
                      )
                    })}
                  </div>
                  {tplExamType && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {tplOfType.length === 0 && <span className="text-[11px] text-content-muted">该卷种下没有可套用的卷</span>}
                      {tplOfType.map((t) => (
                        <button
                          key={t.slug}
                          type="button"
                          onClick={() => toggleTemplate(t)}
                          className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                            appliedSlugs.includes(t.slug)
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-line bg-surface text-content-secondary hover:text-content-primary'
                          }`}
                          title={`${t.questionCount} 题（可多选，结构取并集）`}
                        >
                          {t.title}
                          {t.year ? ` ${t.year}` : ''}
                        </button>
                      ))}
                    </div>
                  )}
                  {appliedSlugs.length > 0 && (
                    <div className="mt-1.5 text-[10.5px] text-accent">
                      已套用 {appliedSlugs.length} 张卷的结构{appliedSlugs.length > 1 ? '（并集：同大题取题数多的一档）' : ''}（行可手改）
                    </div>
                  )}
                </div>
                {/* 题目来源:随机 / 针对我复习 */}
                <div>
                  <div className="mb-1.5 text-[10px] text-content-muted">题目来源</div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSourceMode('random')}
                      className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                        sourceMode === 'random'
                          ? 'border-accent bg-accent-soft font-semibold text-accent'
                          : 'border-line bg-surface text-content-secondary hover:text-content-primary'
                      }`}
                    >
                      随机抽题
                    </button>
                    <button
                      type="button"
                      onClick={() => setSourceMode('focus')}
                      className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                        sourceMode === 'focus'
                          ? 'border-accent bg-accent-soft font-semibold text-accent'
                          : 'border-line bg-surface text-content-secondary hover:text-content-primary'
                      }`}
                    >
                      针对我复习
                    </button>
                  </div>
                </div>
                {sourceMode === 'focus' && (
                  <div>
                    <div className="mb-1.5 text-[10px] text-content-muted">
                      你的薄弱考点（来自错题本与学习记录，按掌握度排；勾选要复习的）
                    </div>
                    {weakQuery.isLoading && <div className="text-[11px] text-content-muted">读取学习记录中…</div>}
                    {!weakQuery.isLoading && allPoints.length === 0 && (
                      <div className="text-[11px] leading-relaxed text-content-muted">
                        错题本里还没有带考点的错题——先在学习台学几道题，或在下面手动输入考点
                      </div>
                    )}
                    {allPoints.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {allPoints.map((w) => (
                          <button
                            key={w.label}
                            type="button"
                            onClick={() => togglePick(w.label)}
                            className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                              picks.includes(w.label)
                                ? 'border-accent bg-accent-soft font-semibold text-accent'
                                : 'border-line bg-surface text-content-secondary hover:text-content-primary'
                            }`}
                          >
                            {w.label}
                            {w.mastery != null && <span className="ml-1 text-[10px] opacity-70">{w.mastery}%</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="mt-1.5 flex gap-1.5">
                      <input
                        value={manualTopic}
                        onChange={(e) => setManualTopic(e.target.value.slice(0, 30))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addManualTopic()
                          }
                        }}
                        placeholder="手动加考点（如：文言断句）"
                        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-[12px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent"
                        aria-label="手动加考点"
                      />
                      <button
                        type="button"
                        onClick={addManualTopic}
                        className="h-8 shrink-0 rounded-lg border border-line px-3 text-[11.5px] text-content-secondary transition-colors hover:text-content-primary"
                      >
                        加
                      </button>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="flex items-center gap-2">
                        <span className="text-[10px] text-content-muted">每个考点取</span>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={perTopic}
                          onChange={(e) => setPerTopic(Math.min(10, Math.max(1, Math.round(Number(e.target.value) || 2))))}
                          className="h-7 w-12 rounded-lg border border-line bg-surface px-1.5 text-center text-[12px] text-content-primary outline-none focus:border-accent"
                          aria-label="每个考点题数"
                        />
                        <span className="text-[10px] text-content-muted">道</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-[10px] text-content-muted">另加随机巩固题</span>
                        <input
                          type="number"
                          min={0}
                          max={20}
                          value={extraRandom}
                          onChange={(e) => setExtraRandom(Math.min(20, Math.max(0, Math.round(Number(e.target.value) || 0))))}
                          className="h-7 w-12 rounded-lg border border-line bg-surface px-1.5 text-center text-[12px] text-content-primary outline-none focus:border-accent"
                          aria-label="随机巩固题数"
                        />
                        <span className="text-[10px] text-content-muted">道（放卷尾「巩固练习」）</span>
                      </span>
                    </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="text-[10px] text-content-muted">真题不够时自动补齐：</span>
                      <button
                        type="button"
                        onClick={() => setFillTb((v) => !v)}
                        className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${fillTb ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-surface text-content-secondary hover:text-content-primary'}`}
                      >
                        课本拟题
                      </button>
                      <button
                        type="button"
                        onClick={() => setFillAi((v) => !v)}
                        className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${fillAi ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-surface text-content-secondary hover:text-content-primary'}`}
                      >
                        AI 举一反三
                      </button>
                      <span className="text-[10px] text-content-muted">（补齐的题在卷面标注来源；AI 题答案为 AI 拟答）</span>
                    </div>
                    {appliedSlugs.length === 0 && (
                      <div className="mt-1 text-[10.5px] leading-relaxed text-content-muted">
                        卷子按考点分组（大题名 = 考点）；想套考试结构就选上面的模板，题目会优先匹配这些考点。
                      </div>
                    )}
                  </div>
                )}
                {!(sourceMode === 'focus' && appliedSlugs.length === 0) && <SlotRows rows={rows} onChange={setRows} />}
                <div>
                  <div className="mb-1.5 text-[10px] text-content-muted">卷名（不填自动命名）</div>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value.slice(0, 60))}
                    placeholder="如：语言运用专项 · 周五"
                    className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-[12.5px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent"
                    aria-label="卷名"
                  />
                </div>
                {formError && (
                  <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-500">{formError}</div>
                )}
                <button
                  type="button"
                  onClick={() => void submitCompose()}
                  disabled={submitting}
                  className="flex h-9 w-full items-center justify-center gap-1.5 rounded-full bg-accent text-[12.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {sourceMode === 'focus' ? '组复习卷（真题池匹配薄弱点 · 零拟题）' : '组卷（真题池填充 · 零拟题）'}
                </button>
                <p className="text-[10px] leading-relaxed text-content-muted">
                  全部题目与答案出自原卷真题；组好直接进卷面页（可打印/换题/「这题有误」）。模板 = 库内真题卷的结构快照（只管格式）；「针对我复习」按你的薄弱考点选内容。底卷同位换题模式可回聊天让 AI 组。
                </p>
              </div>
            </div>
          )}

          {!isLoading && papers.length === 0 && !formOpen && (
            <div className="glass-blur rounded-[14px] border border-line/60 bg-surface-glass px-4 py-10 text-center">
              <p className="text-[13.5px] text-content-secondary">还没有拟卷</p>
              <p className="mt-1.5 text-xs leading-relaxed text-content-muted">
                点上方「＋ 组一张卷」就地组一张，或回聊天让 AI 帮你重组（如「按 2023 新课标Ⅰ卷重组一张数学卷」）。
              </p>
            </div>
          )}

          <div className="space-y-2.5">
            {papers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => router.push(`/papers/composed/${p.id}`)}
                className="glass-blur flex w-full items-center gap-3.5 rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-line-strong"
              >
                <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[12px] bg-accent-soft text-accent" aria-hidden>
                  <FileText className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-content-primary">{p.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-content-muted">
                    {SUBJECT_LABELS[p.subject as keyof typeof SUBJECT_LABELS] ?? p.subject} · 满分 {p.totalScore} · {p.slotCount} 题
                    {p.durationMin > 0 ? ` · ${p.durationMin} 分钟` : ''}
                    {p.onlyChoice ? ' · 只取选择题' : ''}
                  </span>
                </span>
                <span className="flex-none text-[11.5px] text-content-muted">{dateRel(p.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ComposedPapersPage() {
  return (
    <AuthErrorBoundary>
      <ClientOnly>
        <ComposedListContent />
      </ClientOnly>
    </AuthErrorBoundary>
  )
}
