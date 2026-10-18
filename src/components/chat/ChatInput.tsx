'use client'

import { useState, useRef, useCallback, useEffect, KeyboardEvent, ChangeEvent } from 'react'
import { Send, Square, X, Plus, AlertCircle, FileText, Play, ArrowUp, Columns2, Drama, Settings as SettingsIcon, Brain, Globe, Plug, Check, ChevronRight, ChevronDown, MoreHorizontal, Copy, ClipboardPaste, TextSelect, Eraser, Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { useContextMenuStore, type ContextMenuItem } from '@/store/contextMenuStore'
import { FileUpload, deleteUploadedFile, type Attachment } from './FileUpload'
import { ModelSelector } from './ModelSelector'
import { ModelQuickSheet } from './ModelQuickSheet'
import { ReasoningTierPicker } from './ReasoningTierPicker'
import { PROVIDER_DOT } from '@/lib/ai/provider-meta'
import { MaskPickerMenu } from './MaskPickerMenu'
import { McpToolMenu } from './McpToolMenu'
import { MiniSwitch } from '@/components/settings/MiniSwitch'
import {
  SEARCH_PLATFORMS,
  getSearchPlatform,
  type SearchPlatformId,
} from '@/lib/ai/search-platforms'
import { ActivityHeatmap } from './ActivityHeatmap'
import type { MaskDTO } from '@/lib/ai/mask-types'
import { useSingleFlight } from '@/hooks/useSingleFlight'
import { useMaskMenuMaxHeight } from '@/hooks/useMaskMenuMaxHeight'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useChatStore } from '@/store/chat-store'
import { draftKeyFor, setDraft as persistDraft } from '@/lib/draft-storage'
import { INPUT_INSERT_EVENT } from '@/lib/input-bridge'
import type { ModelDefinition } from '@/lib/ai/types'

/** 中秋桂花散点坐标(百分比,定稿自 preview-midautumn-themes F-3): 落点避开中心内容带 */
const OSMANTHUS_PTS: [number, number][] = [
  [6, 12], [14, 74], [9, 88], [23, 8], [27, 30], [31, 92], [44, 84], [52, 4],
  [58, 16], [66, 90], [73, 10], [79, 78], [86, 22], [90, 62], [12, 40], [88, 40],
]

/** 手机端输入正文行高(15px/24px),长文升半屏的行数判据基准 */
const MOBILE_LINE_H = 24

/** 半屏编辑器计数文案:字数 + 按 300 字/分折算的通读时长(不足 1 分钟只报字数) */
function longTextCount(text: string): string {
  const chars = text.replace(/\s/g, '').length
  const secs = Math.round((chars / 300) * 60)
  if (secs < 60) return `${chars} 字`
  return `${chars} 字 · 约 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒`
}

export interface ChatInputProps {
  onSend: (text: string, attachments?: Attachment[]) => void
  onStop: () => void
  isLoading: boolean
  className?: string
  models: ModelDefinition[]
  selectedModel: string
  onModelChange: (modelId: string) => void
  deepThink: boolean
  onDeepThinkChange: (enabled: boolean) => void
  /** 联网搜索。需要在设置中配置 SearchApiKey。 */
  webSearch?: boolean
  onWebSearchChange?: (enabled: boolean) => void
  webSearchAvailable?: boolean
  /** 平台定向口径：'auto' 模型自判 / 'all' 强制全网 / 具体平台 id 强制站内白名单。
   *  仅在联网搜索开启时可交互（见 @/lib/ai/search-platforms） */
  searchPlatform?: SearchPlatformId
  onSearchPlatformChange?: (platform: SearchPlatformId) => void
  /** MCP 外部工具。用户名下有启用的 MCP server 时才显示开关。 */
  mcpEnabled?: boolean
  onMcpEnabledChange?: (enabled: boolean) => void
  mcpAvailable?: boolean
  // 对比模式
  compareMode?: boolean
  compareModeAvailable?: boolean
  onCompareModeChange?: (enabled: boolean) => void
  compareModels?: string[]
  onCompareModelsChange?: (models: string[]) => void
  /** 当前生效面具(欢迎页胶囊显示);空表示未使用面具 */
  mask?: { id: string; name: string; avatar: string } | null
  /** 切换/清除面具(欢迎页胶囊菜单) */
  onMaskChange?: (maskId: string | null) => void
  /** 自定义面具列表(欢迎页胶囊菜单「我的面具」分组) */
  userMasks?: MaskDTO[]
  /** 打开面具管理(设置页 masks 分区) */
  onManageMasks?: () => void
  /** 「接着说」横幅:存在时显示在输入框上方 */
  pendingContinuationExists?: boolean
  onContinue?: () => void
  onDismissContinuation?: () => void
  /**
   * 视觉变体:
   * - 'standard'(默认): 聊天页底部玻璃态卡片,支持附件 / 对比 / 接着说
   * - 'welcome': 新对话页简洁卡片(中间偏上),附件/对比入口在输入框下方胶囊行
   */
  variant?: 'standard' | 'welcome'
  /** welcome 变体顶部可选问候语/引导(slot) */
  welcomeHeader?: React.ReactNode
  /** welcome 变体贴在输入胶囊上方的提示条(slot),与错误/草稿提示同一节奏 */
  welcomeBanner?: React.ReactNode
}

export function ChatInput({
  onSend,
  onStop,
  isLoading,
  className,
  models,
  selectedModel,
  onModelChange,
  deepThink,
  onDeepThinkChange,
  webSearch = false,
  onWebSearchChange,
  webSearchAvailable = false,
  searchPlatform = 'auto',
  onSearchPlatformChange,
  mcpEnabled = true,
  onMcpEnabledChange,
  mcpAvailable = false,
  compareMode = false,
  compareModeAvailable = false,
  onCompareModeChange,
  compareModels,
  onCompareModelsChange,
  mask,
  onMaskChange,
  userMasks,
  onManageMasks,
  pendingContinuationExists,
  onContinue,
  onDismissContinuation,
  variant = 'standard',
  welcomeHeader,
  welcomeBanner,
}: ChatInputProps) {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sendError, setSendError] = useState<string | null>(null)
  const [draftRestored, setDraftRestored] = useState(false)
  // welcome 变体:面具胶囊菜单开合
  const [maskMenuOpen, setMaskMenuOpen] = useState(false)
  // MCP 工具下拉菜单开合(总开关+逐工具开关)
  const [mcpMenuOpen, setMcpMenuOpen] = useState(false)
  // 平台定向弹层(桌面): absolute 锚在胶囊行内 + document pointerdown 收合。
  // 不用 fixed 遮罩: 祖先带 backdrop-blur 时 fixed 会退化(同推理面板定案口径)。
  const [platformMenuOpen, setPlatformMenuOpen] = useState(false)
  const platformWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!platformMenuOpen) return
    function onDown(e: PointerEvent) {
      if (!platformWrapRef.current?.contains(e.target as Node)) setPlatformMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [platformMenuOpen])
  // ⋯ 更多工具菜单开合(收纳: 对比模式 + 移动端的面具/MCP)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  // 手机端模型入口:胶囊内不放 ModelSelector,改由 ⋯ 唤 iOS 半屏快切
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const isMobileViewport = useIsMobileViewport()
  // 面具菜单盒高: 桌面在胶囊里向下弹;手机端胶囊贴底,同一颗钮改为向上弹,故方向按视口切换
  const maskMenu = useMaskMenuMaxHeight(maskMenuOpen, isMobileViewport ? 'up' : 'down')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 手机端严格两钮:胶囊内不放上传钮,⋯ 面板「添加附件」经此句柄代理点击隐藏 input
  const attachOpenRef = useRef<(() => void) | null>(null)
  // 手机端长文:>6 行自动升半屏编辑器,≤5 行收回(留 1 行滞回,防阈值抖动反复升降)
  const [longTextMode, setLongTextMode] = useState(false)
  // 手动「收起」后按住不自动弹回,直到行数真的落回阈值以下
  const manualCollapseRef = useRef(false)
  // 手机端正文当前行数(按内容全高折算),驱动圆角收回与「收起/展开」行
  const [mobileLines, setMobileLines] = useState(1)

  // 引用回复状态
  const replyingTo = useChatStore((s) => s.replyingTo)
  const setReplyingTo = useChatStore((s) => s.setReplyingTo)

  // 内置壁纸模式(背景=图片):开启时欢迎页收起点阵/光效装饰,壁纸在 shell 层渲染
  const wallpaperOn = useChatStore((s) => s.backdropMode === 'image')

  // ── 草稿自动保存 ──────────────────────────────────────────────────────────
  // 用 store 里的 currentConversationId 作为 key 维度;空会话用 '__new__'
  const currentConversationId = useChatStore((s) => s.currentConversationId)
  const draftKey = draftKeyFor(currentConversationId)
  const draftsMap = useChatStore((s) => s.drafts)
  const storeSetDraft = useChatStore((s) => s.setDraft)
  // 跟踪上一次挂载的 key:key 变化时重新加载草稿(防止跨会话串台)
  const lastLoadedKeyRef = useRef<string | null>(null)

  // key 切换 → 加载对应草稿(SSR 期间 drafts 为空,客户端 hydrate 后再加载)
  useEffect(() => {
    if (lastLoadedKeyRef.current === draftKey) return
    lastLoadedKeyRef.current = draftKey
    const draft = draftsMap[draftKey]
    if (draft && draft.text) {
      setInput(draft.text)
      setDraftRestored(true)
      // 3 秒后自动隐藏"已恢复"提示
      const t = setTimeout(() => setDraftRestored(false), 3000)
      return () => clearTimeout(t)
    } else {
      setInput('')
    }
    // 仅依赖 key;draftsMap 变化不触发(避免用户输入时被覆盖)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  // 切换会话时清空引用回复(避免跨会话残留)
  useEffect(() => {
    return () => setReplyingTo(null)
  }, [currentConversationId, setReplyingTo])

  // 输入变化 → 写入 store + localStorage(节流 400ms)
  useEffect(() => {
    const t = setTimeout(() => {
      const trimmed = input.trim()
      if (trimmed) {
        storeSetDraft(draftKey, { text: input, savedAt: Date.now() })
        persistDraft(draftKey, { text: input, savedAt: Date.now() })
      } else {
        // 空文本 → 清掉草稿,避免残留旧内容
        storeSetDraft(draftKey, null)
        persistDraft(draftKey, null)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [input, draftKey, storeSetDraft])

  // 外部注入文本(右键代码块「让 AI 解释」等深层入口):追加到输入框并聚焦。
  // 草稿持久化由上方 input effect 自动完成,这里只管 setState。
  useEffect(() => {
    function onInsert(e: Event) {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (typeof text !== 'string' || !text) return
      setInput((prev) => (prev ? `${prev}\n\n${text}` : text))
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
    window.addEventListener(INPUT_INSERT_EVENT, onInsert)
    return () => window.removeEventListener(INPUT_INSERT_EVENT, onInsert)
  }, [])

  // Auto-resize textarea (standard/welcome 自适应卡片共用)
  // 手机端高度一律由内容决定(半屏编辑器除外):原来 min(scrollHeight,164) 在真机字体
  // 度量下会比内容少几 px,配 overflow-y:auto 就露出滚动条拇指(D3)。卡态改 hidden,
  // 高度不再被 164 截断,升半屏由 mobileLong 判据接管
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    if (isMobileViewport) {
      textarea.style.height = longTextMode
        ? `${Math.round(Math.min(window.innerHeight * 0.55, 464))}px`
        : `${textarea.scrollHeight}px`
      return
    }
    textarea.style.height = `${Math.min(textarea.scrollHeight, variant === 'welcome' ? 164 : 200)}px`
  }, [variant, isMobileViewport, longTextMode])

  useEffect(() => {
    adjustHeight()
  }, [input, adjustHeight])

  // 升/收判据必须读「内容全高」:临时置 auto 再量 scrollHeight。
  // 半屏展开后 textarea 高度被编辑器接管,直接量会恒等于编辑器高度 → 永远收不回
  useEffect(() => {
    if (!isMobileViewport) {
      setLongTextMode(false)
      setMobileLines(1)
      manualCollapseRef.current = false
      return
    }
    const ta = textareaRef.current
    if (!ta) return
    const prev = ta.style.height
    ta.style.height = 'auto'
    // 手机端正文 py-2(上下共 16px)要从内容高里扣掉,否则每行档位整体偏 0.7 行
    const lines = Math.max(0, ta.scrollHeight - 16) / MOBILE_LINE_H
    ta.style.height = prev
    setMobileLines(lines)
    if (lines <= 5) {
      manualCollapseRef.current = false
      setLongTextMode(false)
    } else if (lines > 6 && !manualCollapseRef.current) {
      setLongTextMode(true)
    }
  }, [input, isMobileViewport])

  // 发送结束后归还焦点(仅鼠标设备):本 effect 挂载时也会跑一次(isLoading 初始 false),
  // 触屏设备程序性 focus 会立刻弹出软键盘 —— 进主页/AI 回答完都被打断,故 pointer:coarse 一律不抢焦点
  useEffect(() => {
    if (isLoading) return
    if (window.matchMedia('(pointer: coarse)').matches) return
    textareaRef.current?.focus()
  }, [isLoading])

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
  }

  // 输入框右键 → 轮盘(粘贴/复制/全选/清空),替换浏览器原生菜单。
  // 长按右键同样生效:Host 会向本元素合成 contextmenu,复用此装配逻辑
  function handleInputContextMenu(e: React.MouseEvent<HTMLTextAreaElement>) {
    // 触屏设备(手机)不拦截:长按回退浏览器原生粘贴/复制菜单(改版前基线行为)
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return
    const ta = e.currentTarget
    const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd)
    const items: ContextMenuItem[] = [
      {
        id: 'paste',
        label: '粘贴',
        icon: <ClipboardPaste className="w-3.5 h-3.5" />,
        onSelect: () => {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (!text) return
              setInput((prev) => (prev ? `${prev}${text}` : text))
              requestAnimationFrame(() => ta.focus())
            })
            .catch(() => {})
        },
      },
      {
        id: 'copy',
        label: '复制',
        icon: <Copy className="w-3.5 h-3.5" />,
        disabled: !selected && !ta.value,
        onSelect: () => {
          void copyText(selected || ta.value)
        },
      },
      {
        id: 'select-all',
        label: '全选',
        icon: <TextSelect className="w-3.5 h-3.5" />,
        disabled: !ta.value,
        onSelect: () => {
          ta.focus()
          ta.select()
        },
      },
      {
        id: 'clear',
        label: '清空',
        icon: <Eraser className="w-3.5 h-3.5" />,
        danger: true,
        disabled: !ta.value,
        dividerBefore: true,
        onSelect: () => {
          setInput('')
          ta.focus()
        },
      },
    ]
    e.preventDefault()
    const { openContextMenu } = useContextMenuStore.getState()
    openContextMenu({ x: e.clientX, y: e.clientY }, items)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // IME 组合态(拼音选词中)不触发发送;Safari 组合结束帧 isComposing 已翻转但 keyCode 仍为 229,一并拦截
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendDebounced()
    }
  }

  function handleSendInternal() {
    const trimmed = input.trim()
    if ((!trimmed && attachments.length === 0) || isLoading) return

    // 图片附件需要视觉模型:拦截不支持视觉的模型,给出明确指引
    if (attachments.some((a) => a.type.startsWith('image/'))) {
      const visionModels = models.filter((m) => m.supportsVision)
      if (compareMode && compareModels) {
        const blind = compareModels.filter(
          (id) => !models.find((m) => m.id === id)?.supportsVision
        )
        if (blind.length > 0) {
          const blindNames = blind
            .map((id) => models.find((m) => m.id === id)?.name ?? id)
            .join('、')
          setSendError(
            `对比模式中的 ${blindNames} 不支持图片识别` +
              (visionModels.length > 0
                ? `，请换成支持视觉的模型（如 ${visionModels.slice(0, 2).map((m) => m.name).join('、')}）`
                : '')
          )
          return
        }
      } else {
        const current = models.find((m) => m.id === selectedModel)
        if (current && !current.supportsVision) {
          setSendError(
            `当前模型 ${current.name} 不支持图片识别` +
              (visionModels.length > 0
                ? `，请切换到 ${visionModels.slice(0, 2).map((m) => m.name).join(' 或 ')} 后重试`
                : '，请先选择支持视觉的模型')
          )
          return
        }
      }
    }

    setSendError(null)
    // 如果有引用,拼接到消息前面
    let finalText = trimmed
    if (replyingTo) {
      const prefix = `> 回复 ${replyingTo.role === 'user' ? '用户' : 'AI'}: ${replyingTo.text}\n\n`
      finalText = prefix + trimmed
      // 清空引用状态
      setReplyingTo(null)
    }
    onSend(finalText, attachments.length > 0 ? attachments : undefined)
    setInput('')
    setAttachments([])
    // 发送后立即清掉本会话的草稿(避免下次再误加载)
    storeSetDraft(draftKey, null)
    persistDraft(draftKey, null)
    // Reset height after send
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }, 0)
  }

  // Single-flight 锁:发送期间屏蔽重复点击,发送完成后解锁
  const handleSendDebounced = useSingleFlight(handleSendInternal, [
    input,
    attachments,
    isLoading,
    compareMode,
    compareModels,
    models,
    selectedModel,
    onSend,
    variant,
  ])

  // 对比模式: 更换某个位置的模型(若与列表内其他位置重复则交换)
  function handleCompareModelChange(index: number, modelId: string) {
    if (!compareModels || !onCompareModelsChange) return
    const next = [...compareModels]
    const existingIdx = next.indexOf(modelId)
    if (existingIdx !== -1 && existingIdx !== index) {
      next[existingIdx] = next[index]
    }
    next[index] = modelId
    onCompareModelsChange(next)
  }

  function handleAddCompareModel() {
    if (!compareModels || !onCompareModelsChange || compareModels.length >= 3) return
    const next = models.find((m) => !compareModels.includes(m.id))
    if (next) onCompareModelsChange([...compareModels, next.id])
  }

  function handleRemoveCompareModel(index: number) {
    if (!compareModels || !onCompareModelsChange || compareModels.length <= 2) return
    onCompareModelsChange(compareModels.filter((_, i) => i !== index))
  }

  // ============= 共享工具图标组 =============
  // welcome(新对话页)与 standard(会话页)共用,位于输入框卡片内底部行左侧。
  // A+B 融合方案:全部图标化圆形钮(桌面 28px/移动 44px 触控),低频入口分端收纳:
  //   桌面外显 上传/思考/搜索/MCP/面具,对比模式收进 ⋯;
  //   移动端(<sm)只外显 上传/思考/搜索,MCP/面具/对比全部收进 ⋯(390px 实测不溢出)。
  // MCP/面具是弹菜单型入口:桌面从各自钮弹出,移动端从 ⋯ 钮弹出(两端互斥渲染)。
  // 手机端 38px:与原型 tiny-btn 同档,单行胶囊里 4 个钮 + 输入区在 390px 下才不溢出
  const iconBtnBase = 'flex items-center justify-center h-7 w-7 min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 rounded-full transition-colors shrink-0'
  const pillIdle = 'bg-surface-muted hover:bg-surface-subtle text-content-secondary'
  const pillActive = 'bg-accent text-accent-foreground'
  const hasCompareEntry = compareModeAvailable && !!onCompareModeChange
  const currentModel = models.find((m) => m.id === selectedModel)
  const hasMcpEntry = mcpAvailable && !!onMcpEnabledChange
  const hasMaskEntry = !!onMaskChange
  // ⋯ 钮:手机端恒显(深度思考/搜索/面具/MCP/对比全收在这里);
  // 桌面端仅当有「对比模式」项时出现(面具/MCP 桌面已外显),用 hidden/max-sm:block 分端控制
  // ⋯ 更多工具/面具/MCP 弹层(welcome 与 standard 两变体共用):
  // 挂在 ⋯ 按钮自身的 wrapper 上,以按钮为锚居中向上弹出;
  // 宽度钳制必须用视口单位(calc(100vw-2rem)):百分比 max-w 相对锚点 wrapper(仅 44px)解析,
  // 会把弹层压瘪成竖条(曾实测 28px)。w-60/w-64 加视口钳制后任何屏宽不溢出视口。
  const moreMenus = (
    <>
      {moreMenuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMoreMenuOpen(false)} />
          <div
            className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-50 w-60 max-w-[calc(100vw-2rem)]
              rounded-xl border border-line bg-surface shadow-lg py-1.5
              max-md:left-auto max-md:right-1 max-md:translate-x-0 max-md:w-[min(300px,calc(100vw-16px))]
              max-md:rounded-2xl max-md:bg-surface/95 max-md:backdrop-blur-xl
              max-md:max-h-[60vh] max-md:overflow-y-auto
              max-md:shadow-[0_18px_50px_rgb(0_0_0_/_0.28)]"
            role="menu"
          >
            {/* 内容组(仅手机端):附件与面具都不再占胶囊位,统一从 ⋯ 进入 */}
            {isMobileViewport && (
              <>
                <div className="px-2.5 pt-2 pb-1 text-[10px] font-medium tracking-wider text-content-muted">内容</div>
                <button
                  className="flex items-center gap-2.5 w-full px-2.5 min-h-[44px] py-2 rounded-lg text-xs text-content-primary hover:bg-surface-subtle active:bg-surface-subtle transition-colors text-left"
                  onClick={() => { setMoreMenuOpen(false); attachOpenRef.current?.() }}
                >
                  <Paperclip className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium">添加附件</span>
                    <span className="block text-[10px] text-content-muted truncate">
                      {attachments.length > 0 ? `已选 ${attachments.length} 个` : '图片 / 文本 / PDF'}
                    </span>
                  </span>
                  <ChevronRight className="w-3 h-3 text-content-muted shrink-0" />
                </button>
                {hasMaskEntry && (
                  <button
                    className="flex items-center gap-2.5 w-full px-2.5 min-h-[44px] py-2 rounded-lg text-xs text-content-primary hover:bg-surface-subtle active:bg-surface-subtle transition-colors text-left"
                    onClick={() => { setMoreMenuOpen(false); setMaskMenuOpen(true) }}
                  >
                    {mask ? (
                      <span aria-hidden className="w-3.5 text-center text-[13px] leading-none shrink-0">{mask.avatar}</span>
                    ) : (
                      <Drama className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium">面具</span>
                      <span className="block text-[10px] text-content-muted truncate">
                        {mask ? `${mask.name}` : '未选，用默认人格'}
                      </span>
                    </span>
                    <ChevronRight className="w-3 h-3 text-content-muted shrink-0" />
                  </button>
                )}
                <div className="px-2.5 pt-2 pb-1 text-[10px] font-medium tracking-wider text-content-muted">模型</div>
              </>
            )}
            {/* 模型(手机端专属):md 以下胶囊里撤掉了 ModelSelector,这里补一个入口,点了弹 iOS 半屏快切 */}
            {!compareMode && (
              <button
                className="hidden max-md:flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-xs text-content-primary hover:bg-surface-subtle active:bg-surface-subtle transition-colors text-left"
                onClick={() => { setMoreMenuOpen(false); setModelSheetOpen(true) }}
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-1.5 w-1.5 flex-none rounded-full',
                    PROVIDER_DOT[currentModel?.provider ?? ''] ?? 'bg-content-muted'
                  )}
                />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium">切换模型</span>
                  <span className="block text-[10px] text-content-muted truncate">{currentModel?.name ?? selectedModel}</span>
                </span>
                <ChevronRight className="w-3 h-3 text-content-muted shrink-0" />
              </button>
            )}
            {isMobileViewport && (
              <div className="px-2.5 pt-2 pb-1 text-[10px] font-medium tracking-wider text-content-muted">工具</div>
            )}
            {/* 深度思考 / 智能搜索(仅移动端):胶囊里放不下第 4、5 个钮,收进 ⋯ 行内开关。
                行本体必须是 div —— MiniSwitch 自身是 button,button 套 button 会被 HTML 解析降级并触发 hydration 报错 */}
            <div className="flex sm:hidden items-center gap-2.5 w-full px-2.5 min-h-[44px] py-2 rounded-lg text-xs text-content-primary hover:bg-surface-subtle active:bg-surface-subtle transition-colors">
              <button
                className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                onClick={() => onDeepThinkChange(!deepThink)}
                aria-pressed={deepThink}
              >
                <Brain className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium">深度思考</span>
                  <span className="block text-[10px] text-content-muted">回答前先展示推理过程</span>
                </span>
              </button>
              <MiniSwitch on={deepThink} onClick={() => onDeepThinkChange(!deepThink)} />
            </div>
            {webSearchAvailable && onWebSearchChange && (
              <div className="flex sm:hidden items-center gap-2.5 w-full px-2.5 min-h-[44px] py-2 rounded-lg text-xs text-content-primary hover:bg-surface-subtle active:bg-surface-subtle transition-colors">
                <button
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                  onClick={() => onWebSearchChange(!webSearch)}
                  aria-pressed={webSearch}
                >
                  <Globe className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium">智能搜索</span>
                    <span className="block text-[10px] text-content-muted">联网检索后再答</span>
                  </span>
                </button>
                <MiniSwitch on={webSearch} onClick={() => onWebSearchChange(!webSearch)} />
              </div>
            )}
            {/* 平台定向(仅移动端): 联网开启才出,与桌面同一份 SEARCH_PLATFORMS 口径 */}
            {webSearch && webSearchAvailable && onWebSearchChange && onSearchPlatformChange && (
              <div className="flex sm:hidden flex-col gap-1.5 w-full px-2.5 pb-2">
                <span className="text-[10px] leading-relaxed text-content-muted">
                  平台定向（自动=模型按问题判断；查不到会自动回退全网）
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {SEARCH_PLATFORMS.map((p) => {
                    const on = p.id === searchPlatform
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onSearchPlatformChange(p.id)}
                        aria-pressed={on}
                        className={cn(
                          'flex items-center gap-1 h-10 px-3 rounded-lg text-xs transition-colors',
                          on
                            ? 'bg-accent text-accent-foreground'
                            : 'bg-surface-muted hover:bg-surface-subtle text-content-secondary'
                        )}
                      >
                        {p.label}
                        {on && <Check className="w-3 h-3" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {/* MCP 工具(仅移动端): 行内快速开关;点主体进管理菜单 */}
            {hasMcpEntry && (
              <div className="flex sm:hidden items-center gap-2.5 w-full px-2.5 min-h-[44px] py-2 rounded-lg text-xs text-content-primary hover:bg-surface-subtle active:bg-surface-subtle transition-colors">
                <button
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                  onClick={() => { setMoreMenuOpen(false); setMcpMenuOpen(true) }}
                >
                  <Plug className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium">MCP 工具</span>
                    <span className="block text-[10px] text-content-muted">{mcpEnabled ? '外部工具注入本会话' : '本会话已停用'}</span>
                  </span>
                </button>
                <MiniSwitch on={mcpEnabled} onClick={() => onMcpEnabledChange(!mcpEnabled)} />
              </div>
            )}
            {/* 对比模式(全端): 低频开关,开启后 textarea 下方出现多模型行 */}
            {hasCompareEntry && (
              <button
                className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-xs text-content-primary hover:bg-surface-subtle active:bg-surface-subtle transition-colors text-left"
                onClick={() => { onCompareModeChange(!compareMode); setMoreMenuOpen(false) }}
              >
                <Columns2 className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium">对比模式</span>
                  <span className="block text-[10px] text-content-muted">多模型同时回答</span>
                </span>
                {compareMode && <Check className="w-3.5 h-3.5 shrink-0" />}
              </button>
            )}
          </div>
        </>
      )}
      {/* 移动端: MCP 管理菜单从 ⋯ 钮弹出(面具已外显成胶囊内独立钮,不再走 ⋯ 二级) */}
      <div className="sm:hidden">
        {mcpMenuOpen && onMcpEnabledChange && (
          <McpToolMenu
            mcpEnabled={mcpEnabled}
            onMcpEnabledChange={onMcpEnabledChange}
            onClose={() => setMcpMenuOpen(false)}
          />
        )}
      </div>
      {/* 手机端面具列表:胶囊内不再有独立钮,从 ⋯「面具」进入后贴底浮层展示(与模型快切同构) */}
      {hasMaskEntry && isMobileViewport && maskMenuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMaskMenuOpen(false)} />
          <div
            className="fixed inset-x-2 bottom-2 z-50 flex flex-col overflow-hidden rounded-2xl
              border border-line bg-surface/95 glass-blur shadow-[0_18px_50px_rgb(0_0_0_/_0.28)]"
            style={{ maxHeight: '55vh' }}
            role="menu"
          >
            <MaskPickerMenu
              activeMaskId={mask?.id ?? null}
              userMasks={userMasks}
              onSelect={(id) => { onMaskChange(id); setMaskMenuOpen(false) }}
              onManage={() => { onManageMasks?.(); setMaskMenuOpen(false) }}
              onClear={() => { onMaskChange(null); setMaskMenuOpen(false) }}
            />
          </div>
        </>
      )}
      {/* 手机端模型半屏快切(portal 到 body,与欢迎页 hero 胶囊同一条 onModelChange 链路) */}
      <ModelQuickSheet
        open={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        models={models}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
      />
    </>
  )
  // 手机端输入形态(桌面恒为 false,DOM 与类名不随之变化):
  //   mobileCard —— 有内容(正文非空或挂了附件):方角卡片 + 正文独行 + 钮沉底
  //   mobileLong —— 超过 6 行:出现「收起/展开 + 计数」行(半屏编辑器的判据)
  //   mobileWide —— 半屏展开中或长文:高度交给视口,正文可滚动
  //   mobileStack —— 卡片态与半屏态共用的「正文独占整行」布局开关
  // 必须声明在 toolPills 之前:toolPills 的 JSX 求值时就引用了这些标志
  // 2026-10-08 真机多行改版定案(预览页里的「零抖动」那条;注意本文件另一处"方案 C"
  // 是 10-06 悬浮胶囊改版的旧代号,与本次无关):原门槛 mobileLines > 2 让第 2 行停在
  // 9999 圆角的胖胶囊上(D1)。换挡改到 0→1 次,打字全程不再变形;代价由用户点名接受
  const mobileCard = isMobileViewport && (!!input.trim() || attachments.length > 0)
  const mobileLong = isMobileViewport && mobileLines > 6
  const mobileWide = longTextMode || mobileLong
  const mobileStack = mobileCard || mobileWide

  const toolPills = (
    <>
            {/* 附件钮:桌面外显;手机端撤掉(胶囊只留 ⋯ + 发送),入口改由 ⋯「添加附件」触发 */}
            {!isMobileViewport && (
              <FileUpload
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                disabled={isLoading}
                hideAttachmentsPreview
                variant="pill"
                pillClassName={cn(iconBtnBase, pillIdle, 'border-0')}
              />
            )}
            {/* 推理强度(触发胶囊+滑杆面板): 桌面外显;与 deepThink 同源,2 段=标准/深度思考。
                手机端仍收进 ⋯ 面板的 MiniSwitch(见 moreMenus),此处 hidden sm:block 不占移动端胶囊位 */}
            <ReasoningTierPicker
              deepThink={deepThink}
              onDeepThinkChange={onDeepThinkChange}
              modelName={currentModel?.name}
              disabled={isLoading}
            />
            {/* 智能搜索开关(图标钮): 联网搜索不可用时隐藏(与模型选择器菜单逻辑一致) */}
            {webSearchAvailable && onWebSearchChange && (
              <button
                onClick={() => onWebSearchChange(!webSearch)}
                disabled={isLoading}
                className={cn(
                  iconBtnBase,
                  // 手机端收进 ⋯ 面板,桌面端保持外显
                  'hidden sm:flex',
                  webSearch ? pillActive : pillIdle,
                  isLoading && 'opacity-50 cursor-not-allowed'
                )}
                title="智能搜索(联网检索)"
                aria-label="智能搜索"
                aria-pressed={webSearch}
              >
                <Globe className="w-3.5 h-3.5" />
              </button>
            )}
            {/* 平台定向(桌面外显): 联网开启才出。默认「自动」= 不干涉模型,与改造前一致;
                选定具体平台后服务端直接按域白名单过滤,并把 platform 参数从工具 schema 摘掉 */}
            {webSearch && webSearchAvailable && onWebSearchChange && onSearchPlatformChange && (
              <div ref={platformWrapRef} className="relative hidden sm:block">
                <button
                  onClick={() => setPlatformMenuOpen((v) => !v)}
                  disabled={isLoading}
                  className={cn(
                    'flex items-center gap-1 h-7 min-h-[38px] sm:min-h-0 px-2.5 rounded-full text-xs transition-colors shrink-0',
                    searchPlatform === 'auto' ? pillIdle : pillActive,
                    isLoading && 'opacity-50 cursor-not-allowed'
                  )}
                  title="平台定向：只查某个站（B站/小红书/知乎…）。自动=由模型按问题判断"
                  aria-label="搜索平台定向"
                  aria-haspopup="menu"
                  aria-expanded={platformMenuOpen}
                >
                  <span className="max-w-[5rem] truncate">{getSearchPlatform(searchPlatform).label}</span>
                  <ChevronDown className="w-3 h-3 opacity-70" />
                </button>
                {platformMenuOpen && (
                  <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-50 w-[236px] rounded-xl border border-line bg-surface shadow-lg p-2">
                    <p className="px-1 pb-1.5 text-[10px] leading-relaxed text-content-muted">
                      限定检索站点。站内索引比全网稀薄，查不到时会自动回退全网并说明。
                    </p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {SEARCH_PLATFORMS.map((p) => {
                        const on = p.id === searchPlatform
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              onSearchPlatformChange(p.id)
                              setPlatformMenuOpen(false)
                            }}
                            className={cn(
                              'flex items-center justify-center gap-1 h-9 rounded-lg text-xs transition-colors',
                              on
                                ? 'bg-accent text-accent-foreground'
                                : 'bg-surface-muted hover:bg-surface-subtle text-content-secondary'
                            )}
                          >
                            {p.label}
                            {on && <Check className="w-3 h-3" />}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* MCP 工具(桌面外显): 点击弹出管理菜单;移动端收纳进 ⋯ */}
            {hasMcpEntry && (
              <div className="relative hidden sm:block">
                <button
                  onClick={() => setMcpMenuOpen((v) => !v)}
                  disabled={isLoading}
                  className={cn(
                    iconBtnBase,
                    mcpEnabled ? pillActive : pillIdle,
                    isLoading && 'opacity-50 cursor-not-allowed'
                  )}
                  title="MCP 外部工具(点击管理工具开关)"
                  aria-label="MCP 工具"
                  aria-haspopup="menu"
                  aria-expanded={mcpMenuOpen}
                  aria-pressed={mcpEnabled}
                >
                  <Plug className="w-3.5 h-3.5" />
                </button>
                {mcpMenuOpen && (
                  <McpToolMenu
                    mcpEnabled={mcpEnabled}
                    onMcpEnabledChange={onMcpEnabledChange}
                    onClose={() => setMcpMenuOpen(false)}
                  />
                )}
              </div>
            )}
            {/* 面具钮:桌面(欢迎页胶囊)外显;手机端改由 ⋯ 面板进入,列表用贴底浮层展示。
                会话页桌面端仍由 ChatPanel 顶部面具 chip 承担,故 standard 变体桌面隐藏 */}
            {hasMaskEntry && !isMobileViewport && (
              <div className={cn('relative', variant === 'welcome' ? 'block' : 'hidden')}>
                <button
                  ref={maskMenu.triggerRef}
                  onClick={() => setMaskMenuOpen((v) => !v)}
                  className={cn(iconBtnBase, mask ? pillActive : pillIdle)}
                  title={mask ? '当前面具,点击切换' : '选择面具'}
                  aria-label="选择面具"
                  aria-haspopup="menu"
                  aria-expanded={maskMenuOpen}
                >
                  {mask ? (
                    <span aria-hidden className="text-[13px] leading-none">{mask.avatar}</span>
                  ) : (
                    <Drama className="w-3.5 h-3.5" aria-hidden />
                  )}
                </button>
                {maskMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMaskMenuOpen(false)} />
                    <div
                      className="absolute top-full mt-1.5 left-1/2 -translate-x-1/2 z-50 w-64 max-md:w-[min(300px,calc(100vw-16px))] max-md:left-auto max-md:right-0 max-md:translate-x-0 max-md:top-auto max-md:bottom-full max-md:mt-0 max-md:mb-1.5 flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
                      style={{ maxHeight: maskMenu.maxHeight }}
                      role="menu"
                    >
                      <MaskPickerMenu
                        activeMaskId={mask?.id ?? null}
                        userMasks={userMasks}
                        onSelect={(id) => { onMaskChange(id); setMaskMenuOpen(false) }}
                        onManage={() => { onManageMasks?.(); setMaskMenuOpen(false) }}
                        onClear={() => { onMaskChange(null); setMaskMenuOpen(false) }}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
            {/* ⋯ 更多工具(收纳菜单): 桌面=对比模式;手机=附件/面具/模型/深度思考/搜索/MCP/对比。
                手机端弹层要贴输入卡右缘,故 max-md:static 撤掉自身定位锚点;
                手机端恒显(它是唯一工具入口),桌面仅当有「对比模式」项时出现 */}
            <div className={cn('relative shrink-0 max-md:static', !hasCompareEntry && 'hidden max-md:block', mobileStack && 'max-md:ml-auto')}>
              <button
                onClick={() => setMoreMenuOpen((v) => !v)}
                className={cn(iconBtnBase, moreMenuOpen ? pillActive : pillIdle)}
                title="更多工具"
                aria-label="更多工具"
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
              {/* ⋯ 弹层: 桌面以按钮为锚居中向上弹出;手机端贴输入卡右缘(两变体共用) */}
              {moreMenus}
            </div>
    </>
  )

  // 对比模式: 多模型选择行(welcome 与 standard 共用);移动端隐藏(md:flex),开启后替代右侧单模型选择器
  // 手机端附件宿主:胶囊只留 ⋯ + 发送,上传进度卡挂在正文上方,选文件由 ⋯「添加附件」经 openRef 触发。
  // 不包 wrapper:wrapper 会是胶囊的一个空 flex 子项,白占一行 + 4px 间距(实测胶囊 54→58)
  const mobileFileUploadHost = isMobileViewport ? (
    <FileUpload
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      disabled={isLoading}
      hideAttachmentsPreview
      hideTrigger
      openRef={attachOpenRef}
    />
  ) : null

  // 手机端长文顶行:「收起/展开」+ 字数·预计时长。手动收起后此行保留,否则无从再展开
  const longTextHeader = mobileLong ? (
    <div className="flex w-full items-center gap-2">
      <button
        onClick={() => {
          if (longTextMode) {
            manualCollapseRef.current = true
            setLongTextMode(false)
          } else {
            manualCollapseRef.current = false
            setLongTextMode(true)
          }
        }}
        className="flex items-center gap-0.5 h-6 px-2 rounded-full shrink-0 bg-surface-muted text-[11px] text-content-secondary"
        aria-label={longTextMode ? '收起长文编辑器' : '展开长文编辑器'}
      >
        <ChevronDown className={cn('w-3 h-3 transition-transform', !longTextMode && 'rotate-180')} aria-hidden />
        {longTextMode ? '收起' : '展开'}
      </button>
      <span className="flex-1 min-w-0 text-right text-[11px] text-content-muted truncate">
        {longTextCount(input)}
      </span>
    </div>
  ) : null

  const compareModelsRow =
    compareMode && compareModels && onCompareModelsChange ? (
      <div className="hidden md:flex items-center justify-end gap-1 px-3 pt-1.5">
        {compareModels.map((modelId, index) => (
          <div key={modelId} className="flex items-center gap-0.5">
            <ModelSelector
              models={models}
              selectedModel={modelId}
              onModelChange={(id) => handleCompareModelChange(index, id)}
              compact
            />
            {compareModels.length > 2 && (
              <button
                onClick={() => handleRemoveCompareModel(index)}
                className="shrink-0 p-1 rounded-md text-content-muted hover:text-red-500 hover:bg-surface-subtle transition-colors"
                aria-label="移除模型"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
          </div>
        ))}
        {compareModels.length < 3 && (
          <button
            onClick={handleAddCompareModel}
            className="flex items-center gap-0.5 h-7 px-2 rounded-full text-[11px] font-medium
              border border-dashed border-line text-content-secondary
              hover:bg-surface-subtle transition-colors shrink-0"
            title="添加对比模型"
            aria-label="添加对比模型"
          >
            <Plus className="w-3 h-3" />
          </button>
        )}
      </div>
    ) : null

  // ============= WELCOME VARIANT =============
  if (variant === 'welcome') {
    return (
      // data-tauri-drag-region:新对话页除中间输入卡片外整片都是空白(装饰层已
      // pointer-events:none),客户端下正是最顺手的抓窗区;只挂属性、不写
      // -webkit-app-region,子元素不继承拖拽区,卡片内控件点击/选词照旧。
      <div
        data-tauri-drag-region=""
        className={cn('relative flex-1 w-full flex flex-col justify-center max-md:justify-start px-4', className)}
        style={{
          // 键盘弹出时让内容贴底(否则依旧被键盘遮住);
          // 没键盘时桌面/移动都垂直居中(只加 paddingBottom 占键盘)。
          // --m-input-pad: 手机端胶囊底距(globals.css 断点定义,桌面 0)
          paddingBottom: 'calc(var(--m-input-pad, 0px) + max(var(--keyboard-height, 0px), var(--sab, 0px)))',
        }}
      >
        {/* 壁纸图与可读性蒙版都合成在 shell 层(WelcomeWallpaperLayer);
            这里只在壁纸关闭时渲染点阵/月盘/光效装饰 —— 开图后纹理会与它们打架 */}
        {!wallpaperOn && (
          <>
        {/* 点阵背景: 中心(内容区)淡出、四周渐显,纯装饰 */}
        <div className="dot-grid" aria-hidden="true" />

        {/* 月夜层(仅配色=月白·桂花金, 见 globals.css 的 .fest-night 门控):
            右上角月盘。该配色只有深色一态,故与白天语境不冲突 */}
        <div className="fest-night moon-corner" aria-hidden="true" />
        {/* 晨光-格子(配色=格子 且 光态=日出, 见 .grid-dawn 门控):
            一天的第一缕光 —— 光在右上画外低角(蜜桃粉光斑从右上溢入) + 全屏薄雾,
            窗棂格影朝**左下**,与暮色"光在左下/影朝右上"成镜像。不画天体 */}
        <div className="grid-dawn light-layer" aria-hidden="true">
          <div className="dawn-glow" />
          <div className="dawn-haze" />
          <div className="dawn-mullion" />
        </div>
        {/* 正午-格子(配色=格子 且 光态=白天, 见 .grid-day 门控):
            窗外天光 = 顶边过曝带 + 窗棂格影 + 玻璃斜光。光源在画面外,
            不画圆盘(白天在角落放"太阳"会被读成凭空一个发光的球) */}
        <div className="grid-day light-layer" aria-hidden="true">
          <div className="daylight-skyfall" />
          <div className="daylight-mullion" />
          <div className="daylight-sheen" />
        </div>
        {/* 日落-格子(配色=格子 且 光态=暮色, 见 .grid-night 门控):
            日头贴到地平线 —— 地平线暖带 + 左下外溢柔光 + 水平云条 +
            暖调玻璃斜光 + 被低角度光拉长的窗棂格影(同一扇窗,同源不同形) */}
        <div className="grid-night light-layer" aria-hidden="true">
          <div className="dusk-horizon" />
          <div className="dusk-spill" />
          <div className="dusk-cloudband">
            <i />
            <i />
            <i />
          </div>
          <div className="dusk-mullion" />
          <div className="dusk-sheen" />
        </div>
        {/* 深夜-格子(配色=格子 且 光态=晚上, 见 .grid-nightfall 门控):
            这一态**没有光** —— 按定稿"删光",右上那团镜面高光整个去掉
            (高光泽反射是金属感的来源)。画面只剩一层冷月白的窗棂格影,
            深底上走 screen 提亮;不画天体,与月白·桂花金一眼可分 */}
        <div className="grid-nightfall light-layer" aria-hidden="true">
          <div className="nightfall-mullion" />
        </div>
        <div className="osmanthus-layer osmanthus" aria-hidden="true">
          {OSMANTHUS_PTS.map(([x, y]) => (
            <i key={`${x}-${y}`} style={{ left: `${x}%`, top: `${y}%` }} />
          ))}
        </div>
          </>
        )}

        {/* 方案 C 手机端:h-full + flex-col,hero 由 my-auto 在自由空间垂直居中,
            输入卡与横滑卡贴底 —— 复刻原型「标语居中/卡片沉底」结构 */}
        <div className="relative w-full max-w-2xl mx-auto -translate-y-[6vh] md:-translate-y-[8vh]
          max-md:h-full max-md:flex max-md:flex-col max-md:justify-start max-md:translate-y-0">
          {/* 可选问候语(slot); 整体上移 6vh(移动)/8vh(桌面),视觉重心中间偏上 */}
          {welcomeHeader}

          {/* 最近对话横滑卡已于 2026-10-05 从手机端欢迎页撤下(用户定案:只留问候语 + 输入胶囊)。
              数据未动,入口仍在抽屉「最近历史」;组件文件 WelcomeCarousel.tsx 保留可随时回挂,
              与 BottomDock 同一处置口径 */}

          {/* 草稿已恢复提示 —— 仅在有草稿时短暂出现 */}
          {draftRestored && input.trim() && (
            <div className="flex items-center gap-1.5 mb-2 mx-2 text-content-muted">
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="text-[11px] flex-1 min-w-0">已恢复上次未发送的内容</span>
              <button
                onClick={() => {
                  setInput('')
                  setDraftRestored(false)
                }}
                className="shrink-0 text-[11px] text-content-secondary hover:text-content-primary underline-offset-2 hover:underline"
                aria-label="清除草稿"
              >
                清除
              </button>
            </div>
          )}

          {/* 发送前校验错误(例如:图片附件 + 当前模型不支持视觉) */}
          {sendError && (
            <div className="flex items-start gap-1.5 mb-2 mx-2">
              <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
              <p className="text-xs text-red-500 leading-relaxed flex-1 min-w-0">{sendError}</p>
              <button
                onClick={() => setSendError(null)}
                className="shrink-0 p-0.5 rounded text-content-muted hover:text-content-primary transition-colors"
                aria-label="关闭提示"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {welcomeBanner}

          {/* 输入框容器: 自适应高度 = 附件预览(可选) + textarea + 底部工具行(与 standard 同构);relative 供 ⋯ 弹层锚定
              方案 C 手机端:胶囊化(26px 圆角+白玻璃+柔投影,原型 pill-input 材质) */}
          <div
            className={cn(
              'relative rounded-xl border border-line bg-surface shadow-sm',
              'focus-within:border-line-strong focus-within:shadow-md',
              'transition-[border-color,box-shadow] duration-200',
              'max-md:flex max-md:flex-wrap max-md:items-end max-md:gap-1 max-md:p-1.5 max-md:pl-4',
              'max-md:rounded-full max-md:border-white/55 max-md:bg-surface/85 max-md:glass-blur',
              // 暗色下白描边 55% 过曝成亮圈:按原型 body.dark .pill 定稿改主题线色
              'dark:max-md:border-line/90',
              'max-md:shadow-[0_8px_26px_rgb(0_0_0_/_0.14)]',
              // 手机端有内容即卡片:圆角从 9999 收回 24px,单行胶囊只留给空态
              mobileCard && 'max-md:rounded-3xl'
            )}
          >
            {mobileFileUploadHost}
            {longTextHeader}
            {/* 附件预览(放在 textarea 上方,与 standard 变体一致);手机端整行占满胶囊上方 */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 px-4 pt-3 max-md:w-full max-md:px-1 max-md:pt-1">
                {attachments.map((att, idx) => (
                  <div
                    key={att.url + idx}
                    className={cn(
                      'group flex items-center gap-2 rounded-lg border',
                      'border-line bg-surface-muted',
                      'px-2 py-1.5 w-full sm:max-w-[200px] sm:w-auto'
                    )}
                  >
                    {att.type.startsWith('image/') ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={att.url}
                        alt={att.name}
                        className="w-5 h-5 rounded object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-5 h-5 rounded bg-surface-subtle flex items-center justify-center shrink-0 text-[8px] text-content-secondary">
                        {/* 用扩展名而非 MIME 子类型:xlsx/docx 的 MIME 是长串 vnd.openxmlformats,截前 3 字符会显示 VND */}
                        {att.name.split('.').pop()?.toUpperCase().slice(0, 3) || 'FILE'}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-content-primary truncate">
                        {att.name}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        const removed = attachments[idx]
                        setAttachments((prev) => prev.filter((_, i) => i !== idx))
                        // 移除未发送的附件时同步删除服务端文件
                        if (removed) deleteUploadedFile(removed.url)
                      }}
                      className="shrink-0 p-0.5 rounded-md opacity-0 show-on-touch group-hover:opacity-100 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-500 transition-opacity"
                      aria-label="移除"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onContextMenu={handleInputContextMenu}
              placeholder="输入问题..."
              rows={1}
              disabled={isLoading}
              className={cn(
                'block w-full bg-transparent text-base sm:text-sm text-content-primary placeholder:text-content-muted',
                'resize-none focus:outline-none border-0 m-0 px-4 pt-3 pb-1 overflow-y-auto disabled:opacity-50',
                'max-md:flex-1 max-md:min-w-0 max-md:px-1.5 max-md:py-2 max-md:text-[15px] max-md:pb-2',
                // 手机端卡片态:正文整行独占,⋯ + 发送 换到底部一行
                mobileStack && 'max-md:w-full max-md:basis-full',
                // 卡态高度=内容高,绝不允许滚动条;只有半屏编辑器内容可溢,才开滚动
                mobileStack && !mobileWide && 'max-md:overflow-hidden'
              )}
              style={{
                // 手机端单行胶囊内收严到 36px(见 globals.css --m-ta-min),桌面保持 44px
                minHeight: 'var(--m-ta-min, 44px)',
                // 手机端高度全权交给 adjustHeight,164px 上限只留桌面
                maxHeight: isMobileViewport ? 'none' : '164px',
                lineHeight: '24px',
              }}
            />

            {/* 对比模式: 多模型选择行(welcome 与 standard 共用) */}
            {compareModelsRow}
            {/* 底部工具行: 左=工具胶囊组 右=模型选择+发送;手机端两包装 contents → 全部子项并入胶囊单行 */}
            <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1 max-md:contents">
              <div className="flex items-center gap-1.5 min-w-0 max-md:contents">
                {toolPills}
              </div>
              <div className="flex items-center gap-1 shrink-0 max-md:contents">
                {/* 模型入口:手机端走 hero/会话页顶部胶囊,不在胶囊里重复占位 */}
                {!compareMode && (
                  <div className="max-md:hidden">
                    <ModelSelector
                      models={models}
                      selectedModel={selectedModel}
                      onModelChange={onModelChange}
                      compact
                    />
                  </div>
                )}
                <button
                  onClick={handleSendDebounced}
                  disabled={(!input.trim() && attachments.length === 0) || isLoading}
                  aria-label="发送"
                  className={cn(
                    // 手机端 38px 圆钮(原型 tiny-btn 档);桌面 36px;窄屏 44px 触控
                    'shrink-0 flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 rounded-full transition-colors',
                    'max-md:w-[38px] max-md:h-[38px]',
                    'active:scale-95 touch-manipulation',
                    (input.trim() || attachments.length > 0) && !isLoading
                      ? 'bg-accent text-accent-foreground hover:bg-accent/90 animate-pop-in'
                      : 'bg-surface-subtle text-content-muted cursor-not-allowed'
                  )}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <ArrowUp className="w-[18px] h-[18px]" />
                </button>
              </div>
            </div>
          </div>

          {/* 活跃度热力图: 输入框卡片下方居中(仅桌面;手机端以最近对话快捷区替代) */}
          <div className="hidden md:block mt-3">
            <ActivityHeatmap />
          </div>
          {/* 「最近对话」快捷区已于 2026-10-07 应用户要求整体下线(同 WelcomeCarousel/BottomDock 口径:
              只撤 UI 不删组件,RelativeTime 仍被 MobileDrawer 引用;要回挂在原位重新 import 渲染即可) */}
        </div>
      </div>
    )
  }

  // ============= STANDARD VARIANT =============
  return (
    // 底部 padding = 0.5rem 基础间距 + max(软键盘高度, 底部安全区)。
    // useVisualViewport hook 会把键盘高度写入 --keyboard-height(桌面上始终 0px);
    // --sab 是 Home Indicator 安全区(浏览器内为 0,PWA 全屏/无键盘时非 0),
    // 取较大者避免键盘弹出时叠加出多余空白。
    // 间距走 --m-input-pad:桌面回落 0.5rem(内联默认值),手机端由 globals 覆写成 12px(悬浮)
    <div
    // 层级必须高于消息区的错误横幅浮层(z-40):⋯ 面板从胶囊向上弹到 60vh,
    // 若沿用 z-20 会被横幅吃掉点击(实测 390×844 有横幅时「切换模型」点不动)
      className={cn('relative z-[42] px-3 pt-1', className)}
      style={{
        // --m-input-pad: 手机端胶囊底距(globals.css 断点定义,桌面 0.5rem)
        paddingBottom: 'calc(var(--m-input-pad, 0.5rem) + max(var(--keyboard-height, 0px), var(--sab, 0px)))',
      }}
    >
      <div className="max-w-2xl mx-auto">
      {/* 「接着说」横幅 —— 在输入框正上方 */}
      {pendingContinuationExists && onContinue && onDismissContinuation && (
        <div className="mb-1.5">
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 px-3 py-2 rounded-lg
              bg-amber-50/80 dark:bg-amber-950/30
              border border-amber-200/70 dark:border-amber-800/50
              backdrop-blur-sm shadow-sm"
          >
            <Play className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
            <span className="text-xs text-amber-700 dark:text-amber-300 flex-1 min-w-0 truncate">
              模型在上次中断的位置停了下来
            </span>
            <button
              onClick={onContinue}
              className="shrink-0 px-2.5 py-1 rounded-md text-xs font-medium
                bg-amber-500 text-white hover:bg-amber-600
                active:scale-95 transition-all"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              接着说
            </button>
            <button
              onClick={onDismissContinuation}
              className="shrink-0 p-0.5 rounded text-amber-600/70 dark:text-amber-400/70 hover:text-amber-700 hover:bg-amber-100/50 dark:hover:bg-amber-900/30 transition-colors"
              aria-label="关闭提示"
              title="不再提示"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 引用回复横幅 */}
      {replyingTo && (
        <div className="mb-1.5">
          <div
            role="status"
            className="flex items-center gap-2 px-3 py-2 rounded-lg
              bg-blue-50/80 dark:bg-blue-950/30
              border border-blue-200/70 dark:border-blue-800/50
              backdrop-blur-sm shadow-sm"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-blue-600/70 dark:text-blue-400/70 font-medium mb-0.5">
                回复 {replyingTo.role === 'user' ? '用户' : 'AI'}
              </div>
              <div className="text-xs text-blue-700 dark:text-blue-300 truncate">
                {replyingTo.text}
              </div>
            </div>
            <button
              onClick={() => setReplyingTo(null)}
              className="shrink-0 p-0.5 rounded text-blue-600/70 dark:text-blue-400/70 hover:text-blue-700 hover:bg-blue-100/50 dark:hover:bg-blue-900/30 transition-colors"
              aria-label="取消引用"
              title="取消引用"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      <div
        className={cn(
          'relative flex flex-col rounded-xl border z-20',
          'border-line/60',
          'bg-surface-glass glass-blur',
          'shadow-lg focus-within:border-line-strong',
          'transition-all',
          // 方案 C 手机端:与欢迎页同款单行胶囊(圆角拉满 + 白玻璃 + 柔投影)
          // base 是 flex-col,手机端必须显式改回 row,否则 flex-wrap 会横向开新列
          'max-md:flex max-md:flex-row max-md:flex-wrap max-md:items-end max-md:gap-1 max-md:p-1.5 max-md:pl-4',
          // 2026-10-07 用户定案:底部两角改回圆角(推翻 10-06 直角版),四角完整胶囊弧
          'max-md:rounded-full max-md:border-white/55 max-md:bg-surface/85 max-md:glass-blur',
          // 暗色下白描边 55% 过曝成亮圈:按原型 body.dark .pill 定稿改主题线色
          'dark:max-md:border-line/90',
          'max-md:shadow-[0_8px_26px_rgb(0_0_0_/_0.14)]',
          // 手机端有内容即卡片:圆角从 9999 收回 24px,单行胶囊只留给空态
          // (写 rounded-3xl 会被 cn 的 tailwind-merge 判为覆盖 rounded-full,四角一起收,正合此形态)
          mobileCard && 'max-md:rounded-3xl'
        )}
      >
          {mobileFileUploadHost}
          {longTextHeader}
          {/* Attachments preview row */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3 max-md:w-full max-md:px-1 max-md:pt-1">
              {attachments.map((att, idx) => (
                <div
                  key={att.url + idx}
                  className={cn(
                    'group flex items-center gap-2 rounded-lg border',
                    'border-line bg-surface-muted',
                    'px-2 py-1.5 w-full sm:max-w-[200px] sm:w-auto'
                  )}
                >
                  {att.type.startsWith('image/') ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={att.url} alt={att.name} className="w-5 h-5 rounded object-cover shrink-0" />
                  ) : (
                    <div className="w-5 h-5 rounded bg-surface-subtle flex items-center justify-center shrink-0 text-[8px] text-content-secondary">
                      {att.type.split('/')[1]?.toUpperCase().slice(0, 3) || 'FILE'}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-content-primary truncate">{att.name}</p>
                  </div>
                  <button
                    onClick={() => {
                      const removed = attachments[idx]
                      setAttachments((prev) => prev.filter((_, i) => i !== idx))
                      // 移除未发送的附件时同步删除服务端文件
                      if (removed) deleteUploadedFile(removed.url)
                    }}
                    className="shrink-0 p-0.5 rounded-md opacity-0 show-on-touch group-hover:opacity-100 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-500 transition-opacity"
                    aria-label="移除"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 发送前校验错误提示 */}
          {sendError && (
            <div className="flex items-start gap-1.5 px-4 pt-2 max-md:w-full max-md:px-1">
              <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
              <p className="text-xs text-red-500 leading-relaxed flex-1 min-w-0">{sendError}</p>
              <button
                onClick={() => setSendError(null)}
                className="shrink-0 p-0.5 rounded text-content-muted hover:text-content-primary transition-colors"
                aria-label="关闭提示"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* 草稿已恢复提示 —— 进入会话时短暂浮现,可手动关闭 */}
          {draftRestored && input.trim() && (
            <div className="flex items-center gap-1.5 px-4 pt-2 text-content-muted max-md:w-full max-md:px-1">
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="text-[11px] flex-1 min-w-0">已恢复上次未发送的内容</span>
              <button
                onClick={() => {
                  setInput('')
                  setDraftRestored(false)
                }}
                className="shrink-0 text-[11px] text-content-secondary hover:text-content-primary underline-offset-2 hover:underline"
                aria-label="清除草稿"
              >
                清除
              </button>
            </div>
          )}

          {/* Textarea —— 手机端 wrapper 用 contents,让 textarea 直接成为胶囊行的 flex 子项 */}
          <div className="px-4 pt-3 max-md:contents">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onContextMenu={handleInputContextMenu}
              placeholder="输入消息..."
              disabled={isLoading}
              rows={1}
              className={cn(
                'w-full resize-none bg-transparent text-base sm:text-sm',
                'text-content-primary',
                'placeholder:text-content-muted',
                'focus:outline-none disabled:opacity-50',
                'min-h-[24px] max-h-[200px]',
                // 10-07 定案:单行胶囊内的正文(36px 高、15px 字号、左右贴着胶囊内边距)
                'max-md:flex-1 max-md:min-w-0 max-md:px-1.5 max-md:py-2 max-md:text-[15px]',
                // 手机端高度由 adjustHeight 按内容写,164px 上限会把 6 行截掉几 px → 滚动条拇指(D3)
                'max-md:min-h-[var(--m-ta-min)] max-md:max-h-none',
                // 10-08 定案:有内容即卡片 —— 正文整行独占,⋯ + 发送 沉到底部一行
                mobileStack && 'max-md:w-full max-md:basis-full',
                mobileStack && !mobileWide && 'max-md:overflow-hidden'
              )}
            />
          </div>

          {/* 对比模式: 多模型选择行(welcome 与 standard 共用,定义见 compareModelsRow) */}
          {compareModelsRow}

          {/* Bottom controls row: 左侧工具胶囊组(上传/对比/深度思考/智能搜索/MCP/面具) + 右侧模型选择与发送
              手机端:两层 wrapper 都 contents,子项直接并入胶囊单行 */}
          <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-1.5 max-md:contents">
            {/* 工具胶囊组(移动端只留图标,允许收窄) */}
            <div className="flex items-center gap-1.5 min-w-0 max-md:contents">
              {toolPills}
            </div>
            {/* Model selector + send button */}
            <div className="flex items-center gap-1 shrink-0 max-md:contents">
              {!compareMode && (
                <div className="max-md:hidden">
                  <ModelSelector
                    models={models}
                    selectedModel={selectedModel}
                    onModelChange={onModelChange}
                    compact
                  />
                </div>
              )}
              {isLoading ? (
                <button
                  onClick={onStop}
                  className={cn(
                    // 手机端 38px 圆钮(与欢迎页胶囊同档),桌面 28px;必须撤掉 44px 触控下限否则 min-* 顶住尺寸
                    'h-7 w-7 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center rounded-full transition-colors shrink-0',
                    'max-md:min-h-0 max-md:min-w-0 max-md:h-[38px] max-md:w-[38px]',
                    'bg-accent text-accent-foreground hover:bg-accent-hover'
                  )}
                  aria-label="停止生成"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  onClick={handleSendDebounced}
                  disabled={!input.trim() && attachments.length === 0}
                  className={cn(
                    'h-7 w-7 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center rounded-full transition-colors shrink-0',
                    'max-md:min-h-0 max-md:min-w-0 max-md:h-[38px] max-md:w-[38px]',
                    'active:scale-95 touch-manipulation',
                    (input.trim() || attachments.length > 0)
                      ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
                      : 'bg-surface-muted text-content-muted cursor-not-allowed'
                  )}
                  aria-label="发送消息"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
