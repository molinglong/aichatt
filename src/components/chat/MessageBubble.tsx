'use client'

import { useState, useCallback, useRef, useEffect, useMemo, KeyboardEvent, memo, type CSSProperties } from 'react'
import { useRenderProbe } from '@/lib/client-diagnostics'
import {
  Bot,
  Copy,
  Check,
  RotateCw,
  Pencil,
  ChevronDown,
  Brain,
  FileText,
  FileType,
  Code2,
  Reply,
  BookmarkPlus,
  CheckCircle2,
  History,
  Loader2,
  X,
} from 'lucide-react'
import { cn, splitReasoningTail } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { useTypewriter } from '@/lib/useTypewriter'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ChartCard } from './ChartCard'
import { ChatImageLightbox } from './ChatImageLightbox'
import { ToolCallCard, extractToolCallViews, extractInlineImages } from './ToolCallCard'
import { TurnFileSummary } from './TurnFileSummary'
import { useSingleFlight } from '@/hooks/useSingleFlight'
import { toast } from '@/lib/toast'
import { useChatStore } from '@/store/chat-store'
import { useContextMenuStore, type ContextMenuItem } from '@/store/contextMenuStore'
import {
  estimatePlaceholderHeight,
  messageHeightStore,
  observeMessageHeight,
  unobserveMessageHeight,
} from './chat-list-bridge'
import type { UIMessage } from 'ai'
import type { Attachment } from '@/lib/attachment-types'

/**
 * 去噪：推理模型每步思考开头常复述用户原话（如"帮我评价一下这个项目"），
 * 多步工具循环下逐轮复现，造成重复输出。展示前剥离与最近一条用户消息一致的前缀。
 */
function stripLeadingEcho(text: string, echo: string | null | undefined): string {
  const src = echo?.trim()
  if (!src) return text
  const t = text.trimStart()
  if (t === src) return ''
  if (!t.startsWith(src)) return text
  const after = t.slice(src.length)
  // 复述后紧跟换行/标点，视为整段复述，一并剥掉，保留后面的实质内容
  if (/^[\s,，。；、！？!?：:]/.test(after)) {
    return after.replace(/^[\s,，。；、！？!?：:]+/, '')
  }
  return text
}

/**
 * 结构化 UI 提示的子类型集合 —— MessageBubble 据此分发到不同渲染分支。
 * 写入规则：仅后端写入；前端按 kind 决定是否走专用卡片组件。
 */
export type MessageMetadata =
  | {
      kind: 'branch_summary'
      version: 1
      /** 来源对话 id,用于"跳回源对话"按钮 */
      sourceId: string
      /** 来源对话标题,用于卡片头部的面包屑显示 */
      sourceTitle?: string
      /** 分支创建时间 ISO 字符串 */
      branchedAt?: string
    }
  | {
      kind: 'chart'
      version: 1
      /** 图表数据 */
      chart: {
        type: 'bar' | 'line' | 'pie' | 'area' | 'scatter'
        data: Record<string, unknown>[]
        title?: string
        xKey?: string
        yKey?: string
        nameKey?: string
        valueKey?: string
        colors?: string[]
      }
    }
  | { kind: string; version?: number; [k: string]: unknown } // 兜底:未来 kind 直接返回 null,走默认渲染

/** 从 UIMessage 取出 metadata,未知结构兜底为 null */
export function getMessageMetadata(msg: UIMessage): MessageMetadata | null {
  const raw = (msg as UIMessage & { metadata?: unknown }).metadata
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as MessageMetadata
}

/**
 * 读出「导入时未迁移的附件」凭据(由导入端写在 metadata.importSkippedAttachments 上,
 * 见 src/lib/conversation-portable.ts)。
 *
 * 单独走一条读取通道而不是塞进 MessageMetadata 联合:那个联合靠 kind 判别渲染分支,
 * 而这个字段是挂在**任意已有 metadata** 上的附加项(原消息可能是 chart、也可能是空),
 * 加进联合反而会把现有分支的 kind 收窄搞坏。
 */
function readImportSkippedAttachments(
  msg: UIMessage
): { count: number; names: string[] } | null {
  const meta = getMessageMetadata(msg) as { importSkippedAttachments?: unknown } | null
  const raw = meta?.importSkippedAttachments
  if (!raw || typeof raw !== 'object') return null
  const info = raw as { count?: unknown; names?: unknown }
  const names = Array.isArray(info.names)
    ? info.names.filter((n): n is string => typeof n === 'string')
    : []
  const count = typeof info.count === 'number' && info.count > 0 ? info.count : names.length
  return count > 0 ? { count, names } : null
}

/** UIMessage 上挂载的附件扩展字段(历史加载与发送后注入) */
export type UIMessageWithAttachments = UIMessage & {
  attachments?: Attachment[]
  /** 历史消息的创建时间(数据库) */
  createdAt?: Date
  /** token 消耗统计 */
  tokens?: { prompt: number; completion: number }
  /** 结构化 UI 提示(由后端写入,见 MessageMetadata) */
  metadata?: MessageMetadata | null
}

/** 格式化完整日期时间:YYYY-MM-DD HH:MM */
function formatFullDateTime(date: Date): string {
  const y = date.getFullYear()
  const m = (date.getMonth() + 1).toString().padStart(2, '0')
  const d = date.getDate().toString().padStart(2, '0')
  const h = date.getHours().toString().padStart(2, '0')
  const min = date.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}`
}

/** 格式化 token 数量 */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n.toString()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** C 分支轻量版: 归档旧版本消息(回看端点返回结构) */
interface ArchivedMessage {
  id: string
  role: string
  content: string
  createdAt?: string
}

interface MessageBubbleProps {
  message: UIMessage
  isStreaming?: boolean
  isLastAssistant?: boolean
  /** 本条是否是会话列表最后一条:"正在生成"判定的依据(见 rich 门控注释) */
  isLastMessage?: boolean
  canRegenerate?: boolean
  onRegenerate?: () => void
  canEdit?: boolean
  /** 「保存并重答」:归档此消息及其后续,然后以新文本重发(异步实现,失败应抛错) */
  onEdit?: (messageId: string, newText: string) => void | Promise<void>
  /** 键盘导航选中状态 */
  isFocused?: boolean
  /** 外层 ref callback，用于滚动到视野 */
  wrapperRef?: (el: HTMLDivElement | null) => void
  /** 前一条用户消息的文本(存错题本时,assistant 消息用它配对题干;null/undefined = 无) */
  prevUserContent?: string | null
  /** 澄清问答:提交回答文本(透传给 ToolCallCard 内的 ClarifyCard) */
  onClarifySubmit?: (answersText: string) => void
  /** local_file:决策(批准/拒绝),透传给 ToolCallCard 内的 LocalFileCard */
  onLocalFileDecision?: (
    toolCallId: string,
    path: string,
    approved: boolean,
    decision: import('@/lib/ai/local-file-tool').LocalFileDecision
  ) => void
  /** local_file:在编辑器中打开,透传给 ToolCallCard 内的 LocalFileCard */
  onOpenEditor?: (path: string) => void
  /** 澄清问答:该消息之后是否已有 user 消息(已答则卡片锁定为摘要行) */
  clarifyAnswered?: boolean
  /**
   * 关闭本消息的 content-visibility 裁剪。虚拟化列表用:屏外 item 已被虚拟化卸载,
   * 若再叠加 CV 跳过,overscan 项会以占位尺寸喂给 measureElement 造成测量反馈循环。
   */
  contentVisibilityOff?: boolean
}

function MessageBubbleInner({
  message,
  isStreaming,
  isLastAssistant,
  isLastMessage,
  canRegenerate,
  onRegenerate,
  canEdit,
  onEdit,
  isFocused,
  wrapperRef,
  prevUserContent,
  onClarifySubmit,
  onLocalFileDecision,
  onOpenEditor,
  clarifyAnswered,
  contentVisibilityOff,
}: MessageBubbleProps) {
  useRenderProbe('MessageBubble')
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const isSystem = message.role === 'system'

  // 结构化 UI 提示: system + metadata.kind === 'branch_summary' 是「在新对话继续」
  // 写入的上文载体,仅后端会写 system 消息。这类消息只喂模型,前端不展示。
  const messageMeta = getMessageMetadata(message)
  const isBranchSummary =
    isSystem && messageMeta?.kind === 'branch_summary' && !!messageMeta.sourceId

  // C 分支轻量版: 编辑产生的新消息带 editedFrom(指向被编辑消息),
  // 据此提供"查看历史版本"回看入口(旧版本链存在服务端归档表中)
  const editedFrom =
    isUser &&
    messageMeta &&
    typeof (messageMeta as { editedFrom?: unknown }).editedFrom === 'string'
      ? ((messageMeta as { editedFrom?: unknown }).editedFrom as string)
      : null
  // 历史「仅保存」路径的编辑标记(入口已下线,旧数据仍可能带 editedAt):只提示内容改过
  const savedEditAt =
    isUser &&
    !editedFrom &&
    messageMeta &&
    typeof (messageMeta as { editedAt?: unknown }).editedAt === 'string'
      ? ((messageMeta as { editedAt?: unknown }).editedAt as string)
      : null
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  // 提交中(保存并重答要等 DELETE 归档往返):禁用编辑卡按钮,避免重复提交
  const [isSaving, setIsSaving] = useState(false)
  // 思考框展开状态: null=未手动干预(自动行为接管),true/false=用户点过折叠按钮后的选择
  const [userShowReasoning, setUserShowReasoning] = useState<boolean | null>(null)
  const autoCollapseReasoning = useChatStore((s) => s.autoCollapseReasoning)
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)
  const copyMenuRef = useRef<HTMLDivElement>(null)
  // 复制菜单的智能定位状态。打开菜单后,根据可用空间自动 choose 上/下/左/右
  const copyMenuPos = useRef<'below-right' | 'below-left' | 'above-right' | 'above-left'>('below-left')
  /** HTML 复制源: 点击复制 HTML 时按需创建, 用完即销毁.
   *  原实现是 MessageBubble render 内常驻一个 hidden MarkdownRenderer,
   *  与主显示区并行渲染, 流式期间双倍重渲染 / 双倍 DOM diff, 是死循环源头之一。
   *  改造: 不再常驻. 点击复制 HTML 时挂载到 portal, 拿到 innerHTML 立即卸载。
   */
  const [htmlMirrorActive, setHtmlMirrorActive] = useState(false)
  const htmlMirrorRef = useRef<HTMLDivElement>(null)
  const htmlMirrorResolveRef = useRef<((html: string | null) => void) | null>(null)

  // ── 旧版本回看(C 分支轻量版)────────────────────────
  const currentConversationId = useChatStore((s) => s.currentConversationId)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [archivedLoading, setArchivedLoading] = useState(false)
  const [archivedMessages, setArchivedMessages] = useState<ArchivedMessage[] | null>(null)

  const toggleArchived = useCallback(() => {
    if (archivedOpen) {
      setArchivedOpen(false)
      return
    }
    setArchivedOpen(true)
    if (archivedMessages || !editedFrom) return
    setArchivedLoading(true)
    fetch(`/api/conversations/${currentConversationId}/archived?rootId=${editedFrom}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => setArchivedMessages(Array.isArray(data?.messages) ? data.messages : []))
      .catch(() => {
        toast.error('历史版本加载失败', { title: '提示' })
        setArchivedOpen(false)
      })
      .finally(() => setArchivedLoading(false))
  }, [archivedOpen, archivedMessages, editedFrom, currentConversationId])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Extract reasoning parts from message (for deep thinking / reasoning models)
  const reasoningParts = message.parts.filter((p) => p.type === 'reasoning')
  const reasoningText = reasoningParts.map((p) => p.text).join('')
  const lastReasoningPart = reasoningParts[reasoningParts.length - 1] as { state?: string } | undefined
  const isReasoningStreaming = isStreaming && isAssistant && lastReasoningPart?.state === 'streaming'

  // 附件 (仅用户消息有)
  const attachments = (message as UIMessageWithAttachments).attachments ?? []
  // 跨实例导入的附件欠账:文件躺在导出时的机器上,包里没带,导入端把引用摘掉并留了这份凭据。
  // 宁可显示"这里原来有 2 个附件",也不留一个点开就 404 的死链。
  const importSkipped = readImportSkippedAttachments(message)
  // 图片浏览器: 当前查看的图片在 imageAtts 中的下标,null=关闭
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const imageAtts = attachments.filter((a) => a.type.startsWith('image/'))

  // 时间戳和 token 统计
  const msgCreatedAt = (message as UIMessageWithAttachments).createdAt
  const msgTokens = (message as UIMessageWithAttachments).tokens
  const totalTokens = msgTokens ? msgTokens.prompt + msgTokens.completion : 0

  // Extract text from message parts
  const textParts = message.parts.filter((p) => p.type === 'text')
  const text = textParts.map((p) => p.text).join('')
  const lastPart = textParts[textParts.length - 1] as { state?: string } | undefined
  const isCurrentlyStreaming = isStreaming && isAssistant && lastPart?.state === 'streaming'
  const isWaitingForReasoning = isStreaming && isAssistant && !reasoningText && !text

  // 工具调用视图(联网搜索等):流式期间来自 message.parts,历史消息来自 metadata.toolCalls。
  // 渲染在 reasoning 与正文之间,时间线上与"模型先查资料后回答"的顺序一致。
  const toolCallViews = useMemo(
    () => (isAssistant ? extractToolCallViews(message) : []),
    [message, isAssistant]
  )
  // 图文混排白名单图:与工具卡同源提取,喂给 MarkdownRenderer 做 [图N] 占位符替换
  const inlineImages = useMemo(
    () => (isAssistant ? extractInlineImages(message) : []),
    [message, isAssistant]
  )

  // content-visibility 裁剪:屏外消息跳过布局/绘制,是长会话滚动性能的基石。
  // 占位尺寸优先用真实测量值(chat-list-bridge 缓存,下方 RO 回填),估算值只兜首帧 ——
  // 此前对"工具卡消息 / 估算 >2600px"的豁免已移除:最重的消息恰恰最需要裁剪,
  // 估算不准的跳变由测量回填 + Chromium last-remembered size 消化。
  // 虚拟化模式传 contentVisibilityOff 关闭(测量职责归 measureElement,避免反馈循环)。
  const wrapperStyle: CSSProperties | undefined = useMemo(() => {
    if (contentVisibilityOff) return undefined
    const estimated = estimatePlaceholderHeight(text, reasoningText, attachments.length)
    const px = messageHeightStore.get(message.id) ?? estimated
    return { contentVisibility: 'auto', containIntrinsicSize: `auto ${px}px` }
  }, [contentVisibilityOff, text, reasoningText, attachments.length, message.id])

  // wrapper 挂载时挂到共享 ResizeObserver 上:测得的真实高度写入 bridge 缓存,
  // 并直接内联到 containIntrinsicSize(绕过 React 状态 —— 流式期间尺寸逐帧变化,
  // 走 setState 会翻倍重渲染;内联值对可见元素无效果,不会被 React 样式 diff 覆盖,
  // 因为 wrapperStyle memo 的值不随之变化)。
  const wrapperElRef = useRef<HTMLDivElement | null>(null)
  const wrapperPropRef = useRef(wrapperRef)
  const messageIdRef = useRef(message.id)
  useEffect(() => {
    wrapperPropRef.current = wrapperRef
  }, [wrapperRef])
  useEffect(() => {
    messageIdRef.current = message.id
  }, [message.id])
  const setWrapperRef = useCallback((el: HTMLDivElement | null) => {
    const prev = wrapperElRef.current
    if (prev === el) return
    if (prev) unobserveMessageHeight(prev)
    wrapperElRef.current = el
    if (el) {
      observeMessageHeight(el, (px) => {
        const id = messageIdRef.current
        messageHeightStore.set(id, px)
        // content-visibility 生效期间才需要回填占位尺寸;虚拟化模式(无 CV)跳过
        if (el.style.contentVisibility === 'auto') {
          el.style.containIntrinsicSize = `auto ${Math.max(1, Math.round(px))}px`
        }
      })
    }
  }, [])

  // 兜底:模型偶发把全部内容(含最终答案)都放进 <think> 标签,导致正文为空。
  // 流式期间也尝试拆分(只要看到明确标记就立即切分),避免用户看到空白几秒到几十秒。
  // 用正则限定只切分明确标记,避免误切普通的"答案"二字。
  const streamingFallbackMarker =
    /(?:【答案】|【最终答案】|【最终结论】|最终结论[：:]|最终答案[：:]|所以答案是[：:]|所以结论是[：:]|回答如下[：:]|回复如下[：:]|综上[，:]?|总结一下[：:]|总结[：:]|Final answer[：:]|Final Answer[：:]|So the answer is[：:])\s*[\s\S]{0,2000}$/
  const needsBodyFallback =
    !text.trim() &&
    reasoningText.trim() !== '' &&
    (!isStreaming || streamingFallbackMarker.test(reasoningText))
  const bodySplit = needsBodyFallback ? splitReasoningTail(reasoningText) : null
  const bodyText = bodySplit ? bodySplit.tail : text

  // 存错题本:用户消息存题干;assistant 消息配对存(prevUserContent 为题干,自身为解析)
  const [studySaveState, setStudySaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const handleSaveToStudy = useCallback(async () => {
    if (studySaveState !== 'idle') return
    const questionText = isUser ? bodyText : (prevUserContent ?? '')
    const analysisText = isAssistant ? bodyText : ''
    if (!questionText.trim() && !analysisText.trim()) {
      toast.error('未找到可保存的题干', { title: '错题本' })
      return
    }
    setStudySaveState('saving')
    try {
      const res = await fetch('/api/study/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceMessageId: message.id, questionText, analysisText }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStudySaveState('saved')
      toast.success('已存入错题本', { title: '错题本' })
    } catch (err) {
      console.error('[MessageBubble] save to study failed:', err)
      setStudySaveState('idle')
      toast.error('存入失败,请重试', { title: '错题本' })
    }
  }, [studySaveState, isUser, isAssistant, bodyText, prevUserContent, message.id])
  // 去噪：剥离思考开头对用户原话的复述（见 stripLeadingEcho）
  const displayReasoningText = stripLeadingEcho(
    bodySplit ? bodySplit.head : reasoningText,
    prevUserContent
  )

  // 思考框自动折叠(设置中可关):思考进行中默认展开,"思考完毕"自动收起让视野回到正文。
  // 完毕判定用 isThinkingActive(生成中且正文未出现)而非 reasoning part 的 state:
  // 流式恢复轮询构造的快照 parts 曾恒为 state:'done'(现按 stillStreaming 标注),
  // 不依赖 part state 的判定对轮询间隙与历史回放都更稳。
  // 用户手动点过按钮后以用户选择为准,新一轮思考开始时重置回自动接管。
  const isThinkingActive = Boolean(isAssistant && isStreaming && !bodyText.trim())
  // 思考中→展开;完毕(正文开始/生成结束/历史消息)→折叠成标题条;开关关闭则始终展开(旧行为)
  const showReasoning = userShowReasoning ?? (autoCollapseReasoning ? isThinkingActive : true)
  const prevThinkingActiveRef = useRef(false)
  useEffect(() => {
    if (isThinkingActive && !prevThinkingActiveRef.current) {
      setUserShowReasoning(null)
    }
    prevThinkingActiveRef.current = isThinkingActive
  }, [isThinkingActive])

  // 本次挂载内是否出现过"思考中":流式期间思考框走 grid-rows 过渡分支的前提,
  // 折叠(思考完毕收起)才能平滑塌缩而非瞬间跳变。历史消息(从未思考中)走静态
  // 分支,折叠的推理文本不常驻 DOM,不给长会话的滚动帧率加负担
  const [thinkingThisMount, setThinkingThisMount] = useState(false)
  useEffect(() => {
    if (isThinkingActive) setThinkingThisMount(true)
  }, [isThinkingActive])

  // ── 思考期限高小窗:真实流是突发的(SSE 一块 1~40 字,思考可上千字),整段挂载会
  // 随长度全段重排版越滚越卡,无限增高又把外层视口一路往上顶。生成中只渲染尾部
  // REASON_TAIL 字符并封顶 120px,新内容在窗内贴底;页面高度到顶即止。
  // 思考完毕走原塌缩分支,回看/手动展开都是全量文本,不受此限。
  // 推理流也过正文同款时间基打字机:直写 DOM 时块大小决定跳动幅度(一跳 1~3 行),
  // 平滑揭示后每帧增量恒定,贴底写入连起来就是连续滚动。
  // 打字机喂原始 reasoningText(单调增长):displayReasoningText 会被 stripLeadingEcho
  // 中途剥掉复述前缀而缩短,触发打字机"重置从头回放"的换轮次语义,窗内容塌一下;
  // 剥回声挪到输出侧逐帧做(思考期内 displayReasoningText 本就等价于这条链)。
  // 速度钳到 420 字/秒:推理流常年超过默认上限 1500 字/秒,稳态贴顶时每帧推进
  // ~25 字(半行),行粒度的位移就是用户说的"字一跳一跳";420 ≈ 每帧 7 字/3.4px,
  // 窗内是连续滚带。思考完毕本来就塌成胶囊,慢半拍无残留
  const { displayText: typedReasoningRaw } = useTypewriter(reasoningText, isThinkingActive, 420)
  const typedReasoning = stripLeadingEcho(typedReasoningRaw, prevUserContent)
  const REASON_TAIL = 600
  // 尾切按换行对齐:逐字符滑窗时每进一个字窗头就掉一个字,窗内每一行都得重新
  // 断行(实测 tlen 恒定时整段高度 ±39px 震荡,观感就是"字一跳一跳")。
  // 钉到窗内首个换行后,已上屏的行不再重排,只有末行随打字机延长
  // 折叠过渡(思考完毕自动收起)期间保持小窗:否则同一帧里“尾窗切全文 + 解除 120px
  // 限高 + grid 开始折叠”三件事一起发生,内容先撑高上千 px 再被 0fr 压回
  // (桌面实测 scrollHeight 762→1899→762)。收起完成后块高为 0,继续用小窗无感;
  // 用户手动展开(showReasoning=true)则立即改回全文。
  const liveReasoningWindow =
    isThinkingActive || (thinkingThisMount && isStreaming && !showReasoning)
  const liveReasoningText = (() => {
    if (!liveReasoningWindow || typedReasoning.length <= REASON_TAIL) return typedReasoning
    const tail = typedReasoning.slice(-REASON_TAIL)
    const nl = tail.indexOf('\n')
    return '…' + (nl === -1 ? tail : tail.slice(nl + 1))
  })()
  const reasonWinRef = useRef<HTMLDivElement>(null)
  const reasonWinFollowRef = useRef(true)
  const reasonTouchYRef = useRef<number | null>(null)
  // 脱离判定必须走输入事件而非 scrollTop 方向差:打字机/尾部截断会让窗内内容
  // 塌缩,浏览器随之回缩 scrollTop,方向判定会把这记成"用户上滑"而误脱离(实测)
  const onReasonWinWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) reasonWinFollowRef.current = false
  }, [])
  const onReasonWinTouchMove = useCallback((e: React.TouchEvent) => {
    const y = e.touches[0]?.clientY ?? null
    if (y != null && reasonTouchYRef.current != null && y > reasonTouchYRef.current + 2) {
      reasonWinFollowRef.current = false
    }
    reasonTouchYRef.current = y
  }, [])
  // 滚回窗底即恢复跟随
  const onReasonWinScroll = useCallback(() => {
    const el = reasonWinRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 4) reasonWinFollowRef.current = true
  }, [])
  useEffect(() => {
    if (isThinkingActive) reasonWinFollowRef.current = true
  }, [isThinkingActive])
  // 打字机每帧推进一次 commit,这里每帧贴底一次;窗内上滑可脱离、回窗底恢复
  useEffect(() => {
    const el = reasonWinRef.current
    if (el && isThinkingActive && reasonWinFollowRef.current) el.scrollTop = el.scrollHeight
  }, [liveReasoningText, isThinkingActive])

  // Typewriter effect: only for live streaming, not for historical messages
  // Skip typewriter when message is already complete (streaming ended) to avoid
  // performance issues with long messages on page refresh
  const { displayText: typedText, isTyping } = useTypewriter(
    bodyText,
    Boolean(isAssistant && isCurrentlyStreaming) // Only enable during active stream
  )
  // 非生成中直接用原文:useTypewriter 首次挂载先返回空串(store 为空,effect 后才揭示),
  // 虚拟化会在那一帧量到“空壳”高度(实测 73px),随后正文撑回 1156px —— 冷启动长会话
  // 因此整轨收缩/回长上千 px。生成结束时的原行为也是一次性显示全文,观感不变。
  const displayText = isCurrentlyStreaming ? typedText : bodyText

  // Show cursor while AI is streaming OR typewriter is still catching up
  const showCursor = isCurrentlyStreaming || isTyping

  // 操作按钮始终可用 —— 只要消息有内容就显示。
  // 之前用 !isCurrentlyStreaming && !isTyping 把按钮藏到流式+打字机追完,
  // 用户得等 1-5 秒才能复制。重生成/停止也同理。
  const showActions = isStreaming !== undefined && bodyText.length > 0

  // Auto-focus and select when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.select()
      // Auto-resize to fit content
      const ta = textareaRef.current
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
    }
  }, [isEditing])

  // Reset edit value when entering edit mode
  // beginEdit 是无事件版本:右键菜单项也要进编辑态(菜单里拿不到原 MouseEvent)
  const beginEdit = useCallback(() => {
    setEditValue(text)
    setIsEditing(true)
  }, [text])

  const startEditing = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    beginEdit()
  }, [beginEdit])

  const cancelEditing = useCallback(() => {
    setEditValue('')
    setIsEditing(false)
  }, [])

  /**
   * 提交编辑(唯一动作「保存并重答」): 父级归档此消息及其后续,再以新文本重发。
   * 归档影响面只在主钮 title 悬浮提示中说明,卡片内不设警示行(定案: 用户嫌啰嗦)。
   * 失败时父级抛错 → 停留在编辑态,用户可重试或取消。
   */
  const submitEdit = useCallback(async () => {
    if (isSaving) return
    const trimmed = editValue.trim()
    if (!trimmed || trimmed === text) {
      setIsEditing(false)
      return
    }
    if (!onEdit) {
      setIsEditing(false)
      return
    }
    setIsSaving(true)
    try {
      await onEdit(message.id, trimmed)
      setIsEditing(false)
    } catch {
      // 错误提示由父级 toast 负责;保持编辑态供重试
    } finally {
      setIsSaving(false)
    }
  }, [isSaving, editValue, text, onEdit, message.id])

  const handleEditKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submitEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (!isSaving) cancelEditing()
    }
  }, [submitEdit, cancelEditing, isSaving])

  const copyPayload = useCallback((text: string) => {
    // copyText 内部:Clipboard API 被拒(无 transient activation / webview 权限受限)时退 execCommand 兜底
    void copyText(text).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } else {
        toast.error('复制失败,请手动选择文本', { title: '复制' })
      }
    })
  }, [])

  const handleCopy = useCallback(() => copyPayload(bodyText), [copyPayload, bodyText])

  const handleCopyDebounced = useSingleFlight(handleCopy, [bodyText])

  /**
   * 复制为 Markdown:模型输出本身就是 Markdown 源码,直接写入剪贴板即可
   */
  const handleCopyMarkdown = useCallback(() => {
    if (!navigator.clipboard?.writeText) {
      toast.error('当前浏览器不支持自动复制', { title: '复制失败' })
      return
    }
    navigator.clipboard.writeText(bodyText)
      .then(() => {
        toast.success('已复制为 Markdown', { title: '复制' })
        setCopyMenuOpen(false)
      })
      .catch((err) => {
        console.error('Failed to copy as markdown:', err)
        toast.error('复制失败', { title: '复制' })
      })
  }, [bodyText])

  /**
   * 复制为 HTML:从隐藏镜像 div 读取渲染后的 outerHTML,套一层 inline 样式
   * 让粘贴到笔记软件(Notion / 语雀 / 飞书等)时样式尽量保留
   *
   * 按需挂载: 用 setState 临时挂一个 hidden MarkdownRenderer, 等 ref 回调拿到 DOM
   * 后再读 innerHTML, 立刻卸载。整个生命周期只持续一次 commit, 不参与流式重渲染循环。
   */
  const handleCopyHtml = useCallback(() => {
    if (!navigator.clipboard?.write) {
      toast.error('当前浏览器不支持富文本复制,请改用纯文本或 Markdown', { title: '复制失败' })
      return
    }
    if (!bodyText.trim()) {
      toast.error('没有可复制的内容', { title: '复制失败' })
      return
    }
    // 用 Promise + ref 回调等 React commit 后立刻读 DOM
    setHtmlMirrorActive(true)
    htmlMirrorResolveRef.current = null
    requestAnimationFrame(() => {
      const node = htmlMirrorRef.current
      if (!node) {
        setHtmlMirrorActive(false)
        toast.error('HTML 渲染尚未就绪,请稍后再试', { title: '复制失败' })
        return
      }
      const html = node.innerHTML
      setHtmlMirrorActive(false)
      if (!html || !html.trim()) {
        toast.error('没有可复制的内容', { title: '复制失败' })
        return
      }
      // ClipboardItem 写入富文本 + 纯文本双格式,粘贴到支持的应用里走富文本,其他应用走纯文本
      const blobHtml = new Blob([html], { type: 'text/html' })
      const blobText = new Blob([bodyText], { type: 'text/plain' })
      const item = new ClipboardItem({ 'text/html': blobHtml, 'text/plain': blobText })
      navigator.clipboard.write([item])
        .then(() => {
          toast.success('已复制为 HTML', { title: '复制' })
          setCopyMenuOpen(false)
        })
        .catch((err) => {
          console.error('Failed to copy as HTML:', err)
          toast.error('富文本复制失败,已降级为纯文本', { title: '复制' })
          navigator.clipboard.writeText(bodyText).catch(() => {})
        })
    })
  }, [bodyText])

  // 下拉菜单的外部点击关闭
  // 用 mousedown + click 双确认 + 跳过刚打开的当次事件(避免菜单闪烁)
  useEffect(() => {
    if (!copyMenuOpen) return
    const openedAt = Date.now()
    function handleOutside(e: MouseEvent) {
      // 点的是同一个 microtask 内的自己 → 忽略(防止刚打开就被自己关掉)
      if (Date.now() - openedAt < 50) return
      if (
        copyMenuRef.current &&
        !copyMenuRef.current.contains(e.target as Node)
      ) {
        setCopyMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('click', handleOutside)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('click', handleOutside)
    }
  }, [copyMenuOpen])

  // 打开复制菜单后,根据可用空间智能 choose 弹出方向,
  // 避免菜单画到屏幕外(尤其移动端 / 窄屏)。预算后不需重测,滚动时再重测。
  useEffect(() => {
    if (!copyMenuOpen) return
    const measure = () => {
      const menu = copyMenuRef.current
      if (!menu) return
      const wrapper = document.querySelector(`[data-message-id="${message.id}"]`) as HTMLElement | null
      if (!wrapper) return
      const wrapperRect = wrapper.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const viewportW = window.innerWidth
      const viewportH = window.innerHeight
      const gap = 4

      // 方向选择:
      //   below = 菜单显示在按钮下方(top-full + mt-1)
      //   above = 菜单显示在按钮上方(bottom-full + mb-1)
      //   right/left = 菜单相对按钮的左右对齐
      const fitsBelow = wrapperRect.bottom + menuRect.height + gap < viewportH
      const fitsAbove = wrapperRect.top - menuRect.height - gap > 0
      const fitsRight = wrapperRect.right + menuRect.width < viewportW
      const fitsLeft = wrapperRect.left - menuRect.width > 0

      let pos: 'below-right' | 'below-left' | 'above-right' | 'above-left' = 'below-left'
      // 优先选择"装得下"的组合
      if (fitsBelow && fitsRight) pos = 'below-right'
      else if (fitsBelow && fitsLeft) pos = 'below-left'
      else if (fitsAbove && fitsRight) pos = 'above-right'
      else if (fitsAbove && fitsLeft) pos = 'above-left'
      else if (fitsBelow) pos = fitsRight ? 'below-right' : 'below-left'
      else pos = fitsAbove ? (fitsRight ? 'above-right' : 'above-left') : pos
      copyMenuPos.current = pos
      // 用 data-attr 配合 CSS 选择器,避免 React 状态污染
      menu.setAttribute('data-pos', pos)
    }
    // 给浏览器一帧渲染时间再测
    const raf = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [copyMenuOpen, message.id])

  const handleRegenerateDebounced = useSingleFlight(() => {
    if (onRegenerate) {
      onRegenerate()
    }
  }, [onRegenerate])

  const startEditingDebounced = useSingleFlight(startEditing, [text])

  // ── 右键菜单:把操作栏的 hover 按钮集合升格为右键菜单(桌面端习惯) ──
  // 菜单项全部复用现有 handlers,不新增 props → 无需改 memo 比较函数。
  // 无可用项时(如空正文)不 preventDefault,保留浏览器默认菜单。
  const assembleAndOpenMenu = useCallback((x: number, y: number) => {
    const canCopy = bodyText.length > 0
    // 选区必须在"装配菜单"这一刻抓取:扇区上的左键 mousedown 会清掉 window 选区,
    // 等 onSelect 再读就只剩整段了(用户报"选一句却复制整段"根因)
    const selText = window.getSelection()?.toString() ?? ''
    const candidates: (ContextMenuItem | false | undefined)[] = [
      canCopy && {
        id: 'copy',
        label: '复制',
        icon: <Copy className="w-3.5 h-3.5" />,
        // 轮盘改版定案:复制只保留纯文本一条路,Markdown/HTML 入口从右键菜单移除
        onSelect: () => copyPayload(selText.trim() ? selText : bodyText),
      },
      isUser && canEdit && onEdit && {
        id: 'edit',
        label: '编辑',
        icon: <Pencil className="w-3.5 h-3.5" />,
        onSelect: beginEdit,
      },
      isAssistant && isLastAssistant && canRegenerate && onRegenerate && {
        id: 'regenerate',
        label: '重新生成',
        icon: <RotateCw className="w-3.5 h-3.5" />,
        onSelect: handleRegenerateDebounced,
      },
      canCopy && {
        id: 'reply',
        label: '引用回复',
        icon: <Reply className="w-3.5 h-3.5" />,
        // 与操作栏「引用回复」按钮同一通路:setReplyingTo 由 ChatInput 消费
        onSelect: () => {
          const { setReplyingTo } = useChatStore.getState()
          setReplyingTo({
            id: message.id,
            role: message.role,
            text: bodyText.slice(0, 120),
          })
        },
      },
      !isStreaming && (isUser || isAssistant) && {
        id: 'study',
        label: studySaveState === 'saved' ? '已存入错题本' : '存入错题本',
        icon: studySaveState === 'saved' ? <CheckCircle2 className="w-3.5 h-3.5 text-accent" /> : <BookmarkPlus className="w-3.5 h-3.5" />,
        disabled: studySaveState !== 'idle',
        onSelect: handleSaveToStudy,
      },
    ]
    const items = candidates.filter((it): it is ContextMenuItem => !!it)
    if (!items.length) return false
    const { openContextMenu } = useContextMenuStore.getState()
    openContextMenu({ x, y }, items)
    return true
  }, [
    bodyText, isUser, isAssistant, canEdit, onEdit, isLastAssistant, canRegenerate,
    onRegenerate, beginEdit, copyPayload,
    handleRegenerateDebounced, handleSaveToStudy, studySaveState, isStreaming,
    message.id, message.role,
  ])

  const handleMessageContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // 触屏(手机):交还浏览器原生文本选择菜单(复制/全选/搜索)。复制是手机端主力动作,
      // 原生可拖选中间一段、精确到选区;自定义菜单在安卓上引发的"先于选区建立""压住
      // 选区手柄"两个真机坑一并消失。消息操作栏已常驻复制/编辑/引用/重新生成/错题本,
      // 长按不再是唯一入口,不存在功能缺口。
      if (window.matchMedia('(pointer: coarse)').matches) return
      if (assembleAndOpenMenu(e.clientX, e.clientY)) e.preventDefault()
    },
    [assembleAndOpenMenu]
  )

  // 分支摘要对用户不可见:这条 system 消息只是「喂给模型的上文」的载体,
  // 真正生效的位置在 chat/route.ts(摘出 messages 后 unshift 进 system prompt)。
  // 消息本身照常入库、照常随请求上传,前端一律不渲染。
  if (isBranchSummary) return null

  // Edit mode: 就地编辑卡(方案A 定案)——头部✎+✕、唯一动作「保存并重答」，无警示行。
  // 失焦不提交:只有点主钮 / Enter 才提交,✕ / Esc 取消。
  if (isUser && isEditing) {
    return (
      <div className="flex justify-end px-4 max-md:px-[15px] py-2">
        <div className="w-full max-w-[460px] max-md:max-w-none">
          <div className="rounded-[13px] border border-line-strong bg-surface overflow-hidden">
            <div className="flex items-center gap-1.5 h-[34px] max-md:h-10 px-3 border-b border-line text-[11.5px] max-md:text-[12.5px] text-content-secondary select-none">
              <Pencil className="w-3 h-3 text-content-muted shrink-0" />
              <span>编辑消息</span>
              <span className="ml-auto max-md:hidden text-[10.5px] text-content-muted">Esc 取消</span>
              <button
                type="button"
                disabled={isSaving}
                onClick={cancelEditing}
                aria-label="取消编辑"
                className={cn(
                  'ml-auto max-md:ml-auto shrink-0 w-6 h-6 max-md:w-10 max-md:h-10 -mr-1 flex items-center justify-center',
                  'rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle',
                  'transition-colors disabled:opacity-50 disabled:pointer-events-none'
                )}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <textarea
              ref={textareaRef}
              value={editValue}
              aria-label="编辑消息内容"
              onChange={(e) => {
                setEditValue(e.target.value)
                // Auto-resize
                const ta = e.target
                ta.style.height = 'auto'
                ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
              }}
              onKeyDown={handleEditKeyDown}
              rows={1}
              className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-content-primary outline-none px-3 pt-2.5 pb-1.5 min-h-[66px] max-h-[220px]"
            />
            <div className="flex p-3">
              <button
                type="button"
                disabled={isSaving}
                onClick={() => void submitEdit()}
                title="归档此消息之后的对话并重新生成回答（Enter）"
                className="ml-auto max-md:w-full max-md:ml-auto h-8 max-md:h-11 px-4 max-md:px-0 rounded-lg bg-accent text-accent-foreground text-xs max-md:text-[13.5px] font-medium inline-flex items-center justify-center gap-1.5 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:pointer-events-none"
              >
                {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isSaving ? '处理中…' : '保存并重答'}
                {!isSaving && (
                  <span className="max-md:hidden text-[10px] opacity-60 border border-current rounded px-1 leading-[1.4]">⏎</span>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={setWrapperRef}
      style={wrapperStyle}
      data-message-id={message.id}
      onContextMenu={handleMessageContextMenu}
      className={cn(
        // 手机端 15px:真机对比定稿(8px 贴边显胖 → 12px 仍偏窄,用户拍板 15px;胶囊自身内距 12px 略窄于正文轴)
        'flex gap-2.5 px-4 max-md:px-[15px] py-2 max-md:py-[11px] transition-colors group relative',
        isUser ? 'justify-end' : 'justify-start',
        isFocused && 'bg-accent/5 border-l-2 border-l-accent'
      )}
    >
      {/* Avatar - only for AI; 手机端让位给正文(头像+间距白吃 34px 屏宽) */}
      {!isUser && (
        <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center bg-accent text-accent-foreground mt-0.5 max-md:hidden">
          <Bot className="w-3 h-3" />
        </div>
      )}

      {/* Message content */}
      <div className={cn('min-w-0 overflow-hidden', isUser ? 'max-w-[80%]' : 'flex-1 max-w-full')}>
        {isAssistant ? (
          <>
            {/* Reasoning / deep thinking section */}
            {/* 折叠态用胶囊条而非纯文字:之前折叠后只剩 11px 灰字,与隐藏无异,
                用户想回看生成过程时找不到入口;胶囊+“点击回看”文案明确可点 */}
            {displayReasoningText && (
              <div className="mb-2">
                <button
                  onClick={() => setUserShowReasoning(!showReasoning)}
                  title={showReasoning ? '点击折叠' : '点击展开思考过程'}
                  className={cn(
                    'transition-colors',
                    showReasoning
                      ? 'flex items-center gap-1.5 text-[11px] font-medium text-content-secondary hover:opacity-80'
                      : 'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-subtle/70 px-2.5 py-1 text-[11px] text-content-secondary hover:text-content-primary hover:bg-surface-subtle'
                  )}
                >
                  <Brain className="w-3 h-3" />
                  <span>{showReasoning ? '思考过程' : '已深度思考 · 点击回看'}</span>
                  <ChevronDown className={cn('w-3 h-3 transition-transform', showReasoning ? '' : '-rotate-90')} />
                </button>
                {isStreaming && thinkingThisMount ? (
                  // 流式期间: grid-rows 1fr/0fr 过渡,思考完毕自动收起时平滑塌缩。
                  // 内容保持挂载(0fr 收起);仅"本条在生成"的消息如此,历史消息走下面
                  // 静态分支,避免长会话里几十条折叠推理文本常驻布局
                  <div
                    className={cn(
                      'grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none',
                      showReasoning ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                    )}
                  >
                    <div className="overflow-hidden">
                      {/* md-blk-rise:与正文段级上浮同款(同 keyframes/时长/缓动),只在思考块
                          挂载那一帧跑一次。窗内不切句 —— 尾切窗句序每掉一批字整体左移,
                          同 key 只改文本不重放,句级淡入在这条链上等于没动效。 */}
                      <div className="md-blk-rise mt-1.5 pl-3 border-l-2 border-line-strong/60">
                        <div
                          ref={isThinkingActive ? reasonWinRef : null}
                          onScroll={isThinkingActive ? onReasonWinScroll : undefined}
                          onWheel={isThinkingActive ? onReasonWinWheel : undefined}
                          onTouchMove={isThinkingActive ? onReasonWinTouchMove : undefined}
                          onTouchEnd={isThinkingActive ? () => { reasonTouchYRef.current = null } : undefined}
                          className={cn(liveReasoningWindow && 'max-h-[120px] overflow-y-auto overscroll-contain [scroll-behavior:auto]')}
                        >
                          <p className="text-xs text-content-secondary whitespace-pre-wrap break-words leading-relaxed">
                            {liveReasoningText}
                            {isReasoningStreaming && (
                              <span className="inline-block w-1 h-3 ml-0.5 bg-accent animate-pulse align-middle" />
                            )}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : showReasoning ? (
                  <div className="mt-1.5 pl-3 border-l-2 border-line-strong/60">
                    <p className="text-xs text-content-secondary whitespace-pre-wrap break-words leading-relaxed">
                      {displayReasoningText}
                    </p>
                  </div>
                ) : null}
              </div>
            )}
            {/* Main response */}
            {/* 工具调用卡片:联网搜索过程可视化(搜索中 spinner / 完成后来源列表) */}
            {toolCallViews.length > 0 && (
              <div className="mb-2 flex flex-col gap-1.5">
                {toolCallViews.map((v, i) => (
                  <ToolCallCard
                    key={v.toolCallId ?? `${v.tool}-${i}`}
                    view={v}
                    clarifyAnswered={clarifyAnswered}
                    onClarifySubmit={onClarifySubmit}
                    onLocalFileDecision={onLocalFileDecision}
                    onOpenEditor={onOpenEditor}
                  />
                ))}
              </div>
            )}
            {/* 回合变更摘要条(P1):聚合本条消息里 local_file 的文件变更,可展开逐文件撤销 */}
            <TurnFileSummary message={message} />
            {displayText ? (
              <div className="relative text-[15px] text-content-primary leading-[1.85]">
                {/* rich 以「本条消息是否在生成」为粒度,不跟单个 text part 的 state 翻转:
                    工具轮次间隙最后 text part 是 done 而会话仍 streaming,若用
                    !showCursor 判定,每轮工具调用都会 plain↔rich 反复横跳(闪烁主源)。
                    isStreaming 是会话级布尔:生成位 = 最后一条消息(submitted 阶段只有
                    新 user 消息垫底、assistant 占位未进列表,此时必须让全部历史消息
                    保持 rich,否则旧 chart/mindmap 卡整个生成窗口期闪回原始 JSON) */}
                <MarkdownRenderer
                  content={displayText}
                  messageId={message.id}
                  rich={isAssistant && !isTyping && (!isStreaming || !isLastMessage)}
                  live={isAssistant}
                  inlineImages={inlineImages}
                />
                {showCursor && (
                  <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-content-secondary animate-pulse align-middle" />
                )}
              </div>
            ) : isWaitingForReasoning ? (
              <div className="flex items-center gap-1.5 py-1">
                <Brain className="w-3 h-3 text-content-secondary animate-pulse" />
                <span className="text-xs text-content-muted">思考中...</span>
              </div>
            ) : isCurrentlyStreaming ? (
              <div className="flex items-center gap-1.5 py-1">
                <span className="w-2 h-2 bg-content-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 bg-content-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-content-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            ) : null}

            {/* 图表渲染: metadata.kind === 'chart' 时显示图表卡片 */}
            {(() => {
              // 使用 useMemo 等效逻辑，但这里在 JSX 中直接计算
              // 仅在 metadata 存在且 kind === 'chart' 时才解析
              const raw = messageMeta as Record<string, unknown> | null
              if (!raw || raw.kind !== 'chart' || !raw.chart) return null
              const chart = raw.chart as Record<string, unknown>
              if (!Array.isArray(chart.data) || !chart.type) return null
              return (
                <div className="mt-3">
                  <ChartCard chart={chart as unknown as Parameters<typeof ChartCard>[0]['chart']} />
                </div>
              )
            })()}
          </>
        ) : (
          <div className="flex flex-col items-end gap-1.5">
            {/* 附件展示:图片缩略图(点击开应用内图片浏览器) / 文件卡片(下载链接) */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap justify-end gap-2">
                {imageAtts.map((att, idx) => (
                  <button
                    key={`${att.url}#${idx}`}
                    type="button"
                    title={att.name}
                    aria-label={`查看图片:${att.name}`}
                    onClick={() => setLightboxIndex(idx)}
                    className="block overflow-hidden rounded-lg border border-line hover:opacity-90 transition-opacity"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={att.url}
                      alt={att.name}
                      className="max-h-40 max-w-[220px] object-contain bg-surface-muted"
                    />
                  </button>
                ))}
                {attachments
                  .filter((att) => !att.type.startsWith('image/'))
                  .map((att, idx) => (
                    <a
                      key={`${att.url}#f${idx}`}
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={att.name}
                      className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-muted px-2 py-1.5 max-w-[180px] hover:bg-surface-subtle transition-colors"
                    >
                      <FileText className="w-3.5 h-3.5 text-content-secondary shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs text-content-primary truncate">{att.name}</p>
                        <p className="text-[10px] text-content-muted">{formatSize(att.size)}</p>
                      </div>
                    </a>
                  ))}
              </div>
            )}
            {importSkipped && (
              <div
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-line px-2 py-1 text-[10px] text-content-muted"
                title={
                  importSkipped.names.length
                    ? `未迁移的附件：${importSkipped.names.join('、')}`
                    : '这些附件文件在导出时未随记录包迁移'
                }
              >
                <FileText className="w-3 h-3 shrink-0" aria-hidden />
                导入时未迁移 {importSkipped.count} 个附件
              </div>
            )}
            <div className="rounded-2xl rounded-br-[6px] bg-accent px-4 py-2.5">
              <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.75] text-accent-foreground">{text}</p>
            </div>
            {/* 应用内图片浏览器: portal 到 body,点缩略图开 */}
            {lightboxIndex != null && imageAtts.length > 0 && (
              <ChatImageLightbox
                images={imageAtts}
                index={lightboxIndex}
                onClose={() => setLightboxIndex(null)}
                onIndexChange={setLightboxIndex}
              />
            )}
          </div>
        )}

        {/* C 分支轻量版: 编辑过的消息提供旧版本回看(仅 user 且有 editedFrom) */}
        {isUser && editedFrom && (
          <div className="mt-1 rounded-lg border border-line/50 bg-surface/60 p-2">
            <button
              onClick={toggleArchived}
              className="inline-flex items-center gap-1 text-[11px] text-content-muted hover:text-content-secondary transition-colors"
              aria-expanded={archivedOpen}
            >
              {archivedLoading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <History className="w-3 h-3" />
              )}
              <span>已编辑 · {archivedOpen ? '收起历史版本' : '查看历史版本'}</span>
              <ChevronDown className={cn('w-3 h-3 transition-transform', archivedOpen ? '' : '-rotate-90')} />
            </button>
            {archivedOpen && archivedMessages && archivedMessages.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {archivedMessages.map((m) => (
                  <div key={m.id} className="rounded-md bg-surface-muted/70 px-2 py-1.5">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle/80 text-content-muted">
                        {m.role === 'user' ? '用户' : 'AI'}
                      </span>
                      {m.createdAt && (
                        <span className="text-[10px] text-content-muted/70">
                          {formatFullDateTime(new Date(m.createdAt))}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-content-secondary break-words leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto">
                      {m.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Action bar */}
        <div className={cn('msg-actions flex items-center gap-0.5 mt-1', isUser ? 'justify-end' : 'justify-start')}>
          {/* 「仅保存」编辑标记:内容就地改过、无历史版本链可看 */}
          {savedEditAt && (
            <span
              className="text-[10px] text-content-muted/60 mr-2 select-none"
              title="内容已修改,未重新生成回答"
            >
              已编辑
            </span>
          )}
          {/* 完整日期时间 + token:仅 assistant 消息永久显示 */}
          {isAssistant && msgCreatedAt && (
            <span className="text-[10px] text-content-muted/60 mr-2 select-none font-mono whitespace-nowrap">
              {formatFullDateTime(new Date(msgCreatedAt))}
              {totalTokens > 0 && (
                <span className="ml-2 text-content-muted/50">
                  · {formatTokens(totalTokens)} tokens
                </span>
              )}
            </span>
          )}
          {showActions && (
            <>
            {/* 复制按钮组:主按钮=纯文本,下拉=Markdown / HTML */}
            <div ref={copyMenuRef} className="relative inline-flex">
              <button
                onClick={handleCopyDebounced}
                className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors active:scale-95 touch-manipulation"
                title="复制纯文本"
                aria-label="复制"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCopyMenuOpen((v) => !v)
                }}
                className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors active:scale-95 touch-manipulation"
                title="复制格式"
                aria-label="选择复制格式"
                aria-haspopup="menu"
                aria-expanded={copyMenuOpen}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <ChevronDown className="w-3 h-3" />
              </button>
              {copyMenuOpen && (
                <div
                  role="menu"
                  // 菜单位置默认 below-left(桌面端常见);移动端 / 窄屏由 effect 测距后
  // 用 data-pos 改写定位(下方/上方 × 左/右),避免溢出屏幕
  className="copy-menu absolute z-30 top-full mt-1 right-0 sm:left-0 min-w-[140px] rounded-lg border border-line/60 bg-surface shadow-xl py-1 text-xs
                    [&[data-pos='below-right']]:top-full [&[data-pos='below-right']]:mt-1 [&[data-pos='below-right']]:right-0 [&[data-pos='below-right']]:left-auto
                    [&[data-pos='below-left']]:top-full [&[data-pos='below-left']]:mt-1 [&[data-pos='below-left']]:left-0 [&[data-pos='below-left']]:right-auto
                    [&[data-pos='above-right']]:top-auto [&[data-pos='above-right']]:bottom-full [&[data-pos='above-right']]:mb-1 [&[data-pos='above-right']]:right-0 [&[data-pos='above-right']]:left-auto
                    [&[data-pos='above-left']]:top-auto [&[data-pos='above-left']]:bottom-full [&[data-pos='above-left']]:mb-1 [&[data-pos='above-left']]:left-0 [&[data-pos='above-left']]:right-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      handleCopy()
                      setCopyMenuOpen(false)
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-surface-subtle text-content-secondary hover:text-content-primary text-left"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    纯文本
                  </button>
                  <button
                    role="menuitem"
                    onClick={handleCopyMarkdown}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-surface-subtle text-content-secondary hover:text-content-primary text-left"
                  >
                    <Code2 className="w-3.5 h-3.5" />
                    Markdown
                  </button>
                  <button
                    role="menuitem"
                    onClick={handleCopyHtml}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-surface-subtle text-content-secondary hover:text-content-primary text-left"
                  >
                    <FileType className="w-3.5 h-3.5" />
                    HTML（带样式）
                  </button>
                </div>
              )}
            </div>
            {isAssistant && isLastAssistant && canRegenerate && onRegenerate && (
              <button
                onClick={handleRegenerateDebounced}
                className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors active:scale-95 touch-manipulation"
                title="重新生成"
                aria-label="重新生成"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
            )}
            {isUser && canEdit && onEdit && (
              <button
                onClick={startEditingDebounced}
                className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors active:scale-95 touch-manipulation"
                title="编辑"
                aria-label="编辑"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {/* 回复按钮:所有消息都可引用回复 */}
            <button
              onClick={() => {
                const { setReplyingTo } = useChatStore.getState()
                setReplyingTo({
                  id: message.id,
                  role: message.role,
                  text: bodyText.slice(0, 120), // 截取前 120 字符作预览
                })
              }}
              className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors active:scale-95 touch-manipulation"
              title="引用回复"
              aria-label="引用回复"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <Reply className="w-3.5 h-3.5" />
            </button>
            {/* 存错题本:流式结束才可点;已存过显示 ✓ */}
            {!isStreaming && (isUser || isAssistant) && (
              <button
                onClick={handleSaveToStudy}
                disabled={studySaveState === 'saving'}
                className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors active:scale-95 touch-manipulation"
                title="存入错题本"
                aria-label="存入错题本"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                {studySaveState === 'saved' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-accent" />
                ) : (
                  <BookmarkPlus className="w-3.5 h-3.5" />
                )}
              </button>
            )}
            </>
          )}
        </div>
      </div>
      {/* HTML 复制源 —— 按需挂载, 用完即销毁。
          永远不在 render 主路径上常驻(那样会和主显示区的 MarkdownRenderer 一起
          被父组件重渲染, 流式期间双倍重渲染 → 死循环源头之一)。
          仅当用户点 "复制为 HTML" 时临时挂一帧, 拿到 innerHTML 后立即卸载。 */}
      {htmlMirrorActive && (
        <div
          ref={htmlMirrorRef}
          aria-hidden
          style={{
            position: 'absolute',
            left: '-99999px',
            top: 0,
            width: '600px',
            visibility: 'hidden',
            pointerEvents: 'none',
          }}
        >
          <MarkdownRenderer content={bodyText} messageId={message.id} rich inlineImages={inlineImages} />
        </div>
      )}
    </div>
  )
}

/**
 * 自定义 props 比较函数 —— 流式场景下避免无关重渲
 *
 * 关键点:
 * - message.id 不变 → 同一条消息
 * - message.parts 的 state 或文本长度变化 → 必须重渲(流式追加)
 * - message.role 不变 → 同角色
 * - isStreaming 变化 → 必须重渲(切换流式/静态视觉)
 * - isLastAssistant 变化 → 切换按钮可见性
 * - canRegenerate / canEdit: 派生自父级,变化即应重渲
 * - onRegenerate / onEdit: 由父级 useCallback 提供,引用稳定;若变化说明父级未优化,照旧重渲
 */
function areMessageBubblePropsEqual(
  prev: Readonly<MessageBubbleProps>,
  next: Readonly<MessageBubbleProps>
): boolean {
  if (prev.message.id !== next.message.id) return false
  if (prev.message.role !== next.message.role) return false
  // 正在生成的这条不参与判等。根因: AI SDK 首次插入流式消息走 pushMessage(不快照),
  // React 手里的 prev.message 就是被 text-delta 原地累加的那个活对象, 它与 next 的
  // 克隆快照内容永远同步等长 → 下面的 parts 指纹恒判相等 → 整轮不重渲
  // (实测: 网络 338 块到达, DOM 正文只变 2 次, 9.4s→17.5s 气泡零渲染)。
  // 代价只落在这一条气泡上, 且频率由 useChat 的 throttle(50ms) 兜住。
  if (next.isStreaming && next.isLastMessage && next.message.role === 'assistant') return false
  if (prev.isStreaming !== next.isStreaming) return false
  if (prev.isLastAssistant !== next.isLastAssistant) return false
  if (prev.isLastMessage !== next.isLastMessage) return false
  if (prev.canRegenerate !== next.canRegenerate) return false
  if (prev.canEdit !== next.canEdit) return false
  if (prev.onRegenerate !== next.onRegenerate) return false
  if (prev.onEdit !== next.onEdit) return false
  if (prev.isFocused !== next.isFocused) return false
  if (prev.prevUserContent !== next.prevUserContent) return false
  if (prev.contentVisibilityOff !== next.contentVisibilityOff) return false
  // wrapperRef 不必比较(它只用来滚动,变化不影响渲染结果)

  // 附件挂载由异步 effect 注入(引用变化): 不比较会导致文件卡片永远不出现。
  // 引用相同直接跳过(url 唯一,长度+url 指纹足以覆盖增删场景)
  const paAtt = (prev.message as UIMessageWithAttachments).attachments
  const pbAtt = (next.message as UIMessageWithAttachments).attachments
  if (paAtt !== pbAtt) {
    if (!paAtt || !pbAtt || paAtt.length !== pbAtt.length) return false
    for (let i = 0; i < paAtt.length; i++) {
      if (paAtt[i].url !== pbAtt[i].url) return false
    }
  }

  // metadata 引用比对: onFinish 内容同步 / 后端写 chart 卡片时该对象会被替换。
  // 若只靠下面的 parts 指纹,「文本等长替换」会漏渲(如服务端兜底拆分后总长恰好不变)
  if (
    (prev.message as { metadata?: unknown }).metadata !==
    (next.message as { metadata?: unknown }).metadata
  ) {
    return false
  }

  // 关键: parts 的"形状+体量指纹" —— state 切换或文本长度变化才重渲。
  // 流式追加时长度必然增长,而打字机依赖气泡重渲才能把新 fullText 送进
  // useTypewriter —— 只比长度不比内容,O(1) 且足以覆盖"追加"这一唯一常态;
  // 引用稳定的回调(onEdit 已收敛到 ref)让历史气泡在这里直接 bail out
  const pa = prev.message.parts
  const pb = next.message.parts
  if (pa.length !== pb.length) return false
  for (let i = 0; i < pa.length; i++) {
    const a = pa[i]
    const b = pb[i]
    if (a.type !== b.type) return false
    // 同一个 type 的 part,只在 state 切换、文本长度变化或类型变化时重渲
    const aState = (a as { state?: string }).state
    const bState = (b as { state?: string }).state
    if (aState !== bState) return false
    const aText = (a as { text?: unknown }).text
    const bText = (b as { text?: unknown }).text
    const aLen = typeof aText === 'string' ? aText.length : 0
    const bLen = typeof bText === 'string' ? bText.length : 0
    if (aLen !== bLen) return false
  }
  return true
}

/**
 * Memoized MessageBubble —— 列表中其他消息变化时不会重渲
 * (流式场景: 只有"正在流式的那一条 + 最后一条助手"会频繁重渲)
 */
export const MessageBubble = memo(MessageBubbleInner, areMessageBubblePropsEqual)
