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
import { ChevronLeft, FileText, Plus, Sparkles, X } from 'lucide-react'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { confirmDialog } from '@/components/ui/ConfirmDialog'
import { fetchJson } from '@/lib/query/fetcher'
import { providersModelsQuery, isModelAvailable, providerKeysStatusQuery } from '@/lib/query/providers'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import { SUBJECT_LABELS } from '@/lib/study/subject-labels'
import ComposeGenerating from '@/components/papers/ComposeGenerating'
import { dateRel, type ComposedPaperListItem } from '@/components/study/StudyHome'

const TOPBAR_H = 52

type SlotRow = { section: string; kind: 'choice' | 'answer'; score: number; count: number }

const KIND_LABEL: Record<SlotRow['kind'], string> = { choice: '选择题', answer: '解答/填空' }

const rowsTotal = (rows: ReadonlyArray<{ score: number; count: number }>) => rows.reduce((s, r) => s + r.score * r.count, 0)
const rowsCount = (rows: ReadonlyArray<{ count: number }>) => rows.reduce((s, r) => s + r.count, 0)

/** 按现有分值比例把整卷配平到目标总分:比例缩放取整后,差额在大分值行逐次找平(够不到就停在最近值) */
function balanceRows(rows: SlotRow[], target: number): SlotRow[] {
  const cur = rowsTotal(rows)
  if (!target || cur <= 0 || cur === target) return rows
  const ratio = target / cur
  let next = rows.map((r) => ({ ...r, score: Math.min(60, Math.max(1, Math.round(r.score * ratio))) }))
  let diff = rowsTotal(next) - target
  let guard = 60
  while (diff !== 0 && guard-- > 0) {
    let ai = 0
    for (let k = 1; k < next.length; k++) if (next[k].score > next[ai].score) ai = k
    if (diff > 0) {
      if (next[ai].score <= 1) break
      next = next.map((r, k) => (k === ai ? { ...r, score: r.score - 1 } : r))
      diff -= next[ai].count
    } else {
      next = next.map((r, k) => (k === ai ? { ...r, score: r.score + 1 } : r))
      diff += next[ai].count
    }
  }
  return next
}

/**
 * 大纲表:大题名/题型/每题分/题数/小计 + 删行;表头桌面显示,移动端两行布局(名一行,控制一行)。
 * 分值越界自动钳回(1-60,写作满分需要);小计与合计实时算,目标总分在表外的合计行操作。
 */
function OutlineTable({ rows, onChange }: { rows: SlotRow[]; onChange: (rows: SlotRow[]) => void }) {
  const patch = (i: number, p: Partial<SlotRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...p } : r)))
  const gridCls = 'grid grid-cols-[minmax(0,1fr)_64px_56px_48px_52px_26px] items-center gap-1.5 max-md:grid-cols-[64px_50px_44px_48px_26px]'
  return (
    <div>
      <div className="rounded-[10px] border border-line bg-surface px-1.5 py-1">
        <div className={`${gridCls} border-b border-line px-1 pb-1.5 max-md:hidden`}>
          <span className="text-[11px] font-semibold text-content-muted">大题名</span>
          <span className="text-[11px] font-semibold text-content-muted">题型</span>
          <span className="text-center text-[11px] font-semibold text-content-muted">每题分</span>
          <span className="text-center text-[11px] font-semibold text-content-muted">题数</span>
          <span className="text-center text-[11px] font-semibold text-content-muted">小计</span>
          <span />
        </div>
        <div>
          {rows.map((r, i) => (
            <div key={i} className={`${gridCls} border-b border-line/60 px-1 py-1.5 last:border-b-0`}>
              <input
                value={r.section}
                onChange={(e) => patch(i, { section: e.target.value.slice(0, 30) })}
                placeholder={`大题名（${KIND_LABEL[r.kind]}）`}
                className="h-8 min-w-0 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent max-md:col-span-5"
                aria-label="大题名"
              />
              <select
                value={r.kind}
                onChange={(e) => patch(i, { kind: e.target.value as SlotRow['kind'] })}
                className="h-8 rounded-lg border border-line bg-surface px-1 text-[12px] text-content-primary outline-none focus:border-accent"
                aria-label="题型"
              >
                <option value="choice">选择</option>
                <option value="answer">解答</option>
              </select>
              <input
                type="number"
                min={1}
                max={60}
                value={r.score}
                onChange={(e) => patch(i, { score: Math.min(60, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
                className="h-8 rounded-lg border border-line bg-surface px-1.5 text-center text-[12.5px] text-content-primary outline-none focus:border-accent"
                aria-label="每题分值"
              />
              <input
                type="number"
                min={1}
                max={20}
                value={r.count}
                onChange={(e) => patch(i, { count: Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
                className="h-8 rounded-lg border border-line bg-surface px-1.5 text-center text-[12.5px] text-content-primary outline-none focus:border-accent"
                aria-label="题数"
              />
              <span className="whitespace-nowrap text-center text-[12px] tabular-nums text-content-secondary">
                <b className="font-semibold text-content-primary">{r.score * r.count}</b> 分
              </span>
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
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, { section: '', kind: rows[rows.length - 1]?.kind ?? 'choice', score: 3, count: 5 }])}
        className="mt-1.5 w-full rounded-lg border border-dashed border-line-strong py-1.5 text-[12px] text-content-secondary transition-colors hover:text-content-primary"
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
  // 给 AI 的备注:真题不够走 AI 补题时进生成 prompt(组卷时瞬时生效,不落库)
  const [note, setNote] = useState('')
  // 目标总分:设置后可一键按分值比例配平;null = 不设限,合计行只显示当前总分
  const [targetScore, setTargetScore] = useState<number | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  // no_pool 死路 → AI 出题兜底:命中过 no_pool 才显示「改用 AI 出题」;警告一次后会话内不再重复弹
  const [noPoolHit, setNoPoolHit] = useState(false)
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
  // 组卷进行中:mode=纯真题(pool,快)/AI 补题(ai,慢),total=提交时刻的题数(动画示意用,固化不怕表单中途变化)
  const [submitting, setSubmitting] = useState<null | { mode: 'ai' | 'pool'; total: number }>(null)
  const formCardRef = useRef<HTMLDivElement>(null)
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
        const row = { section: g.section ?? '', kind: (g.kind === 'answer' ? 'answer' : 'choice') as 'choice' | 'answer', score: Math.min(60, Math.max(1, g.score)), count: Math.min(20, Math.max(1, g.count)), order: ti * 100 + gi }
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

  // 学习台「去组一张卷」深链:带 ?compose=1 进来时自动展开组卷表单(与「＋ 组一张卷」同效)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('compose') === '1') setFormOpen(true)
  }, [])

  // 从独立生成页「回去改改」/「离开等待」回来:恢复组卷表单状态(可能带错误提示),然后清键防重复恢复
  useEffect(() => {
    const raw = window.sessionStorage.getItem('composed-form-state')
    if (!raw) return
    window.sessionStorage.removeItem('composed-form-state')
    try {
      const { form, error } = JSON.parse(raw) as {
        form: Partial<{ subject: string; rows: SlotRow[]; title: string; note: string; sourceMode: 'random' | 'focus'; picks: string[]; extraTopics: string[]; perTopic: number; extraRandom: number; fillTb: boolean; fillAi: boolean; targetScore: number | null; appliedSlugs: string[]; tplExamType: string | null }>
        error: string | null
      }
      if (form.subject) setSubject(form.subject)
      if (form.rows) setRows(form.rows)
      if (form.title != null) setTitle(form.title)
      if (form.note != null) setNote(form.note)
      if (form.sourceMode) setSourceMode(form.sourceMode)
      if (form.picks) { setPicks(form.picks); weakInitedRef.current = true }
      if (form.extraTopics) setExtraTopics(form.extraTopics)
      if (form.perTopic != null) setPerTopic(form.perTopic)
      if (form.extraRandom != null) setExtraRandom(form.extraRandom)
      if (form.fillTb != null) setFillTb(form.fillTb)
      if (form.fillAi != null) setFillAi(form.fillAi)
      if (form.targetScore !== undefined && form.targetScore !== null) setTargetScore(form.targetScore)
      if (form.appliedSlugs) setAppliedSlugs(form.appliedSlugs)
      if (form.tplExamType !== undefined) setTplExamType(form.tplExamType)
      setFormOpen(true)
      if (error) setFormError(error)
    } catch { /* 损坏的暂存直接丢弃 */ }
  }, [])

  const submitCompose = useCallback(async (opts?: { aiFillAll?: boolean }) => {
    if (submitting) return
    const aiFillAll = !!opts?.aiFillAll && !!defaultModelId
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
    setFormError(null)
    setNoPoolHit(false)
    formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const payload: Record<string, unknown> = { subject, title: title.trim() || undefined }
    if (note.trim()) payload.note = note.trim().slice(0, 200)
    if (useSlots) payload.slotDefs = defs
    if (focusOn) {
      payload.focusTopics = sel
      if (appliedSlugs.length === 0) {
        payload.perTopic = perTopic
        payload.extraRandom = extraRandom
      }
    }
    if (aiFillAll) {
      // AI 兜底重试:整卷缺口都按 AI 拟题补,预算放宽到 30(远大于整卷题量);两种模式都带
      payload.aiFillAll = true
      payload.fillInline = { textbook: fillTb ? 30 : 0, aiVariant: fillAi || !fillTb ? 30 : 0 }
      payload.modelId = defaultModelId
    } else if (focusOn && appliedSlugs.length === 0) {
      payload.fillInline = { textbook: fillTb ? 9 : 0, aiVariant: fillAi ? 9 : 0 }
      payload.modelId = defaultModelId
    }
    if (aiFillAll) {
      // AI 补题(约 1-3 分钟)跳独立生成页(design/preview-paper-compose-generating.html 方案 E,折中落定:
      // 纯真题快模式留在卡内,慢模式才跳页);payload+meta 暂存 sessionStorage,由生成页发起请求,
      // 表单状态一并暂存,失败「回去改改」/等待中离开都能回列表恢复
      sessionStorage.setItem(
        'composed-pending',
        JSON.stringify({
          payload,
          meta: {
            subjectLabel: SUBJECT_LABELS[subject as keyof typeof SUBJECT_LABELS] ?? subject,
            total: Math.max(1, useSlots ? rowsCount(defs) : sel.length * perTopic + extraRandom),
            score: useSlots ? rowsTotal(defs) : null,
            sourceLabel: focusOn ? '围绕我的薄弱点' : '随机抽真题',
          },
        })
      )
      sessionStorage.setItem(
        'composed-form-state',
        JSON.stringify({
          form: { subject, rows, title, note, sourceMode, picks, extraTopics, perTopic, extraRandom, fillTb, fillAi, targetScore, appliedSlugs, tplExamType },
          error: null,
        })
      )
      setSubmitting(null)
      router.push('/papers/composed/generating')
      return
    }
    setSubmitting({ mode: 'pool', total: Math.max(1, useSlots ? rowsCount(defs) : sel.length * perTopic + extraRandom) })
    try {
      const res = await fetchJson<{
        id: string
        shortages: Array<{ kind: string; score: number; requested: number; filled: number }>
        filledInline?: { textbook: number; aiVariant: number }
      }>('/api/papers/composed', { method: 'POST', json: payload, timeoutMs: aiFillAll ? 300_000 : 30_000 })
      void qc.invalidateQueries({ queryKey: queryKeys.papers.composedList() })
      const shortageNote = (res.shortages ?? [])
        .map((s) =>
          s.score === 0
            ? `${s.kind}：匹配到 ${s.filled}/${s.requested} 道`
            : `${KIND_LABEL[s.kind as SlotRow['kind']] ?? s.kind}${s.score}分 缺 ${s.requested - s.filled} 道`
        )
        .join('；')
      const inlineCount = (res.filledInline?.textbook ?? 0) + (res.filledInline?.aiVariant ?? 0)
      const inlineNote = inlineCount > 0 ? `${shortageNote ? '；' : ''}AI 拟题补齐 ${inlineCount} 道（卷面已标注来源）` : ''
      if (shortageNote || inlineNote) toast.success(`组好了（${shortageNote}${inlineNote}）`, { title: '拟卷' })
      router.push(`/papers/composed/${res.id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '组卷失败'
      if (msg === 'no_pool') {
        setFormError(defaultModelId ? '该科真题池还没有带官方答案的题——可改用 AI 出题，或换个学科 / 先回聊天录入试卷' : '该科真题池还没有带官方答案的题，换个学科或先回聊天录入试卷')
        setNoPoolHit(true)
      } else {
        setFormError(msg)
      }
      setSubmitting(null)
    }
  }, [rows, subject, title, note, submitting, qc, router, sourceMode, picks, appliedSlugs, perTopic, extraRandom, fillTb, fillAi, defaultModelId])

  /** no_pool 兜底入口:警告一次(整卷 AI 拟题非官方、四路资源依据、耗时较长)后带 aiFillAll 重试;
   *  警示记号走 sessionStorage——同一浏览器会话确认过就不再弹第二次,进新会话才会再提醒 */
  const retryWithAi = useCallback(async () => {
    if (window.sessionStorage.getItem('composed-ai-warned') !== '1') {
      const ok = await confirmDialog({
        title: '改用 AI 出题组卷',
        message:
          '该科真题池暂无带官方答案的题，整卷题目与答案将由 AI 生成（非官方）。' +
          '出题会依据你的课本库、错题本薄弱点、真题库风格与联网检索，卷面每道 AI 题都会标注来源；' +
          '整卷生成约需 1-3 分钟。',
        okText: 'AI 出题组卷',
      })
      if (!ok) return
      window.sessionStorage.setItem('composed-ai-warned', '1')
    }
    void submitCompose({ aiFillAll: true })
  }, [submitCompose])

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

          {/* 组卷表单(重做版·方案B 双栏工作台:左=卷子结构,右=白底设置栏;目标总分+AI备注;行话清零) */}
          {formOpen && (
            <div ref={formCardRef} className="glass-blur mb-4 scroll-mt-[60px] overflow-hidden rounded-[14px] border border-line/60 bg-surface-glass">
              <div className="flex items-center gap-2 border-b border-line/60 px-4 py-3">
                <span className="text-[14px] font-bold text-content-primary">组一张卷</span>
                <span className="text-[10.5px] text-content-muted">真题重组</span>
                <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold text-accent">
                  {submitting ? (
                    <>
                      <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                      {submitting.mode === 'ai' ? '正在组卷 · 约需 1-3 分钟' : '正在组卷 · 约几十秒'}
                    </>
                  ) : (
                    <>
                      {SUBJECT_LABELS[subject as keyof typeof SUBJECT_LABELS] ?? subject} · {rowsCount(rows)} 题 · {rowsTotal(rows)} 分
                    </>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  disabled={!!submitting}
                  className="rounded-md p-1 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary disabled:pointer-events-none disabled:opacity-40"
                  aria-label="收起表单"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {submitting ? (
                <ComposeGenerating mode={submitting.mode} total={submitting.total} />
              ) : (
              <div className="flex flex-col md:flex-row md:items-stretch">
                {/* 左栏:卷子结构 */}
                <div className="flex min-w-0 flex-col gap-2 p-4 md:flex-[1.45_1_0%]">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[12.5px] font-bold text-content-primary">卷子结构</span>
                    <span className="text-[10.5px] text-content-muted">每行一个大题；真题不够有多少放多少</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-content-muted">套用真题结构</span>
                    <button
                      type="button"
                      onClick={() => {
                        setTplExamType(null)
                        setAppliedSlugs([])
                        resetToCustom()
                      }}
                      className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
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
                          className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${
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
                    <div className="flex flex-wrap gap-1.5">
                      {tplOfType.length === 0 && <span className="text-[11px] text-content-muted">该卷种下没有可套用的卷</span>}
                      {tplOfType.map((t) => (
                        <button
                          key={t.slug}
                          type="button"
                          onClick={() => toggleTemplate(t)}
                          className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors ${
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
                    <div className="text-[11px] text-accent">
                      已套用 {appliedSlugs.length} 张真题卷的结构（行可手改{sourceMode === 'focus' ? '；真题会优先匹配你勾的考点' : ''}）
                    </div>
                  )}
                  {sourceMode === 'focus' && appliedSlugs.length === 0 ? (
                    <div className="rounded-[10px] border border-accent/30 bg-accent-soft px-3 py-2 text-[11.5px] leading-relaxed text-content-secondary">
                      这卷不套固定结构：<b className="text-accent">按你勾的考点自动分组</b>（大题名 = 考点名，每考点 {perTopic} 道
                      {extraRandom > 0 ? `，卷尾加 ${extraRandom} 道巩固题` : ''}）。想固定结构就先点上面的「套用真题结构」。
                    </div>
                  ) : (
                    <>
                      <OutlineTable rows={rows} onChange={setRows} />
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                        <span className="text-[12.5px] text-content-secondary">
                          合计 <b className="tabular-nums text-content-primary">{rowsCount(rows)}</b> 题 ·{' '}
                          <b className="tabular-nums text-content-primary">{rowsTotal(rows)}</b> 分
                        </span>
                        <div className="ml-auto flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-content-muted">目标总分</span>
                          <input
                            type="number"
                            min={10}
                            max={720}
                            value={targetScore ?? ''}
                            onChange={(e) => setTargetScore(Number(e.target.value) || null)}
                            placeholder="如 100"
                            className="h-7 w-14 rounded-lg border border-line bg-surface px-1.5 text-center text-[12px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent"
                            aria-label="目标总分"
                          />
                          {[100, 120, 150].map((p) => (
                            <button
                              key={p}
                              type="button"
                              onClick={() => {
                                setTargetScore(p)
                                setRows((prev) => balanceRows(prev, p))
                              }}
                              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                                targetScore === p
                                  ? 'border-accent bg-accent-soft font-semibold text-accent'
                                  : 'border-line bg-surface text-content-secondary hover:text-accent'
                              }`}
                            >
                              {p}
                            </button>
                          ))}
                          {targetScore != null && rowsTotal(rows) - targetScore !== 0 && (
                            <>
                              <span className="text-[11px] text-red-500">差 {Math.abs(rowsTotal(rows) - targetScore)} 分</span>
                              <button
                                type="button"
                                onClick={() => setRows((prev) => balanceRows(prev, targetScore))}
                                className="rounded-full border border-accent bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold text-accent transition-opacity hover:opacity-90"
                              >
                                按分值配平
                              </button>
                            </>
                          )}
                          {targetScore != null && rowsTotal(rows) - targetScore === 0 && (
                            <span className="text-[11px] font-semibold text-accent">已配平 {targetScore} 分</span>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* 右栏:白底设置栏(学科/来源/备注/卷名/提交) */}
                <div className="flex min-w-0 flex-col gap-3 border-t border-line/60 bg-surface p-4 md:flex-1 md:border-l md:border-t-0">
                  <div>
                    <div className="mb-1.5 text-[11.5px] font-semibold text-content-secondary">学科</div>
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
                          className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
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
                  <div>
                    <div className="mb-1.5 text-[11.5px] font-semibold text-content-secondary">题目来源</div>
                    <div className="inline-flex w-fit rounded-[10px] border border-line bg-surface-subtle p-0.5">
                      <button
                        type="button"
                        onClick={() => setSourceMode('random')}
                        className={`rounded-lg px-3 py-1 text-[12px] transition-colors ${
                          sourceMode === 'random'
                            ? 'bg-surface font-semibold text-content-primary'
                            : 'text-content-secondary hover:text-content-primary'
                        }`}
                      >
                        随机抽真题
                      </button>
                      <button
                        type="button"
                        onClick={() => setSourceMode('focus')}
                        className={`rounded-lg px-3 py-1 text-[12px] transition-colors ${
                          sourceMode === 'focus'
                            ? 'bg-surface font-semibold text-content-primary'
                            : 'text-content-secondary hover:text-content-primary'
                        }`}
                      >
                        围绕我的薄弱点
                      </button>
                    </div>
                    {sourceMode === 'focus' && (
                      <div className="mt-2 rounded-[10px] border border-line bg-surface-subtle p-2.5">
                        <div className="text-[11px] text-content-muted">
                          你的薄弱考点（来自错题本与学习记录，按掌握度排；勾选要复习的）
                        </div>
                        {weakQuery.isLoading && <div className="mt-1.5 text-[11px] text-content-muted">读取学习记录中…</div>}
                        {!weakQuery.isLoading && allPoints.length === 0 && (
                          <div className="mt-1.5 text-[11px] leading-relaxed text-content-muted">
                            错题本里还没有带考点的错题——先在学习台学几道题，或在下面手动输入考点
                          </div>
                        )}
                        {allPoints.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {allPoints.map((w) => (
                              <button
                                key={w.label}
                                type="button"
                                onClick={() => togglePick(w.label)}
                                className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
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
                        <div className="mt-2 flex gap-1.5">
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
                            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent"
                            aria-label="手动加考点"
                          />
                          <button
                            type="button"
                            onClick={addManualTopic}
                            className="h-8 shrink-0 rounded-lg border border-line px-3 text-[12px] text-content-secondary transition-colors hover:text-content-primary"
                          >
                            加
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <span className="flex items-center gap-1.5 text-[11px] text-content-muted">
                            每个考点取
                            <input
                              type="number"
                              min={1}
                              max={10}
                              value={perTopic}
                              onChange={(e) => setPerTopic(Math.min(10, Math.max(1, Math.round(Number(e.target.value) || 2))))}
                              className="h-7 w-11 rounded-lg border border-line bg-surface px-1.5 text-center text-[12px] text-content-primary outline-none focus:border-accent"
                              aria-label="每个考点题数"
                            />
                            道
                          </span>
                          <span className="flex items-center gap-1.5 text-[11px] text-content-muted">
                            另加随机巩固
                            <input
                              type="number"
                              min={0}
                              max={20}
                              value={extraRandom}
                              onChange={(e) => setExtraRandom(Math.min(20, Math.max(0, Math.round(Number(e.target.value) || 0))))}
                              className="h-7 w-11 rounded-lg border border-line bg-surface px-1.5 text-center text-[12px] text-content-primary outline-none focus:border-accent"
                              aria-label="随机巩固题数"
                            />
                            道（放卷尾）
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                          <span className="text-[11px] text-content-muted">真题不够时补：</span>
                          <button
                            type="button"
                            onClick={() => setFillTb((v) => !v)}
                            className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors ${fillTb ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-surface text-content-secondary hover:text-content-primary'}`}
                          >
                            课本拟题
                          </button>
                          <button
                            type="button"
                            onClick={() => setFillAi((v) => !v)}
                            className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors ${fillAi ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-surface text-content-secondary hover:text-content-primary'}`}
                          >
                            AI 举一反三
                          </button>
                          <span className="text-[10.5px] text-content-muted">补的题在卷面标注来源</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="mb-1 text-[11.5px] font-semibold text-content-secondary">
                      给 AI 的备注<span className="ml-1 font-normal text-content-muted">可选 · 真题不够 AI 补题时照办</span>
                    </div>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value.slice(0, 200))}
                      rows={2}
                      placeholder="例：挑考试里出现最多的题型；文言文部分多来两道"
                      className="w-full resize-none rounded-[10px] border border-line bg-surface px-3 py-2 text-[12.5px] leading-relaxed text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent"
                      aria-label="给AI的备注"
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-[11.5px] font-semibold text-content-secondary">
                      卷名<span className="ml-1 font-normal text-content-muted">不填自动起</span>
                    </div>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value.slice(0, 60))}
                      placeholder="如：语言运用专项 · 周五"
                      className="h-9 w-full rounded-[10px] border border-line bg-surface px-3 text-[12.5px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent"
                      aria-label="卷名"
                    />
                  </div>
                  {formError && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-500">{formError}</div>
                  )}
                  {noPoolHit && !submitting && defaultModelId && (
                    <button
                      type="button"
                      onClick={() => void retryWithAi()}
                      className="flex h-9 w-full items-center justify-center gap-1.5 rounded-full border border-accent/60 bg-accent-soft text-[12px] font-semibold text-accent transition-opacity hover:opacity-90"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      改用 AI 出题组这张卷（依据课本 / 错题本 / 真题 / 联网）
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void submitCompose()}
                    disabled={!!submitting}
                    className="mt-auto flex h-9 w-full items-center justify-center gap-1.5 rounded-full bg-accent text-[12.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {sourceMode === 'focus' ? '组复习卷' : '组卷'}
                  </button>
                  <p className="text-[10.5px] leading-relaxed text-content-muted">
                    题目与答案全部出自真题库；某档真题不够有多少放多少，缺口组好后如实提示。组好直接进卷面页（可打印 / 换题 / 标记「这题有误」）。
                  </p>
                </div>
              </div>
              )}
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
