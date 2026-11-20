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
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileText, FileUp, Maximize2, Plus, Sparkles, X } from 'lucide-react'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { confirmDialog } from '@/components/ui/ConfirmDialog'
import { fetchJson } from '@/lib/query/fetcher'
import { providersModelsQuery, isModelAvailable, providerKeysStatusQuery } from '@/lib/query/providers'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import { SUBJECT_LABELS, SUBJECT_COLORS, subjectTint } from '@/lib/study/subject-labels'
import ComposeGenerating from '@/components/papers/ComposeGenerating'
import { PrintFootprintCard } from '@/components/papers/PrintFootprintCard'
import { dateRel, type ComposedPaperListItem } from '@/components/study/StudyHome'
import { slotHintsFor } from '@/lib/papers/slot-hints'
import OutlinePreview, { type DrySlot } from '@/components/papers/OutlinePreview'

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
function OutlineTable({ rows, onChange, subject }: { rows: SlotRow[]; onChange: (rows: SlotRow[]) => void; subject: string }) {
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
          {rows.map((r, i) => {
            // 槽位考点提示:真题逐题统计的常考规律(详见 lib/papers/slot-hints),连续同考点合并成题号区间
            const startNo = rows.slice(0, i).reduce((a, x) => a + x.count, 0) + 1
            const hints = r.section?.trim() ? slotHintsFor(subject, r.section, r.kind, r.score) : []
            const ranges: Array<{ from: number; to: number; label: string }> = []
            // 单提示 = 该行所有题同考点(引擎同口径);多提示按题序对号,超出题数截断
            const hintSeq = hints.length === 1 ? Array.from({ length: r.count }, () => hints[0]) : hints.slice(0, r.count)
            hintSeq.forEach((h, k) => {
              const last = ranges[ranges.length - 1]
              if (last && last.label === h.label) last.to = startNo + k
              else ranges.push({ from: startNo + k, to: startNo + k, label: h.label })
            })
            return (
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
                max={40}
                value={r.count}
                onChange={(e) => patch(i, { count: Math.min(40, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
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
              {ranges.length > 0 && (
                <div className="col-span-full -mt-0.5 border-t border-dashed border-line/60 pt-1 text-[10.5px] leading-relaxed text-content-muted">
                  {ranges.map((g, k) => (
                    <span key={k}>
                      {k > 0 && <span className="mx-1.5 opacity-60">·</span>}
                      <b className="tabular-nums font-semibold text-content-secondary">
                        {g.from === g.to ? g.from : `${g.from}-${g.to}`}
                      </b>{' '}
                      <span className="text-content-secondary">{g.label}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            )
          })}
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

/** 拟卷列表前端分页页长(方案A「数字页码」挑稿;API 全量不动,量级上千再谈接口分页) */
const COMPOSED_PAGE_SIZE = 15

function ComposedListContent() {
  const router = useRouter()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.papers.composedList(),
    queryFn: ({ signal }) => fetchJson<{ papers: ComposedPaperListItem[] }>('/api/papers/composed', { signal }),
    staleTime: 30_000,
  })
  const papers = data?.papers ?? []
  // ── 列表分页(2026-11-16 方案A「数字页码」,原型 design/preview-composed-pager.html) ──
  const [pageRaw, setPage] = useState(0)
  const pageCount = Math.ceil(papers.length / COMPOSED_PAGE_SIZE)
  const page = Math.min(pageRaw, Math.max(0, pageCount - 1))
  // 新卷落顶/列表量变化时回第 1 页
  useEffect(() => { setPage(0) }, [papers.length])
  const listRef = useRef<HTMLDivElement>(null)
  const gotoPage = (p: number) => {
    setPage(p)
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // 页码收缩:>7 页时只露 1 … 邻页 … 尾(-1/-2 哨兵 = 省略号)
  const pageItems = useMemo(() => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i)
    const items: number[] = [0]
    if (page > 2) items.push(-1)
    for (let i = Math.max(1, page - 1); i <= Math.min(pageCount - 2, page + 1); i++) items.push(i)
    if (page < pageCount - 3) items.push(-2)
    items.push(pageCount - 1)
    return items
  }, [page, pageCount])
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
  // 学科步进器的下拉全览开关(点中间当前科展开)
  const [subjectDdOpen, setSubjectDdOpen] = useState(false)
  // 学科下拉:点面板外关闭
  const settingsPanelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!subjectDdOpen) return
    const onDoc = (e: PointerEvent) => {
      if (settingsPanelRef.current && !settingsPanelRef.current.contains(e.target as Node)) setSubjectDdOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [subjectDdOpen])
  // 全屏结构工作台:左编辑右试装预览(Esc 返回);试装=dry-run 防抖拉真题,换一批=换 seed 重调
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [wbSeed, setWbSeed] = useState(0)
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
  // 卷名列表折叠:默认收起(已选 chip 常显),≤4 张的卷种自动平铺
  const [tplListOpen, setTplListOpen] = useState(false)
  const [appliedSlugs, setAppliedSlugs] = useState<string[]>([])
  // 真卷限定:只用所套用的那一张卷的题(同卷仿真模拟);仅套用单张卷时可勾
  const [restrictPaper, setRestrictPaper] = useState(false)
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
  // 真卷限定生效 slug:仅套用单张卷时才有意义
  const restrictSlug = restrictPaper && appliedSlugs.length === 1 ? appliedSlugs[0] : null
  const tplQuery = useQuery({
    queryKey: ['papers', 'base-structures', subject, restrictSlug],
    queryFn: ({ signal }) =>
      fetchJson<{ templates: Array<{ slug: string; title: string; examType: string | null; year: string | null; questionCount: number; groups: Array<{ section: string | null; kind: string; score: number; count: number }> }>; poolStats: Array<{ kind: string; score: number; count: number }> }>(
        `/api/papers/composed/base-structures?subject=${subject}${restrictSlug ? `&restrictSlug=${encodeURIComponent(restrictSlug)}` : ''}`,
        { signal }
      ),
    enabled: formOpen,
    staleTime: 60_000,
  })
  const templates = tplQuery.data?.templates ?? []
  const poolStats = tplQuery.data?.poolStats
  const examTypes = Array.from(new Set(templates.map((t) => t.examType ?? '未标注')))
  const tplOfType = tplExamType ? templates.filter((t) => (t.examType ?? '未标注') === tplExamType) : []

  // 组前预检覆盖率:按 (题型,分值) 桶汇总「需要 vs 真题池有」,缺口在随机模式=有多少放多少(如实缺题)
  const coverage = useMemo(() => {
    if (!poolStats) return null
    const haveMap = new Map<string, number>(poolStats.map((p) => [`${p.kind}:${p.score}`, p.count] as const))
    const needMap = new Map<string, { need: number; label: string }>()
    for (const r of rows) {
      const k = `${r.kind}:${r.score}`
      const cur = needMap.get(k) ?? { need: 0, label: `${r.kind === 'choice' ? '选择' : '解答'}·${r.score}分` }
      cur.need += r.count
      needMap.set(k, cur)
    }
    let total = 0
    let have = 0
    const shorts: Array<{ label: string; diff: number }> = []
    for (const [k, { need, label }] of Array.from(needMap)) {
      const h = haveMap.get(k) ?? 0
      total += need
      have += Math.min(h, need)
      if (h < need) shorts.push({ label, diff: need - h })
    }
    return { total, have, shorts, allMissing: have === 0 }
  }, [rows, poolStats])

  // ── 全屏结构工作台:试装 dry-run(防抖 350ms;换一批=换 seed 重调;Esc 关闭) ──
  const wbDefs = useMemo(
    () => JSON.stringify({ subject, slotDefs: rows, restrictPaperSlug: restrictSlug, focusTopics: sourceMode === 'focus' ? picks : [] }),
    [subject, rows, restrictSlug, sourceMode, picks]
  )
  const [wbDefsKey, setWbDefsKey] = useState('')
  useEffect(() => {
    if (!workbenchOpen) return
    const t = setTimeout(() => setWbDefsKey(wbDefs), 350)
    return () => clearTimeout(t)
  }, [wbDefs, workbenchOpen])
  const wbQuery = useQuery({
    queryKey: ['papers', 'dry-run', wbDefsKey, wbSeed],
    queryFn: ({ signal }) =>
      fetchJson<{ slots: DrySlot[] }>('/api/papers/composed/dry-run', { method: 'POST', json: JSON.parse(wbDefsKey), signal }),
    enabled: workbenchOpen && !!wbDefsKey,
    placeholderData: (prev) => prev,
  })
  useEffect(() => {
    if (!workbenchOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWorkbenchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workbenchOpen])

  /** 多选模板:结构取并集——同(归一大题名,题型,分值)取题数最大值,不同组按首现顺序合并,≤12 行 */
  const applyTemplateSet = (selected: Array<(typeof templates)[number]>) => {
    const map = new Map<
      string,
      { section: string; kind: 'choice' | 'answer'; score: number; count: number; order: number }
    >()
    selected.forEach((t, ti) => {
      t.groups.forEach((g, gi) => {
        // 大题名跨卷有「解答与证明题/解答题与证明题」「单项选择题/选择题」级差异,不归一会让并集翻倍:
        // 剥编号/括号/空白与「单项」前缀,按「与」拆词去掉尾部「题」,排序后拼接作键
        const tokens = (g.section ?? '')
          .replace(/[（）()\[\]\s\d.、．:：一二三四五六七八九十]/g, '')
          .replace(/^单项/, '')
          .split('与')
          .map((w) => w.replace(/题+$/g, ''))
          .filter(Boolean)
          .sort()
        const key = `${tokens.join('+')}|${g.kind}|${g.score}`
        const row = { section: g.section ?? '', kind: (g.kind === 'answer' ? 'answer' : 'choice') as 'choice' | 'answer', score: Math.min(60, Math.max(1, g.score)), count: Math.min(40, Math.max(1, g.count)), order: ti * 100 + gi }
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
  // 考场丢分考点(第二信号源):学校考试勾错题聚合,与错题本薄弱点合并进考点清单;
  // source=both 表示错题本也丢(真漏洞),exam=仅考场丢(考场失手)。
  const examLossQuery = useQuery({
    queryKey: queryKeys.examRecords.analysis(),
    queryFn: ({ signal }) =>
      fetchJson<{ analysis: { topicLossAgg: Array<{ topic: string; loss: number; source: 'both' | 'exam' }> } }>(
        `/api/exam-records/analysis${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`,
        { signal }
      ),
    enabled: formOpen && sourceMode === 'focus',
    staleTime: 60_000,
  })
  const examLossPoints = (examLossQuery.data?.analysis.topicLossAgg ?? [])
    .filter((t) => t.topic.trim().length >= 2)
    .slice(0, 8)
  const allPoints = [
    ...weakPoints.map((w) => ({
      label: w.label,
      mastery: w.mastery as number | null,
      lossTag: examLossPoints.some((e) => e.topic === w.label) ? '错题本+考场' : null,
    })),
    ...examLossPoints
      .filter((e) => !weakPoints.some((w) => w.label === e.topic))
      .map((e) => ({
        label: e.topic,
        mastery: null as number | null,
        lossTag: e.source === 'both' ? ('错题本+考场' as const) : ('考场丢分' as const),
      })),
    ...extraTopics
      .filter((t) => !weakPoints.some((w) => w.label === t))
      .map((t) => ({ label: t, mastery: null as number | null, lossTag: null as string | null })),
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

  // 学习台「去组一张卷」深链:带 ?compose=1 进来时自动展开组卷表单(与「＋ 组一张卷」同效);
  // 成绩分析「专项 ›」深链:?compose=1&focusTopic=<考点> 自动进针对我复习并勾上该考点
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('compose') === '1') setFormOpen(true)
    const ft = params.get('focusTopic')
    if (ft) {
      setFormOpen(true)
      setSourceMode('focus')
      setExtraTopics((prev) => (prev.includes(ft) ? prev : [...prev, ft]))
      setPicks((prev) => (prev.includes(ft) ? prev : [...prev, ft]))
      weakInitedRef.current = true
    }
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
    // 真卷限定:勾了「只用这张卷的题」且套用单张卷时传 slug(引擎 loadPool 过滤)
    if (restrictSlug) payload.restrictPaperSlug = restrictSlug
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
        avoidedRecent?: number
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
      const recentNote = res.avoidedRecent ? `${shortageNote || inlineNote ? '；' : ''}已避开最近卷里的旧题 ${res.avoidedRecent} 道` : ''
      if (shortageNote || inlineNote || recentNote) toast.success(`组好了（${shortageNote}${inlineNote}${recentNote}）`, { title: '拟卷' })
      // 缺口在卷面页留一条可见提示(组前「缺口如实提示」的兑现):toast 一闪而过,
      // 卷面页按 id 读这条 sessionStorage 渲染可关闭横幅;AI/课本已补齐时不再告警。
      const missingCount = (res.shortages ?? []).reduce((n, s) => n + Math.max(0, s.requested - s.filled), 0)
      const missingScore = (res.shortages ?? []).reduce(
        (n, s) => n + (s.score > 0 ? s.score * Math.max(0, s.requested - s.filled) : 0),
        0
      )
      if (missingCount > 0 && inlineCount === 0) {
        sessionStorage.setItem(
          `composed-gap:${res.id}`,
          JSON.stringify({ missing: missingCount, score: missingScore })
        )
      }
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
  }, [rows, subject, title, note, submitting, qc, router, sourceMode, picks, appliedSlugs, perTopic, extraRandom, fillTb, fillAi, defaultModelId, restrictSlug])

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
          {/* 打印足迹卡(design/preview-print-center.html 方案A,2026-11-18 挑稿定案) */}
          <PrintFootprintCard />
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
              onClick={() => router.push('/papers/import')}
              className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-3 text-[11.5px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
            >
              <FileUp className="h-3.5 w-3.5" />
              PDF 录题
            </button>
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
                    <button
                      type="button"
                      onClick={() => setWorkbenchOpen(true)}
                      className="ml-auto flex items-center gap-1 self-center rounded-md border border-line bg-surface px-2 py-0.5 text-[10.5px] text-content-secondary transition-colors hover:text-content-primary"
                      title="全屏结构工作台（左编辑右试装预览）"
                    >
                      <Maximize2 className="h-3 w-3" /> 工作台
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-content-muted">照哪张真题卷的结构</span>
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
                          title={rep ? `套用这张卷的结构：${rep.title}（${rep.questionCount} 题，只搬大题格式不搬题）` : undefined}
                        >
                          {et}
                        </button>
                      )
                    })}
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
                  </div>
                  {tplExamType && (
                    // 卷名多时折叠:收起=已选 chip +「展开 N 张卷名」(已选仍可反选);≤4 张直接平铺
                    (() => {
                      const tplChip = (t: (typeof templates)[number]) => (
                        <button
                          key={t.slug}
                          type="button"
                          onClick={() => toggleTemplate(t)}
                          className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors ${
                            appliedSlugs.includes(t.slug)
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-line bg-surface text-content-secondary hover:text-content-primary'
                          }`}
                          title={`套用这张卷的结构（只搬大题格式不搬题；可多选，同大题取题数最多）`}
                        >
                          {t.title}
                          {t.year ? ` ${t.year}` : ''}
                        </button>
                      )
                      const collapseBtn = (
                        <button
                          type="button"
                          onClick={() => setTplListOpen(false)}
                          aria-expanded={true}
                          className="flex items-center gap-0.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11.5px] text-content-secondary transition-colors hover:text-content-primary"
                        >
                          <ChevronUp className="h-3 w-3" /> 收起
                        </button>
                      )
                      if (tplListOpen || tplOfType.length <= 4) {
                        return (
                          <div className="flex flex-wrap gap-1.5">
                            {tplOfType.length === 0 && <span className="text-[11px] text-content-muted">该卷种下没有可套用的卷</span>}
                            {tplOfType.map(tplChip)}
                            {tplOfType.length > 4 && collapseBtn}
                          </div>
                        )
                      }
                      return (
                        <div className="flex flex-wrap gap-1.5">
                          {tplOfType.filter((t) => appliedSlugs.includes(t.slug)).map(tplChip)}
                          <button
                            type="button"
                            onClick={() => setTplListOpen(true)}
                            aria-expanded={false}
                            className="flex items-center gap-0.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11.5px] text-content-secondary transition-colors hover:text-content-primary"
                          >
                            <ChevronDown className="h-3 w-3" /> 展开 {tplOfType.length} 张卷名
                          </button>
                        </div>
                      )
                    })()
                  )}
                  {appliedSlugs.length > 0 && (
                    <div className="text-[11px] text-accent">
                      已套用 {appliedSlugs.length} 张卷的结构——只搬格式，题目组卷时从真题池另抽（行可手改{sourceMode === 'focus' ? '；真题会优先匹配你勾的考点' : ''}）
                    </div>
                  )}
                  {sourceMode === 'focus' && appliedSlugs.length === 0 ? (
                    <div className="rounded-[10px] border border-accent/30 bg-accent-soft px-3 py-2 text-[11.5px] leading-relaxed text-content-secondary">
                      这卷不套固定结构：<b className="text-accent">按你勾的考点自动分组</b>（大题名 = 考点名，每考点 {perTopic} 道
                      {extraRandom > 0 ? `，卷尾加 ${extraRandom} 道巩固题` : ''}）。想固定结构就先点上面的「照哪张真题卷的结构」。
                    </div>
                  ) : (
                    <>
                      <OutlineTable rows={rows} onChange={setRows} subject={subject} />
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
                <div
                  ref={settingsPanelRef}
                  className="flex min-w-0 flex-col gap-3 border-t border-line/60 bg-surface p-4 md:flex-1 md:border-l md:border-t-0"
                >
                  <div>
                    <div className="mb-1.5 text-[11.5px] font-semibold text-content-secondary">学科</div>
                    {/* 步进器+下拉(原型 design/preview-subject-picker.html 方案D+下拉总览,用户定稿):
                        ‹ › 循环换科;点中间当前科展开十科全览(色点+打勾),找不到的科一击直达 */}
                    {(() => {
                      const keys = Object.keys(SUBJECT_LABELS) as Array<keyof typeof SUBJECT_LABELS>
                      const idx = keys.indexOf(subject as keyof typeof SUBJECT_LABELS)
                      const pickSubject = (key: string) => {
                        setSubject(key)
                        setTplExamType(null)
                        setAppliedSlugs([])
                        setSubjectDdOpen(false)
                      }
                      const cycle = (d: number) => pickSubject(keys[(idx + d + keys.length) % keys.length])
                      const curColor = SUBJECT_COLORS[subject as keyof typeof SUBJECT_COLORS] ?? '#98989f'
                      return (
                        <div className="relative">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => cycle(-1)}
                              aria-label="上一学科"
                              className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full border border-line bg-surface text-content-secondary transition-colors hover:text-content-primary"
                              style={{ color: subjectDdOpen ? curColor : undefined, borderColor: subjectDdOpen ? subjectTint(curColor, 0.45) : undefined }}
                            >
                              <ChevronLeft className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setSubjectDdOpen(!subjectDdOpen)}
                              aria-haspopup="listbox"
                              aria-expanded={subjectDdOpen}
                              aria-label={`当前学科 ${SUBJECT_LABELS[subject as keyof typeof SUBJECT_LABELS]}，点击展开全部学科`}
                              className="relative flex min-w-[76px] items-center justify-center rounded-full border px-3.5 py-1 text-[12.5px] font-semibold transition-colors"
                              style={{ borderColor: subjectTint(curColor, 0.55), background: subjectTint(curColor, 0.12), color: curColor }}
                            >
                              {SUBJECT_LABELS[subject as keyof typeof SUBJECT_LABELS]}
                              <ChevronDown className={`absolute right-2.5 h-3 w-3 opacity-80 transition-transform ${subjectDdOpen ? 'rotate-180' : ''}`} />
                            </button>
                            <button
                              type="button"
                              onClick={() => cycle(1)}
                              aria-label="下一学科"
                              className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full border border-line bg-surface text-content-secondary transition-colors hover:text-content-primary"
                              style={{ color: subjectDdOpen ? curColor : undefined, borderColor: subjectDdOpen ? subjectTint(curColor, 0.45) : undefined }}
                            >
                              <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                            <span className="text-[10.5px] tabular-nums text-content-muted">{idx + 1} / {keys.length}</span>
                          </div>
                          {subjectDdOpen && (
                            <>
                              <div
                                role="listbox"
                                aria-label="全部学科"
                                className="absolute left-1/2 top-full z-30 mt-1.5 flex w-[136px] -translate-x-1/2 flex-col gap-px rounded-xl border border-line bg-surface p-1.5"
                                style={{ boxShadow: '0 8px 28px rgb(0 0 0 / 0.14)' }}
                              >
                                {keys.map((key) => (
                                  <button
                                    key={key}
                                    type="button"
                                    role="option"
                                    aria-selected={subject === key}
                                    onClick={() => pickSubject(key)}
                                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ${
                                      subject === key
                                        ? 'bg-accent-soft font-semibold text-content-primary'
                                        : 'text-content-secondary hover:bg-surface-subtle hover:text-content-primary'
                                    }`}
                                  >
                                    <i className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: SUBJECT_COLORS[key] }} />
                                    {SUBJECT_LABELS[key]}
                                    {subject === key && <span className="ml-auto text-[11px] text-accent">✓</span>}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )
                    })()}
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
                    {/* 组前预检覆盖率:随机模式下按桶显示真题够不够;缺口小标签化,全缺不逐条罗列 */}
                    {sourceMode === 'random' && coverage && coverage.total > 0 && (
                      <div className="mt-1.5 text-[11px] leading-relaxed text-content-muted">
                        真题覆盖 <b className="tabular-nums text-content-secondary">{coverage.have}/{coverage.total}</b>
                        {coverage.shorts.length === 0 ? (
                          <span className="ml-1 text-accent">✓ 全部有真题</span>
                        ) : coverage.allMissing ? (
                          <span className="ml-1 text-amber-600 dark:text-amber-400">· 该科真题池为空，整卷需 AI 兜底出题</span>
                        ) : (
                          <span className="ml-1 inline-flex flex-wrap items-center gap-1 align-middle">
                            {coverage.shorts.map((s) => (
                              <span key={s.label} className="rounded bg-amber-500/10 px-1.5 py-px text-[10.5px] text-amber-700 dark:text-amber-400">
                                {s.label} 差 {s.diff}
                              </span>
                            ))}
                            <span>→ 有多少放多少</span>
                          </span>
                        )}
                      </div>
                    )}
                    {/* 真卷限定:套用单张卷时出现,勾上=只用这张卷的题(同卷仿真) */}
                    {appliedSlugs.length === 1 && (
                      <label className="mt-1.5 flex w-fit cursor-pointer items-center gap-1.5 text-[11.5px] text-content-secondary">
                        <input
                          type="checkbox"
                          checked={restrictPaper}
                          onChange={(e) => setRestrictPaper(e.target.checked)}
                          className="h-3.5 w-3.5"
                          style={{ accentColor: 'var(--accent)' }}
                        />
                        只用这张卷的题（同卷仿真模拟）
                      </label>
                    )}
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
                                {w.lossTag && (
                                  <span
                                    className={`ml-1 rounded px-1 py-px text-[9.5px] font-medium ${
                                      w.lossTag === '错题本+考场' ? 'bg-danger-soft text-danger' : 'bg-surface-subtle text-content-secondary'
                                    }`}
                                  >
                                    {w.lossTag}
                                  </span>
                                )}
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
                    题目与答案全部出自真题库；某档真题不够有多少放多少，缺口组好后如实提示；随机抽题自动避开最近 3 张组过的卷里用过的题。组好直接进卷面页（可打印 / 换题 / 标记「这题有误」）。
                  </p>
                </div>
              </div>
              )}
            </div>
          )}

          {workbenchOpen &&
            createPortal(
              <div className="fixed inset-0 z-[70] flex flex-col bg-surface-muted">
                <div className="flex items-center gap-2.5 border-b border-line bg-surface px-4 py-2.5">
                  <b className="text-[13px]">组一张卷 · 结构工作台</b>
                  <span className="text-[10.5px] text-content-muted">Esc 返回 · 预览实时更新 · 试装纯真题不参与 AI</span>
                  <button type="button" onClick={() => setWorkbenchOpen(false)} aria-label="关闭工作台" className="ml-auto rounded-md p-1 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                  <div className="flex w-full flex-col gap-3 overflow-y-auto border-b border-line/60 bg-surface p-4 md:w-[44%] md:min-w-[360px] md:border-b-0 md:border-r">
                    <div>
                      <div className="mb-1.5 text-[11.5px] font-semibold text-content-secondary">照哪张真题卷的结构</div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {examTypes.map((et) => {
                          const rep = templates.filter((t) => (t.examType ?? '未标注') === et).sort((a, b) => b.questionCount - a.questionCount)[0]
                          return (
                            <button
                              key={et}
                              type="button"
                              onClick={() => { setTplExamType(et); if (rep) { setAppliedSlugs([rep.slug]); applyTemplateSet([rep]) } }}
                              className={'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ' + (tplExamType === et ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-surface text-content-secondary hover:text-content-primary')}
                              title={rep ? '套用：' + rep.title + '（' + rep.questionCount + ' 题）' : undefined}
                            >
                              {et}
                            </button>
                          )
                        })}
                        <button
                          type="button"
                          onClick={() => { setTplExamType(null); setAppliedSlugs([]) }}
                          className={'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ' + (!tplExamType ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-surface text-content-secondary hover:text-content-primary')}
                        >
                          自定义
                        </button>
                      </div>
                      {tplExamType && (
                        // 卷名多时折叠:收起=已选 chip 常显(可反选)+「展开 N 张卷名」;≤4 张直接平铺(与就地表单同款,共用 tplListOpen)
                        tplListOpen || tplOfType.length <= 4 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {tplOfType.length === 0 && <span className="text-[11px] text-content-muted">该卷种下没有可套用的卷</span>}
                            {tplOfType.map((t) => (
                              <button
                                key={t.slug}
                                type="button"
                                onClick={() => toggleTemplate(t)}
                                className={'rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors ' + (appliedSlugs.includes(t.slug) ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-content-secondary hover:text-content-primary')}
                                title="套用这张卷的结构（只搬大题格式不搬题；可多选，同大题取题数最多）"
                              >
                                {t.title}
                                {t.year ? ' ' + t.year : ''}
                              </button>
                            ))}
                            {tplOfType.length > 4 && (
                              <button
                                type="button"
                                onClick={() => setTplListOpen(false)}
                                aria-expanded={true}
                                className="flex items-center gap-0.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11.5px] text-content-secondary transition-colors hover:text-content-primary"
                              >
                                <ChevronUp className="h-3 w-3" /> 收起
                              </button>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {tplOfType.filter((t) => appliedSlugs.includes(t.slug)).map((t) => (
                              <button
                                key={t.slug}
                                type="button"
                                onClick={() => toggleTemplate(t)}
                                className={'rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors ' + (appliedSlugs.includes(t.slug) ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-content-secondary hover:text-content-primary')}
                                title="套用这张卷的结构（只搬大题格式不搬题；可多选，同大题取题数最多）"
                              >
                                {t.title}
                                {t.year ? ' ' + t.year : ''}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={() => setTplListOpen(true)}
                              aria-expanded={false}
                              className="flex items-center gap-0.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11.5px] text-content-secondary transition-colors hover:text-content-primary"
                            >
                              <ChevronDown className="h-3 w-3" /> 展开 {tplOfType.length} 张卷名
                            </button>
                          </div>
                        )
                      )}
                      {appliedSlugs.length > 0 && (
                        <div className="mt-1 text-[11px] text-accent">已套用 {appliedSlugs.length} 张卷的结构——只搬格式，题目组卷时从真题池另抽（行可手改）</div>
                      )}
                    </div>
                    <OutlineTable rows={rows} onChange={setRows} subject={subject} />
                    {coverage && coverage.total > 0 && (
                      <div className="text-[11px] leading-relaxed text-content-muted">
                        真题覆盖 <b className="tabular-nums text-content-secondary">{coverage.have}/{coverage.total}</b>
                        {coverage.shorts.length === 0 ? (
                          <span className="ml-1 text-accent">✓ 全部有真题</span>
                        ) : coverage.allMissing ? (
                          <span className="ml-1 text-amber-600 dark:text-amber-400">· 该科真题池为空，整卷需 AI 兜底出题</span>
                        ) : (
                          <span className="ml-1 inline-flex flex-wrap items-center gap-1 align-middle">
                            {coverage.shorts.map((s) => (
                              <span key={s.label} className="rounded bg-amber-500/10 px-1.5 py-px text-[10.5px] text-amber-700 dark:text-amber-400">{s.label} 差 {s.diff}</span>
                            ))}
                            <span>→ 有多少放多少</span>
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-[12.5px] text-content-secondary">
                      <span>合计 <b className="tabular-nums text-content-primary">{rowsCount(rows)}</b> 题 · <b className="tabular-nums text-content-primary">{rowsTotal(rows)}</b> 分</span>
                      <button
                        type="button"
                        onClick={() => setWbSeed((v) => v + 1)}
                        className="ml-auto rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11px] text-content-secondary transition-colors hover:text-content-primary"
                      >
                        ↻ 换一批试装
                      </button>
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 overflow-y-auto bg-surface-subtle p-5">
                    <OutlinePreview rows={rows} subject={subject} picks={wbQuery.data?.slots ?? []} loading={wbQuery.isFetching} paperTitle={title} />
                  </div>
                </div>
                <div className="flex items-center gap-3 border-t border-line bg-surface px-4 py-2.5">
                  <span className="text-[10.5px] leading-relaxed text-content-muted">试装 = 每槽从真题池按考点优先抽一道 · 不落库不参与 AI · 正式组卷同口径重抽</span>
                  <button
                    type="button"
                    onClick={() => { setWorkbenchOpen(false); void submitCompose() }}
                    disabled={!!submitting}
                    className="ml-auto flex h-9 flex-none items-center justify-center gap-1.5 rounded-full bg-accent px-7 text-[12.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    组卷
                  </button>
                </div>
              </div>,
              document.body
            )}

          {!isLoading && papers.length === 0 && !formOpen && (
            <div className="glass-blur rounded-[14px] border border-line/60 bg-surface-glass px-4 py-10 text-center">
              <p className="text-[13.5px] text-content-secondary">还没有拟卷</p>
              <p className="mt-1.5 text-xs leading-relaxed text-content-muted">
                点上方「＋ 组一张卷」就地组一张，或回聊天让 AI 帮你重组（如「按 2023 新课标Ⅰ卷重组一张数学卷」）。
              </p>
            </div>
          )}

          <div className="space-y-2.5" ref={listRef}>
            {papers.slice(page * COMPOSED_PAGE_SIZE, (page + 1) * COMPOSED_PAGE_SIZE).map((p) => (
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

          {/* 分页器(方案A 数字页码;≤1 页不渲染;当前页实底,前后 Chevrons 边界置灰) */}
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-1.5 pt-2">
              <button
                type="button"
                onClick={() => gotoPage(page - 1)}
                disabled={page === 0}
                aria-label="上一页"
                className="flex h-[34px] min-w-[34px] flex-none items-center justify-center rounded-[10px] border border-line/80 bg-surface px-2 text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-40 disabled:hover:border-line/80"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              {pageItems.map((n, i) =>
                n < 0 ? (
                  <span key={`ellipsis-${i}`} className="px-1 text-[12px] text-content-muted">…</span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    onClick={() => gotoPage(n)}
                    aria-label={`第 ${n + 1} 页`}
                    aria-current={n === page ? 'page' : undefined}
                    className={`flex h-[34px] min-w-[34px] flex-none items-center justify-center rounded-[10px] border px-2.5 text-[13px] tabular-nums transition-colors ${
                      n === page
                        ? 'border-accent bg-accent font-semibold text-accent-foreground'
                        : 'border-line/80 bg-surface text-content-secondary hover:border-line-strong hover:text-content-primary'
                    }`}
                  >
                    {n + 1}
                  </button>
                ),
              )}
              <button
                type="button"
                onClick={() => gotoPage(page + 1)}
                disabled={page >= pageCount - 1}
                aria-label="下一页"
                className="flex h-[34px] min-w-[34px] flex-none items-center justify-center rounded-[10px] border border-line/80 bg-surface px-2 text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-40 disabled:hover:border-line/80"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
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
