'use client'

/**
 * 卷面 AI 助手(方案 1+2 定案,design/preview-paper-assistant.html;自动执行升级 design/preview-assistant-autopilot.html 方案A):
 * - 收起 = 右下悬浮球;展开 = 右缘停靠列(≥md,推挤卷面列),<md 退化为浮卡 overlay
 * - 两种模式(头部「自动执行」开关,默认开):
 *   · 开 = AI 直接改卷:服务端 exec_op 真执行,操作卡流式显示 执行中→已执行/失败,结果回流卷面(invalidate query)
 *   · 关 = 手动模式:propose_op 只出卡,用户点「执行」才走既有 PATCH 槽位操作
 * - 口径红线:助手不生成/不改写题目内容,卷面保持「全部题目与答案出自原卷」;
 *   AI 参考答案题入池需用户明确同意(set_allow_ai,答案页逐题标注);操作不可撤销
 * - 模型 = 学习台同款默认口径(公共池优先),走 resolveChatModel 同一套解析/额度闸
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, SendHorizontal, Sparkles, Square, X } from 'lucide-react'
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

/** propose_op / exec_op 工具的输入契约(与服务端 zod schema 对齐,宽松兜底) */
interface OpInput {
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
}

/** exec_op / set_allow_ai 的执行回执(服务端 execute 返回,经 UI message stream 流回) */
interface OpOutput {
  ok: boolean
  reason?: string
  hint?: string
  detail?: string
  paper?: string
  allow?: boolean
  note?: string
  poolStats?: { official: number; ai: number }
}

type LoosePart = {
  type: string
  text?: string
  state?: string
  toolCallId?: string
  input?: unknown
  output?: unknown
}

type OpState = 'executed' | 'cancelled' | 'error'

function opLabel(input: OpInput): string {
  switch (input.op) {
    case 'replace':
      return `换一题 · 第 ${input.slotNumber ?? '?'} 题`
    case 'remove':
      return `移除 · 第 ${input.slotNumber ?? '?'} 题`
    case 'insert':
      return input.afterNumber ? `加一题 · 插到第 ${input.afterNumber} 题后` : '加一题'
    case 'retitle':
      return '改卷名'
    case 'rescore':
      return `改分值 · 第 ${input.slotNumber ?? '?'} 题 → ${input.score ?? '?'} 分`
    case 'move':
      return `移位 · 第 ${input.slotNumber ?? '?'} 题 → 第 ${input.toNumber ?? '?'} 题`
    case 'resection':
      return `改大题名 ·「${input.fromSection ?? '?'}」→「${input.toSection ?? '?'}」`
    case 'reduration':
      return `调时长 · ${input.durationMin ?? '?'} 分钟`
  }
}

function opDetail(input: OpInput): string {
  switch (input.op) {
    case 'replace':
      return '同题型同分值随机换一道真题,原题将被替换(不可撤销)'
    case 'remove':
      return '从卷面移除该题,其余题号自动前移(不可撤销)'
    case 'insert':
      return '把选中的真题加进卷子,自动归入对应大题(不可撤销)'
    case 'retitle':
      return `卷名改为「${input.title ?? ''}」`
    case 'rescore':
      return '只改分值不动题目,卷面总分自动重算'
    case 'move':
      return '移动到新位置,题号自动重排'
    case 'resection':
      return '该大题整组改名,题目不动'
    case 'reduration':
      return '只改考试时长'
  }
}

/** 手动模式操作卡(现状保留:用户点「执行」才走 PATCH) */
function OpCard({
  input,
  state,
  onExecute,
  onCancel,
}: {
  input: OpInput
  state?: OpState
  onExecute: () => void
  onCancel: () => void
}) {
  const label = opLabel(input)
  const detail = opDetail(input)
  return (
    <div
      className={`w-full rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed transition-colors ${
        state === 'executed'
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : state === 'error'
            ? 'border-red-500/40 bg-red-500/5'
            : 'border-line bg-surface'
      }`}
    >
      <span className="mb-1.5 inline-block rounded-md bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">{label}</span>
      {input.note && <div className="text-content-primary">{input.note}</div>}
      <div className="mt-0.5 text-[11px] text-content-muted">{detail}</div>
      {state === 'executed' ? (
        <div className="mt-1.5 text-[11px] font-semibold text-emerald-600">✓ 已执行 · 卷面已刷新</div>
      ) : state === 'error' ? (
        <div className="mt-1.5 text-[11px] font-semibold text-red-500">执行失败，请重试或手动操作</div>
      ) : state === 'cancelled' ? (
        <div className="mt-1.5 text-[11px] text-content-muted">已取消</div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onExecute}
            className="rounded-full bg-accent px-3.5 py-1 text-[11.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
          >
            执行
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-line px-3.5 py-1 text-[11.5px] text-content-secondary transition-colors hover:text-content-primary"
          >
            取消
          </button>
        </div>
      )}
    </div>
  )
}

/** 自动模式回执卡:input 到 = 执行中;output 到 = 按结果渲染已执行/失败 */
function ExecCard({ input, state, output }: { input: OpInput; state?: string; output?: OpOutput }) {
  const label = opLabel(input)
  const done = state === 'output-available' && output?.ok
  const failed = state === 'output-available' && !output?.ok
  return (
    <div
      className={`w-full rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed transition-colors ${
        done
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : failed
            ? 'border-red-500/40 bg-red-500/5'
            : 'border-dashed border-accent/60 bg-surface'
      }`}
    >
      <span
        className={`mb-1.5 inline-block rounded-md px-2 py-0.5 text-[10px] font-bold ${
          done ? 'bg-emerald-500/15 text-emerald-600' : failed ? 'bg-red-500/15 text-red-500' : 'bg-accent-soft text-accent'
        }`}
      >
        {label}
      </span>
      {input.note && <div className="text-content-primary">{input.note}</div>}
      {done ? (
        <div className="mt-1.5 text-[11px] font-semibold text-emerald-600">
          ✓ 已执行{output?.detail ? ` · ${output.detail}` : ''}{output?.paper ? `（${output.paper}）` : ''}
        </div>
      ) : failed ? (
        <div className="mt-1.5 text-[11px] font-semibold text-red-500">
          ✗ 执行失败{output?.hint ? ` · ${output.hint}` : ''}
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-content-muted">
          <Loader2 className="h-3 w-3 animate-spin" /> 执行中…（不可撤销）
        </div>
      )}
    </div>
  )
}

/** 题源闸门回执卡(set_allow_ai) */
function AllowAiCard({ state, output }: { state?: string; output?: OpOutput }) {
  const done = state === 'output-available' && output?.ok
  const allow = output?.allow === true
  return (
    <div className={`w-full rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed ${done ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-dashed border-accent/60 bg-surface'}`}>
      <span
        className={`mb-1.5 inline-block rounded-md px-2 py-0.5 text-[10px] font-bold ${
          done ? 'bg-emerald-500/15 text-emerald-600' : 'bg-accent-soft text-accent'
        }`}
      >
        {allow ? '放行 AI 参考答案题' : '切回纯官方池'}
      </span>
      {done && output?.poolStats && (
        <div className="mt-0.5 text-[11px] text-content-secondary">
          池内现况：官方答案 {output.poolStats.official} 题 · AI 参考答案 {output.poolStats.ai} 题
        </div>
      )}
      {done ? (
        <div className="mt-1.5 text-[11px] font-semibold text-emerald-600">✓ 已切换{output?.note ? ` · ${output.note}` : ''}</div>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-content-muted">
          <Loader2 className="h-3 w-3 animate-spin" /> 切换中…
        </div>
      )}
    </div>
  )
}

const SUGGESTIONS = ['第 3 题太简单，换一道', '把第 2 题分值改成 4 分', '改成 60 分钟，卷名改成周末模拟卷']

export function ComposedAssistant({
  composedId,
  slots,
  paperTitle,
  onExecute,
}: {
  composedId: string
  slots: AssistantSlot[]
  paperTitle: string
  /** 走既有 PATCH 槽位操作,返回是否成功(失败时操作卡显示重试提示) */
  onExecute: (body: Record<string, unknown>, key: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [autoExecute, setAutoExecute] = useState(true)
  const [opStates, setOpStates] = useState<Record<string, OpState>>({})
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
  const autoRef = useRef(autoExecute)
  autoRef.current = autoExecute

  const chat = useChat({
    id: `assistant-${composedId}`,
    transport: useMemo(
      () =>
        new DefaultChatTransport<UIMessage>({
          api: `/api/papers/composed/${composedId}/assistant`,
          body: {
            get modelId() { return modelRef.current },
            get autoExecute() { return autoRef.current },
          },
        }),
      [composedId]
    ),
  })
  const busy = chat.status === 'submitted' || chat.status === 'streaming'

  // 自动模式:服务端已真执行,工具回执(output-available)出现即刷新卷面(满分/题号/卷名可能都变了)
  const serverDoneCount = useMemo(
    () =>
      chat.messages.reduce(
        (n, m) =>
          n +
          (m.parts as LoosePart[]).filter(
            (p) => (p.type === 'tool-exec_op' || p.type === 'tool-set_allow_ai') && p.state === 'output-available'
          ).length,
        0
      ),
    [chat.messages]
  )
  useEffect(() => {
    if (serverDoneCount > 0) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.papers.composed(composedId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.papers.composedList() })
    }
  }, [serverDoneCount, composedId, queryClient])

  const send = (text: string) => {
    const t = text.trim()
    if (!t || busy || !modelId) return
    void chat.sendMessage({ text: t })
  }

  const executeOp = async (callId: string, input: OpInput) => {
    const findSlot = (n?: number) => slots.find((s) => s.number === n)
    let body: Record<string, unknown> | null = null
    let key = ''
    if (input.op === 'replace' || input.op === 'remove') {
      const slot = findSlot(input.slotNumber)
      if (!slot) {
        setOpStates((prev) => ({ ...prev, [callId]: 'error' }))
        return
      }
      body = { op: input.op, slotId: slot.slotId }
      key = `assistant:${input.op}:${slot.slotId}`
    } else if (input.op === 'insert') {
      if (!input.paperQuestionId) {
        setOpStates((prev) => ({ ...prev, [callId]: 'error' }))
        return
      }
      body = { op: 'insert', paperQuestionId: input.paperQuestionId }
      key = `assistant:insert:${input.paperQuestionId}`
    } else if (input.op === 'retitle') {
      if (!input.title?.trim()) {
        setOpStates((prev) => ({ ...prev, [callId]: 'error' }))
        return
      }
      body = { op: 'retitle', title: input.title.trim() }
      key = 'assistant:retitle'
    } else if (input.op === 'rescore') {
      const slot = findSlot(input.slotNumber)
      if (!slot || !input.score) {
        setOpStates((prev) => ({ ...prev, [callId]: 'error' }))
        return
      }
      body = { op: 'rescore', slotId: slot.slotId, score: input.score }
      key = `assistant:rescore:${slot.slotId}:${input.score}`
    } else if (input.op === 'move') {
      const slot = findSlot(input.slotNumber)
      if (!slot || !input.toNumber) {
        setOpStates((prev) => ({ ...prev, [callId]: 'error' }))
        return
      }
      body = { op: 'move', slotId: slot.slotId, toNumber: input.toNumber }
      key = `assistant:move:${slot.slotId}:${input.toNumber}`
    } else if (input.op === 'resection') {
      if (!input.fromSection || !input.toSection) {
        setOpStates((prev) => ({ ...prev, [callId]: 'error' }))
        return
      }
      body = { op: 'resection', fromSection: input.fromSection, toSection: input.toSection }
      key = `assistant:resection:${input.fromSection}`
    } else if (input.op === 'reduration') {
      if (!input.durationMin) {
        setOpStates((prev) => ({ ...prev, [callId]: 'error' }))
        return
      }
      body = { op: 'reduration', durationMin: input.durationMin }
      key = `assistant:reduration:${input.durationMin}`
    }
    if (!body) return
    const ok = await onExecute(body, key)
    setOpStates((prev) => ({ ...prev, [callId]: ok ? 'executed' : 'error' }))
  }

  const renderMessages = () => {
    if (chat.messages.length === 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-accent-soft text-accent" aria-hidden>
            <Sparkles className="h-4 w-4" />
          </span>
          <p className="text-[12.5px] text-content-secondary">想改哪里，直接说</p>
          <p className="text-[11px] leading-relaxed text-content-muted">
            换题、加题、改分值、移题、改卷名、调时长；{autoExecute ? 'AI 说改就改，关掉开关则出卡等你确认' : 'AI 出操作卡，你确认才执行'}
          </p>
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-2">
        {chat.messages.map((m) => (
          <div key={m.id} className="flex flex-col gap-1.5">
            {m.parts.map((raw, i) => {
              const part = raw as LoosePart
              if (part.type === 'text' && part.text?.trim()) {
                const isUser = m.role === 'user'
                return (
                  <div
                    key={i}
                    className={`max-w-[92%] whitespace-pre-wrap rounded-xl px-3 py-1.5 text-[12px] leading-relaxed ${
                      isUser
                        ? 'self-end rounded-br-sm bg-accent text-accent-foreground'
                        : 'self-start rounded-bl-sm border border-line bg-surface text-content-primary'
                    }`}
                  >
                    {part.text}
                  </div>
                )
              }
              if (part.type === 'tool-exec_op' || part.type === 'tool-propose_op') {
                const input = (part.input ?? {}) as OpInput
                if (!input.op) return null
                if (part.type === 'tool-exec_op') {
                  return <ExecCard key={i} input={input} state={part.state} output={part.output as OpOutput | undefined} />
                }
                // 手动模式:保持点卡确认(操作不可撤销在 detail 里已说明)
                return (
                  <OpCard
                    key={i}
                    input={input}
                    state={part.toolCallId ? opStates[part.toolCallId] : undefined}
                    onExecute={() => part.toolCallId && void executeOp(part.toolCallId, input)}
                    onCancel={() => part.toolCallId && setOpStates((prev) => ({ ...prev, [part.toolCallId as string]: 'cancelled' }))}
                  />
                )
              }
              if (part.type === 'tool-set_allow_ai') {
                return <AllowAiCard key={i} state={part.state} output={part.output as OpOutput | undefined} />
              }
              return null
            })}
          </div>
        ))}
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
          <span className="block text-[12px] font-bold text-content-primary">AI 助手</span>
          <span className="block truncate text-[10px] text-content-muted">{paperTitle}</span>
        </span>
        {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-content-muted" />}
        {/* 自动执行开关(方案A,design/preview-assistant-autopilot.html):开=AI 说改就改,关=出卡等确认 */}
        <label className="flex flex-none items-center gap-1.5" title={autoExecute ? '自动执行:AI 直接改卷' : '手动:每步先出卡等你点执行'}>
          <span className="text-[10.5px] text-content-secondary">自动执行</span>
          <button
            type="button"
            role="switch"
            aria-checked={autoExecute}
            aria-label="自动执行开关"
            onClick={() => setAutoExecute((v) => !v)}
            className={`relative h-[17px] w-[30px] shrink-0 rounded-full transition-colors ${autoExecute ? 'bg-accent' : 'bg-line-strong'}`}
          >
            <span
              className={`absolute top-[2px] h-[13px] w-[13px] rounded-full bg-white shadow-sm transition-all ${autoExecute ? 'left-[15px]' : 'left-[2px]'}`}
            />
          </button>
        </label>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md p-1 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
          aria-label="收起助手"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* 消息流 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">{renderMessages()}</div>
      {/* 快捷建议(空会话时) */}
      {chat.messages.length === 0 && (
        <div className="flex flex-none flex-wrap gap-1.5 px-3 pb-1.5">
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
      {/* 输入行 */}
      <div className="flex flex-none items-center gap-1.5 border-t border-line px-3 py-2">
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
          placeholder={modelId ? '跟 AI 说想改哪里…' : '没有可用的 AI 模型'}
          disabled={!modelId || busy}
          className="h-8 min-w-0 flex-1 rounded-full border border-line bg-surface px-3 text-[12px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent disabled:opacity-50"
          aria-label="跟 AI 说想改哪里"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => chat.stop()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-subtle text-content-secondary transition-colors hover:text-content-primary"
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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            aria-label="发送"
          >
            <SendHorizontal className="h-3.5 w-3.5" />
          </button>
        )}
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
          title="AI 助手 · 想改哪里直接说"
          className="paper-assistant-print-hide absolute bottom-5 right-5 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-[0_4px_16px_rgb(10_132_255/0.4)] transition-transform hover:scale-105"
          aria-label="打开 AI 助手"
        >
          <Sparkles className="h-5 w-5" />
        </button>
      )}
      {open && (
        <>
          {/* ≥md:右缘停靠列,推挤卷面列 */}
          <aside className="paper-assistant-print-hide hidden h-full w-[400px] max-w-[46%] shrink-0 flex-col border-l border-line bg-surface md:flex">
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
