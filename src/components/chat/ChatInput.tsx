'use client'

import { useState, useRef, useCallback, useEffect, KeyboardEvent, ChangeEvent } from 'react'
import { Send, Square, X, Plus, AlertCircle, FileText, Play, ArrowUp, Columns2, Drama, Brain, Globe, Plug, Check, ChevronRight, ChevronLeft, ChevronDown, MoreHorizontal, Copy, ClipboardPaste, TextSelect, Eraser, Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { useContextMenuStore, type ContextMenuItem } from '@/store/contextMenuStore'
import { FileUpload, deleteUploadedFile, UploadingChip, type Attachment, type UploadingItem } from './FileUpload'
import { ChatImageLightbox } from './ChatImageLightbox'
import { ModelSelector } from './ModelSelector'
import { ModelQuickSheet } from './ModelQuickSheet'
import { ReasoningTierPicker } from './ReasoningTierPicker'
import { PROVIDER_DOT } from '@/lib/ai/provider-meta'
import { MaskPickerMenu } from './MaskPickerMenu'
import { McpToolMenu } from './McpToolMenu'
import { MiniSwitch } from '@/components/settings/MiniSwitch'
import { MobileSheet, SheetGroup, SheetRow, SheetToggleRow } from '@/components/ui/MobileSheet'
import {
  SEARCH_PLATFORMS,
  getSearchPlatform,
  type SearchPlatformId,
} from '@/lib/ai/search-platforms'
import { ActivityHeatmap } from './ActivityHeatmap'
import type { MaskDTO } from '@/lib/ai/mask-types'
import type { BuiltinMask } from '@/lib/ai/builtin-masks'
import { useSingleFlight } from '@/hooks/useSingleFlight'
import { useMaskMenuMaxHeight } from '@/hooks/useMaskMenuMaxHeight'
import { usePanelPresence } from '@/hooks/usePanelPresence'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useChatStore } from '@/store/chat-store'
import { draftKeyFor, setDraft as persistDraft } from '@/lib/draft-storage'
import { INPUT_INSERT_EVENT } from '@/lib/input-bridge'
import type { ModelDefinition } from '@/lib/ai/types'
import { useComposerShortcuts } from './useComposerShortcuts'
import { normalizeReferences, prependConversationReferences, type ConversationReference } from '@/lib/chat-shortcuts'

/** 中秋桂花散点坐标(百分比,定稿自 preview-midautumn-themes F-3): 落点避开中心内容带 */
const OSMANTHUS_PTS: [number, number][] = [
  [6, 12], [14, 74], [9, 88], [23, 8], [27, 30], [31, 92], [44, 84], [52, 4],
  [58, 16], [66, 90], [73, 10], [79, 78], [86, 22], [90, 62], [12, 40], [88, 40],
]

/** 手机端输入正文行高(15px/24px),长文升半屏的行数判据基准 */
const MOBILE_LINE_H = 24

/** 剪贴板文件常叫 image.png / 空名,附件卡上一列同名很糊,这类通用名替换成带时间戳的可读名 */
const GENERIC_PASTE_NAME = /^(image|blob|clipboard)(\.\w+)?$/i

/** 读屏文件类型的扩展名(jpeg → jpg,其余按 mime 子类型) */
function pasteExtOf(type: string): string {
  const sub = type.split('/')[1] || 'png'
  return sub.replace(/^jpeg$/, 'jpg').replace(/^\+xml$/, '')
}

function withPasteName(file: File): File {
  if (file.name && !GENERIC_PASTE_NAME.test(file.name)) return file
  const ext = pasteExtOf(file.type)
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '-')
  const base = file.type.startsWith('image/') ? '粘贴图片' : '粘贴文件'
  return new File([file], `${base}-${stamp}.${ext}`, { type: file.type, lastModified: file.lastModified })
}

/** 从剪贴板事件里捞可上传的文件:截图/复制的图片、从资源管理器复制的文件都在其中 */
function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return []
  const fromItems = Array.from(data.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((f): f is File => !!f)
  const files = fromItems.length > 0 ? fromItems : Array.from(data.files)
  return files.map(withPasteName)
}

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
  /** 面具面板已下载的内置面具(与自定义面具一起进「我的面具」) */
  installedMasks?: readonly BuiltinMask[]
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
  installedMasks,
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
  // 上传中条目:进度卡与已上传附件卡排在同一行(FileUpload 经 hideUploads 交出渲染权),
  // 否则进度卡会挤进底部工具行,把胶囊行撑高、把附件钮挤到下一排
  const [uploadingFiles, setUploadingFiles] = useState<UploadingItem[]>([])
  const [references, setReferences] = useState<ConversationReference[]>([])
  // 待发送图片附件的大图预览下标(对应 attachments 过滤出的图片序列)
  const [previewImageIndex, setPreviewImageIndex] = useState<number | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [draftRestored, setDraftRestored] = useState(false)
  // welcome 变体:面具胶囊菜单开合
  const [maskMenuOpen, setMaskMenuOpen] = useState(false)
  // MCP 工具下拉菜单开合(总开关+逐工具开关)
  const [mcpMenuOpen, setMcpMenuOpen] = useState(false)
  // ⋯ 更多工具菜单开合(收纳: 搜索平台定向 + 对比模式 + 移动端的面具/MCP)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  // ⋯ 菜单里的平台定向二级面板(方案A 2026-11-11): 行点击换页成九站网格,返回箭头回主列表。
  // 只是同一弹层内的层级态,开合随 ⋯ 菜单走;⋯ 关闭时复位回第一层
  const [platformGridOpen, setPlatformGridOpen] = useState(false)
  useEffect(() => {
    if (!moreMenuOpen) setPlatformGridOpen(false)
  }, [moreMenuOpen])
  // 手机端模型入口:胶囊内不放 ModelSelector,改由 ⋯ 唤 iOS 半屏快切
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  // 面板退场统一入口:关闭后保留 180ms 播完动效再卸载；动效本体见 globals.css 的 .panel-motion
  const morePanel = usePanelPresence(moreMenuOpen)
  const maskPanel = usePanelPresence(maskMenuOpen)
  const isMobileViewport = useIsMobileViewport()
  // 面具菜单盒高: 桌面在胶囊里向下弹;手机端改走 MobileSheet(自带 portal,不受输入卡 glass-blur 的包含块影响)
  const maskMenu = useMaskMenuMaxHeight(maskMenuOpen, isMobileViewport ? 'up' : 'down')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 手机端严格两钮:胶囊内不放上传钮,⋯ 面板「添加附件」经此句柄代理点击隐藏 input
  const attachOpenRef = useRef<(() => void) | null>(null)
  // 剪贴板直传句柄:FileUpload 挂载时写入,Ctrl+V / 右键粘贴的图片与文件由此进上传链路
  const attachFilesRef = useRef<((files: FileList | File[]) => void) | null>(null)
  // 手机端长文:>6 行自动升半屏编辑器,≤5 行收回(留 1 行滞回,防阈值抖动反复升降)
  const [longTextMode, setLongTextMode] = useState(false)
  // 手动「收起」后按住不自动弹回,直到行数真的落回阈值以下
  const manualCollapseRef = useRef(false)
  // 手机端正文当前行数(按内容全高折算),驱动圆角收回与「收起/展开」行
  const [mobileLines, setMobileLines] = useState(1)

  // 引用回复状态
  const replyingTo = useChatStore((s) => s.replyingTo)
  const setReplyingTo = useChatStore((s) => s.setReplyingTo)

  // ── 草稿自动保存 ──────────────────────────────────────────────────────────
  // 用 store 里的 currentConversationId 作为 key 维度;空会话用 '__new__'
  const currentConversationId = useChatStore((s) => s.currentConversationId)
  const draftKey = draftKeyFor(currentConversationId)
  const draftsMap = useChatStore((s) => s.drafts)
  const storeSetDraft = useChatStore((s) => s.setDraft)
  // 跟踪上一次挂载的 key:key 变化时重新加载草稿(防止跨会话串台)
  const lastLoadedKeyRef = useRef<string | null>(null)

  const shortcuts = useComposerShortcuts({
    input, setInput, textareaRef, scopeKey: draftKey, isLoading,
    models, selectedModel, onModelChange, compareMode,
    deepThink, onDeepThinkChange, webSearch, webSearchAvailable, onWebSearchChange,
    maskId: mask?.id, userMasks, installedMasks, onMaskChange, references, setReferences,
    onUpload: () => attachOpenRef.current?.(),
    onOpen: () => {
      setMoreMenuOpen(false)
      setMaskMenuOpen(false)
      setMcpMenuOpen(false)
      setPlatformGridOpen(false)
      setModelSheetOpen(false)
    },
  })
  const hasSendContent = !!input.trim() || attachments.length > 0 || references.length > 0
  const sendBlocked = isLoading || shortcuts.pending

  // key 切换 → 加载对应草稿(SSR 期间 drafts 为空,客户端 hydrate 后再加载)
  useEffect(() => {
    if (lastLoadedKeyRef.current === draftKey) return
    lastLoadedKeyRef.current = draftKey
    const draft = draftsMap[draftKey]
    const restoredReferences = normalizeReferences(draft?.references)
    setReferences(restoredReferences)
    if (draft && (draft.text || restoredReferences.length)) {
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
      if (trimmed || references.length) {
        const draft = { text: input, savedAt: Date.now(), ...(references.length ? { references } : {}) }
        storeSetDraft(draftKey, draft)
        persistDraft(draftKey, draft)
      } else {
        // 空文本且无引用 → 清掉草稿,避免残留旧内容
        storeSetDraft(draftKey, null)
        persistDraft(draftKey, null)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [input, references, draftKey, storeSetDraft])

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
    shortcuts.updateFromTextarea(e.target)
  }

  // Ctrl+V 直传:剪贴板里的图片/文件直接进待发送附件,不必先存盘再点附件钮。
  // 纯文字粘贴一律放行(浏览器原生插入);图文混贴时文字照常插入、图片收进附件
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (isLoading) return
    const files = filesFromClipboard(e.clipboardData)
    if (files.length === 0) return
    attachFilesRef.current?.(files)
  }

  // 右键「粘贴」:先读富内容(截图/复制的图片直接进附件),不支持或被拒权限时退回纯文本
  async function pasteRichFromClipboard(focusTarget: HTMLTextAreaElement) {
    const appendText = (text: string) => {
      if (!text) return
      setInput((prev) => (prev ? `${prev}${text}` : text))
    }
    if (!isLoading && navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read()
        const files: File[] = []
        let text = ''
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith('image/'))
          if (imageType) {
            const blob = await item.getType(imageType)
            files.push(withPasteName(new File([blob], '', { type: imageType })))
          } else if (item.types.includes('text/plain')) {
            text += await (await item.getType('text/plain')).text()
          }
        }
        if (files.length > 0) attachFilesRef.current?.(files)
        appendText(text)
        requestAnimationFrame(() => focusTarget.focus())
        return
      } catch {
        // 落到下面的纯文本读取
      }
    }
    try {
      appendText(await navigator.clipboard.readText())
      requestAnimationFrame(() => focusTarget.focus())
    } catch {
      // 剪贴板不可读时静默(与改版前一致)
    }
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
          void pasteRichFromClipboard(ta)
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
    if (shortcuts.handleKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendDebounced()
    }
  }

  function handleSendInternal() {
    const trimmed = input.trim()
    if (!hasSendContent || isLoading || shortcuts.isPending()) return

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
    // 复用现有文本发送/持久化/对比链路：发送的是可见的正文快照，不只是会话标题。
    finalText = prependConversationReferences(finalText, references)
    onSend(finalText, attachments.length > 0 ? attachments : undefined)
    shortcuts.close()
    shortcuts.clearFeedback()
    setInput('')
    setReferences([])
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
    references,
    replyingTo,
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
  const iconBtnBase = 'composer-tool flex items-center justify-center h-7 w-7 min-h-[38px] min-w-[38px] sm:min-h-0 sm:min-w-0 rounded-full transition-colors shrink-0'
  const pillIdle = 'bg-surface-muted hover:bg-surface-subtle text-content-secondary'
  const pillActive = 'bg-accent text-accent-foreground'
  const hasCompareEntry = compareModeAvailable && !!onCompareModeChange
  // 搜索平台定向(方案A 2026-11-11): 桌面不再外露胶囊,收进 ⋯ 菜单作二级面板。
  // 与联网开关绑定为从属项:搜索关着时整条不出现(能力开关仍外显在工具行)
  const hasPlatformEntry = webSearch && webSearchAvailable && !!onSearchPlatformChange
  const currentModel = models.find((m) => m.id === selectedModel)
  const hasMcpEntry = mcpAvailable && !!onMcpEnabledChange
  const hasMaskEntry = !!onMaskChange
  // ⋯ 更多工具(welcome 与 standard 两变体共用):
  // 桌面端 =「搜索平台定向」(联网开启才出,点开原地换页成九站网格)+「对比模式」,以 ⋯ 钮为锚向上弹小气泡;
  // 手机端整套工具改走统一底部面板 MobileSheet(把手 / 居中标题 / 取消行 / 下滑关闭)。
  // 宽度钳制必须用视口单位(calc(100vw-2rem)):百分比 max-w 相对锚点 wrapper(仅 44px)解析,
  // 会把弹层压瘪成竖条(曾实测 28px)。w-60 加视口钳制后任何屏宽不溢出视口。
  const moreMenus = (
    <>
      {!isMobileViewport && (hasCompareEntry || hasPlatformEntry) && morePanel.rendered && (
        <>
          <div
            className={cn('fixed inset-0 z-40', morePanel.closing && 'pointer-events-none')}
            onClick={() => setMoreMenuOpen(false)}
          />
          <div
            className="panel-motion absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-50 w-60 max-w-[calc(100vw-2rem)]
              rounded-xl border border-line bg-surface shadow-lg p-1.5"
            data-panel-state={morePanel.closing ? 'closed' : 'open'}
            data-panel-kind="pop-soft"
            data-panel-side="top"
            role="menu"
          >
            {hasPlatformEntry && !platformGridOpen && (
              <>
                <button
                  className="flex items-center gap-3 w-full px-2.5 py-2.5 rounded-lg text-xs text-content-primary hover:bg-surface-subtle active:bg-surface-subtle transition-colors text-left"
                  onClick={() => setPlatformGridOpen(true)}
                >
                  <Globe className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium">搜索平台定向</span>
                    <span className="block mt-0.5 truncate text-[10px] text-content-muted">
                      {getSearchPlatform(searchPlatform).sub}
                    </span>
                  </span>
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-55" aria-hidden />
                </button>
                {hasCompareEntry && <div className="mx-2 my-1 h-px bg-line" aria-hidden />}
              </>
            )}
            {hasCompareEntry && !platformGridOpen && (
              <button
                className="flex items-center gap-3 w-full px-2.5 py-2.5 rounded-lg text-xs text-content-primary hover:bg-surface-subtle active:bg-surface-subtle transition-colors text-left"
                onClick={() => { onCompareModeChange(!compareMode); setMoreMenuOpen(false) }}
              >
                <Columns2 className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium">对比模式</span>
                  <span className="block mt-0.5 text-[10px] text-content-muted">多模型同时回答</span>
                </span>
                {compareMode && <Check className="w-3.5 h-3.5 shrink-0" />}
              </button>
            )}
            {/* 二级面板: 九站网格原地替换主列表(同弹层同锚点,视觉上是翻页不是换弹层)。
                网格口径沿用原桌面胶囊弹层的定稿(3列 h-9 圆角钮,选中 accent+对勾) */}
            {hasPlatformEntry && platformGridOpen && (
              <div role="menu" aria-label="搜索平台定向">
                <div className="flex items-center gap-1 px-1 pb-1 pt-0.5">
                  <button
                    type="button"
                    onClick={() => setPlatformGridOpen(false)}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-content-secondary transition-colors hover:bg-surface-subtle"
                    aria-label="返回"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <span className="flex-1 text-xs font-semibold text-content-primary">搜索平台定向</span>
                  <span className="shrink-0 text-[10px] text-content-muted">
                    当前 {getSearchPlatform(searchPlatform).label}
                  </span>
                </div>
                <p className="px-1 pb-1.5 text-[10px] leading-relaxed text-content-muted">
                  站内索引较稀薄，查不到时会自动回退全网并说明。
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {SEARCH_PLATFORMS.map((p) => {
                    const on = p.id === searchPlatform
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          onSearchPlatformChange?.(p.id)
                          setMoreMenuOpen(false)
                          setPlatformGridOpen(false)
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
        </>
      )}
      {/* 手机端 ⋯ 全套工具:改走统一底部面板(此前是贴右缘浮卡,和面具/模型各写一套样式)。
          行一律 SheetRow / SheetToggleRow:48~54 高、主文 14 / 副文 11.5、选中整行浅底、无分隔线 */}
      {isMobileViewport && (
        <MobileSheet open={moreMenuOpen} onClose={() => setMoreMenuOpen(false)} title="更多">
          <SheetGroup>内容</SheetGroup>
          <SheetRow
            title="添加附件"
            subtitle={attachments.length > 0 ? `已选 ${attachments.length} 个` : '图片 / 文本 / PDF'}
            lead={<Paperclip aria-hidden />}
            trailing={<ChevronRight className="h-4 w-4 shrink-0 text-content-muted" aria-hidden />}
            onClick={() => { setMoreMenuOpen(false); attachOpenRef.current?.() }}
          />
          {hasMaskEntry && (
            <SheetRow
              title="面具"
              subtitle={mask ? mask.name : '未选，用默认人格'}
              lead={
                mask ? (
                  <span className="text-[18px] leading-none" aria-hidden>{mask.avatar}</span>
                ) : (
                  <Drama aria-hidden />
                )
              }
              trailing={<ChevronRight className="h-4 w-4 shrink-0 text-content-muted" aria-hidden />}
              onClick={() => { setMoreMenuOpen(false); setMaskMenuOpen(true) }}
            />
          )}
          {/* 对比模式下模型由顶部多选行接管,这一项自然退场 */}
          {!compareMode && (
            <>
              <SheetGroup>模型</SheetGroup>
              <SheetRow
                title="切换模型"
                subtitle={currentModel?.name ?? selectedModel}
                lead={
                  <span
                    aria-hidden
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      PROVIDER_DOT[currentModel?.provider ?? ''] ?? 'bg-content-muted'
                    )}
                  />
                }
                trailing={<ChevronRight className="h-4 w-4 shrink-0 text-content-muted" aria-hidden />}
                onClick={() => { setMoreMenuOpen(false); setModelSheetOpen(true) }}
              />
            </>
          )}
          <SheetGroup>工具</SheetGroup>
          <SheetToggleRow
            title="深度思考"
            subtitle="回答前先展示推理过程"
            lead={<Brain aria-hidden />}
            on={deepThink}
            onToggle={() => onDeepThinkChange(!deepThink)}
            trailing={<MiniSwitch on={deepThink} onClick={() => onDeepThinkChange(!deepThink)} />}
          />
          {webSearchAvailable && onWebSearchChange && (
            <SheetToggleRow
              title="智能搜索"
              subtitle="联网找资料再回答"
              lead={<Globe aria-hidden />}
              on={webSearch}
              onToggle={() => onWebSearchChange(!webSearch)}
              trailing={<MiniSwitch on={webSearch} onClick={() => onWebSearchChange(!webSearch)} />}
            />
          )}
          {/* 平台定向是「智能搜索」的从属项:左侧缩进到与其它行文字起点对齐(16 + 22 + 12 = 50) */}
          {webSearch && webSearchAvailable && onWebSearchChange && onSearchPlatformChange && (
            <div className="flex min-h-[46px] items-center gap-3 pb-1 pl-[50px] pr-4">
              <span className="min-w-0 flex-1 truncate text-[13px] text-content-secondary">平台定向</span>
              <div className="relative shrink-0">
                <select
                  value={searchPlatform}
                  onChange={(e) => onSearchPlatformChange(e.target.value as SearchPlatformId)}
                  aria-label="平台定向"
                  className="h-8 w-[6rem] cursor-pointer appearance-none rounded-xl bg-surface-muted pl-3 pr-7
                    text-[13px] text-content-primary outline-none transition-colors
                    focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  {SEARCH_PLATFORMS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-content-muted" aria-hidden />
              </div>
            </div>
          )}
          {/* MCP:点左侧主体进管理菜单,右侧开关就地开关;行本体是 div,避免 button 套 button */}
          {hasMcpEntry && (
            <div className="flex min-h-[54px] w-full items-center gap-3 px-4 py-2.5" data-sheet-toggle>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left text-[14px] leading-[1.35] text-content-primary"
                onClick={() => { setMoreMenuOpen(false); setMcpMenuOpen(true) }}
              >
                <span className="grid w-[22px] shrink-0 place-items-center text-content-secondary [&_svg]:h-[18px] [&_svg]:w-[18px]">
                  <Plug aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">MCP 工具</span>
                  <span className="mt-[3px] block truncate text-[11.5px] leading-[1.4] text-content-muted">
                    {mcpEnabled ? '外部工具注入本会话' : '本会话已停用'}
                  </span>
                </span>
              </button>
              <MiniSwitch on={mcpEnabled} onClick={() => onMcpEnabledChange(!mcpEnabled)} />
            </div>
          )}
          {/* 对比模式手机端只在「已处于对比模式」时露出,否则开了就没处关(2026-10-28 定案) */}
          {hasCompareEntry && compareMode && (
            <SheetRow
              title="对比模式"
              subtitle="多模型同时回答"
              lead={<Columns2 aria-hidden />}
              trailing={<Check className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
              onClick={() => { onCompareModeChange(!compareMode); setMoreMenuOpen(false) }}
            />
          )}
        </MobileSheet>
      )}
      {/* 移动端: MCP 管理菜单从 ⋯ 钮弹出(面具已外显成胶囊内独立钮,不再走 ⋯ 二级) */}
      <div className="sm:hidden">
        {onMcpEnabledChange && (
          <McpToolMenu
            open={mcpMenuOpen}
            mcpEnabled={mcpEnabled}
            onMcpEnabledChange={onMcpEnabledChange}
            onClose={() => setMcpMenuOpen(false)}
          />
        )}
      </div>
      {/* 手机端面具列表:从 ⋯「面具」进入,走统一底部面板 MobileSheet
          (把手 + 居中标题 + 取消行 + 下滑关闭)。列表窗靠 flex-auto 自滚,
          所以 bodyClassName 必须给 flex flex-col,否则撑不开只剩一屏外露。 */}
      {hasMaskEntry && isMobileViewport && (
        <MobileSheet
          open={maskMenuOpen}
          onClose={() => setMaskMenuOpen(false)}
          title="选择面具"
          bodyClassName="flex flex-col"
        >
          <MaskPickerMenu
            variant="sheet"
            activeMaskId={mask?.id ?? null}
            userMasks={userMasks}
            installedMasks={installedMasks}
            onSelect={(id) => { onMaskChange(id); setMaskMenuOpen(false) }}
            onManage={() => { onManageMasks?.(); setMaskMenuOpen(false) }}
            onClear={() => { onMaskChange(null); setMaskMenuOpen(false) }}
          />
        </MobileSheet>
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
  const mobileCard = isMobileViewport && (hasSendContent || shortcuts.pending)
  const mobileLong = isMobileViewport && mobileLines > 6
  const mobileWide = longTextMode || mobileLong
  const mobileStack = mobileCard || mobileWide

  const imageAtts = attachments.filter((att) => att.type.startsWith('image/'))

  // 附件被移除或发送清空后,预览下标可能越界/悬空,及时收口
  useEffect(() => {
    if (previewImageIndex == null) return
    if (imageAtts.length === 0) setPreviewImageIndex(null)
    else if (previewImageIndex > imageAtts.length - 1) setPreviewImageIndex(imageAtts.length - 1)
  }, [imageAtts.length, previewImageIndex])

  const imageLightbox =
    previewImageIndex != null && imageAtts.length > 0 ? (
      <ChatImageLightbox
        images={imageAtts}
        index={Math.min(previewImageIndex, imageAtts.length - 1)}
        onClose={() => setPreviewImageIndex(null)}
        onIndexChange={setPreviewImageIndex}
      />
    ) : null

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
                openRef={attachOpenRef}
                filesRef={attachFilesRef}
                hideUploads
                onUploadingFilesChange={setUploadingFiles}
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
            {/* MCP 工具(桌面外显): 点击弹出管理菜单;移动端收纳进 ⋯(2026-10-26 调序:能力开关连排) */}
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
                <McpToolMenu
                  open={mcpMenuOpen}
                  mcpEnabled={mcpEnabled}
                  onMcpEnabledChange={onMcpEnabledChange}
                  onClose={() => setMcpMenuOpen(false)}
                />
              </div>
            )}
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
                {maskPanel.rendered && (
                  <>
                    <div
                      className={cn('fixed inset-0 z-40', maskPanel.closing && 'pointer-events-none')}
                      onClick={() => setMaskMenuOpen(false)}
                    />
                    <div
                      className="panel-motion absolute top-full mt-1.5 left-1/2 -translate-x-1/2 z-50 w-64 max-md:w-[min(300px,calc(100vw-16px))] max-md:left-auto max-md:right-0 max-md:translate-x-0 max-md:top-auto max-md:bottom-full max-md:mt-0 max-md:mb-1.5 flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
                      data-panel-state={maskPanel.closing ? 'closed' : 'open'}
                      data-panel-side="bottom"
                      style={{ maxHeight: maskMenu.maxHeight }}
                      role="menu"
                    >
                      <MaskPickerMenu
                        activeMaskId={mask?.id ?? null}
                        userMasks={userMasks}
                        installedMasks={installedMasks}
                        onSelect={(id) => { onMaskChange(id); setMaskMenuOpen(false) }}
                        onManage={() => { onManageMasks?.(); setMaskMenuOpen(false) }}
                        onClear={() => { onMaskChange(null); setMaskMenuOpen(false) }}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
            {/* ⋯ 更多工具(收纳菜单): 桌面=搜索平台定向+对比模式;手机=附件/面具/模型/深度思考/搜索/MCP/对比。
                手机端弹层要贴输入卡右缘,故 max-md:static 撤掉自身定位锚点;
                手机端恒显(它是唯一工具入口),桌面仅当有收纳项(平台定向/对比模式)时出现 */}
            <div className={cn('relative shrink-0 max-md:static', !hasCompareEntry && !hasPlatformEntry && 'hidden max-md:block', mobileStack && 'max-md:ml-auto')}>
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
      filesRef={attachFilesRef}
      hideUploads
      onUploadingFilesChange={setUploadingFiles}
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
        className={cn('relative flex-1 w-full flex flex-col justify-center max-md:justify-start px-4 max-md:px-6', className)}
        style={{
          // 键盘弹出时让内容贴底(否则依旧被键盘遮住);
          // 没键盘时桌面/移动都垂直居中(只加 paddingBottom 占键盘)。
          // --m-input-pad: 手机端胶囊底距(globals.css 断点定义,桌面 0)
          // --m-safe-bottom: 手机端兜底手势条(24px);桌面回落到 sab,保持原间距
          paddingBottom: 'calc(var(--m-input-pad, 0px) + max(var(--keyboard-height, 0px), var(--m-safe-bottom, var(--sab, 0px))))',
        }}
      >
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
          {draftRestored && (input.trim() || references.length > 0) && (
            <div className="flex items-center gap-1.5 mb-2 mx-2 text-content-muted">
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="text-[11px] flex-1 min-w-0">已恢复上次未发送的内容</span>
              <button
                onClick={() => {
                  setInput('')
                  setReferences([])
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
          {!shortcuts.open && shortcuts.feedback}

          {/* 输入框容器: 自适应高度 = 附件预览(可选) + textarea + 底部工具行(与 standard 同构);relative 供 ⋯ 弹层锚定
              方案 C 手机端:胶囊化(26px 圆角+白玻璃+柔投影,原型 pill-input 材质) */}
          <div
            ref={shortcuts.anchorRef}
            data-composer-anchor=""
            className={cn(
              'relative rounded-xl border border-line bg-surface shadow-sm',
              // composer-card: 样式维度钩子(html[data-style="bigsur"] 换玻璃岛材质,globals.css)
              'composer-card',
              'focus-within:border-line-strong focus-within:shadow-md',
              'transition-[border-color,box-shadow] duration-200',
              'max-md:flex max-md:flex-wrap max-md:items-end max-md:gap-1 max-md:p-1.5 max-md:pl-4',
              'max-md:rounded-full max-md:border-white/55 max-md:bg-surface/85 max-md:glass-blur',
              // 暗色下白描边 55% 过曝成亮圈:按原型 body.dark .pill 定稿改主题线色
              'dark:max-md:border-line/90',
              'max-md:shadow-[0_8px_26px_rgb(0_0_0_/_0.14)]',
              // 手机端有内容即卡片:圆角从 9999 收回 24px,单行胶囊只留给空态
              mobileCard && 'max-md:rounded-3xl',
              shortcuts.anchorClassName
            )}
          >
            {shortcuts.panel}
            {shortcuts.referenceChips}
            {mobileFileUploadHost}
            {longTextHeader}
            {/* 附件预览(放在 textarea 上方,与 standard 变体一致);手机端整行占满胶囊上方。
                上传中与已上传排同一行:粘贴后先看到进度卡,完成后原地换成附件卡,位置不跳 */}
            {(attachments.length > 0 || uploadingFiles.length > 0) && (
              <div className="flex flex-wrap gap-2 px-4 pt-3 max-md:w-full max-md:px-2 max-md:pt-2">
                {uploadingFiles.map((u) => (
                  <UploadingChip key={u.id} item={u} />
                ))}
                {attachments.map((att, idx) => (
                  <AttachmentChip
                    key={att.url + idx}
                    att={att}
                    onPreview={() =>
                      setPreviewImageIndex(
                        attachments
                          .slice(0, idx)
                          .filter((a) => a.type.startsWith('image/')).length
                      )
                    }
                    onRemove={() => {
                      const removed = attachments[idx]
                      setAttachments((prev) => prev.filter((_, i) => i !== idx))
                      // 移除未发送的附件时同步删除服务端文件
                      if (removed) deleteUploadedFile(removed.url)
                    }}
                  />
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              {...shortcuts.textareaProps}
              value={input}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
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
                  disabled={!hasSendContent || sendBlocked}
                  aria-label="发送"
                  className={cn(
                    // 手机端 38px 圆钮(原型 tiny-btn 档);桌面 36px;窄屏 44px 触控
                    'shrink-0 flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 rounded-full transition-colors',
                    'max-md:w-[38px] max-md:h-[38px]',
                    'active:scale-95 touch-manipulation',
                    (hasSendContent && !sendBlocked) && !isLoading
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
        {imageLightbox}
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
      className={cn('relative z-[42] px-3 max-md:px-6 pt-1', className)}
      style={{
        // --m-input-pad: 手机端胶囊底距(globals.css 断点定义,桌面 0.5rem)
        paddingBottom: 'calc(var(--m-input-pad, 0.5rem) + max(var(--keyboard-height, 0px), var(--m-safe-bottom, var(--sab, 0px))))',
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

      {!shortcuts.open && shortcuts.feedback}
      <div
        ref={shortcuts.anchorRef}
        data-composer-anchor=""
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
          mobileCard && 'max-md:rounded-3xl',
          shortcuts.anchorClassName
        )}
      >
          {shortcuts.panel}
          {shortcuts.referenceChips}
          {mobileFileUploadHost}
          {longTextHeader}
          {/* Attachments preview row(上传中 + 已上传同排,见 welcome 变体同段注释) */}
          {(attachments.length > 0 || uploadingFiles.length > 0) && (
            <div className="flex flex-wrap gap-2 px-4 pt-3 max-md:w-full max-md:px-2 max-md:pt-2">
              {uploadingFiles.map((u) => (
                <UploadingChip key={u.id} item={u} />
              ))}
              {attachments.map((att, idx) => (
                <AttachmentChip
                  key={att.url + idx}
                  att={att}
                  onPreview={() =>
                    setPreviewImageIndex(
                      attachments
                        .slice(0, idx)
                        .filter((a) => a.type.startsWith('image/')).length
                    )
                  }
                  onRemove={() => {
                    const removed = attachments[idx]
                    setAttachments((prev) => prev.filter((_, i) => i !== idx))
                    // 移除未发送的附件时同步删除服务端文件
                    if (removed) deleteUploadedFile(removed.url)
                  }}
                />
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
          {draftRestored && (input.trim() || references.length > 0) && (
            <div className="flex items-center gap-1.5 px-4 pt-2 text-content-muted max-md:w-full max-md:px-1">
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="text-[11px] flex-1 min-w-0">已恢复上次未发送的内容</span>
              <button
                onClick={() => {
                  setInput('')
                  setReferences([])
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
              {...shortcuts.textareaProps}
              value={input}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
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
                  disabled={!hasSendContent || sendBlocked}
                  className={cn(
                    'h-7 w-7 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center rounded-full transition-colors shrink-0',
                    'max-md:min-h-0 max-md:min-w-0 max-md:h-[38px] max-md:w-[38px]',
                    'active:scale-95 touch-manipulation',
                    (hasSendContent && !sendBlocked)
                      ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
                      : 'bg-surface-muted text-content-muted cursor-not-allowed'
                  )}
                  aria-label="发送消息"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  {/* 方案 A:手机端统一 ↑(与欢迎页输入同语义),桌面保留纸飞机 */}
                  <Send className="w-3.5 h-3.5 max-md:hidden" />
                  <ArrowUp className="hidden max-md:block w-[18px] h-[18px]" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {imageLightbox}
    </div>
  )
}

/**
 * 待发送附件卡片(手机/桌面两个变体共用)。
 * 图片附件整卡可点开大图查看;非图片只展示文件名/扩展名。
 * 2026-10-27 改版:由「20px 图标 + 单行文件名」的紧凑条升级为缩略图卡(40px 图/扩展名块 + 文件名 + 体积/解析信息),
 * 移除钮由 hover 才出现改为常显 —— 粘贴进来的附件多了以后,原来的小叉几乎点不到。
 */
function formatAttachmentBytes(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 附件副标题:解析型附件报页数/字数,图片与普通文件报体积 */
function attachmentMeta(att: Attachment): { text: string; failed: boolean } {
  if (att.parseStatus === 'failed') return { text: '解析失败', failed: true }
  const chars =
    att.charCount == null
      ? ''
      : att.charCount < 1000
        ? `${att.charCount} 字`
        : `${(att.charCount / 1000).toFixed(1)}k 字`
  if (att.pageCount != null) {
    return { text: chars ? `${att.pageCount} 页 · ${chars}` : `${att.pageCount} 页`, failed: false }
  }
  if (chars) return { text: chars, failed: false }
  return { text: formatAttachmentBytes(att.size), failed: false }
}

function AttachmentChip({
  att,
  onPreview,
  onRemove,
}: {
  att: Attachment
  onPreview: () => void
  onRemove: () => void
}) {
  const isImage = att.type.startsWith('image/')
  const meta = attachmentMeta(att)
  // 用扩展名而非 MIME 子类型:xlsx/docx 的 MIME 是长串 vnd.openxmlformats,截前 3 字符会显示 VND
  const ext = att.name.split('.').pop()?.toUpperCase().slice(0, 4) || 'FILE'
  return (
    <div
      role={isImage ? 'button' : undefined}
      tabIndex={isImage ? 0 : undefined}
      aria-label={isImage ? `查看图片:${att.name}` : undefined}
      title={att.name}
      onClick={isImage ? onPreview : undefined}
      onKeyDown={
        isImage
          ? (e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPreview()
              }
            }
          : undefined
      }
      className={cn(
        'group flex items-center gap-2.5 rounded-xl border p-1.5 pr-2',
        'border-line bg-surface-muted/70',
        'w-full sm:w-auto sm:max-w-[228px]',
        'transition-colors',
        isImage && 'cursor-zoom-in hover:border-line-strong hover:bg-surface-muted'
      )}
    >
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={att.url}
          alt={att.name}
          className={cn(
            'h-10 w-10 shrink-0 rounded-lg object-cover ring-1 ring-black/5 dark:ring-white/10',
            'transition-transform duration-200 group-hover:scale-[1.04]'
          )}
        />
      ) : (
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-subtle
            text-[9px] font-semibold tracking-wide text-content-secondary"
        >
          {ext}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium leading-tight text-content-primary">{att.name}</p>
        <p
          className={cn(
            'mt-1 truncate text-[10px] leading-none',
            meta.failed ? 'text-red-500' : 'text-content-muted'
          )}
        >
          {meta.text}
        </p>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors
          text-content-muted/70 hover:bg-red-100 hover:text-red-500 dark:hover:bg-red-900/30"
        aria-label="移除"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}
