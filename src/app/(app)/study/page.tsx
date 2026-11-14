'use client'

/**
 * /study · 学习模式 v2(独立体系):
 * - 学习台首屏(E+ 三宫格):复习到期卡 / 继续上次 / 学新题;左栏学习会话历史
 * - setup:题目/题图/起点/模型 → POST /api/study 建会话 → stream(start) 开讲
 * - 讲义卡流:一步一卡 + 操作条(懂了继续/没懂换说法/直接要答案) + 追问输入框
 * - 结课:总结卡 + 自动归档错题本;右侧抽屉复用错题本/回看/收藏
 * 学习会话与聊天会话彻底分家:不再走 ChatPanel / /api/chat,历史列表由 /api/conversations 过滤。
 */
import { useState, Suspense, useEffect, useMemo, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import { StudyPanelDialog } from '@/components/study/StudyPanelDialog'
import { StudyHome, type StudySessionListItem, type ComposedPaperListItem, type StudyPlanSummary } from '@/components/study/StudyHome'
import { ReviewStatsDialog, type StudyStats } from '@/components/study/ReviewStatsDialog'
import { PlanDialog, type StudyPlan } from '@/components/study/PlanDialog'
import { StudyWorkspace } from '@/components/study/StudyWorkspace'
import { FileUpload } from '@/components/chat/FileUpload'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { useStudySession } from '@/hooks/useStudyStream'
import { providersModelsQuery, isModelAvailable, providerKeysStatusQuery } from '@/lib/query/providers'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import type { Attachment } from '@/lib/attachment-types'

interface StudyListResp {
  items: StudySessionListItem[]
  total: number
  hasMore: boolean
  meta?: { dueCount: number; noteCount?: number; weak: Array<{ topic: string | null; title: string; mastery: number }> }
}

function StudySetup({ onBack, onCreated, studyModels, defaultModelId, initialQuestion }: {
  onBack: () => void
  onCreated: (id: string, question: string) => void
  studyModels: Array<{ id: string; name?: string; publicPool?: boolean }>
  defaultModelId: string
  initialQuestion?: string
}) {
  const [question, setQuestion] = useState(initialQuestion ?? '')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [level, setLevel] = useState<'beginner' | 'partial' | 'review'>('beginner')
  /** 「只会一点」起点的思路备注:用户已做的过程/卡点,模型据此定位真实卡点 */
  const [notes, setNotes] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string>('')
  const [modelOpen, setModelOpen] = useState(false)
  const modelWrapRef = useRef<HTMLDivElement>(null)

  // 弹层外点击关闭
  useEffect(() => {
    if (!modelOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!modelWrapRef.current?.contains(e.target as Node)) setModelOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [modelOpen])

  const effectiveModelId = modelId || defaultModelId
  const canSubmit = question.trim().length > 0 && !creating

  const submit = async () => {
    if (!canSubmit) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/study', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          images: attachments.map((a) => a.url).filter((u) => typeof u === 'string' && u.startsWith('/')),
          notes: level === 'partial' && notes.trim() ? notes.trim() : undefined,
          startLevel: level,
          modelId: effectiveModelId,
        }),
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || `HTTP ${res.status}`)
      }
      const d = (await res.json()) as { session: { id: string } }
      onCreated(d.session.id, question.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-7 py-7">
          <button
            type="button"
            onClick={onBack}
            className="mb-4 inline-flex items-center gap-1 text-[13px] text-content-muted transition-colors hover:text-content-primary"
          >
            ← 返回
          </button>
          <label className="mb-2 block text-[13px] font-semibold">题目</label>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={20000}
            placeholder="输入或粘贴题目,也可以只上传题图…"
            className="min-h-[110px] w-full rounded-[14px] border border-line bg-surface px-3.5 py-2.5 text-[14px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <FileUpload
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              variant="pill"
              pillClassName="min-h-11 px-4"
            />
            {/* 模型选项框:附件右侧,自定义弹层向下弹出(原生 select 弹出位置系统控制,会压到起点卡) */}
            <div ref={modelWrapRef} className="relative min-w-0 max-w-full flex-1 sm:flex-none sm:basis-[280px]">
              <button
                type="button"
                onClick={() => setModelOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={modelOpen}
                title="讲解模型 · 开讲后不可换"
                className="flex h-11 w-full items-center gap-2 rounded-full border border-line bg-surface px-4 text-[13px] text-content-secondary transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  {studyModels.find((m) => m.id === effectiveModelId)?.name || effectiveModelId}
                </span>
                <ChevronDown
                  className={cn('h-3.5 w-3.5 shrink-0 transition-transform', modelOpen && 'rotate-180')}
                  aria-hidden
                />
              </button>
              {modelOpen && (
                <div
                  role="listbox"
                  aria-label="讲解模型"
                  className="absolute left-0 top-full z-30 mt-2 max-h-64 w-full overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-lg"
                >
                  {studyModels.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={m.id === effectiveModelId}
                      onClick={() => {
                        setModelId(m.id)
                        setModelOpen(false)
                      }}
                      className={cn(
                        'w-full px-4 py-2 text-left text-[13px] transition-colors hover:bg-surface-subtle',
                        m.id === effectiveModelId ? 'bg-accent-soft font-medium text-accent' : 'text-content-secondary'
                      )}
                    >
                      {m.name || m.id}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <label className="mb-2 mt-6 block text-[13px] font-semibold">从哪个起点讲</label>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {(
              [
                ['beginner', '完全不会', '从零开始,一次一小步,不跳'],
                ['partial', '只会一点', '先看我卡在哪,再接着讲'],
                ['review', '都会了复习', '直接过思路,重点查漏'],
              ] as const
            ).map(([v, label, desc]) => (
              <button
                key={v}
                type="button"
                onClick={() => setLevel(v)}
                className={cn(
                  'rounded-[14px] border p-3 text-left transition-colors',
                  level === v
                    ? 'border-accent bg-accent-soft'
                    : 'border-line bg-surface hover:border-line-strong'
                )}
              >
                <b className={cn('block text-[14px]', level === v && 'text-accent')}>{label}</b>
                <span className="text-xs text-content-muted">{desc}</span>
              </button>
            ))}
          </div>

          {level === 'partial' && (
            <div className="mt-4">
              <label className="mb-2 block text-[13px] font-semibold">
                你的思路 / 已做到哪一步
                <span className="ml-1.5 font-normal text-content-muted">让导师看清你真实卡在哪</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={5000}
                placeholder="把你的解题过程、已经试过的做法、卡住的地方贴上来…(可留空,导师会先问)"
                className="min-h-[90px] w-full rounded-[14px] border border-line bg-surface px-3.5 py-2.5 text-[14px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
              />
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-[13px] text-destructive">
              {error}
            </div>
          )}

          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-content-primary px-7 py-3 text-sm font-semibold text-surface transition-opacity disabled:opacity-40"
          >
            {creating ? '创建中…' : '选个学习起点 ›'}
          </button>
        </div>
      </div>
    </div>
  )
}

function StudyContent() {
  const { status } = useSession()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerTab, setDrawerTab] = useState<'review' | 'notes' | 'favorites'>('notes')
  // 复习模式与考点专项(阶段一方案A 双出口 + 统计弹层「专项 ›」)
  const [drawerMode, setDrawerMode] = useState<'flip' | 'redo'>('flip')
  const [drawerTopic, setDrawerTopic] = useState<string | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [creatingPlan, setCreatingPlan] = useState(false)

  // 视图状态:学习台 / 学新题 / 会话中(本地状态;刷新回学习台,继续上次一键回)
  const [view, setView] = useState<{ kind: 'home' } | { kind: 'setup'; draft?: string } | { kind: 'session'; id: string }>({ kind: 'home' })

  // 会话列表 + 学习台元数据
  const listQuery = useQuery({
    queryKey: ['study', 'sessions'],
    queryFn: () => fetchJson<StudyListResp>('/api/study?withMeta=1&limit=50'),
    staleTime: 15_000,
  })
  const sessions = listQuery.data?.items ?? []
  const meta = listQuery.data?.meta

  const activeSessionId = view.kind === 'session' ? view.id : null
  const { session, steps, loading, loadError, busy, streamError, archivedNoteId, setArchivedNoteId, reload, postTo, complete } = useStudySession(activeSessionId)

  // 模型清单(学习台/setup/重学共用):已配 Key 的模型优先
  const { data: allModels } = useQuery({ ...providersModelsQuery })
  const { data: keyProviders } = useQuery<Set<string>>({ ...providerKeysStatusQuery })
  const studyModels = useMemo(() => {
    if (!allModels) return []
    if (!keyProviders) return allModels
    return allModels.filter((m) => isModelAvailable(m, keyProviders))
  }, [allModels, keyProviders])
  const defaultModelId = studyModels.find((m) => m.publicPool)?.id || studyModels[0]?.id || ''

  // 计数(错题本/到期/收藏/课本)——复用旧页的取数口径;sourceQuestionId 用于「可重做数」
  const { data: queue, isPending: queuePending } = useQuery({
    queryKey: ['study', 'queue'],
    queryFn: () => fetchJson<Array<{ id: string; sourceQuestionId: string | null }>>('/api/study/queue'),
    staleTime: 30_000,
  })
  const { data: notes, isPending: notesPending } = useQuery({
    queryKey: ['study', 'notes-count'],
    queryFn: () => fetchJson<Array<{ id: string; lapses: number; mastery: number }>>('/api/study/notes'),
    staleTime: 30_000,
  })
  const dueCount = queue?.length ?? meta?.dueCount ?? 0
  const noteCount = notes?.length ?? 0
  // 薄弱考点计数(弹窗 chips 用):遗忘过或掌握度偏低
  const weakCount = notes?.filter((n) => n.lapses >= 1 || n.mastery < 0.3).length ?? 0
  // 小组件数据:掌握度均值(0-1,无笔记为 null)与累计场次(列表接口 total)
  const masteryAvg =
    notes && notes.length > 0 ? notes.reduce((sum, n) => sum + n.mastery, 0) / notes.length : null
  const totalSessions = listQuery.data?.total ?? 0
  const { data: favoritesCount, isPending: favoritesPending } = useQuery({
    queryKey: ['favorites', 'count'],
    queryFn: () => fetchJson<{ count: number }>('/api/favorites?count=1'),
    staleTime: 30_000,
  })
  const favoriteCount = favoritesCount?.count ?? 0
  const dueRedoCount = queue?.filter((q) => q.sourceQuestionId).length ?? 0
  // 复习统计(小组件「复习统计」卡 + 统计弹层共用一份数据)
  const { data: stats, isPending: statsPending } = useQuery({
    queryKey: ['study', 'stats'],
    queryFn: ({ signal }) => fetchJson<StudyStats>('/api/study/stats', { signal }),
    staleTime: 30_000,
  })
  // 冲刺计划(阶段四:active 计划;无计划 { plan: null })
  const { data: planData, isPending: planPending } = useQuery({
    queryKey: ['study', 'plan'],
    queryFn: ({ signal }) => fetchJson<{ plan: StudyPlan | null }>('/api/study/plan', { signal }),
    staleTime: 15_000,
  })
  const plan: StudyPlan | null = planData?.plan
    ? {
        ...planData.plan,
        examDate: planData.plan.examDate.slice(0, 10),
        items: planData.plan.items.map((i) => ({ ...i, date: i.date.slice(0, 10) })),
      }
    : null
  const todayIso = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const activePlan: StudyPlanSummary | null = plan
    ? {
        title: plan.title,
        examDate: plan.examDate,
        todayTotal: plan.items.filter((i) => i.date.slice(0, 10) === todayIso).length,
        todayDone: plan.items.filter((i) => i.date.slice(0, 10) === todayIso && i.done).length,
        totalItems: plan.items.length,
        totalDone: plan.items.filter((i) => i.done).length,
      }
    : null
  const router = useRouter()
  const { data: kbDocs, isPending: kbPending } = useQuery({
    queryKey: queryKeys.kb.docs(),
    queryFn: ({ signal }) => fetchJson<Array<{ id: string }>>('/api/kb/docs', { signal }),
    staleTime: 60_000,
  })
  const kbCount = kbDocs?.length ?? 0
  // 拟卷列表(学习台「拟卷练习」区块 + 统计行 chip;GET /api/papers/composed)
  const { data: composedList, isPending: composedPending } = useQuery({
    queryKey: queryKeys.papers.composedList(),
    queryFn: ({ signal }) => fetchJson<{ papers: ComposedPaperListItem[] }>('/api/papers/composed', { signal }),
    staleTime: 30_000,
  })
  const composedPapers = composedList?.papers ?? []
  // 首屏数据未齐 → 学习台整页骨架屏(方案A):任一首取未完成就不渲染零值空态;
  // 有缓存时 isPending 直接为 false,回访不闪骨架
  const booting =
    listQuery.isPending ||
    queuePending ||
    notesPending ||
    favoritesPending ||
    kbPending ||
    composedPending

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['study', 'sessions'] })
    void queryClient.invalidateQueries({ queryKey: ['study', 'queue'] })
    void queryClient.invalidateQueries({ queryKey: ['study', 'notes-count'] })
    void queryClient.invalidateQueries({ queryKey: ['study', 'stats'] })
    void queryClient.invalidateQueries({ queryKey: ['favorites', 'count'] })
  }

  /** 冲刺计划任务勾销/生成/结束 → 计划与统计一起刷 */
  const refreshPlan = () => {
    void queryClient.invalidateQueries({ queryKey: ['study', 'plan'] })
    void queryClient.invalidateQueries({ queryKey: ['study', 'stats'] })
  }

  // 复习到期 → 主对话 ping(服务端 24h 去重,挂载时调用是安全的)
  useEffect(() => {
    if (!meta || (meta.dueCount ?? 0) <= 0) return
    void fetch('/api/main-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'review_due',
        payload: { count: meta.dueCount, items: (meta.weak ?? []).map((w) => w.topic || w.title).slice(0, 3).join(' · ') },
      }),
    }).catch(() => {})
  }, [meta])

  // 扩展等外部入口直落抽屉:/study?panel=notes
  useEffect(() => {
    const panel = searchParams.get('panel')
    if (panel === 'notes' || panel === 'review' || panel === 'favorites') {
      setDrawerTab(panel)
      setDrawerOpen(true)
    }
  }, [searchParams])

  /** 统计弹层「专项 ›」:按考点过滤复习队列(开回看弹层 flip 模式) */
  const handleSpecialize = (topic: string) => {
    setStatsOpen(false)
    setDrawerTopic(topic)
    setDrawerMode('flip')
    setDrawerTab('review')
    setDrawerOpen(true)
  }

  /** 生成冲刺排期(PlanDialog 表单提交);成功返回 true 让弹层切到计划视图 */
  const handleCreatePlan = async (body: { examName: string; examDate: string; subject?: string }) => {
    setCreatingPlan(true)
    try {
      const res = await fetch('/api/study/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || `HTTP ${res.status}`)
      }
      refreshPlan()
      toast.success('排期已生成,学习台会常驻冲刺条', { title: '冲刺计划' })
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成失败', { title: '冲刺计划' })
      return false
    } finally {
      setCreatingPlan(false)
    }
  }

  const handleToggleItem = async (itemId: string, done: boolean) => {
    try {
      const res = await fetch('/api/study/plan/item', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, done }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      refreshPlan()
    } catch (err) {
      console.error('[study] toggle plan item failed:', err)
      toast.error('更新失败,请重试', { title: '冲刺计划' })
    }
  }

  const handleEndPlan = async () => {
    try {
      const res = await fetch('/api/study/plan', { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      refreshPlan()
      toast.success('计划已结束,可随时重新排一份', { title: '冲刺计划' })
    } catch (err) {
      console.error('[study] end plan failed:', err)
      toast.error('操作失败,请重试', { title: '冲刺计划' })
    }
  }

  if (status === 'loading') return null

  const handleCreated = async (id: string, _question: string) => {
    refreshAll()
    setView({ kind: 'session', id })
    // 先把新会话的空步载入,再发起 start 流(载入完成后再发,避免快照把流式占位覆盖掉)
    await reload(id)
    void postTo(id, 'start')
  }

  const handleManualComplete = async () => {
    if (activeSessionId) {
      await complete()
      refreshAll()
    }
  }

  /** 复习卡「重新学这道」:以错题内容开一个新学习会话,起点=只会一点 */
  const handleRestudy = async (note: { id: string; title: string; content: string; imageUrl?: string | null }) => {
    if (!defaultModelId) return
    try {
      const res = await fetch('/api/study', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: note.content,
          images: note.imageUrl ? [note.imageUrl] : [],
          startLevel: 'partial',
          modelId: defaultModelId,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as { session: { id: string } }
      refreshAll()
      setDrawerOpen(false)
      setView({ kind: 'session', id: d.session.id })
      await reload(d.session.id)
      void postTo(d.session.id, 'start')
    } catch (err) {
      console.error('[study] restudy failed:', err)
    }
  }

  /** 复习卡「举一反三」:同考点巩固练习会话——模型连续出变式题,作答即判分 */
  const handleDrill = async (note: { id: string; title: string; content: string; imageUrl?: string | null }) => {
    if (!defaultModelId) return
    try {
      const res = await fetch('/api/study', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: note.content,
          images: note.imageUrl ? [note.imageUrl] : [],
          startLevel: 'partial',
          modelId: defaultModelId,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as { session: { id: string } }
      refreshAll()
      setDrawerOpen(false)
      setView({ kind: 'session', id: d.session.id })
      await reload(d.session.id)
      void postTo(d.session.id, 'drill')
    } catch (err) {
      console.error('[study] drill failed:', err)
    }
  }

  const openSession = (id: string) => {
    setView({ kind: 'session', id })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1">
        {view.kind === 'home' && (
          <StudyHome
            sessions={sessions}
            dueCount={dueCount}
            dueRedoCount={dueRedoCount}
            noteCount={noteCount}
            favoriteCount={favoriteCount}
            kbCount={kbCount}
            masteryAvg={masteryAvg}
            streakDays={statsPending ? null : stats?.streakDays ?? null}
            totalSessions={totalSessions}
            activePlan={activePlan}
            papers={composedPapers}
            loading={listQuery.isLoading}
            booting={booting}
            onResume={openSession}
            onNew={(text) => setView({ kind: 'setup', draft: text })}
            onOpenDrawer={(tab, mode) => {
              setDrawerTab(tab)
              if (tab === 'review' && mode) setDrawerMode(mode)
              else if (tab !== 'review') setDrawerMode('flip')
              setDrawerOpen(true)
            }}
            onOpenStats={() => setStatsOpen(true)}
            onOpenPlan={() => setPlanOpen(true)}
          />
        )}

        {view.kind === 'setup' && (
          <StudySetup
            onBack={() => setView({ kind: 'home' })}
            onCreated={handleCreated}
            studyModels={studyModels}
            defaultModelId={defaultModelId}
            initialQuestion={view.draft}
          />
        )}

        {view.kind === 'session' && (
          <>
            {loadError ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-content-muted">
                <div>{loadError === 'not_found' ? '这道题的学习会话不存在或已被删除' : loadError}</div>
                <button
                  type="button"
                  onClick={() => setView({ kind: 'home' })}
                  className="rounded-full border border-line px-4 py-1.5 text-sm text-content-secondary hover:text-content-primary"
                >
                  返回学习台
                </button>
              </div>
            ) : !session ? (
              <div className="flex h-full items-center justify-center text-content-muted">
                <div className="flex items-center gap-3">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-content-muted border-t-transparent" />
                  <span>正在续上这道题…</span>
                </div>
              </div>
            ) : (
              <StudyWorkspace
                session={session}
                steps={steps}
                busy={busy}
                streamError={streamError}
                archivedNoteId={archivedNoteId}
                onArchiveChange={(remove) => {
                  if (!activeSessionId) return
                  void (async () => {
                    const res = await fetch(`/api/study/${activeSessionId}/archive`, {
                      method: remove ? 'DELETE' : 'POST',
                    }).catch(() => null)
                    if (res && res.ok) {
                      const d = (await res.json().catch(() => ({}))) as { noteId?: string }
                      setArchivedNoteId(remove ? null : d?.noteId ?? 'restored')
                      refreshAll()
                    }
                  })()
                }}
                onAction={(action, opts) => {
                  if (activeSessionId) void postTo(activeSessionId, action, opts)
                }}
                onManualComplete={() => void handleManualComplete()}
                onBack={() => {
                  refreshAll()
                  setView({ kind: 'home' })
                }}
              />
            )}
          </>
        )}

        {/* 错题本/复习/收藏浮层:原右侧抽屉改居中宽弹窗(方案 C) */}
        <StudyPanelDialog
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          tab={drawerTab}
          onTab={setDrawerTab}
          dueCount={dueCount}
          weakCount={weakCount}
          favoriteCount={favoriteCount}
          onChanged={refreshAll}
          onRestudy={(note) => void handleRestudy(note)}
          onDrill={(note) => void handleDrill(note)}
          initialMode={drawerMode}
          topicFilter={drawerTopic}
          onClearTopic={() => setDrawerTopic(null)}
        />

        {/* 复习统计弹层(阶段三方案B:小组件/统计 chip 进入) */}
        <ReviewStatsDialog
          open={statsOpen}
          onClose={() => setStatsOpen(false)}
          stats={stats ?? null}
          loading={statsPending}
          onSpecialize={handleSpecialize}
          onOpenPlan={() => {
            setStatsOpen(false)
            setPlanOpen(true)
          }}
        />

        {/* 考前冲刺计划弹层(阶段四方案A:生成表单/按日勾销) */}
        <PlanDialog
          open={planOpen}
          onClose={() => setPlanOpen(false)}
          plan={plan}
          loading={planPending}
          creating={creatingPlan}
          onToggleItem={(id, done) => void handleToggleItem(id, done)}
          onCreate={handleCreatePlan}
          onEndPlan={() => void handleEndPlan()}
        />
      </div>
    </div>
  )
}

export default function StudyPage() {
  return (
    <AuthErrorBoundary>
      <Suspense>
        <ClientOnly>
          <StudyContent />
        </ClientOnly>
      </Suspense>
    </AuthErrorBoundary>
  )
}
