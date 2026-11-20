'use client'

/**
 * 卷面 AI 助手 v2(方案 A,design/preview-assistant-redo.html)——计划为主工作台:
 * - 顶部审卷诊断条(GET /api/papers/composed/[id]/review,确定性查库无模型成本):
 *   考点覆盖/缺口/薄弱点 chips,可展开,一键「按缺口出补题计划」
 * - 中部变更计划卡(最新一张,来自 propose_plan 工具调用):
 *   逐条勾选、换题给 2-3 道候选举牌(不再盲盒)、客户端实时算应用后变化;
 *   「应用全部」→ POST /apply(服务端先快照再顺序执行,失败不回滚)
 * - 应用后顶部撤销条 → POST /undo 按快照整卷还原
 * - 底部对话收窄成条(文字消息 + 输入),操作卡不再逐条刷屏
 * 口径红线:助手不生成/不改写题目内容,计划里的每道题都来自真题池;
 * 模型 = 学习台同款默认口径(公共池优先),走 resolveChatModel 同一套解析/额度闸
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Loader2, SendHorizontal, Sparkles, Square, Undo2, X } from 'lucide-react'
import { providersModelsQuery, isModelAvailable, providerKeysStatusQuery } from '@/lib/query/providers'
import { queryKeys } from '@/lib/query/keys'

/** 卷面槽位的结构视图(与 ComposedSlotView 字段对齐,组件内 duck-type 免跨文件导出) */
export interface AssistantSlot {
  slotId: string
  number: number
  section: string | null
  kind: string
  score: number
  stem: string | null
}

/** 计划候选题(propose_plan op.candidates / search_candidates 返回共用形状) */
interface PlanCandidate {
  paperQuestionId: string
  stemBrief?: string
  topics?: string[]
  paperTitle?: string
  answerBrief?: string
  kind?: string
  score?: number
  answerSource?: string
}

/** propose_plan 工具的 op 输入契约(与服务端 zod schema 对齐,宽松兜底) */
interface PlanOpInput {
  op: 'replace' | 'remove' | 'insert' | 'retitle' | 'rescore' | 'move' | 'resection' | 'reduration'
  slotNumber?: number
  paperQuestionId?: string
  afterNumber?: number
  title?: string
  score?: number
  toNumber?: number
  fromSection?: string
  toSection?: string
  durationMin?: number
  note?: string
  candidates?: PlanCandidate[]
}

/** /apply 逐条回执(与 compose.applyPlan results 对齐) */
interface ApplyResult {
  op: string
  ok: boolean
  reason?: string
  hint?: string
  detail?: string
}

/** /review 审卷诊断(compose.computeReview 返回) */
interface ReviewData {
  coveredCount: number
  highFreqCount: number
  gaps: Array<{ topic: string; count: number; chapter: string | null }>
  weak: Array<{ topic: string; mastery: number; onPaper: boolean }>
}

type LoosePart = {
  type: string
  text?: string
  state?: string
  toolCallId?: string
  input?: unknown
  output?: unknown
}

const OP_LABEL: Record<PlanOpInput['op'], string> = {
  replace: '换题',
  remove: '移除',
  insert: '加题',
  retitle: '改卷名',
  rescore: '改分值',
  move: '移位',
  resection: '改大题名',
  reduration: '调时长',
}

const OP_LABEL_FULL: Record<PlanOpInput['op'], (o: PlanOpInput) => string> = {
  replace: (o) => `第 ${o.slotNumber ?? '?'} 题 → 换入新题`,
  remove: (o) => `第 ${o.slotNumber ?? '?'} 题移出卷面`,
  insert: (o) => (o.afterNumber ? `插到第 ${o.afterNumber} 题后` : '加入卷面'),
  retitle: (o) => `卷名改为「${o.title ?? ''}」`,
  rescore: (o) => `第 ${o.slotNumber ?? '?'} 题 → ${o.score ?? '?'} 分`,
  move: (o) => `第 ${o.slotNumber ?? '?'} 题 → 第 ${o.toNumber ?? '?'} 题`,
  resection: (o) => `「${o.fromSection ?? '?'}」→「${o.toSection ?? '?'}」`,
  reduration: (o) => `考试时长 → ${o.durationMin ?? '?'} 分钟`,
}

const SUGGESTIONS = ['第 3 题换成更基础的', '补两道高频考点的选择题', '按审卷缺口出一份补题计划', '改成 90 分钟，卷名改成周末模拟卷']

/** 操作短标签(未知 op 兜底,流式半途/模型越界都不崩) */
const opLabel = (op: PlanOpInput['op'] | undefined) => (op && OP_LABEL[op]) || '未知操作'
/** 操作完整描述(op 缺失或未收录时退化为短标签) */
const opFullLabel = (o: PlanOpInput) => {
  const fn = o.op ? OP_LABEL_FULL[o.op] : undefined
  return fn ? fn(o) : opLabel(o.op)
}

export function ComposedAssistant({
  composedId,
  slots,
  paperTitle,
  durationMin,
}: {
  composedId: string
  slots: AssistantSlot[]
  paperTitle: string
  /** 当前考试时长(计划应用后变化的 Δ 计算用) */
  durationMin: number
}) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [diagOpen, setDiagOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  /** 已应用的计划:快照 id + 逐条回执(撤销条与计划卡回执态共用) */
  const [applied, setApplied] = useState<{ snapshotId: string; results: ApplyResult[] } | null>(null)
  /** 每条操作的勾选态(key=op 序号) */
  const [opChecked, setOpChecked] = useState<Record<number, boolean>>({})
  /** replace 类操作挑中的候选(key=op 序号,value=paperQuestionId) */
  const [candPick, setCandPick] = useState<Record<number, string>>({})
  const queryClient = useQueryClient()

  // 模型:学习台同款默认口径(公共池优先,有 Key 的优先)
  const { data: allModels } = useQuery({ ...providersModelsQuery })
  const { data: keyProviders } = useQuery<Set<string>>({ ...providerKeysStatusQuery })
  const modelId = useMemo(() => {
    if (!allModels) return null
    const avail = keyProviders ? allModels.filter((m) => isModelAvailable(m, keyProviders)) : allModels
    return avail.find((m) => m.publicPool)?.id || avail[0]?.id || null
  }, [allModels, keyProviders])
  const modelRef = useRef(modelId)
  modelRef.current = modelId

  const chat = useChat({
    id: `assistant-${composedId}`,
    transport: useMemo(
      () =>
        new DefaultChatTransport<UIMessage>({
          api: `/api/papers/composed/${composedId}/assistant`,
          body: { get modelId() { return modelRef.current } },
        }),
      [composedId]
    ),
  })
  const busy = chat.status === 'submitted' || chat.status === 'streaming'

  // 审卷诊断:面板打开时拉一次(确定性查库,便宜);应用/撤销后失效重算
  const reviewQuery = useQuery<ReviewData>({
    queryKey: ['papers', 'composed', composedId, 'review'],
    queryFn: async () => {
      const res = await fetch(`/api/papers/composed/${composedId}/review`)
      if (!res.ok) throw new Error('review_failed')
      return res.json()
    },
    enabled: open,
  })
  const review = reviewQuery.data

  // 最新一张计划卡:从消息流倒序找最后一个有 ops 的 propose_plan
  // 只取 input 已完整的 tool part——流式半途的 input 是不完整 JSON,op 字段可能缺失
  const plan = useMemo(() => {
    for (let mi = chat.messages.length - 1; mi >= 0; mi--) {
      const parts = chat.messages[mi].parts as LoosePart[]
      for (let pi = parts.length - 1; pi >= 0; pi--) {
        const p = parts[pi]
        if (p.type === 'tool-propose_plan' && p.state === 'input-available' && p.input && typeof p.input === 'object') {
          const inp = p.input as { ops?: PlanOpInput[] }
          if (Array.isArray(inp.ops) && inp.ops.length) return { toolCallId: p.toolCallId ?? '', ops: inp.ops }
        }
      }
    }
    return null
  }, [chat.messages])
  const planKey = plan?.toolCallId ?? ''
  const planGenerating = useMemo(
    () => busy && chat.messages.some((m) => (m.parts as LoosePart[]).some((p) => p.type === 'tool-propose_plan')),
    [busy, chat.messages]
  )

  // 新计划到达:勾选态默认全选、候选默认取第一道(AI 的推荐)
  useEffect(() => {
    if (!plan) return
    setOpChecked(Object.fromEntries(plan.ops.map((_, i) => [i, true])))
    setCandPick(
      Object.fromEntries(
        plan.ops
          .map((o, i) => [i, o.candidates?.[0]?.paperQuestionId ?? o.paperQuestionId ?? ''] as const)
          .filter(([, v]) => !!v)
      )
    )
    setApplied(null)
    setApplyError(null)
  }, [planKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const invalidatePaper = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.papers.composed(composedId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.papers.composedList() })
    void queryClient.invalidateQueries({ queryKey: ['papers', 'composed', composedId, 'review'] })
  }

  const send = (text: string) => {
    const t = text.trim()
    if (!t || busy || !modelId) return
    void chat.sendMessage({ text: t })
  }

  // 应用后变化 Δ(只算勾选中的;题号/分值全部按计划生成时的卷面基线)
  const delta = useMemo(() => {
    if (!plan) return null
    let count = 0
    let score = 0
    let duration = 0
    plan.ops.forEach((o, i) => {
      if (!(opChecked[i] ?? true)) return
      const slot = o.slotNumber ? slots.find((s) => s.number === o.slotNumber) : null
      if (o.op === 'insert') {
        count += 1
        score += o.candidates?.[0]?.score ?? 0
      } else if (o.op === 'remove') {
        count -= 1
        score -= slot?.score ?? 0
      } else if (o.op === 'replace') {
        const picked = o.candidates?.find((c) => c.paperQuestionId === (candPick[i] ?? o.paperQuestionId)) ?? o.candidates?.[0]
        score += (picked?.score ?? slot?.score ?? 0) - (slot?.score ?? 0)
      } else if (o.op === 'rescore' && o.score && slot) {
        score += o.score - slot.score
      } else if (o.op === 'reduration' && o.durationMin) {
        duration += o.durationMin - durationMin
      }
    })
    const fmt = (v: number, unit: string) => (v === 0 ? null : `${v > 0 ? '+' : ''}${v}${unit}`)
    return {
      count: fmt(count, ' 题'),
      score: fmt(score, ' 分'),
      duration: fmt(duration, ' 分钟'),
      hasAny: count !== 0 || score !== 0 || duration !== 0,
    }
  }, [plan, opChecked, candPick, slots, durationMin])

  const applyPlan = async () => {
    if (!plan || applying) return
    const ops = plan.ops
      .map((o, i): PlanOpInput | null => {
        if (!(opChecked[i] ?? true)) return null
        const picked = o.candidates?.find((c) => c.paperQuestionId === candPick[i]) ?? o.candidates?.[0]
        return {
          ...o,
          paperQuestionId: o.op === 'replace' ? (picked?.paperQuestionId ?? o.paperQuestionId) : o.paperQuestionId,
        }
      })
      .filter((o): o is PlanOpInput => !!o)
    if (!ops.length) return
    setApplying(true)
    setApplyError(null)
    try {
      const res = await fetch(`/api/papers/composed/${composedId}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      })
      const data = (await res.json()) as { ok?: boolean; snapshotId?: string; results?: ApplyResult[]; error?: string }
      if (!res.ok || !data.ok) {
        setApplyError(
          data.error === 'not_found'
            ? '卷子不存在'
            : data.error === 'empty_plan'
              ? '计划为空'
              : data.error === 'plan_too_large'
                ? '计划超过 12 条，请让 AI 拆分'
                : '应用失败，请重试'
        )
        return
      }
      setApplied({ snapshotId: data.snapshotId ?? '', results: data.results ?? [] })
      invalidatePaper()
    } catch {
      setApplyError('应用失败，请重试')
    } finally {
      setApplying(false)
    }
  }

  const undoPlan = async () => {
    if (applying || !applied) return
    setApplying(true)
    try {
      const res = await fetch(`/api/papers/composed/${composedId}/undo`, { method: 'POST' })
      if (res.ok) {
        setApplied(null)
        invalidatePaper()
      }
    } finally {
      setApplying(false)
    }
  }

  const chatLogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open && chatLogRef.current) chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight
  }, [chat.messages, open])

  /** 计划卡单条操作(勾选 + 候选举牌) */
  const renderOp = (o: PlanOpInput, i: number) => {
    const checked = opChecked[i] ?? true
    const result = applied?.results[i]
    const pickedId = o.candidates?.length ? (candPick[i] ?? o.candidates[0]?.paperQuestionId) : null
    return (
      <div key={i} className="border-b border-line px-3 py-2.5 last:border-b-0">
        <div className="flex gap-2.5">
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={`操作 ${i + 1}: ${opLabel(o.op)}`}
            onClick={() => setOpChecked((prev) => ({ ...prev, [i]: !checked }))}
            className={`mt-0.5 flex h-[15px] w-[15px] flex-none items-center justify-center rounded-md border transition-colors ${
              checked ? 'border-accent bg-accent text-accent-foreground' : 'border-line-strong bg-surface'
            }`}
          >
            {checked && (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-[9px] w-[9px]">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            )}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                  o.op === 'remove' ? 'bg-[rgb(214_69_65/.09)] text-red-500' : 'bg-accent-soft text-accent'
                }`}
              >
                {opLabel(o.op)}
              </span>
              <span className="text-[12px] font-semibold text-content-primary">{opFullLabel(o)}</span>
              {result && (
                <span className={`text-[10.5px] font-semibold ${result.ok ? 'text-emerald-600' : 'text-red-500'}`}>
                  {result.ok ? '✓ 已应用' : `✗ ${result.hint ?? '失败'}`}
                </span>
              )}
            </div>
            {o.note && <div className="mt-1 text-[11px] leading-relaxed text-content-secondary">{o.note}</div>}
            {/* 候选举牌:换题不再盲盒,2-3 道任挑 */}
            {!!o.candidates?.length && (
              <div className="mt-2 flex flex-col gap-1.5">
                {o.candidates.length > 1 && <div className="text-[10.5px] text-content-muted">候选（按考点命中排序，挑一道）</div>}
                {o.candidates.map((c) => {
                  const on = pickedId === c.paperQuestionId
                  return (
                    <button
                      key={c.paperQuestionId}
                      type="button"
                      onClick={() => setCandPick((prev) => ({ ...prev, [i]: c.paperQuestionId }))}
                      className={`rounded-[10px] border px-2.5 py-2 text-left transition-colors ${
                        on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-line-strong'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className={`h-3 w-3 flex-none rounded-full border-2 ${on ? 'border-accent bg-accent' : 'border-line-strong bg-surface'}`} />
                        <span className="truncate text-[10.5px] font-bold text-content-secondary">
                          {c.paperTitle ?? '真题'}
                          {c.answerSource === 'ai' ? ' · AI 参考答案' : ''}
                        </span>
                        {c.score != null && <span className="ml-auto flex-none text-[10.5px] text-content-muted">{c.score} 分</span>}
                      </span>
                      {!!c.topics?.length && (
                        <span className="mt-1.5 flex flex-wrap gap-1">
                          {c.topics.slice(0, 3).map((t) => (
                            <span
                              key={t}
                              className={`rounded px-1.5 py-0.5 text-[10px] ${on ? 'bg-[rgb(10_132_255/.14)] text-accent' : 'bg-surface-subtle text-content-secondary'}`}
                            >
                              {t}
                            </span>
                          ))}
                        </span>
                      )}
                      {c.stemBrief && <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-content-primary">{c.stemBrief}</div>}
                      {c.answerBrief && <div className="mt-0.5 truncate text-[10.5px] text-content-muted">答案 {c.answerBrief}</div>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  const renderMessages = () => {
    if (chat.messages.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-1 text-center">
          <p className="text-[11.5px] text-content-secondary">想怎么改直接说——AI 落成计划，你确认才应用</p>
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-1.5">
        {chat.messages.map((m) =>
          (m.parts as LoosePart[])
            .filter((p) => (p.type === 'text' && p.text?.trim()) || p.type === 'tool-set_allow_ai')
            .map((p, i) => {
              if (p.type === 'tool-set_allow_ai') {
                const out = p.output as { ok?: boolean; note?: string; poolStats?: { official: number; ai: number } } | undefined
                const done = p.state === 'output-available' && out?.ok
                return (
                  <div
                    key={`ai-${i}`}
                    className={`self-start rounded-xl border px-3 py-1.5 text-[11px] leading-relaxed ${
                      done ? 'border-emerald-500/40 bg-emerald-500/5 text-content-primary' : 'border-dashed border-accent/60 bg-surface text-content-secondary'
                    }`}
                  >
                    {done ? `✓ ${out?.note ?? '题源口径已切换'}` : '切换题源口径中…'}
                    {done && out?.poolStats && (
                      <span className="text-content-muted">（官方 {out.poolStats.official} · AI {out.poolStats.ai}）</span>
                    )}
                  </div>
                )
              }
              const isUser = m.role === 'user'
              return (
                <div
                  key={i}
                  className={`max-w-[94%] whitespace-pre-wrap rounded-xl px-3 py-1.5 text-[11.5px] leading-relaxed ${
                    isUser
                      ? 'self-end rounded-br-sm bg-accent text-accent-foreground'
                      : 'self-start rounded-bl-sm border border-line bg-surface text-content-primary'
                  }`}
                >
                  {p.text}
                </div>
              )
            })
        )}
        {chat.status === 'error' && (
          <div className="self-start rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11.5px] text-red-500">
            助手连接失败，请重试
          </div>
        )}
      </div>
    )
  }

  const body = (
    <>
      {/* 头 */}
      <div className="flex flex-none items-center gap-2 border-b border-line px-3.5 py-2">
        <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-accent-soft text-accent" aria-hidden>
          <Sparkles className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block text-[12px] font-bold text-content-primary">卷面助手</span>
          <span className="block truncate text-[10px] text-content-muted">{paperTitle}</span>
        </span>
        {busy && <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-content-muted" />}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md p-1 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
          aria-label="收起助手"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* 审卷诊断条 */}
      <div className="flex flex-none items-center gap-1.5 border-b border-line bg-surface-muted px-3 py-2">
        <span className="flex-none text-[10.5px] font-bold text-content-secondary">审卷</span>
        {reviewQuery.isLoading ? (
          <Loader2 className="h-3 w-3 animate-spin text-content-muted" />
        ) : review ? (
          <>
            <span className="whitespace-nowrap rounded-full border border-line bg-surface px-2 py-0.5 text-[10.5px] text-content-secondary">
              覆盖 {review.coveredCount}/{review.highFreqCount} 高频
            </span>
            {review.gaps.slice(0, 2).map((g) => (
              <span
                key={g.topic}
                className="whitespace-nowrap rounded-full border border-[rgb(176_112_15/.45)] bg-[rgb(176_112_15/.1)] px-2 py-0.5 text-[10.5px] text-[rgb(176_112_15)]"
              >
                缺：{g.topic}
              </span>
            ))}
            {review.weak.some((w) => !w.onPaper) && (
              <span className="whitespace-nowrap rounded-full border border-line bg-surface px-2 py-0.5 text-[10.5px] text-content-secondary">
                薄弱 {review.weak.filter((w) => !w.onPaper).length} 项
              </span>
            )}
            <button
              type="button"
              onClick={() => setDiagOpen((v) => !v)}
              className="ml-auto flex flex-none rounded-md p-0.5 text-content-muted transition-colors hover:text-content-primary"
              aria-label={diagOpen ? '收起审卷详情' : '展开审卷详情'}
              aria-expanded={diagOpen}
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${diagOpen ? 'rotate-180' : ''}`} />
            </button>
          </>
        ) : (
          <span className="text-[10.5px] text-content-muted">暂无诊断</span>
        )}
      </div>
      {diagOpen && review && (
        <div className="flex-none border-b border-line bg-surface-muted px-3 py-2 text-[11px] leading-relaxed text-content-secondary">
          {review.gaps.length === 0 ? (
            <p>高频考点全覆盖，没有明显缺口。</p>
          ) : (
            <p>高频缺口：{review.gaps.map((g) => `${g.topic}（考 ${g.count} 次）`).join('、')}</p>
          )}
          {review.weak.length > 0 && (
            <p className="mt-0.5">
              错题本薄弱：{review.weak.map((w) => `${w.topic}${w.onPaper ? '（已在卷）' : ''}`).join('、')}
            </p>
          )}
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => send('按审卷缺口和薄弱考点出一份补题计划，能补几道补几道')}
              disabled={busy || !modelId}
              className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:border-accent disabled:opacity-40"
            >
              按缺口出补题计划
            </button>
          </div>
        </div>
      )}
      {/* 撤销条(已应用态) */}
      {applied && (
        <div className="mx-3 mt-2.5 flex flex-none items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-2.5 py-1.5">
          <Undo2 className="h-3.5 w-3.5 flex-none text-emerald-600" />
          <span className="min-w-0 flex-1 text-[11px] leading-snug text-content-primary">
            已应用 {applied.results.filter((r) => r.ok).length} 条操作
            {applied.results.some((r) => !r.ok) ? `（${applied.results.filter((r) => !r.ok).length} 条失败）` : ''} · 卷面已更新
          </span>
          <button
            type="button"
            onClick={() => void undoPlan()}
            disabled={applying}
            className="flex-none rounded-full border border-emerald-500/50 px-2.5 py-1 text-[11px] font-bold text-emerald-600 transition-colors hover:bg-emerald-500/10 disabled:opacity-40"
          >
            撤销本轮
          </button>
        </div>
      )}
      {/* 计划区(主区) */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {plan ? (
          <div className="overflow-hidden rounded-[13px] border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line bg-surface-muted px-3 py-2">
              <span className="rounded-md bg-accent-soft px-2 py-0.5 text-[10.5px] font-bold text-accent">变更计划</span>
              <span className="text-[11px] text-content-secondary">
                {plan.ops.length} 条 · 勾选 {plan.ops.filter((_, i) => opChecked[i] ?? true).length}
              </span>
              {!applied && !planGenerating && <span className="ml-auto text-[10px] text-content-muted">确认后一键应用</span>}
              {planGenerating && (
                <span className="ml-auto flex items-center gap-1 text-[10px] text-content-muted">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" /> 计划生成中…
                </span>
              )}
            </div>
            {plan.ops.map((o, i) => renderOp(o, i))}
            {delta?.hasAny && (
              <div className="border-t border-line bg-surface-muted px-3 py-1.5 text-[11px] text-content-secondary">
                应用后：
                {delta.count && <b className="text-content-primary">{delta.count}</b>}{' '}
                {delta.score && <b className="text-content-primary">{delta.score}</b>}{' '}
                {delta.duration && <b className="text-content-primary">{delta.duration}</b>}
              </div>
            )}
            {!applied && (
              <div className="flex items-center gap-2 border-t border-line px-3 py-2">
                <button
                  type="button"
                  onClick={() => void applyPlan()}
                  disabled={applying || planGenerating || plan.ops.every((_, i) => !(opChecked[i] ?? true))}
                  className="rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-bold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {applying ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" /> 应用中…
                    </span>
                  ) : (
                    '应用全部'
                  )}
                </button>
                {applyError && <span className="text-[11px] font-semibold text-red-500">{applyError}</span>}
                <span className="ml-auto text-[10px] text-content-muted">应用前自动快照 · 可撤销</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-accent-soft text-accent" aria-hidden>
              <Sparkles className="h-4 w-4" />
            </span>
            <p className="text-[12.5px] text-content-secondary">还没有变更计划</p>
            <p className="text-[11px] leading-relaxed text-content-muted">
              在下面说想怎么改，AI 会落成一张计划卡：
              <br />
              换题给候选你挑，确认才应用
            </p>
          </div>
        )}
      </div>
      {/* 对话区:固定占面板 ~38%,日志区内滚动 */}
      <div className="flex h-[38%] min-h-[150px] flex-none flex-col border-t border-line">
        <div ref={chatLogRef} className="min-h-[24px] flex-1 overflow-y-auto px-3 py-2">
          {renderMessages()}
        </div>
        {chat.messages.length === 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pb-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="rounded-full bg-accent-soft px-2.5 py-1 text-[10.5px] font-medium text-accent transition-opacity hover:opacity-80"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5 border-t border-line px-3 py-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(input)
                setInput('')
              }
            }}
            placeholder={modelId ? '说想怎么改，AI 落成计划…' : '没有可用的 AI 模型'}
            disabled={!modelId || busy}
            className="h-8 min-w-0 flex-1 rounded-full border border-line bg-surface px-3 text-[12px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent disabled:opacity-50"
            aria-label="说想怎么改"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => chat.stop()}
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-surface-subtle text-content-secondary transition-colors hover:text-content-primary"
              aria-label="停止"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                send(input)
                setInput('')
              }}
              disabled={!input.trim() || !modelId}
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-accent text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              aria-label="发送"
            >
              <SendHorizontal className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </>
  )

  return (
    <>
      {/* 收起态:右下悬浮球(打印隐藏走 paper-assistant-print-hide,随卷面页 PRINT_GLOBAL 生效) */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="卷面助手 · 想怎么改直接说"
          className="paper-assistant-print-hide absolute bottom-5 right-5 z-30 flex h-12 w-12 items-center justify-center rounded-full border border-line-strong bg-surface text-content-secondary shadow-[0_4px_16px_rgb(var(--foreground)/0.14)] transition-transform hover:scale-105 hover:text-accent"
          aria-label="打开卷面助手"
        >
          <Sparkles className="h-5 w-5" />
        </button>
      )}
      {open && (
        <>
          {/* ≥md:右缘停靠列,推挤卷面列 */}
          <aside className="paper-assistant-print-hide hidden h-full w-[430px] max-w-[46%] shrink-0 flex-col border-l border-line bg-surface md:flex">
            {body}
          </aside>
          {/* <md:浮卡 overlay */}
          <div className="paper-assistant-print-hide absolute inset-x-2 bottom-14 top-12 z-40 flex flex-col rounded-2xl border border-line bg-surface shadow-2xl md:hidden">
            {body}
          </div>
        </>
      )}
    </>
  )
}
