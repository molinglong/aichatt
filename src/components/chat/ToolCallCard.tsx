'use client'

import { memo, useState } from 'react'
import { BookOpen, BookX, Brain, Calculator, Check, ChevronDown, ClipboardCheck, Clock, Dumbbell, Fish, Globe, Link2, ListTodo, Loader2, Plug, ScrollText, Search, Settings2, TriangleAlert, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UIMessage } from 'ai'
import { ClarifyCard } from './ClarifyCard'
import { LocalFileCard } from './LocalFileCard'
import { GenerateMaskCard } from './GenerateMaskCard'
import { WriteDocCard } from './WriteDocCard'
import { WriteCodeCard } from './WriteCodeCard'
import { PreviewCheckCard } from './PreviewCheckCard'
import { TripMapCard } from './TripMapCard'
import { ProviderModelCard } from './ProviderModelCard'
import { AddCustomModelCard } from './AddCustomModelCard'
import { DeleteCustomModelCard } from './DeleteCustomModelCard'
import { CLARIFY_TOOL_NAME } from '@/lib/ai/clarify'
import { LOCAL_FILE_TOOL_NAME } from '@/lib/ai/local-file-tool'
import { MASK_TOOL_NAME } from '@/lib/ai/mask-tool'
import { WRITE_DOC_TOOL_NAME } from '@/lib/ai/write-doc-tool'
import { WRITE_CODE_TOOL_NAME } from '@/lib/ai/write-code-tool'
import { PREVIEW_CHECK_TOOL_NAME } from '@/lib/ai/preview-check-tool'
import { PROJECT_CHECK_TOOL_NAME } from '@/lib/ai/project-check-tool'
import { ProjectCheckCard } from './ProjectCheckCard'
import { TRIP_TOOL_NAME } from '@/lib/ai/trip-tool'
import { SETTINGS_TOOL_NAME } from '@/lib/ai/settings-tool'
import { PROVIDER_MODEL_TOOL_NAME } from '@/lib/ai/provider-model-tool'
import { ADD_CUSTOM_MODEL_TOOL_NAME } from '@/lib/ai/custom-model-tool'
import { DELETE_CUSTOM_MODEL_TOOL_NAME } from '@/lib/ai/delete-custom-model-tool'
import { MEMORY_TOOL_NAME } from '@/lib/ai/memory-tool'
import {
  KNOWLEDGE_TOOL_NAME,
  KNOWLEDGE_OUTLINE_TOOL_NAME,
  type KnowledgeToolOutput,
  type KnowledgeOutlineOutput,
} from '@/lib/ai/knowledge-tool'
import { PRACTICE_TOOL_NAME, RECORD_TOOL_NAME, type PracticeToolOutput } from '@/lib/ai/practice-tool'
import { PAPER_SEARCH_TOOL_NAME, PAPER_ANALYZE_TOOL_NAME, COMPOSE_PAPER_TOOL_NAME, type PaperSearchOutput, type PaperAnalyzeOutput, type ComposePaperOutput } from '@/lib/ai/paper-tool'
import { KnowledgeDetail, OutlineDetail, PracticeDetail, CalcDetail, PaperDetail, PaperAnalysisDetail, ComposeDetail } from './ToolDetailBlocks'
import { TODO_TOOL_NAME, type TodoToolOutput } from '@/lib/ai/todo-tool'
import { SAVE_WRONG_QUESTION_TOOL_NAME, type SaveWrongQuestionToolOutput } from '@/lib/ai/wrong-question-tool'
import { URL_READER_TOOL_NAME, type UrlReaderOutput } from '@/lib/ai/url-reader'
import { CALC_TOOL_NAME, type CalcOutput } from '@/lib/ai/calc-tool'
import { TIME_TOOL_NAME, type TimeToolOutput } from '@/lib/ai/time-tool'
import { YELLOW_FISH_TOOL_NAME, YELLOW_FISH_WATCH_TOOL_NAME, type YellowFishToolOutput, type YellowFishWatchToolOutput } from '@/lib/ai/yellow-fish-tool'
import { YELLOW_FISH_LIVE_TOOL_NAME, type YellowFishLiveToolOutput } from '@/lib/ai/yellow-fish-live-tool'
import { YellowFishLiveListings } from './YellowFishLiveListings'
import { parseMcpToolDisplay } from '@/lib/ai/mcp/mcp-constants'
import { getSettingDef, formatSettingValue } from '@/lib/settings/registry'
import { isRevertableSetting, revertSettingsOp } from '@/lib/settings/executor'
import { MiniSwitch } from '@/components/settings/MiniSwitch'
import { useChatStore } from '@/store/chat-store'

/**
 * 工具调用卡片 —— 渲染 AI 工具调用过程,让"模型查资料"对用户可见可信。
 *
 * 数据双来源(在 extractToolCallViews 中归一为 ToolCallView):
 * - 流式/当轮: UIMessage.parts 里 type 形如 'tool-<name>' 的 part(AI SDK v7 原生)
 * - 历史: Message.metadata 里 kind='tool_calls' 的持久化明细(chat route onFinish 写入)
 *
 * 渲染策略:
 * - web_search: 搜索中 spinner;完成后折叠为"已搜索 N 条来源",展开显示来源列表
 * - 未知工具: 灰色一行兜底(扩展位,阶段二/三的新工具走同一协议)
 */
export interface ToolCallView {
  /** 工具名(不含 'tool-' 前缀) */
  tool: string
  toolCallId?: string
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
  input: unknown
  output: unknown
  errorText?: string
}

/** web_search 工具的 output 形状(见 lib/ai/search.ts execute) */
interface WebSearchOutput {
  query?: string
  engine?: string
  results?: Array<{ title: string; url?: string; snippet?: string }>
  /** 图文混排白名单图(服务端过滤编号,见 lib/ai/search.ts EmbeddableImage) */
  images?: Array<{ n: number; url: string; description?: string; host: string; bytes?: number }>
  note?: string
  error?: string
}

function isWebSearchOutput(o: unknown): o is WebSearchOutput {
  return !!o && typeof o === 'object' && Array.isArray((o as WebSearchOutput).results)
}

/** 历史消息 metadata 的工具明细形状(chat route onFinish 写入) */
interface ToolCallsMetadata {
  kind: 'tool_calls'
  version?: number
  toolCalls?: Array<{ tool?: string; input?: unknown; output?: unknown }>
}

/**
 * 从 UIMessage 提取工具调用视图,流式 parts 优先,历史 metadata 兜底。
 * 两来源互斥(当轮消息 parts 必有数据;历史消息 parts 无 tool part 才读 metadata),不会重复渲染。
 */
export function extractToolCallViews(message: UIMessage): ToolCallView[] {
  // 来源 A: AI SDK 流式/当轮 parts(type 形如 'tool-<name>';dynamic-tool 暂不支持,v1 只处理静态工具)
  const partViews: ToolCallView[] = []
  for (const p of message.parts) {
    const t = (p as { type?: string }).type ?? ''
    if (!t.startsWith('tool-') || t === 'tool-') continue
    partViews.push({
      tool: t.slice(5),
      toolCallId: (p as { toolCallId?: string }).toolCallId,
      state: ((p as { state?: string }).state ?? 'input-available') as ToolCallView['state'],
      input: (p as { input?: unknown }).input,
      output: (p as { output?: unknown }).output,
      errorText: (p as { errorText?: string }).errorText,
    })
  }
  if (partViews.length > 0) return partViews
  // 来源 B: 历史消息(metadata.toolCalls,由 chat route onFinish 写入)
  const meta = (message as { metadata?: unknown }).metadata as ToolCallsMetadata | undefined
  if (meta?.kind === 'tool_calls' && Array.isArray(meta.toolCalls)) {
    return meta.toolCalls.map((c, i) => {
      const out = c.output as { error?: string } | undefined
      return {
        tool: c.tool ?? 'unknown',
        toolCallId: `persisted-${i}`,
        state: out?.error ? 'output-error' : 'output-available',
        input: c.input ?? null,
        output: c.output ?? null,
      }
    })
  }
  return []
}

/** 从 view 提取搜索关键词(input 流式期间可能不完整,优先读 output) */
function extractQuery(view: ToolCallView): string {
  if (isWebSearchOutput(view.output) && view.output.query) return view.output.query
  const q = (view.input as { query?: string } | undefined)?.query
  return typeof q === 'string' ? q : ''
}

/** 图文混排: 正文 [图N] 占位符可引用的一张白名单图(与服务端 EmbeddableImage 同构) */
export interface InlineImageRef {
  n: number
  url: string
  description?: string
  host: string
  bytes?: number
}

/**
 * 从消息里提取全部可引用插图,按工具调用顺序摊平。
 * 双来源与 extractToolCallViews 一致(流式 parts / 历史 metadata.toolCalls),
 * 编号冲突(多次搜索各自从 1 编)时先到先得 —— 服务端 note 已约束模型只用一组。
 */
export function extractInlineImages(message: UIMessage): InlineImageRef[] {
  const collect = (views: ToolCallView[]): InlineImageRef[] => {
    const out: InlineImageRef[] = []
    const seen = new Set<number>()
    for (const v of views) {
      if (v.tool !== 'web_search') continue
      const out0 = v.output as WebSearchOutput | undefined
      for (const img of out0?.images ?? []) {
        if (typeof img?.n !== 'number' || typeof img?.url !== 'string' || seen.has(img.n)) continue
        seen.add(img.n)
        out.push(img)
      }
    }
    return out
  }
  // 流式 parts 优先;为空再翻历史 metadata(与 extractToolCallViews 同款双来源)
  const views: ToolCallView[] = []
  for (const p of message.parts) {
    const t = (p as { type?: string }).type ?? ''
    if (!t.startsWith('tool-') || t === 'tool-') continue
    views.push({
      tool: t.slice(5),
      toolCallId: (p as { toolCallId?: string }).toolCallId,
      state: ((p as { state?: string }).state ?? 'input-available') as ToolCallView['state'],
      input: (p as { input?: unknown }).input,
      output: (p as { output?: unknown }).output,
      errorText: (p as { errorText?: string }).errorText,
    })
  }
  const partImages = collect(views)
  if (partImages.length > 0) return partImages
  const meta = (message as { metadata?: unknown }).metadata as ToolCallsMetadata | undefined
  if (meta?.kind === 'tool_calls' && Array.isArray(meta.toolCalls)) {
    return collect(
      meta.toolCalls.map((c, i) => {
        const out = c.output as { error?: string } | undefined
        return {
          tool: c.tool ?? 'unknown',
          toolCallId: `persisted-${i}`,
          state: out?.error ? ('output-error' as const) : ('output-available' as const),
          input: c.input ?? null,
          output: c.output ?? null,
        }
      })
    )
  }
  return []
}

/**
 * 一行式工具卡片基础件:统一容器/图标/文案/状态反馈。
 * 中性灰规范:反馈色仅小面积 —— 失败态容器保持中性灰,红色只落在
 * 右侧「未生效」文案与警号图标上;成功态用 muted 色 Check,不打扰。
 * 流式(input-streaming)显示 spinner,提示"参数正在生成/正在执行"。
 */
function ToolRow({
  icon,
  text,
  streaming = false,
  failed = false,
  details,
}: {
  icon: React.ReactNode
  text: string
  streaming?: boolean
  failed?: boolean
  /**
   * 展开区(可选):提供后整行可点,点开看这次调用的具体内容。
   * 缺省保持原一行式 —— 状态类卡片(记忆/待办/设置/验算)不提供详情,行为不变。
   */
  details?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const head = (
    <>
      <span className="flex shrink-0 items-center text-content-secondary">{icon}</span>
      <span className="min-w-0 truncate text-content-secondary">{text}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {streaming ? (
          <Loader2 className="w-3 h-3 animate-spin text-content-muted" />
        ) : failed ? (
          <>
            <span className="text-red-500">未生效</span>
            <TriangleAlert className="w-3 h-3 text-red-500" />
          </>
        ) : (
          <Check className="w-3 h-3 text-content-muted" />
        )}
      </span>
    </>
  )

  if (!details) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-lg border border-line/60 bg-surface-muted px-2.5 py-1.5 text-xs"
        title={text}
      >
        {head}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-line/60 bg-surface-muted overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-surface-subtle transition-colors"
        title={text}
      >
        {head}
        <ChevronDown className={cn('w-3 h-3 shrink-0 text-content-muted transition-transform', open ? '' : '-rotate-90')} />
      </button>
      {/* 展开区:内容懒挂载(默认不跑 markdown/KaTeX),高度过渡与 web_search 同款 */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="overflow-hidden">
          {open && (
            <div className="max-h-[340px] overflow-y-auto overscroll-contain border-t border-line/50 px-2.5 py-2">
              {details}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** MCP 工具参数摘要:取 input 里第一个非空字符串字段截断(通用,不绑定具体工具 schema) */
function mcpArgBrief(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  for (const v of Object.values(input as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim().replace(/\s+/g, ' ')
      return s.length > 42 ? `${s.slice(0, 42)}…` : s
    }
  }
  return ''
}

/** MCP 错误摘要:压缩空白后截断 —— 一行式卡片放不下长堆栈,保留可读根因 */
function mcpErrBrief(err: string | undefined | null): string {
  if (!err) return ''
  const s = err.replace(/\s+/g, ' ').trim()
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

/** 闲鱼行情详情区（行情概览/每日走势/最近商品/note）—— get_yellow_fish_market 与
 *  add_yellow_fish_watch 两个分支共用的渲染；两工具的行情子字段同形（见 yellow-fish-tool.ts）。 */
function YellowFishMarketDetails({
  out,
}: {
  out: Pick<
    YellowFishToolOutput,
    'keyword' | 'matchedKeyword' | 'market' | 'history' | 'dailyTrend' | 'recentItems' | 'note'
  >
}) {
  const yuan = (v?: number | null) => (v == null ? '—' : String(v))
  const money = (v?: number | null) => (v == null ? '—' : `¥${v}`)
  const m = out.market
  return (
    <div className="space-y-3 py-0.5">
      {/* 行情概览：拆成均价/中位/区间/样本四个指标块，黑白灰分层 */}
      <div>
        <div className="mb-2 text-[11px] font-medium tracking-wide text-content-muted">
          行情概览 · {out.matchedKeyword || out.keyword}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
          {[
            { label: '均价', value: money(m?.avg) },
            { label: '中位', value: money(m?.median) },
            { label: '区间', value: m?.min != null && m?.max != null ? `${money(m.min)}~${money(m.max)}` : '—' },
            { label: '样本', value: String(m?.sampleCount ?? 0) },
          ].map((c) => (
            <div key={c.label}>
              <div className="text-[11px] text-content-muted">{c.label}</div>
              <div className="mt-0.5 text-sm font-medium tabular-nums text-content-primary">{c.value}</div>
            </div>
          ))}
        </div>
        {m?.snapshotTime ? (
          <div className="mt-2 text-[11px] text-content-muted">
            抓取时间 {String(m.snapshotTime).slice(0, 16).replace('T', ' ')}
          </div>
        ) : null}
      </div>

      {/* 每日均价走势：≥2 天才展示 */}
      {out.dailyTrend && out.dailyTrend.length > 1 ? (
        <div className="border-t border-line/50 pt-2.5">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-content-muted">每日均价走势</div>
          <ul className="space-y-1">
            {out.dailyTrend.map((p) => (
              <li key={p.day} className="flex items-baseline gap-2 text-xs">
                <span className="tabular-nums text-content-secondary">{p.day}</span>
                <span className="font-medium tabular-nums text-content-primary">¥{yuan(p.avg)}</span>
                <span className="tabular-nums text-content-muted">¥{yuan(p.min)}~¥{yuan(p.max)} · {p.sampleCount}件</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 最近商品：缩略图 + 价格/地区/时间顶栏 + 两行标题 */}
      {out.recentItems && out.recentItems.length > 0 ? (
        <div className="border-t border-line/50 pt-2.5">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-content-muted">最近商品</div>
          <ul className="space-y-2.5">
            {out.recentItems.map((it, idx) => {
              const metaParts = [it.region, it.publishTime ? String(it.publishTime).slice(5, 10) : ''].filter(Boolean)
              return (
                <li key={it.link || idx} className="flex items-start gap-2.5">
                  {it.image ? (
                    <img
                      src={it.image}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="h-12 w-12 shrink-0 rounded-md object-cover bg-black/5 dark:bg-white/10 select-none"
                    />
                  ) : (
                    <div className="h-12 w-12 shrink-0 rounded-md bg-black/5 dark:bg-white/10" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium tabular-nums text-content-primary">
                        {it.price != null ? `¥${it.price}` : (it.priceDisplay || '—')}
                      </span>
                      {metaParts.length > 0 ? (
                        <span className="shrink-0 text-[11px] tabular-nums text-content-muted">{metaParts.join(' · ')}</span>
                      ) : null}
                    </div>
                    {it.link ? (
                      <a
                        href={it.link}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 line-clamp-2 text-xs leading-snug text-content-secondary hover:underline"
                      >
                        {it.title}
                      </a>
                    ) : (
                      <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-content-secondary">{it.title}</div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      {out.note ? (
        <div className="border-t border-line/50 pt-2 text-[11px] leading-relaxed text-content-muted">{out.note}</div>
      ) : null}
    </div>
  )
}

/** ToolCallCard 渲染入参:除工具视图外,携带澄清卡片的交互回调与已答状态 */
interface ToolCallCardProps {
  view: ToolCallView
  /** ask_clarification:该消息之后是否已有 user 消息(已答则卡片锁定) */
  clarifyAnswered?: boolean
  /** ask_clarification:提交回答文本(走 sendMessage 全链路);缺省则卡片只读 */
  onClarifySubmit?: (answersText: string) => void
  /** local_file:决策(批准/拒绝);缺省则待确认卡片只读 */
  onLocalFileDecision?: (
    toolCallId: string,
    path: string,
    approved: boolean,
    decision: import('@/lib/ai/local-file-tool').LocalFileDecision
  ) => void
  /** local_file:在编辑器中打开(Monaco 侧栏面板);缺省则不显示按钮 */
  onOpenEditor?: (path: string) => void
}

function ToolCallCardInner({ view, clarifyAnswered, onClarifySubmit, onLocalFileDecision, onOpenEditor }: ToolCallCardProps) {
  // hooks 置顶(web_search 的展开状态),避免条件 return 造成 hooks 顺序不稳定
  const [manual, setManual] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [revokedKeys, setRevokedKeys] = useState<Set<string>>(new Set())

  // 澄清提问:专用交互卡片(问题+选项点选),不进通用工具卡分支
  if (view.tool === CLARIFY_TOOL_NAME) {
    return <ClarifyCard view={view} answered={clarifyAnswered ?? false} onSubmit={onClarifySubmit} />
  }

  // 本地文件操作:专用卡片(create 自动执行展示结果;delete 待确认→批准后执行)。
  // 外层带 data-tcid:待批准钉住横幅据它滚动定位到卡片(ChatPanel)
  if (view.tool === LOCAL_FILE_TOOL_NAME) {
    return (
      <div data-tcid={view.toolCallId}>
        <LocalFileCard view={view} onDecision={onLocalFileDecision} onOpenEditor={onOpenEditor} />
      </div>
    )
  }

  // 面具工坊:专用交互卡片(草稿预览+一键添加),不进通用工具卡分支
  if (view.tool === MASK_TOOL_NAME) {
    return <GenerateMaskCard view={view} />
  }

  // 服务商模型管理:确认卡片(用户点确认才写入;移除带二次确认+计算题防护)
  if (view.tool === PROVIDER_MODEL_TOOL_NAME) {
    return <ProviderModelCard view={view} />
  }

  // 中转站/自定义模型:确认卡片(Key 由用户在卡片里就地粘贴并测试;Key 不进对话记录)
  if (view.tool === ADD_CUSTOM_MODEL_TOOL_NAME) {
    return <AddCustomModelCard view={view} />
  }

  // 删除自定义模型:确认卡片(聊天/生图两库;二次确认+计算题双层防护)
  if (view.tool === DELETE_CUSTOM_MODEL_TOOL_NAME) {
    return <DeleteCustomModelCard view={view} />
  }

  // 写作文档:一行式卡片(成功→打开按钮;流式→占位;失败→标红)
  if (view.tool === WRITE_DOC_TOOL_NAME) {
    return <WriteDocCard view={view} />
  }

  // 代码文档:与写作文档对称(成功自动滑出代码编辑器面板)
  if (view.tool === WRITE_CODE_TOOL_NAME) {
    return <WriteCodeCard view={view} />
  }

  // 预览验证:preview_check 结果(通过/报错清单/不可验证)
  if (view.tool === PREVIEW_CHECK_TOOL_NAME) {
    return <PreviewCheckCard view={view} />
  }

  // 项目检查:project_check 结果(通过/未通过+输出/未能执行)
  if (view.tool === PROJECT_CHECK_TOOL_NAME) {
    return <ProjectCheckCard view={view} />
  }

  // 行程规划:地图卡片(AI 结构化行程,前端段间真实路径规划+时间线联动+全屏总览)
  if (view.tool === TRIP_TOOL_NAME) {
    return <TripMapCard view={view} />
  }

  // AI 设置控制:开关列表式卡片 —— 每条操作一行「名称 → 值」+ 右侧开关;开关默认开(已应用),
  // 点掉即撤销该条(回到 AI 改动前的原值);流式/失败/无操作时退化为一行式 ToolRow。
  if (view.tool === SETTINGS_TOOL_NAME) {
    const ops =
      (view.input as { operations?: Array<{ key: string; value: string }> } | undefined)?.operations ?? []
    const failed =
      view.state === 'output-error' || (view.output as { ok?: boolean } | undefined)?.ok === false
    const streaming = view.state === 'input-streaming' || view.state === 'input-available'
    const toolCallId = view.toolCallId
    const isPersisted = !!toolCallId?.startsWith('persisted-')

    // 退化:流式/失败/无操作时保持原一行式(状态提示更清晰)
    if (streaming || failed || ops.length === 0) {
      const text =
        ops.length > 0
          ? `应用设置：${ops
              .map((op) => `${getSettingDef(op.key)?.label ?? op.key}→${formatSettingValue(op.key, op.value)}`)
              .join('、')}`
          : '应用设置'
      return <ToolRow icon={<Settings2 className="w-3.5 h-3.5" />} text={text} streaming={streaming} failed={failed} />
    }

    return (
      <div className="rounded-lg border border-line/60 bg-surface-muted overflow-hidden text-xs">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5">
          <Settings2 className="w-3.5 h-3.5 shrink-0 text-content-secondary" />
          <span className="text-content-secondary">应用设置</span>
          <span className="ml-auto text-content-muted">{ops.length} 项</span>
        </div>
        <div className="flex flex-col border-t border-line/50">
          {ops.map((op, i) => {
            const label = getSettingDef(op.key)?.label ?? op.key
            const valueText = formatSettingValue(op.key, op.value)
            const revoked = revokedKeys.has(op.key)
            const canRevert = !isPersisted && !!toolCallId && isRevertableSetting(op.key)
            return (
              <div key={`${op.key}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5">
                <span className={cn('min-w-0 flex-1 truncate', revoked && 'text-content-muted line-through')}>
                  {label} <span className="text-content-muted">→</span> {valueText}
                </span>
                <MiniSwitch
                  on={!revoked}
                  disabled={!canRevert}
                  onClick={() => {
                    if (!canRevert || !toolCallId) return
                    if (revertSettingsOp(toolCallId, op.key)) {
                      setRevokedKeys((s) => new Set(s).add(op.key))
                    }
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // 显式记忆添加:一行式卡片列出已保存的记忆内容;服务端写库,这里只展示
  if (view.tool === MEMORY_TOOL_NAME) {
    const items =
      (view.input as { memories?: Array<{ content?: string }> } | undefined)?.memories ?? []
    const out = view.output as { ok?: boolean; saved?: string[] } | undefined
    const failed = view.state === 'output-error' || out?.ok === false
    // 展示优先用服务端确认的实际入库内容(execute 会去重/拒超长),流式期间回退到 input
    const contents = out?.saved?.length ? out.saved : items.map((m) => m.content ?? '').filter(Boolean)
    const text =
      contents.length > 0
        ? `${view.state === 'output-available' && !failed ? '已记住' : '记住'}：${contents.join('；')}`
        : view.state === 'input-streaming'
          ? '正在保存记忆…'
          : '保存记忆'
    return <ToolRow icon={<Brain className="w-3.5 h-3.5" />} text={text} streaming={view.state === 'input-streaming'} failed={failed} />
  }

  // 待办管理:一行式卡片,按操作类型展示;服务端写库,这里只展示
  if (view.tool === TODO_TOOL_NAME) {
    const input = view.input as
      | {
          operation?: string
          items?: Array<{ content?: string }>
          match?: string
          update?: { content?: string; dueAt?: string }
        }
      | undefined
    const out = view.output as TodoToolOutput | undefined
    const failed = view.state === 'output-error' || out?.ok === false
    const op = out?.operation ?? input?.operation
    // 展示优先用服务端确认的实际入库内容,流式期间回退 input 预览
    let text: string
    if (view.state === 'input-streaming') {
      const preview = input?.items?.map((t) => t.content ?? '').filter(Boolean).join('；')
      text = preview ? `正在添加待办「${preview}」…` : input?.match ? `正在操作待办「${input.match}」…` : '正在操作待办…'
    } else if (out?.candidates?.length) {
      // 模糊匹配命中多条:列出候选项,由模型向用户澄清
      text = `待办匹配到多条：${out.candidates.join('；')}`
    } else if (out?.ok === false && out.message) {
      text = `未生效：${out.message}`
    } else if (op === 'add' && out?.added?.length) {
      text = `已添加待办：${out.added.map((t) => t.content).join('；')}`
    } else if (op === 'complete' && out?.completed?.length) {
      text = `已完成：${out.completed.join('；')}`
    } else if (op === 'update' && out?.updated?.length) {
      text = `已更新：${out.updated.join('；')}`
    } else if (op === 'delete' && out?.deleted?.length) {
      text = `已删除：${out.deleted.join('；')}`
    } else if (op === 'list' && out?.todos) {
      const undone = out.todos.filter((t) => !t.done).length
      text = undone > 0 ? `查看待办 · ${undone} 条未完成` : '查看待办 · 列表为空或已全部完成'
    } else {
      text = failed ? '待办操作未生效' : '待办操作'
    }
    return <ToolRow icon={<ListTodo className="w-3.5 h-3.5" />} text={text} streaming={view.state === 'input-streaming'} failed={failed} />
  }

  // 错题本存入:一行式卡片;服务端写库(captureStudyNote 幂等),这里只展示
  if (view.tool === SAVE_WRONG_QUESTION_TOOL_NAME) {
    const wOut = view.output as SaveWrongQuestionToolOutput | undefined
    const wFailed = view.state === 'output-error' || !!wOut?.error
    const wPending = view.state === 'input-streaming' || view.state === 'input-available'
    const wText = wPending
      ? '正在存入错题本…'
      : wFailed
        ? '存入错题本未生效'
        : wOut?.created
          ? `已存入错题本「${wOut.title || '题目'}」，进入今日复习队列`
          : '该题此前已存入错题本'
    return <ToolRow icon={<BookX className="w-3.5 h-3.5" />} text={wText} streaming={wPending} failed={wFailed} />
  }

  // 课本目录:一行式卡片;完成后显示“几本 / 几个框题”,展开看章-节-框题树
  if (view.tool === KNOWLEDGE_OUTLINE_TOOL_NAME) {
    const oIn = view.input as { title?: string; subject?: string } | undefined
    const oOut = view.output as KnowledgeOutlineOutput | undefined
    const oDocs = oOut?.docs ?? []
    const oTitle = oIn?.title || oDocs[0]?.title || ''
    const oHeadings = oDocs.reduce(
      (sum, d) => sum + (d.chapters ?? []).reduce((s, c) => s + (c.sections ?? []).reduce((n, x) => n + (x.headings?.length ?? 0), 0), 0),
      0
    )
    const oFailed = view.state === 'output-error' || !!oOut?.error
    const oText =
      view.state === 'input-streaming'
        ? `正在翻课本目录「${oTitle}」…`
        : oFailed
          ? `翻课本目录「${oTitle}」未生效`
          : oDocs.length > 0
            ? `翻课本目录「${oTitle}」· ${oDocs.length} 本 / ${oHeadings} 个条目`
            : `课本目录「${oTitle}」未找到`
    return (
      <ToolRow
        icon={<BookOpen className="w-3.5 h-3.5" />}
        text={oText}
        streaming={view.state === 'input-streaming'}
        failed={oFailed}
        details={!oFailed && oDocs.length > 0 ? <OutlineDetail docs={oDocs} /> : undefined}
      />
    )
  }

  // 课本知识库检索:一行式卡片;流式显示检索词,完成后显示命中段数,展开看每段出处与原文
  if (view.tool === KNOWLEDGE_TOOL_NAME) {
    const kOut = view.output as KnowledgeToolOutput | undefined
    const kQuery = kOut?.query ?? (view.input as { query?: string } | undefined)?.query ?? ''
    const kCount = kOut?.results?.length ?? 0
    const kFailed = view.state === 'output-error' || !!kOut?.error
    const kText =
      view.state === 'input-streaming'
        ? `正在翻课本「${kQuery}」…`
        : kFailed
          ? `查课本「${kQuery}」未生效`
          : kCount > 0
            ? `查课本「${kQuery}」· 命中 ${kCount} 段`
            : `查课本「${kQuery}」· 课本中未找到`
    return (
      <ToolRow
        icon={<BookOpen className="w-3.5 h-3.5" />}
        text={kText}
        streaming={view.state === 'input-streaming'}
        failed={kFailed}
        details={!kFailed && kCount > 0 ? <KnowledgeDetail results={kOut!.results} /> : undefined}
      />
    )
  }

  // 真题检索:一行式卡片;流式显示检索词,完成后显示命中题数与考点数,展开看考次统计与题目出处
  if (view.tool === PAPER_SEARCH_TOOL_NAME) {
    const psOut = view.output as PaperSearchOutput | undefined
    const psQuery = psOut?.query ?? (view.input as { query?: string } | undefined)?.query ?? ''
    const psCount = psOut?.results?.length ?? 0
    const psTopics = psOut?.topicCounts?.length ?? 0
    const psFailed = view.state === 'output-error' || !!psOut?.error
    const psText =
      view.state === 'input-streaming'
        ? `正在翻试卷「${psQuery}」…`
        : psFailed
          ? `查真题「${psQuery}」未生效`
          : psCount > 0 || psTopics > 0
            ? `查真题「${psQuery}」· 命中 ${psCount} 题${psTopics ? ` · ${psTopics} 个考点考次` : ''}`
            : `查真题「${psQuery}」· 真题中未找到`
    return (
      <ToolRow
        icon={<ScrollText className="w-3.5 h-3.5" />}
        text={psText}
        streaming={view.state === 'input-streaming'}
        failed={psFailed}
        details={!psFailed && psCount + psTopics > 0 ? <PaperDetail output={psOut!} /> : undefined}
      />
    )
  }

  if (view.tool === PAPER_ANALYZE_TOOL_NAME) {
    const paOut = view.output as PaperAnalyzeOutput | undefined
    const paPapers = paOut?.overview?.length ?? 0
    const paTopics = paOut?.topicStats?.length ?? 0
    const paWeak = paOut?.weakTopics?.length ?? 0
    const paFailed = view.state === 'output-error' || !!paOut?.error
    const paText =
      view.state === 'input-streaming'
        ? '正在整理试卷库…'
        : paFailed
          ? '整理试卷未生效'
          : paPapers > 0 || paTopics > 0
            ? `整理试卷 · ${paPapers} 套卷 · ${paTopics} 个考点${paWeak ? ` · ${paWeak} 个薄弱考点` : ''}`
            : '整理试卷 · 试卷库还没有卷子'
    return (
      <ToolRow
        icon={<ScrollText className="w-3.5 h-3.5" />}
        text={paText}
        streaming={view.state === 'input-streaming'}
        failed={paFailed}
        details={!paFailed && paPapers + paTopics > 0 ? <PaperAnalysisDetail output={paOut!} /> : undefined}
      />
    )
  }

  // 智能拟卷:一行式卡片;流式「正在组卷」,完成后显示卷名/题数/总分,展开有卷面页入口与来源声明。
  // 整卷内容不进聊天——换题/删题/打印都在卷面页(与工具 note 纪律一致)
  if (view.tool === COMPOSE_PAPER_TOOL_NAME) {
    const cpOut = view.output as ComposePaperOutput | undefined
    const cpFailed = view.state === 'output-error' || cpOut?.ok === false || !!cpOut?.error
    const cpText =
      view.state === 'input-streaming'
        ? '正在从试卷库组卷…'
        : cpFailed
          ? '组卷未生效'
          : cpOut?.title
            ? `拟卷「${cpOut.title}」· ${cpOut.questionCount ?? 0} 题 · ${cpOut.totalScore ?? 0} 分`
            : '已组卷'
    return (
      <ToolRow
        icon={<ScrollText className="w-3.5 h-3.5" />}
        text={cpText}
        streaming={view.state === 'input-streaming'}
        failed={cpFailed}
        details={!cpFailed && cpOut?.composedId ? <ComposeDetail output={cpOut} /> : undefined}
      />
    )
  }

  // 题库抽题:一行式卡片;流式显示抽题条件,完成后显示抽到几道;0 道时明确告知题库无匹配。
  // 展开只看题干(答案仅模型判分用,展示即剧透)
  if (view.tool === PRACTICE_TOOL_NAME) {
    const pIn = view.input as { topic?: string; year?: string; kind?: string } | undefined
    const pOut = view.output as PracticeToolOutput | undefined
    const pItems = pOut?.items ?? []
    const pFailed = view.state === 'output-error' || !!pOut?.error
    const pBrief = [
      pIn?.year ? `${pIn.year}年` : '',
      pIn?.topic ?? '',
      pIn?.kind === 'choice' ? '选择题' : pIn?.kind === 'answer' ? '解答题' : '',
    ]
      .filter(Boolean)
      .join('·')
    const pPending = view.state === 'input-streaming' || view.state === 'input-available'
    const pText = pPending
      ? pBrief
        ? `正在抽题「${pBrief}」…`
        : '正在抽题…'
      : pFailed
        ? '抽题未生效'
        : pItems.length > 0
          ? pBrief
            ? `已抽 ${pItems.length} 道题「${pBrief}」`
            : `已抽 ${pItems.length} 道题`
          : '题库暂无匹配题目'
    return (
      <ToolRow
        icon={<Dumbbell className="w-3.5 h-3.5" />}
        text={pText}
        streaming={pPending}
        failed={pFailed}
        details={!pFailed && pItems.length > 0 ? <PracticeDetail items={pItems} /> : undefined}
      />
    )
  }

  // 判分回传:一行式卡片;完成后显示登记题数与新收错题数(答错自动进错题本)
  if (view.tool === RECORD_TOOL_NAME) {
    const rOut = view.output as
      | { processed?: number; wrongRecorded?: number; existingReused?: number; missing?: number; error?: string }
      | undefined
    const rFailed = view.state === 'output-error' || !!rOut?.error
    const rPending = view.state === 'input-streaming' || view.state === 'input-available'
    const rText = rPending
      ? '正在登记作答…'
      : rFailed
        ? '记录作答未生效'
        : [
            `已登记 ${rOut?.processed ?? 0} 题作答`,
            rOut?.wrongRecorded ? `新收 ${rOut.wrongRecorded} 道错题` : '',
            rOut?.existingReused ? `${rOut.existingReused} 道已在错题本` : '',
            rOut?.missing ? `${rOut.missing} 题未找到` : '',
          ]
            .filter(Boolean)
            .join(' · ')
    return <ToolRow icon={<ClipboardCheck className="w-3.5 h-3.5" />} text={rText} streaming={rPending} failed={rFailed} />
  }

  // 全文阅读:一行式卡片;流式显示目标域名,完成后显示类型与域名;服务端 fetch,这里只展示
  // streaming 涵盖 input-available:服务端 fetch 最长 15s,这期间必须持续转圈避免“假卡死”
  if (view.tool === URL_READER_TOOL_NAME) {
    const input = view.input as { url?: string } | undefined
    const out = view.output as UrlReaderOutput | undefined
    const failed = view.state === 'output-error' || !!out?.error
    const url = out?.url ?? input?.url ?? ''
    const host = hostOf(url)
    const kindLabel = out?.kind === 'pdf' ? 'PDF' : out?.kind === 'text' ? '文本' : '网页'
    const pending = view.state === 'input-streaming' || view.state === 'input-available'
    const text =
      pending
        ? host
          ? `正在读取 ${host}…`
          : '正在读取链接…'
        : failed
          ? `读取${host ? ` ${host}` : '链接'}未生效`
          : `已读取${kindLabel} · ${host}`
    return <ToolRow icon={<Link2 className="w-3.5 h-3.5" />} text={text} streaming={pending} failed={failed} />
  }

  // 验算：一行式「表达式 = 结果」，多行结果只取最后一行（前面是中间变量）；
  // purpose 有值时作前缀，让用户知道这步在验什么。展开看完整表达式、每一步结果与报错原文。
  if (view.tool === CALC_TOOL_NAME) {
    const input = view.input as { expression?: string; purpose?: string } | undefined
    const out = view.output as CalcOutput | undefined
    const failed = view.state === 'output-error' || !!out?.error
    const pending = view.state === 'input-streaming' || view.state === 'input-available'
    const expr = (out?.expression ?? input?.expression ?? '').replace(/\s*\n\s*/g, '; ').trim()
    const purpose = out?.purpose ?? input?.purpose
    const shortExpr = expr.length > 60 ? `${expr.slice(0, 60)}…` : expr
    const lastLine = (out?.result ?? '').split('\n').filter(Boolean).pop() ?? ''
    const text = pending
      ? `正在验算${shortExpr ? ` ${shortExpr}` : '…'}`
      : failed
        ? `验算未生效${shortExpr ? ` · ${shortExpr}` : ''}`
        : `${purpose ? `${purpose} · ` : ''}${shortExpr} = ${lastLine}`
    return (
      <ToolRow
        icon={<Calculator className="w-3.5 h-3.5" />}
        text={text}
        streaming={pending}
        failed={failed}
        details={
          !pending && expr ? (
            <CalcDetail
              expression={out?.expression ?? input?.expression ?? expr}
              tex={out?.tex}
              result={out?.result}
              error={out?.error ?? view.errorText}
              purpose={purpose}
            />
          ) : undefined
        }
      />
    )
  }

  // 实时时间：一行式直接给结果。与验算同属无副作用的即时读取，不提供展开区。
  if (view.tool === TIME_TOOL_NAME) {
    const out = view.output as TimeToolOutput | undefined
    const pending = view.state === 'input-streaming' || view.state === 'input-available'
    const failed = view.state === 'output-error' || !!out?.error
    const text = pending
      ? '正在读取当前时间…'
      : failed
        ? '读取当前时间未生效'
        : out?.human
          ? `当前时间 ${out.human}`
          : '已读取当前时间'
    return (
      <ToolRow
        icon={<Clock className="w-3.5 h-3.5" />}
        text={text}
        streaming={pending}
        failed={failed}
      />
    )
  }

  // 闲鱼行情：一行式「关键词 · 均价」，展开看区间/每日走势/最近商品（走 ToolRow 详情区）。
  // 未连通（available=false）只给一行式降级卡，具体原因由模型正文解释。
  if (view.tool === YELLOW_FISH_TOOL_NAME) {
    const input = view.input as { keyword?: string } | undefined
    const out = view.output as YellowFishToolOutput | undefined
    const pending = view.state === 'input-streaming' || view.state === 'input-available'
    const keyword = out?.keyword || input?.keyword || ''
    const failed = view.state === 'output-error' || (out ? out.available === false : false)
    const avg = out?.market?.avg
    const text = pending
      ? `正在查闲鱼行情${keyword ? ` · ${keyword}` : ''}…`
      : failed
        ? `闲鱼行情未连通${keyword ? ` · ${keyword}` : ''}`
        : out?.available && avg != null
          ? `YellowFish 行情 · ${out.matchedKeyword || keyword} · 均价 ¥${avg}`
          : out?.available
            ? `YellowFish 行情 · ${out.matchedKeyword || keyword} · 暂无价格样本`
            : '已查询闲鱼行情'
    return (
      <ToolRow
        icon={<Fish className="w-3.5 h-3.5" />}
        text={text}
        streaming={pending}
        failed={failed}
        details={out && out.available ? <YellowFishMarketDetails out={out} /> : undefined}
      />
    )
  }

  // 闲鱼建监控闭环：一行式「建好/在爬/失败」，出行情时复用行情详情区。
  // 软状态（已开爬/任务在跑/超时兜底）不算失败，给正常色 + 说明；只有 error 才标红。
  if (view.tool === YELLOW_FISH_WATCH_TOOL_NAME) {
    const input = view.input as { keyword?: string } | undefined
    const out = view.output as YellowFishWatchToolOutput | undefined
    const pending = view.state === 'input-streaming' || view.state === 'input-available'
    const keyword = out?.keyword || input?.keyword || ''
    const failed = view.state === 'output-error' || !!out?.error
    const waiting = !!out && !out.available && !out.error
    const avg = out?.market?.avg
    const text = pending
      ? `正在建闲鱼监控${keyword ? ` · ${keyword}` : ''}…`
      : failed
        ? `建监控未成功${keyword ? ` · ${keyword}` : ''}`
        : out?.available && avg != null
          ? `监控行情 · ${out.matchedKeyword || keyword} · 均价 ¥${avg}`
          : out?.available
            ? `监控行情 · ${out.matchedKeyword || keyword} · 暂无价格样本`
            : waiting
              ? `监控已开跑 · ${keyword} · 稍后问行情`
              : '已处理监控任务'
    return (
      <ToolRow
        icon={<Fish className="w-3.5 h-3.5" />}
        text={text}
        streaming={pending}
        failed={failed}
        details={
          out && out.available ? (
            <YellowFishMarketDetails out={out} />
          ) : waiting && out?.note ? (
            <div className="py-0.5 text-[11px] leading-relaxed text-content-muted">{out.note}</div>
          ) : undefined
        }
      />
    )
  }

  // YellowFish 实时价（goofish-cli 桥）：一行式「区间 · 采样」，展开看在售列表。
  // 限频/失败一行式降级；真实搜索样本与推荐流在列表里区分标注。
  if (view.tool === YELLOW_FISH_LIVE_TOOL_NAME) {
    const input = view.input as { keyword?: string } | undefined
    const out = view.output as YellowFishLiveToolOutput | undefined
    const pending = view.state === 'input-streaming' || view.state === 'input-available'
    const keyword = out?.keyword || input?.keyword || ''
    const cookieExpired = out?.cookieExpired === true
    const failed = view.state === 'output-error' || !!out?.error || out?.rateLimited === true || cookieExpired
    const s = out?.stats
    const text = pending
      ? `正在搜 YellowFish 实时价${keyword ? ` · ${keyword}` : ''}…`
      : cookieExpired
        ? `YellowFish 实时 · ${keyword} · 登录已过期`
        : failed
          ? `YellowFish 实时价未拿到${keyword ? ` · ${keyword}` : ''}`
          : out?.available && s
            ? `YellowFish 实时 · ${keyword} · ¥${s.min ?? '—'}~¥${s.max ?? '—'} · ${s.sampleCount}条在售`
            : '已搜索YellowFish 实时价'
    return (
      <ToolRow
        icon={<Fish className="w-3.5 h-3.5" />}
        text={text}
        streaming={pending}
        failed={failed}
        details={
          cookieExpired ? (
            <div className="space-y-2 py-0.5">
              {out?.note ? (
                <div className="text-[11px] leading-relaxed text-content-muted">{out.note}</div>
              ) : (
                <div className="text-[11px] leading-relaxed text-content-muted">
                  YellowFish 登录态已失效，实时价查不了。到「设置 → YellowFish」点扫码修复即可（会弹登录窗口）；监控快照不受影响。
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  useChatStore.getState().setSettingsSection('yellowfish')
                  useChatStore.getState().setSettingsOpen(true)
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-foreground transition hover:opacity-90"
              >
                去修复登录
              </button>
            </div>
          ) : out && out.available && s ? (
            <div className="space-y-3 py-0.5">
              <div>
                <div className="mb-2 text-[11px] font-medium tracking-wide text-content-muted">
                  实时在售采样 · {keyword}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
                  {[
                    { label: '最低', value: s.min != null ? `¥${s.min}` : '—' },
                    { label: '中位', value: s.median != null ? `¥${s.median}` : '—' },
                    { label: '最高', value: s.max != null ? `¥${s.max}` : '—' },
                    { label: '样本', value: `${s.sampleCount}（搜索${s.searchCount}）` },
                  ].map((c) => (
                    <div key={c.label}>
                      <div className="text-[11px] text-content-muted">{c.label}</div>
                      <div className="mt-0.5 text-sm font-medium tabular-nums text-content-primary">{c.value}</div>
                    </div>
                  ))}
                </div>
                {out.recommendationHeavy ? (
                  <div className="mt-2 text-[11px] text-content-muted">推荐流占比高，结论可信度有限</div>
                ) : null}
              </div>
              {out.listings && out.listings.length > 0 ? (
                <div className="border-t border-line/50 pt-2.5">
                  <div className="mb-2 text-[11px] font-medium tracking-wide text-content-muted">在售商品</div>
                  <YellowFishLiveListings listings={out.listings} keyword={keyword} />
                </div>
              ) : null}
              {out.note ? (
                <div className="border-t border-line/50 pt-2 text-[11px] leading-relaxed text-content-muted">{out.note}</div>
              ) : null}
            </div>
          ) : out?.note && !failed ? (
            <div className="py-0.5 text-[11px] leading-relaxed text-content-muted">{out.note}</div>
          ) : undefined
        }
      />
    )
  }

  // 用户手动切换后交还控制权,不再自动变化。
  const autoOpen = view.state !== 'output-available'
  const isOpen = manual ? expanded : autoOpen
  const toggle = () => {
    setManual(true)
    setExpanded((v) => !v)
  }

  // ---- MCP 动态工具:从 mcp_<slug>_<tool> 解析出「服务 · 工具」展示 ----
  // MCP 外部调用耗时最长(网络往返 5~15s),streaming 涵盖 input-available:
  // 参数到位后真正在执行,必须持续转圈;完成后展示参数摘要,失败带原因。
  const mcpDisplay = parseMcpToolDisplay(view.tool)
  if (mcpDisplay) {
    // MCP 结果结构(MCP spec CallToolResult): { content: [{type:'text',text}], isError? }
    const out = view.output as
      | { content?: Array<{ text?: string }>; isError?: boolean; error?: string }
      | undefined
    // 失败判定:SDK 层错误(output-error)/ MCP 协议层错误(isError)/ 业务 error 字段
    const failed = view.state === 'output-error' || out?.isError === true || !!out?.error
    const argBrief = mcpArgBrief(view.input)
    const pending = view.state === 'input-streaming' || view.state === 'input-available'
    const text = pending
      ? `正在调用 ${mcpDisplay}${argBrief ? ` 「${argBrief}」` : ''}…`
      : failed
        ? `${mcpDisplay} 未生效${mcpErrBrief(view.errorText ?? out?.error) ? `：${mcpErrBrief(view.errorText ?? out?.error)}` : ''}`
        : argBrief
          ? `${mcpDisplay} · 「${argBrief}」`
          : `调用 ${mcpDisplay}`
    return (
      <ToolRow
        icon={<Plug className="w-3.5 h-3.5" />}
        text={text}
        streaming={pending}
        failed={failed}
      />
    )
  }

  // ---- 未知工具兜底 ----
  if (view.tool !== 'web_search') {
    return (
      <ToolRow
        icon={<Wrench className="w-3.5 h-3.5 text-content-muted" />}
        text={`调用了 ${view.tool}`}
        streaming={view.state === 'input-streaming'}
        failed={view.state === 'output-error'}
      />
    )
  }

  // ---- web_search 渲染 ----
  const query = extractQuery(view)
  const out = isWebSearchOutput(view.output) ? view.output : null
  const results = out?.results ?? []
  const hasError =
    view.state === 'output-error' || (out?.error != null && out.error !== '')
  const running = view.state === 'input-streaming' || view.state === 'input-available'

  return (
    <div className="rounded-lg border border-line/60 bg-surface-muted overflow-hidden text-xs">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-surface-subtle transition-colors text-left"
        aria-expanded={isOpen}
      >
        <Search className="w-3.5 h-3.5 shrink-0 text-content-secondary" />
        <span className="min-w-0 truncate text-content-primary">
          {query ? <>搜索「{query}」</> : '联网搜索'}
        </span>
        <span className="ml-auto flex items-center gap-1 shrink-0 text-content-muted">
          {running ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              搜索中…
            </>
          ) : hasError ? (
            <>
              <TriangleAlert className="w-3 h-3 text-red-500" />
              <span className="text-red-500">搜索失败</span>
            </>
          ) : (
            <>
              <Globe className="w-3 h-3" />
              {results.length} 条来源
              {out?.images?.length ? ` · ${out.images.length} 张图` : ''}
            </>
          )}
          <ChevronDown
            className={cn('w-3 h-3 transition-transform', isOpen ? '' : '-rotate-90')}
          />
        </span>
      </button>

      {/* 展开区:常驻 DOM + grid-rows 过渡,收起/展开有顺滑的高度动画 */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="overflow-hidden">
        <div className="px-2.5 pb-2 pt-0.5 flex flex-col gap-1.5">
          {/* 错误信息(工具执行失败或搜索 API 报错) */}
          {(hasError || view.errorText) && (
            <p className="text-red-500/90 break-words">
              {view.errorText || out?.error || '搜索失败'}
            </p>
          )}
          {results.length === 0 && !hasError && (
            <p className="text-content-muted break-words">未找到相关结果</p>
          )}
          {results.map((r, i) => {
            const host = r.url ? hostOf(r.url) : ''
            const clickable = !!r.url && !!host
            const inner = (
              <>
                {/* 首字母站标:避免第三方 favicon 服务的外部请求与离线破图 */}
                <span className="flex-shrink-0 w-4 h-4 rounded bg-accent/15 text-accent flex items-center justify-center text-[10px] font-medium select-none">
                  {(host.replace(/^www\./, '')[0] || '?').toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-[10px] text-content-muted font-mono shrink-0">[{i + 1}]</span>
                    <span className="truncate text-content-primary">{r.title}</span>
                    {host && (
                      <span className="shrink-0 text-[10px] text-content-muted truncate max-w-[40%]">
                        {host}
                      </span>
                    )}
                  </span>
                  {r.snippet && (
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-content-secondary line-clamp-2">
                      {r.snippet}
                    </span>
                  )}
                </span>
              </>
            )
            return clickable ? (
              <a
                key={r.url}
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-1.5 rounded-md px-1 py-1 -mx-1 hover:bg-surface-subtle transition-colors"
              >
                {inner}
              </a>
            ) : (
              <div key={`${i}-${r.title}`} className="flex items-start gap-1.5 px-1 py-1 -mx-1">
                {inner}
              </div>
            )
          })}
        </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Memoized ToolCallCard —— tool part 的 output 一次性到达、之后引用稳定,
 * memo 保证正文流式重渲时不连带重渲卡片。
 */
export const ToolCallCard = memo(ToolCallCardInner)
