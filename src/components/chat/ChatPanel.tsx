'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useRenderProbe, recordStreamStatus, addCrumb, reportDiagnostic } from '@/lib/client-diagnostics'
import { useChat } from '@ai-sdk/react'
import { useQuery } from '@tanstack/react-query'
import { DefaultChatTransport } from 'ai'
import type { UIMessage } from 'ai'
import { ChevronDown } from 'lucide-react'
import { ChatErrorBanner } from './ChatErrorBanner'
import { MessageList } from './MessageList'
import { HeroModelChip } from './HeroModelChip'
import { ChatInput } from './ChatInput'
import { ProfileProbe } from './ProfileProbe'
import { ComparePanel } from './ComparePanel'
import { WriteDocPanel } from '@/components/write/WriteDocPanel'
import { FileEditorPanel } from './FileEditorPanel'
import { CodePanel } from '@/components/code/CodePanel'
import { ChatPreviewPanel } from './ChatPreviewPanel'
import { WorkSidePane } from '@/components/workspace/WorkSidePane'
import { OutlineSidebar } from './OutlineSidebar'
import { pinScrollToBottom, registerListFollowing } from './chat-list-bridge'
import { INPUT_SEND_EVENT } from '@/lib/input-bridge'
import { InfoAsidePanel, INFO_PANEL_WIDTH, INFO_TAB_WIDTH } from './InfoAsidePanel'
import { MaskPickerMenu } from './MaskPickerMenu'
import { ContextMeter } from './ContextMeter'
import { NEW_CHAT_MASK_SIGNAL_KEY, useChatStore, liveCodeDoc } from '@/store/chat-store'
import { getErrorMessage } from '@/lib/chat-errors'
import { buildSettingsSnapshot, executeSettingsOps } from '@/lib/settings/executor'
import { toast } from '@/lib/toast'
import { useVisualViewport } from '@/hooks/useVisualViewport'
import { useIsComputerMode } from '@/hooks/useIsComputerMode'
import { useMaskMenuMaxHeight } from '@/hooks/useMaskMenuMaxHeight'
import { useReplyReminder } from '@/hooks/useReplyReminder'
import { queryKeys, STALE } from '@/lib/query/keys'
import { fetchJson } from '@/lib/query/fetcher'
import type { ModelDefinition } from '@/lib/ai/types'
import { getBuiltinMask } from '@/lib/ai/builtin-masks'
import type { MaskDTO } from '@/lib/ai/mask-types'
import type { Attachment } from './FileUpload'
import { getIsTauri, tauri, useIsTauri } from '@/lib/tauri'
import {
  writeFile as lfWriteFile,
  deleteFile as lfDeleteFile,
  readFile as lfReadFile,
  listDir as lfListDir,
  editFile as lfEditFile,
  moveFile as lfMoveFile,
  fileExists as lfFileExists,
  execCommand as lfExecCommand,
  overviewDir as lfOverviewDir,
  searchContent as lfSearchContent,
  getWorkspaceDir,
  LOCAL_FILES_SYNC_KEY,
} from '@/lib/tauri-files'
import {
  LOCAL_FILE_TOOL_NAME,
  isExecAutoAllowed,
  type LocalFileToolInput,
  type LocalFileToolOutput,
} from '@/lib/ai/local-file-tool'
import {
  CODE_EDIT_TOOL_NAME,
  type CodeEditToolOutput,
} from '@/lib/ai/code-edit-tool'
import { applyCodeEdit } from '@/lib/ai/code-edit-match'
import {
  PREVIEW_CHECK_TOOL_NAME,
  type PreviewCheckToolOutput,
} from '@/lib/ai/preview-check-tool'
import {
  PROJECT_CHECK_TOOL_NAME,
  CHECK_ALLOWLIST_HINT,
  isCheckCommandAllowed,
  type ProjectCheckToolInput,
  type ProjectCheckToolOutput,
} from '@/lib/ai/project-check-tool'
import {
  analyzeTurnForGate,
  buildVerifyGateMessage,
  isVerifyGateMessage,
} from '@/lib/ai/verify-gate'
import { WRITE_CODE_TOOL_NAME } from '@/lib/ai/write-code-tool'
import type { CodeDocFull } from '@/components/code/types'
import {
  ensureWorkspaceSnapshot,
  refreshWorkspaceSnapshot,
  getWorkspaceSnapshot,
} from '@/lib/workspace/workspace-snapshot'

const MODEL_STORAGE_KEY = 'chat:selectedModel'
const DEEP_THINK_STORAGE_KEY = 'chat:deepThink'
const WEB_SEARCH_STORAGE_KEY = 'chat:webSearch'
const MCP_ENABLED_STORAGE_KEY = 'chat:mcpEnabled'
const COMPARE_MODE_STORAGE_KEY = 'chat:compareMode'
const COMPARE_MODELS_STORAGE_KEY = 'chat:compareModels'

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return '夜深了，还在思考？'
  if (hour < 9) return '早上好，新的一天开始了'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  if (hour < 21) return '晚上好'
  return '夜深了，注意休息'
}

/** 欢迎页副标题用日期行: 「9月17日 周四」 */
function getDateLine(): string {
  const now = new Date()
  return `${now.getMonth() + 1}月${now.getDate()}日 周${'日一二三四五六'[now.getDay()]}`
}

/**
 * sendAutomaticallyWhen 判据:仅当最后一条 assistant 消息里存在“已回填结果”的无 execute 客户端工具
 * (local_file / code_edit / preview_check)、全部 tool part 都已有 output、且最后一个 tool part 之后
 * 没有实质文本/推理(模型尚未据结果续答)时,才自动再发一次请求让模型收尾。
 * 模型续答产生文本后判据转 false,杜绝无限重发。
 * 不含这三类工具的普通对话恒 false,对既有流程零影响。
 */
function shouldContinueAfterLocalFile(messages: UIMessage[]): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return false
  const parts = last.parts as Array<{ type?: string; state?: string; text?: string }>
  let sawClientTool = false
  let lastToolIdx = -1
  let allResolved = true
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].type ?? ''
    if (!t.startsWith('tool-')) continue
    lastToolIdx = i
    if (
      t === `tool-${LOCAL_FILE_TOOL_NAME}` ||
      t === `tool-${CODE_EDIT_TOOL_NAME}` ||
      t === `tool-${PREVIEW_CHECK_TOOL_NAME}` ||
      t === `tool-${PROJECT_CHECK_TOOL_NAME}`
    )
      sawClientTool = true
    const st = parts[i].state
    if (st !== 'output-available' && st !== 'output-error') allResolved = false
  }
  if (!sawClientTool || lastToolIdx < 0 || !allResolved) return false
  // 最后一个 tool part 之后若已有正文/推理,说明模型已据结果续答,不再重发
  for (let i = lastToolIdx + 1; i < parts.length; i++) {
    const p = parts[i]
    if (p.type === 'reasoning') return false
    if (p.type === 'text' && p.text && p.text.trim()) return false
  }
  return true
}

interface ChatPanelProps {
  conversationId?: string
  conversationTitle?: string
  initialMessages: UIMessage[]
  initialModel: string
  allModels: ModelDefinition[] // builtin only
  /** 会话模式：single | compare(来自 DB) */
  mode?: string
  /** 对比模式模型列表 (来自 DB) */
  compareModels?: string[]
  /** 对比模式每个泳道的初始消息 */
  laneInitialMessages?: UIMessage[][]
  /** 当前会话已保存的回复风格 preset id,默认 balanced */
  initialStylePreset?: string | null
  /** 当前会话已保存的回复长度档 id,默认 standard */
  initialReplyLength?: string | null
  /** 当前会话已保存的面具 id(内置面具);null 表示无面具 */
  initialMaskId?: string | null
  /** E 对比模式投票: 最新一轮投票(对比模式回显高亮用) */
  initialCompareVote?: { groupId: string; votedModel: string } | null
  /** 跳转桥: /chat?q= 传入的自动发送文本(bento「继续对话」等外部入口);
   *  mount 后空会话自动发出一次,随后清掉 URL 参数防刷新重发 */
  autoSendText?: string
  /** 学习模式(/study 导师对话流):随请求上报服务端强制挂载课本/练题工具并注入教学能力段;
   *  同时关闭首条消息后的 URL 改写(/study 无 c/[id] 子路由,进页即开课,刷新=新开课) */
  studyMode?: boolean
  /** 首屏分页:未下发的更早消息条数(0/undefined 不渲染"查看更早"入口) */
  earlierCount?: number
  /** 首屏分页:由页面发起的更早页拉取(端点/游标口径都归页面),resolve 后面板前插并锚定滚动 */
  onLoadEarlier?: () => Promise<UIMessage[]>
}

export function ChatPanel({
  conversationId: initialConversationId,
  initialMessages,
  initialModel,
  allModels, // builtin
  conversationTitle,
  mode,
  compareModels: compareModelsProp,
  laneInitialMessages,
  initialStylePreset,
  initialReplyLength,
  initialMaskId,
  initialCompareVote,
  autoSendText,
  studyMode,
  earlierCount,
  onLoadEarlier,
}: ChatPanelProps) {
  useRenderProbe('ChatPanel')
  const [currentModel, setCurrentModel] = useState(initialModel)
  // 写作画布/预览面板/文件编辑器打开时桌面端压缩聊天区让位(与面板同宽并排,豆包式)
  const writePanelOpen = useChatStore((s) => s.writePanelDocId !== null)
  const editorOpen = useChatStore((s) => s.editorFile !== null)
  const codePanelOpen = useChatStore((s) => s.codePanelOpen)
  const infoPanelOpen = useChatStore((s) => s.infoPanelOpen)
  // 工作态(仅桌面端):右侧产物区常驻,聊天主区同步让位(同宽 min(34vw,440px))
  const inTauri = useIsTauri()
  const workMode = useChatStore((s) => s.workMode)
  const openEditor = useChatStore((s) => s.openEditor)
  const [conversationId, setConversationId] = useState(initialConversationId)

  // 切换会话/新建对话时自动收起写作画布面板(含 remount 首跑):
  // 发送首条消息新建会话只更新内部 state,不改 props.initialConversationId,不会误关。
  // 同时重置工作区定位文件——workFile 是全局的,不重置会挂上一个对话的文件
  useEffect(() => {
    useChatStore.getState().closeWritePanel()
    useChatStore.getState().closeCodePanel()
    useChatStore.getState().setWorkFile(null)
  }, [initialConversationId])

  // A 流式恢复: 页面加载时若历史里最后一条 assistant 消息带 streaming 标记,
  // 说明服务端可能仍在生成(草稿行快照中),进入轮询续显模式。
  // 正常流式由 useChat 的流直接驱动,此值保持 null,轮询只在恢复场景激活。
  const [remoteStreamingId, setRemoteStreamingId] = useState<string | null>(() => {
    for (let i = initialMessages.length - 1; i >= 0; i--) {
      const m = initialMessages[i]
      if (m.role === 'assistant') {
        const meta = m.metadata as { streaming?: unknown } | undefined
        return meta?.streaming === true ? m.id : null
      }
    }
    return null
  })
  const conversationStylePreset = useChatStore(state => state.conversationStylePreset)
  const setConversationStylePreset = useChatStore(state => state.setConversationStylePreset)
  const conversationMaskId = useChatStore(state => state.conversationMaskId)
  const setConversationMaskId = useChatStore(state => state.setConversationMaskId)
  const conversationReplyLength = useChatStore(state => state.conversationReplyLength)
  const setConversationReplyLength = useChatStore(state => state.setConversationReplyLength)

  // 移动端软键盘:把键盘高度写入 --keyboard-height,让 ChatInput 用
  // padding-bottom: var(--keyboard-height,0px) 顶住键盘。
  useVisualViewport()

  useEffect(() => {
    if (initialConversationId) {
      setConversationStylePreset(initialStylePreset ?? 'balanced')
      return
    }
    const stored = localStorage.getItem('chat:stylePreset')
    setConversationStylePreset(stored || 'balanced')
  }, [initialConversationId, initialStylePreset, setConversationStylePreset])

  // 长度档恢复:已有会话用会话 DB 值;新对话沿用上次选择(localStorage),默认 standard
  useEffect(() => {
    if (initialConversationId) {
      setConversationReplyLength(initialReplyLength ?? 'standard')
      return
    }
    const stored = localStorage.getItem('chat:replyLength')
    setConversationReplyLength(stored || 'standard')
  }, [initialConversationId, initialReplyLength, setConversationReplyLength])

  // 面具恢复:已有会话用 DB 值;新对话不再"记忆"上次的面具(总忘记关),
  // 默认回到无面具;仅侧边栏「选面具开新对话」的一次性信号才带入
  useEffect(() => {
    if (initialConversationId) {
      setConversationMaskId(initialMaskId ?? null)
      return
    }
    const signal = localStorage.getItem(NEW_CHAT_MASK_SIGNAL_KEY)
    // 一次性消费:信号只对紧随其后的这次新对话生效,不延续到下一个
    localStorage.removeItem(NEW_CHAT_MASK_SIGNAL_KEY)
    // 旧版"面具记忆"key,清理遗留
    localStorage.removeItem('chat:maskId')
    // 内置裸 id 直接认;user: 前缀的合法性由服务端 getMaskById 兑底
    setConversationMaskId(signal && (getBuiltinMask(signal) || signal.startsWith('user:')) ? signal : null)
  }, [initialConversationId, initialMaskId, setConversationMaskId])

  // 面具选择面板开关
  const [maskPickerOpen, setMaskPickerOpen] = useState(false)
  // 面具面板盒高: chip 在页首,向下弹,按 chip 下方可用空间夹取
  const headerMaskMenu = useMaskMenuMaxHeight(maskPickerOpen, 'down')
  // 自定义面具列表（badge 解析 + picker「我的面具」分组）
  const { data: userMasks } = useQuery({
    queryKey: queryKeys.masks.list(),
    queryFn: () => fetchJson<MaskDTO[]>('/api/masks'),
    staleTime: STALE.masks,
  })
  const setSettingsOpen = useChatStore((s) => s.setSettingsOpen)
  const setSettingsSection = useChatStore((s) => s.setSettingsSection)
  // 当前生效面具:内置直接查;user: 前缀从自定义列表解析（列表未加载时短暂不显示 badge）
  const activeMask = useMemo(() => {
    const builtin = getBuiltinMask(conversationMaskId)
    if (builtin) return builtin
    if (conversationMaskId?.startsWith('user:')) {
      const um = userMasks?.find((m) => m.id === conversationMaskId)
      if (um) return { id: um.id, name: um.name, avatar: um.avatar, description: um.description }
    }
    return undefined
  }, [conversationMaskId, userMasks])

  // 预览面板打开状态(ChatPreviewPanel 滑出驱动):桌面端聊天区同步压缩让位
  const previewOpen = useChatStore((s) => s.previewCode !== null)

  // 右侧抽屉(写作/预览/编辑器/代码/工作态产物区)任一打开 → 资料面板整列撤下:
  // 抽屉是 fixed 浮层 + margin 让位,资料面板是布局内的一列,两者叠加会撑出容器
  const drawerOpen =
    codePanelOpen || writePanelOpen || previewOpen || editorOpen || (inTauri && workMode)
  // 资料面板(展开或只剩收起的竖标签)是否占着右墙;
  // 电脑模式限定:平板/手机(触屏为主)整列不渲染,让位量随之归零
  const isComputerMode = useIsComputerMode()
  const infoSlotOccupied = isComputerMode && !!conversationId && !drawerOpen
  
  // Auto-enable deepThink for reasoning models (like DeepSeek-R1), but allow user to toggle off
  const shouldAutoEnableDeepThink = initialModel && allModels.find(m => m.id === initialModel)?.supportsReasoning
  const [deepThink, setDeepThink] = useState(shouldAutoEnableDeepThink || false)
  // Track if user manually changed deepThink to prevent auto-re-enabling
  const userToggledDeepThink = useRef(false)
  // Keep stable ref to allModels so we can read it inside effects without causing re-runs.
  // Must be done in useEffect, NOT in the component body — assigning .current during render
  // causes React to see different hook inputs on each render, triggering the
  // "Cannot update a component while rendering" / "areHookInputsEqual" cascade.
  const allModelsRef = useRef(allModels)
  useEffect(() => {
    allModelsRef.current = allModels
  }, [allModels])

  // 联网搜索：默认关闭，仅在用户在 ChatInput 中主动开启时才把 web_search 工具挂到模型。
  // webSearchAvailable 由下文的 searchKeysQuery 派生。
  const [webSearch, setWebSearch] = useState(false)
  // 当前联网搜索引擎（来自共享 store）
  const searchEngine = useChatStore((s) => s.searchEngine)
  // 平台定向口径（'auto' 默认 = 模型自判；与引擎同为本地偏好，走 store 持久化）
  const searchPlatform = useChatStore((s) => s.searchPlatform)
  const setSearchPlatform = useChatStore((s) => s.setSearchPlatform)

  // 联网搜索可用性:由 /api/search/keys 返回的 key 数量决定。
  // 用 useQuery 接管,与全站 queryKeys 体系对齐。
  const searchKeysQuery = useQuery<Array<{ engine: string }>>({
    queryKey: queryKeys.search.keys(),
    queryFn: () =>
      fetchJson<Array<{ engine: string }>>('/api/search/keys', {
        // 401 时返回空数组而不是抛错——聊天页允许用户无 key 也能进入
        swallowNotFound: true,
      }).then((data) => (Array.isArray(data) ? data : [])),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: STALE.providers,
  })
  const webSearchAvailable = (searchKeysQuery.data?.length ?? 0) > 0

  // MCP 外部工具:默认启用(配置即全局生效),仅显式关闭后本会话请求不注入。
  // 可用性由用户名下启用的 MCP server 决定;与设置页共享 query 缓存,
  // 设置里新增/启停后 invalidate 会同步刷新这里的按钮显示。
  const [mcpEnabled, setMcpEnabled] = useState(true)
  const mcpServersQuery = useQuery<{ servers: Array<{ enabled: boolean }> }>({
    queryKey: queryKeys.mcp.servers(),
    queryFn: () => fetchJson('/api/mcp/servers'),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: STALE.providers,
  })
  const mcpAvailable = (mcpServersQuery.data?.servers ?? []).some((s) => s.enabled)

  // AI 本地文件能力(仅桌面端):DB 总开关经 /api/settings/local-files 查得,存 ref 供 transport
  // body getter 读取。网页端 getIsTauri()=false → query 不启用 → 恒 false,服务端不注入 local_file
  // 工具;refetchOnWindowFocus:用户在独立设置窗口切换开关后,回到主窗口即刷新。
  const localFilesQuery = useQuery<{ localFilesEnabled: boolean; localFilesExecAutoRun?: boolean }>({
    queryKey: ['settings', 'local-files'],
    queryFn: () => fetchJson('/api/settings/local-files'),
    enabled: getIsTauri(),
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: STALE.providers,
  })
  const localFilesEnabled = localFilesQuery.data?.localFilesEnabled ?? false
  // exec 命令"始终运行":开启后白名单外的命令也直接执行,不再弹确认卡(设置里切换)
  const localFilesExecAutoRun = localFilesQuery.data?.localFilesExecAutoRun ?? false
  const localFilesToggleRef = useRef(false)
  useEffect(() => {
    localFilesToggleRef.current = localFilesEnabled
  }, [localFilesEnabled])
  const execAutoRunRef = useRef(false)
  useEffect(() => {
    execAutoRunRef.current = localFilesExecAutoRun
  }, [localFilesExecAutoRun])
  // 设置窗口是独立 WebView,在那里切换开关后本窗口缓存无从得知;refetchOnWindowFocus
  // 又会被 staleTime 拦下(数据还“新鲜”就跳过)。经 storage 事件(跨窗口广播)感知并
  // 立即 refetch(不受 staleTime 限制),让开关秒级生效——否则下一条消息仍不注入
  // local_file 工具,模型会声称“没有文件能力”。
  useEffect(() => {
    if (!getIsTauri()) return
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOCAL_FILES_SYNC_KEY) void localFilesQuery.refetch()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [localFilesQuery.refetch])

  // 从 localStorage 恢复 webSearch 偏好(全局记忆:已有对话也恢复,切换会话/刷新不丢)
  useEffect(() => {
    if (localStorage.getItem(WEB_SEARCH_STORAGE_KEY) === 'true') {
      setWebSearch(true)
    }
  }, [initialConversationId])

  // 从 localStorage 恢复 MCP 工具偏好(默认启用,仅显式 false 时关闭;已有对话也恢复)
  useEffect(() => {
    if (localStorage.getItem(MCP_ENABLED_STORAGE_KEY) === 'false') {
      setMcpEnabled(false)
    }
  }, [initialConversationId])
  
  // Sync deepThink state with model changes - auto-enable for reasoning models (only if user hasn't manually toggled)
  // NOTE: deepThink NOT in dep array — we only want to react to currentModel changes,
  // not to deepThink itself changing (which would cause an infinite loop).
  // allModels is read via ref to avoid the same problem.
  useEffect(() => {
    if (currentModel && !userToggledDeepThink.current) {
      const modelDef = allModelsRef.current.find(m => m.id === currentModel)
      if (modelDef?.supportsReasoning && !deepThink) {
        setDeepThink(true)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentModel])

  // 合并 builtin + custom + provider-user 模型。复用全站 queryKey 的缓存。
  const customModelsQuery = useQuery<ModelDefinition[]>({
    queryKey: queryKeys.customModels(),
    queryFn: () =>
      fetchJson<ModelDefinition[] | { items?: ModelDefinition[] }>(
        '/api/custom-models'
      ).then((data) => (Array.isArray(data) ? data : data?.items ?? [])),
    enabled: !initialConversationId,
    staleTime: STALE.customModels,
  })
  const providerUserModelsQuery = useQuery<ModelDefinition[]>({
    queryKey: [...queryKeys.providers(), 'effective'],
    queryFn: async () => {
      const payload = await fetchJson<
        Array<{ effectiveModels: ModelDefinition[] }> | { providers: Array<{ effectiveModels: ModelDefinition[] }> }
      >('/api/providers')
      const list = Array.isArray(payload) ? payload : payload.providers ?? []
      return list.flatMap((p) => p.effectiveModels ?? [])
    },
    enabled: !initialConversationId,
    staleTime: STALE.providers,
  })

  const mergedModels = useMemo(() => {
    const custom = customModelsQuery.data ?? []
    const providerUser = providerUserModelsQuery.data ?? []
    if (custom.length === 0 && providerUser.length === 0) return allModels
    const seen = new Set<string>()
    const merged: ModelDefinition[] = []
    for (const m of [...allModels, ...custom, ...providerUser]) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      merged.push(m)
    }
    return merged
  }, [allModels, customModelsQuery.data, providerUserModelsQuery.data])

  // 对比模式状态: 仅从 props 初始化(已有 compare 会话),新聊天的 localStorage 预设
  // 在挂载后加载,避免 SSR 水合不一致
  const [compareMode, setCompareMode] = useState(mode === 'compare')

  // 对比模型列表：DB > 默认前两个 (use mergedModels)
  const [compareModels, setCompareModels] = useState<string[]>(() => {
    if (compareModelsProp && compareModelsProp.length >= 2) return compareModelsProp
    const first = mergedModels[0]?.id
    const second = mergedModels.find((m) => m.id !== first)?.id
    return [first, second].filter(Boolean) as string[]
  })

  const handleCompareModeChange = useCallback(
    (enabled: boolean) => {
      setCompareMode(enabled)
      localStorage.setItem(COMPARE_MODE_STORAGE_KEY, String(enabled))
      if (enabled) {
        // 无保存的对比模型时，用当前模型 + 第一个不同模型作为默认
        const saved = localStorage.getItem(COMPARE_MODELS_STORAGE_KEY)
        if (!saved) {
          const second = mergedModels.find((m) => m.id !== currentModel)?.id
          if (second) setCompareModels([currentModel, second])
        }
      }
    },
    [mergedModels, currentModel]
  )

  // 对比模式会话创建后同步回来,用于隐藏切换开关
  const handleCompareConversationCreated = useCallback((convId: string) => {
    setConversationId((prev) => prev ?? convId)
  }, [])

  // On mount, load last selected model (new chats only) and deepThink preference (global).
  // deepThink 恢复不受 initialConversationId 限制:已有对话切换/刷新后同样保留用户偏好。
  useEffect(() => {
    if (!initialConversationId) {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY)
      if (saved && mergedModels.some((m) => m.id === saved)) {
        setCurrentModel(saved)
      }
    }
    const savedDeepThink = localStorage.getItem(DEEP_THINK_STORAGE_KEY)
    if (savedDeepThink === 'true') {
      setDeepThink(true)
      userToggledDeepThink.current = true
    } else if (savedDeepThink === 'false') {
      // 用户显式关闭过: 恢复关闭状态,并阻止推理模型 auto-enable 重新打开
      setDeepThink(false)
      userToggledDeepThink.current = true
    }
    if (!initialConversationId) {
      // 恢复对比模式预设 (移动端不实现对比，跳过)
      if (
        window.matchMedia('(min-width: 768px)').matches &&
        localStorage.getItem(COMPARE_MODE_STORAGE_KEY) === 'true'
      ) {
        setCompareMode(true)
      }
      try {
        const savedCompare = JSON.parse(localStorage.getItem(COMPARE_MODELS_STORAGE_KEY) ?? '[]')
        if (Array.isArray(savedCompare) && savedCompare.length >= 2) {
          const valid = savedCompare.filter((id: unknown) => mergedModels.some((m) => m.id === id))
          if (valid.length >= 2) setCompareModels(valid as string[])
        }
      } catch {
        // 忽略损坏的 localStorage 数据
      }
    }
    // mergedModels 故意不加入依赖:仅挂载时读一次,避免列表异步加载完成后覆盖恢复值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const conversationIdRef = useRef(initialConversationId)
  const attachmentsRef = useRef<Attachment[] | undefined>(undefined)
  // 消息区滚动容器(供 OutlineSidebar 做 scroll-spy / 平滑滚动)
  const [messagesScrollEl, setMessagesScrollEl] = useState<HTMLDivElement | null>(null)
  const setCurrentConversationId = useChatStore((s) => s.setCurrentConversationId)
  const setConversationTitle = useChatStore((s) => s.setConversationTitle)
  const bumpConversationVersion = useChatStore((s) => s.bumpConversationVersion)
  const pendingContinuation = useChatStore((s) => s.pendingContinuation)
  const setPendingContinuation = useChatStore((s) => s.setPendingContinuation)
  const markConversationRead = useChatStore((s) => s.markConversationRead)
  const registerBackgroundStreaming = useChatStore((s) => s.registerBackgroundStreaming)
  const unregisterBackgroundStreaming = useChatStore((s) => s.unregisterBackgroundStreaming)

  // 切换/挂载会话时:
  //  - 通知 store(Sidebar 监听)
  //  - 标记已读 + 3s 后再次标兜底(覆盖流式回复刚完成的情况)
  //  - 卸载时清"接着说"残留
  useEffect(() => {
    setCurrentConversationId(initialConversationId ?? null)
    setConversationTitle(conversationTitle ?? null)
    if (initialConversationId) {
      markConversationRead(initialConversationId)
      const t = setTimeout(() => markConversationRead(initialConversationId), 3000)
      return () => clearTimeout(t)
    }
  }, [initialConversationId, conversationTitle, setCurrentConversationId, setConversationTitle, markConversationRead])

  // 切换会话时清掉"接着说"横幅(避免上一个会话的提示残留)
  useEffect(() => {
    return () => setPendingContinuation(null)
  }, [initialConversationId, setPendingContinuation])

  // 所有 ref 同步必须放在 useEffect 里,不能在 render 体直接写 .current =,
  // 否则 React 18 并发渲染下会触发无限更新循环 (Maximum update depth exceeded)。
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  // 用 ref 持有最新的可变值,避免 transport body 闭包捕获旧值。
  // 即使 useChat 内部缓存了 transport,body getter 在请求时才读取,
  // 也能拿到最新的 model / deepThink / webSearch 等。
  // useRef() 声明和 .current 赋值严格分开:声明在 render 体,赋值在 useEffect
  const currentModelRef = useRef(currentModel)
  const deepThinkRef = useRef(deepThink)
  const webSearchRef = useRef(webSearch)
  const searchEngineRef = useRef(searchEngine)
  const searchPlatformRef = useRef(searchPlatform)
  const mcpEnabledRef = useRef(mcpEnabled)
  const conversationStylePresetRef = useRef(conversationStylePreset)
  const conversationMaskIdRef = useRef(conversationMaskId)
  const conversationReplyLengthRef = useRef(conversationReplyLength)
  useEffect(() => {
    currentModelRef.current = currentModel
    deepThinkRef.current = deepThink
    webSearchRef.current = webSearch
    searchEngineRef.current = searchEngine
    searchPlatformRef.current = searchPlatform
    mcpEnabledRef.current = mcpEnabled
    conversationStylePresetRef.current = conversationStylePreset
    conversationMaskIdRef.current = conversationMaskId
    conversationReplyLengthRef.current = conversationReplyLength
  }, [currentModel, deepThink, webSearch, searchEngine, searchPlatform, mcpEnabled, conversationStylePreset, conversationMaskId, conversationReplyLength])

  // Create transport with current model, conversationId, deepThink, and webSearch.
  // 用 useMemo 收敛创建;所有可变值都通过 getter 读 ref,保证请求时拿到最新值。
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: '/api/chat',
        body: {
          get model() { return currentModelRef.current },
          get conversationId() { return conversationIdRef.current },
          get deepThink() { return deepThinkRef.current },
          get webSearch() { return webSearchRef.current },
          get searchEngine() { return searchEngineRef.current },
          get searchPlatform() { return searchPlatformRef.current },
          get mcpEnabled() { return mcpEnabledRef.current },
          get stylePreset() { return conversationStylePresetRef.current },
          get replyLength() { return conversationReplyLengthRef.current },
          get maskId() { return conversationMaskIdRef.current },
          // 学习模式:页面级常量(prop),服务端据此强挂教学工具+能力段
          ...(studyMode ? { studyMode: true } : {}),
          // AI 设置控制: 每次请求前读取最新客户端设置快照,服务端注入 system prompt(读写对称)
          get settingsSnapshot() {
            return buildSettingsSnapshot()
          },
          // 写作画布面板当前打开的文档:让 AI 可用 append 续写这篇(面板未开为 null)
          get currentWriteDocId() {
            return useChatStore.getState().writePanelDocId
          },
          // 本地文件能力(仅桌面端且用户开关开启):服务端据此注入无 execute 的 local_file 工具
          get localFilesEnabled() {
            return getIsTauri() && localFilesToggleRef.current
          },
          // 代码编辑器面板是否打开:服务端据此注入 code_edit 工具(AI 改代码片段)
          get codePanelOpen() {
            return useChatStore.getState().codePanelOpen
          },
          // 工作区快照(仅桌面端有值):目录树 + AGENT.md 约定,服务端注入 system。
          // 仿 settingsSnapshot 模式;TTL 缓存,写操作后失效重建,注入段声明"可能滞后"
          get workspaceContext() {
            return getIsTauri() ? (getWorkspaceSnapshot() ?? undefined) : undefined
          },
          // Attachments are read from ref at send time
          get attachments() {
            return attachmentsRef.current
          },
        },
        // Intercept response to capture conversation ID from header
        fetch: async (url, options) => {
          const response = await fetch(url, options)
          const newConvId = response.headers.get('X-Conversation-Id')
          const newConvTitle = response.headers.get('X-Conversation-Title')
          if (newConvId && newConvId !== conversationIdRef.current) {
            conversationIdRef.current = newConvId
            setConversationId(newConvId)
            setCurrentConversationId(newConvId)
            bumpConversationVersion() // 新会话已入库,通知侧边栏刷新列表
            if (newConvTitle) {
              setConversationTitle(decodeURIComponent(newConvTitle))
            }
            // Update URL without full navigation
            // 学习模式不改写:/study 没有 c/[id] 子路由,改写会 404/劫持到 /chat;
            // 会话由 conversationId state 维持,刷新 /study = 开新课,语义自洽
            if (!studyMode) {
              window.history.replaceState(null, '', `/chat/c/${newConvId}`)
            }
          }
          return response
        },
      }),
    // transport 内部所有运行时值都通过 ref 读取最新值,
    // 这里只依赖稳定的 store setter(来自 zustand,引用恒定),避免 transport 被频繁重建
    // studyMode 是页面级常量 prop,进依赖仅满足 exhaustive-deps,不会引起重建
    [setConversationId, setCurrentConversationId, setConversationTitle, bumpConversationVersion, studyMode]
  )

  // Ref to setMessages,避免在 useChat 初始化器内部自引用导致循环依赖
  const setMessagesRef = useRef<((updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void) | null>(null)

  // ── 首屏分页:更早消息续载 ──────────────────────────────────────
  // 拉取由页面发起(端点/游标口径归页面),resolve 后面板前插并锚定滚动位置。
  const [earlierLoading, setEarlierLoading] = useState(false)
  // 前插一页后要复位的位置 = 「视口顶部那条消息 + 它距容器顶的像素」。
  // 不用 scrollHeight 增量:虚拟化下新页只有估算高度,实测能偏上千米,
  // 用户看到的就是"点一下被拽走几十条"。按消息复位交给持有 virtualizer 的 MessageList 执行。
  const [restoreAnchor, setRestoreAnchor] = useState<{ id: string; top: number; token: number } | null>(null)
  const anchorTokenRef = useRef(0)

  // local_file 工具调用去重:防 StrictMode/重渲导致同一 call 被重复执行(尤其 delete)
  const executedLocalFileCallsRef = useRef<Set<string>>(new Set())

  const { messages, sendMessage, setMessages, stop, status, error, clearError, regenerate, addToolOutput } = useChat<UIMessage>({
    // 流式 UI 更新节流(AI SDK 官方机制): 不节流时每个 chunk 都触发强制同步重渲染,
    // 快速流式下会累积 React nestedUpdateCount 至 50 抛 "Maximum update depth exceeded",
    // 传 throttle 后通知频率与渲染耗时脱钩,配合打字机视觉平滑度不受影响。
    throttle: 50,
    ...(initialConversationId ? { id: initialConversationId } : {}), // 用会话 ID 作为 useChat 实例 id(仅已有会话),避免不同会话复用同一组件时状态错乱
    transport,
    messages: initialMessages,
    // local_file 是“无 execute 客户端工具”:模型发出 tool-call 后本轮流即结束,这里拦截
    // 并在本地(Tauri)执行——create 自动写入、delete 交卡片确认——再 addToolOutput 回填,
    // 配合 sendAutomaticallyWhen 在同一轮内让模型据结果续跑收尾。
    onToolCall: async ({ toolCall }) => {
      // code_edit:AI 改代码文档 → 写 pendingDiff + 展开代码面板 + 回填「待审查」,本轮流结束。
      // 用户在编辑器审查 Diff 后采纳/放弃(后续动作,不自动回填)。
      if (toolCall.toolName === CODE_EDIT_TOOL_NAME) {
        const callId = toolCall.toolCallId
        if (executedLocalFileCallsRef.current.has(callId)) return
        executedLocalFileCallsRef.current.add(callId)
        const ci = (toolCall.input ?? {}) as {
          docId?: string
          old_text?: string
          new_text?: string
          replace_all?: boolean
        }
        const docId = typeof ci.docId === 'string' ? ci.docId : ''
        const oldText = typeof ci.old_text === 'string' ? ci.old_text : ''
        const newText = typeof ci.new_text === 'string' ? ci.new_text : ''
        if (!docId) {
          addToolOutput({
            tool: CODE_EDIT_TOOL_NAME,
            toolCallId: callId,
            output: { ok: false, error: '缺少 docId' } satisfies CodeEditToolOutput,
          })
          return
        }
        // 片段替换:在文档「当前真实内容」上做唯一匹配(精确→逐行 trim 两级,ZCode Edit 语义)。
        // 内容来源:面板开着且就是这篇 → 编辑器实时值(含未保存改动);否则 GET 落库版本
        let current = liveCodeDoc.docId === docId ? liveCodeDoc.content : ''
        if (!current) {
          try {
            const doc = await fetchJson<CodeDocFull>(`/api/code/docs/${docId}`, { timeoutMs: 15_000 })
            current = doc.content
          } catch {
            addToolOutput({
              tool: CODE_EDIT_TOOL_NAME,
              toolCallId: callId,
              output: {
                ok: false,
                error: '无法读取文档当前内容(接口失败)。请告知用户打开对应文档后重试。',
              } satisfies CodeEditToolOutput,
            })
            return
          }
        }
        const match = applyCodeEdit(current, oldText, newText, ci.replace_all === true)
        if (match.status !== 'ok' || typeof match.modifiedContent !== 'string') {
          // 0 处/多处/无变化:回填可行动错误文案(见 code-edit-match.ts),模型同轮自纠重试
          addToolOutput({
            tool: CODE_EDIT_TOOL_NAME,
            toolCallId: callId,
            output: { ok: false, error: match.message ?? '片段匹配失败' } satisfies CodeEditToolOutput,
          })
          return
        }
        useChatStore.getState().setCodePendingDiff({ docId, original: current, modified: match.modifiedContent })
        useChatStore.getState().openCodePanel(docId)
        addToolOutput({
          tool: CODE_EDIT_TOOL_NAME,
          toolCallId: callId,
          output: {
            ok: true,
            status: 'pending-review',
            strategy: match.strategy,
          } satisfies CodeEditToolOutput,
        })
        return
      }
      // preview_check:AI 主动验证 HTML 预览 → 打开代码面板写入检查请求,CodeEditor 认领执行
      // (切预览渲染→静默期收集 console/脚本错误),结果经 store resolver 回来后回填续跑。
      // 与 local_file 同属无 execute 客户端工具,但不需要 Tauri,Web 端同样可用
      if (toolCall.toolName === PREVIEW_CHECK_TOOL_NAME) {
        const callId = toolCall.toolCallId
        if (executedLocalFileCallsRef.current.has(callId)) return
        executedLocalFileCallsRef.current.add(callId)
        const pi = (toolCall.input ?? {}) as { docId?: string }
        const store = useChatStore.getState()
        let docId =
          typeof pi.docId === 'string' && pi.docId ? pi.docId : store.codePanelDocId ?? ''
        // 兜底:AI 在 write_code 同一轮紧跟着调 preview_check 时,卡片的"自动打开面板"effect
        // 可能还没跑,codePanelDocId 仍为 null——从本会话消息里回溯最近一次 write_code 产物
        if (!docId) {
          for (const m of messages) {
            for (const p of m.parts as Array<{ type?: string; output?: unknown }>) {
              if (p.type !== `tool-${WRITE_CODE_TOOL_NAME}`) continue
              const out = p.output as { ok?: boolean; docId?: string } | undefined
              if (out && out.ok === true && typeof out.docId === 'string' && out.docId) {
                docId = out.docId
              }
            }
          }
        }
        if (!docId) {
          addToolOutput({
            tool: PREVIEW_CHECK_TOOL_NAME,
            toolCallId: callId,
            output: {
              ok: false,
              message: '未指定 docId,且当前没有打开的代码文档',
            } satisfies PreviewCheckToolOutput,
          })
          return
        }
        // 打开面板(CodeEditor 挂载后认领请求执行);检查在 3~8 秒内经 resolver 回传
        store.openCodePanel(docId)
        const output = await new Promise<PreviewCheckToolOutput>((resolve) => {
          useChatStore.getState().beginPreviewCheck(docId, resolve)
          // 兜底:CodeEditor 未挂载/执行链路异常时,不能让 tool part 悬死(续跑判据永假)
          setTimeout(
            () => resolve({ ok: false, message: '预览检查超时(12 秒),前端未完成渲染验证' }),
            12_000
          )
        })
        addToolOutput({ tool: PREVIEW_CHECK_TOOL_NAME, toolCallId: callId, output })
        return
      }
      if (toolCall.toolName === PROJECT_CHECK_TOOL_NAME) {
        const callId = toolCall.toolCallId
        if (executedLocalFileCallsRef.current.has(callId)) return
        executedLocalFileCallsRef.current.add(callId)
        const ci = (toolCall.input ?? {}) as ProjectCheckToolInput
        const cmd = typeof ci.command === 'string' ? ci.command.trim() : ''
        const deny = (error: string) => {
          addToolOutput({
            tool: PROJECT_CHECK_TOOL_NAME,
            toolCallId: callId,
            output: { ok: false, error } satisfies ProjectCheckToolOutput,
          })
        }
        if (!getIsTauri()) {
          deny('项目检查仅桌面客户端可用(Web 端没有本地命令执行能力)')
          return
        }
        if (!cmd) {
          deny('缺少要运行的检查命令(command 为空)')
          return
        }
        if (!isCheckCommandAllowed(cmd)) {
          deny(
            `命令不在检查白名单(仅允许纯检查命令,自动执行不弹确认):${CHECK_ALLOWLIST_HINT}。` +
              `收到的是「${cmd}」——如确需运行,请改用 local_file 的 exec 动作(会弹确认卡等用户批准)。`
          )
          return
        }
        const timeoutMs =
          typeof ci.timeout_ms === 'number' && ci.timeout_ms > 0
            ? Math.min(ci.timeout_ms, 180_000)
            : 120_000
        // 后台并发执行;超时兜底语义与下方 runLocalFileAsync 一致(invoke 异常场景永不返回时
        // 保证 tool part 必然回填,续跑判据不悬死)。不复用该函数:它把回填写死为 local_file 工具
        const wait = Math.min(timeoutMs + 5_000, 610_000)
        void Promise.race([
          lfExecCommand(cmd, timeoutMs),
          new Promise<{ ok: false; error: string }>((resolve) =>
            setTimeout(() => resolve({ ok: false, error: '执行超时,本次调用被中止' }), wait)
          ),
        ]).then(
          (out) => {
            const res: ProjectCheckToolOutput = out.ok
              ? {
                  ok: out.exitCode === 0,
                  exitCode: out.exitCode,
                  output: out.execOutput,
                  truncated: out.truncated,
                  durationMs: out.durationMs,
                }
              : { ok: false, error: out.error ?? '命令执行失败' }
            addToolOutput({ tool: PROJECT_CHECK_TOOL_NAME, toolCallId: callId, output: res })
          },
          (err) => {
            addToolOutput({
              tool: PROJECT_CHECK_TOOL_NAME,
              toolCallId: callId,
              output: { ok: false, error: String(err) } satisfies ProjectCheckToolOutput,
            })
          }
        )
        return
      }
      if (toolCall.toolName !== LOCAL_FILE_TOOL_NAME) return
      const callId = toolCall.toolCallId
      if (executedLocalFileCallsRef.current.has(callId)) return
      const input = (toolCall.input ?? {}) as LocalFileToolInput
      // 只读动作(read/list/overview/search/exec 白名单档)后台并发执行:多个互不依赖的调用
      // 同时跑(总耗时≈最慢的一个,而非串行累加),完成后各自乱序回填;
      // sendAutomaticallyWhen 的判据(所有 tool part 均已回填)天然支持乱序,无需顺序保证。
      // 写类动作(create/edit/move)保持串行,避免同时改盘互相踩。
      const runLocalFileAsync = (
        id: string,
        action: LocalFileToolOutput['action'],
        run: () => Promise<LocalFileToolOutput>,
        // exec 可按模型申请的 timeout_ms 放宽兜底(任务真实时长未知,兜底=申请值+5s);
        // 其余动作保持 25s
        opTimeoutMs?: number
      ) => {
        // 超时兜底:invoke 若因异常场景永不返回,tool part 将永远停在 input-available,
        // 自动续跑判据(allResolved)永假,流程静默死停;race 一个超时结果保证必然回填,
        // 模型会收到明确的失败原因而不是无限等待(迟到的真实结果会覆盖超时结果,幂等无害)
        const wait =
          typeof opTimeoutMs === 'number' && opTimeoutMs > 0
            ? Math.min(opTimeoutMs + 5_000, 610_000)
            : 25_000
        const timeout = new Promise<LocalFileToolOutput>((resolve) =>
          setTimeout(
            () => resolve({ ok: false, action, error: '执行超时,本次调用被中止' }),
            wait
          )
        )
        void Promise.race([run(), timeout]).then(
          (output) => addToolOutput({ tool: LOCAL_FILE_TOOL_NAME, toolCallId: id, output }),
          (err) =>
            addToolOutput({
              tool: LOCAL_FILE_TOOL_NAME,
              toolCallId: id,
              output: { ok: false, action, error: String(err) } satisfies LocalFileToolOutput,
            })
        )
      }
      // 网页端(非 Tauri)碰不到本地磁盘:回填错误,让模型如实告知“仅桌面客户端可用”
      if (!getIsTauri()) {
        executedLocalFileCallsRef.current.add(callId)
        addToolOutput({
          tool: LOCAL_FILE_TOOL_NAME,
          toolCallId: callId,
          output: { ok: false, action: input.action, error: '仅桌面客户端可用' } satisfies LocalFileToolOutput,
        })
        return
      }
      // 未授权工作区:不执行也不空转 —— 滑出右侧产物区停在「选择文件夹」引导,
      // 同时把明确原因回填给模型(它会如实向用户解释),授权后用户让 AI 重试即可
      const base = await getWorkspaceDir()
      if (!base) {
        executedLocalFileCallsRef.current.add(callId)
        useChatStore.getState().setWorkMode(true)
        toast.error('还没有选择工作区文件夹，请先在右侧「工作区」里选一个', {
          title: '本地文件',
          timeout: 8000,
        })
        addToolOutput({
          tool: LOCAL_FILE_TOOL_NAME,
          toolCallId: callId,
          output: {
            ok: false,
            action: input.action,
            error:
              '尚未选择工作区文件夹(右侧「工作区」面板点「选择文件夹…」授权)。' +
              '请告知用户先选文件夹，选好后让用户说一声再重试本次操作。',
          } satisfies LocalFileToolOutput,
        })
        return
      }
      if (input.action === 'create') {
        // 覆盖确认:目标已存在时不自动写入(与 edit 唯一匹配/move 拒覆盖对齐),也不标记
        // 已执行——卡片停在待确认态,由 handleLocalFileDecision 执行写入并回填;目标不存在
        // 则与原来一致直接写入(无覆盖风险)
        const ex = await lfFileExists(input.path)
        if (ex.ok && ex.exists) return
        executedLocalFileCallsRef.current.add(callId)
        const content = typeof input.content === 'string' ? input.content : ''
        const res = await lfWriteFile(input.path, content)
        if (res.ok) void refreshWorkspaceSnapshot()
        addToolOutput({
          tool: LOCAL_FILE_TOOL_NAME,
          toolCallId: callId,
          output: { ...res, action: 'create' } satisfies LocalFileToolOutput,
        })
        return
      }
      // read/list/edit/move:低危或自带保护,自动执行后回填同轮续跑——
      // read/list 不落盘;edit 由 Rust 强制唯一匹配(匹配不上不写盘);move 拒绝覆盖已存在目标。
      if (input.action === 'read') {
        executedLocalFileCallsRef.current.add(callId)
        const offset = typeof input.offset === 'number' ? input.offset : undefined
        const limit = typeof input.limit === 'number' ? input.limit : undefined
        const mode = input.mode === 'outline' ? ('outline' as const) : undefined
        runLocalFileAsync(callId, 'read', async () =>
          ({ ...(await lfReadFile(input.path, offset, limit, mode)), action: 'read' }) satisfies LocalFileToolOutput
        )
        return
      }
      if (input.action === 'list') {
        executedLocalFileCallsRef.current.add(callId)
        runLocalFileAsync(callId, 'list', async () =>
          ({ ...(await lfListDir(input.path)), action: 'list' }) satisfies LocalFileToolOutput
        )
        return
      }
      if (input.action === 'overview') {
        executedLocalFileCallsRef.current.add(callId)
        runLocalFileAsync(callId, 'overview', async () =>
          ({ ...(await lfOverviewDir(input.path)), action: 'overview' }) satisfies LocalFileToolOutput
        )
        return
      }
      if (input.action === 'search') {
        const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : ''
        if (!pattern) return
        const glob = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : undefined
        executedLocalFileCallsRef.current.add(callId)
        runLocalFileAsync(callId, 'search', async () =>
          ({ ...(await lfSearchContent(input.path, pattern, glob)), action: 'search' }) satisfies LocalFileToolOutput
        )
        return
      }
      if (input.action === 'edit') {
        executedLocalFileCallsRef.current.add(callId)
        const res = await lfEditFile(input.path, input.old_text ?? '', input.new_text ?? '')
        if (res.ok) void refreshWorkspaceSnapshot()
        addToolOutput({
          tool: LOCAL_FILE_TOOL_NAME,
          toolCallId: callId,
          output: { ...res, action: 'edit' } satisfies LocalFileToolOutput,
        })
        return
      }
      if (input.action === 'move') {
        executedLocalFileCallsRef.current.add(callId)
        const res = await lfMoveFile(input.path, input.to_path ?? '')
        if (res.ok) void refreshWorkspaceSnapshot()
        addToolOutput({
          tool: LOCAL_FILE_TOOL_NAME,
          toolCallId: callId,
          output: { ...res, action: 'move' } satisfies LocalFileToolOutput,
        })
        return
      }
      if (input.action === 'exec') {
        // 命令执行:白名单或"始终运行"开启时后台执行(不阻塞其他并发调用);其余(含空命令)
        // 停等确认卡,由 handleLocalFileDecision 执行并回填——与 delete/create 确认流同层。
        // timeout_ms 由模型按任务时长申请(Rust 侧钳制),回填兜底超时同步放宽
        const cmd = typeof input.command === 'string' ? input.command.trim() : ''
        if (!cmd) return
        const timeoutMs =
          typeof input.timeout_ms === 'number' && input.timeout_ms > 0 ? input.timeout_ms : undefined
        if (!execAutoRunRef.current && !isExecAutoAllowed(cmd)) return
        executedLocalFileCallsRef.current.add(callId)
        runLocalFileAsync(
          callId,
          'exec',
          async () => {
            const out = { ...(await lfExecCommand(cmd, timeoutMs)), action: 'exec' } as LocalFileToolOutput
            if (out.ok) void refreshWorkspaceSnapshot()
            return out
          },
          timeoutMs
        )
        return
      }
      // delete: 不自动执行。卡片停在待确认态,用户批准后由 handleLocalFileDecision 执行并回填。
    },
    // 仅当 local_file 结果刚回填、模型尚未据此续答时,自动再发一次请求收尾(判据见 helper,杜绝死循环)
    sendAutomaticallyWhen: ({ messages }) => shouldContinueAfterLocalFile(messages),
    onFinish: async ({ message, isError, isAbort }) => {
      if (isError) return
      if (isAbort) {
        // 中止:服务端不推进 conversation.updatedAt,但会话行早已存在;
        // bump 让侧栏立刻捕获该会话,不再等下一轮无关刷新才"回来"
        bumpConversationVersion()
        return
      }
      const convId = conversationIdRef.current
      if (!convId) return
      // 客户端工具轮(local_file / code_edit / preview_check):tool part 生命周期由前端管理
      // (create 回填结果、delete 等用户异步确认、code_edit 待审查、preview_check 检查结果)。
      // 若在此用 DB 内容替换 parts,会丢掉这些 tool part,导致卡片无法交互、addToolOutput
      // 找不到目标、同轮续跑失效。故本轮含客户端工具调用时跳过内容同步。
      if (
        message.parts.some((p) => {
          const t = (p as { type?: string }).type ?? ''
          return (
            t === `tool-${LOCAL_FILE_TOOL_NAME}` ||
            t === `tool-${CODE_EDIT_TOOL_NAME}` ||
            t === `tool-${PREVIEW_CHECK_TOOL_NAME}` ||
            t === `tool-${PROJECT_CHECK_TOOL_NAME}`
          )
        })
      ) {
        // 服务端成功路径已推进 updatedAt;客户端工具轮跳过内容同步,但列表仍需刷新
        bumpConversationVersion()
        return
      }
      // 系统通知:回复完成且窗口失焦时弹通知(仅桌面端;开关在设置-聊天行为,默认开)。
      // 放在 early-return 之后:错误/中止不通知;local_file 多轮只在收尾轮通知一次。
      const notifyText = message.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text?: string }).text ?? '')
        .join('')
        .trim()
      void tauri.notifyReplyDone(
        useChatStore.getState().conversationTitle || 'AI 回复完成',
        notifyText || '回复已完成'
      )
      try {
        // 服务端在 finish 事件之前已完成生图与入库(onFinish 先于 finish part 发送),
        // 这里拉取最新的助手消息,把含图片的最终内容同步到界面。
        const res = await fetch(`/api/conversations/${convId}/messages?limit=1`)
        if (!res.ok) return
        const data = await res.json()
        const latest = data.messages?.[0]
        if (!latest || latest.role !== "assistant" || typeof latest.content !== "string") return
        // 服务端 onFinish 已更新 conversation.updatedAt,通知 Sidebar 刷新列表(更新未读/排序)
        bumpConversationVersion()
        setMessagesRef.current?.((prev: UIMessage[]) =>
          prev.map((m) => {
            if (m.id !== message.id) return m
            // 澄清问答: parts 替换会丢掉本地流式的 tool part,
            // 合并库中 metadata(含 ask_clarification 明细)让卡片经历史回放路径继续渲染
            let latestMeta: unknown = null
            try {
              latestMeta = typeof latest.metadata === 'string' ? JSON.parse(latest.metadata) : latest.metadata
            } catch {
              latestMeta = null
            }
            return {
              ...m,
              ...(latestMeta && typeof latestMeta === 'object' ? { metadata: latestMeta } : {}),
              // 以库中最终数据为准:reasoning 可能被兜底拆分(答案从推理尾部移入正文)
              parts: [
                ...(typeof latest.reasoning === 'string' && latest.reasoning.trim()
                  ? [{ type: 'reasoning' as const, text: latest.reasoning, state: 'done' as const }]
                  : []),
                { type: 'text' as const, text: latest.content, state: 'done' as const },
              ],
            }
          })
        )
      } catch (err) {
        console.error("Failed to sync final message content:", err)
        toast.error('同步最终回复失败', {
          title: '提示',
        })
      }
    },
  })

  // setMessages 引用稳定(来自 useChat),挂到 ref 上供 onFinish 内的最终内容同步使用
  setMessagesRef.current = setMessages

  // 首屏分页按钮路径:调页面的拉取回调,resolve 后前插并登记滚动锚位
  // (setMessages 来自 useChat,在其后才可引用,故实现落在这里)
  const handleLoadEarlier = useCallback(async () => {
    if (!onLoadEarlier || earlierLoading) return
    setEarlierLoading(true)
    try {
      const msgs = await onLoadEarlier()
      if (msgs.length > 0) {
        if (messagesScrollEl) {
          const box = messagesScrollEl.getBoundingClientRect()
          const topMost = Array.from(messagesScrollEl.querySelectorAll<HTMLElement>('[data-message-id]'))
            .map((n) => ({ id: n.dataset.messageId ?? '', top: n.getBoundingClientRect().top - box.top }))
            .filter((n) => n.id && n.top >= -2)
            .sort((a, b) => a.top - b.top)[0]
          if (topMost) setRestoreAnchor({ id: topMost.id, top: Math.round(topMost.top), token: ++anchorTokenRef.current })
        }
        setMessages((prev) => [...msgs, ...prev])
      }
    } catch {
      // 拉取失败:按钮留在原位,用户可再点一次;不打断聊天主流程
    } finally {
      setEarlierLoading(false)
    }
  }, [onLoadEarlier, earlierLoading, messagesScrollEl, setMessages])

  // 取证面包屑:#185 这类崩溃的生产堆栈只剩 react-dom 帧,能定元凶的是"崩前那一刻
  // 流式状态怎么跳、每秒渲染了多少次"。状态变化与上游报错都进环形缓冲随证据一起上报。
  useEffect(() => {
    recordStreamStatus(status, `消息 ${messages.length} 条`)
  }, [status, messages.length])
  useEffect(() => {
    if (!error) return
    addCrumb('stream-error', error.message || String(error))
    // 手机上看不见控制台,光有面包屑没人上传等于零证据:错误原文 + 当时前后台/联网状态入库
    reportDiagnostic('stream', `聊天流中断: ${error.message || String(error)} · visibility=${document.visibilityState} · online=${navigator.onLine}`)
  }, [error])

  // 收工验收门(verify-gate):agent 本回合成功改过工作区文件(local_file create/edit)、
  // 之后没有任何一次 project_check 跑绿、且模型以文本收尾时,自动注入一条打回消息,
  // 强制它先验收再汇报——语义对应 ZCode 的 Stop-hook 验证门。判定纯函数见 verify-gate.ts。
  // 防失控三保险:①每回合(锚点=最后一条真实用户消息)最多打回 2 次;②同一条 assistant
  // 消息只打回一次(StrictMode/重渲安全);③仅在亲眼见证一轮流式结束(status 回 ready)
  // 时判定——挂载回放历史/切换会话不会误触发旧回合的门。
  // 仅桌面端+工作区开关开启时启用(与服务端 project_check 注入闸门同源)。
  const verifyGateRef = useRef<{ anchorId: string | null; fired: number; gatedAssistantId: string | null }>({
    anchorId: null,
    fired: 0,
    gatedAssistantId: null,
  })
  const gatePrevStatusRef = useRef(status)
  useEffect(() => {
    const prev = gatePrevStatusRef.current
    gatePrevStatusRef.current = status
    if (status !== 'ready') return
    if (prev !== 'streaming' && prev !== 'submitted') return
    if (!getIsTauri() || !localFilesToggleRef.current) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return
    // 回合锚点=最后一条真实用户消息(跳过门注入消息);锚点变化即新回合,重置计数
    let anchorId: string | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'user') continue
      if (isVerifyGateMessage(m)) continue
      anchorId = m.id ?? null
      break
    }
    const gate = verifyGateRef.current
    if (gate.anchorId !== anchorId) {
      gate.anchorId = anchorId
      gate.fired = 0
    }
    if (gate.fired >= 2 || gate.gatedAssistantId === last.id) return
    const verdict = analyzeTurnForGate(messages)
    if (!verdict.shouldGate) return
    gate.fired += 1
    gate.gatedAssistantId = last.id
    void sendMessage({ text: buildVerifyGateMessage(verdict.unverifiedWrites) })
  }, [messages, status, sendMessage])

  // messages 的 ref 镜像: 供 handleEditMessage 等回调在依赖数组里摆脱 messages。
  // 否则流式期间 messages 每 50ms 变一次 → 回调引用跟着变 → 打穿 MessageBubble
  // 的 memo(比较器比对 onEdit 引用),全列表气泡逐帧重渲染
  const messagesRef = useRef(messages)
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // A 流式恢复: 远端仍在生成(轮询续显中)也算生成中,输入框保持禁用/停止按钮可见,
  // 新消息按 F 方案入队,待定格后自动发出
  const isLoading = status === 'submitted' || status === 'streaming' || remoteStreamingId != null

  // 安卓壳:生成开始即向系统预约一条「回来看」定时通知,结束/回到前台撤掉。
  // 切后台会冻住 JS(WebView.onPause),完成那一刻在前端根本等不到,只能提前挂号。
  useReplyReminder(isLoading)

  // 生成开始时(stop → send 或 regenerate)清掉"接着说"横幅
  const prevStatusRef = useRef(status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    // 'ready' → 'submitted'/'streaming' 表示新一轮开始,清掉横幅
    if (prev === 'ready' && status !== 'ready') {
      setPendingContinuation(null)
    }
  }, [status, pendingContinuation, setPendingContinuation])

  // 排队发送(F): isLoading 期间用户发送的消息先入队,本轮结束(status 回到 ready)后自动发出。
  // isLoadingRef 供 handleSend 判断当前是否生成中;按项目惯例 ref 声明与赋值分开,赋值在 effect。
  const isLoadingRef = useRef(false)
  useEffect(() => {
    isLoadingRef.current = isLoading
  }, [isLoading])

  // 后台生成跟踪:进入会话时先注销(切回来由本地流/轮询续显接管);
  // 离开(卸载或切换)时若仍在生成则注册,由 useBackgroundStreamWatcher 轮询,
  // 生成完成后 bumpConversationVersion 点亮侧边栏蓝点——否则后台完成无人报信,
  // 列表缓存里的 updatedAt 不前进,蓝点永远不亮。refs 在 cleanup 时读到最终态。
  useEffect(() => {
    if (initialConversationId) {
      unregisterBackgroundStreaming(initialConversationId)
    }
    return () => {
      const convId = conversationIdRef.current
      if (convId && isLoadingRef.current) {
        registerBackgroundStreaming(convId)
      }
    }
  }, [initialConversationId, registerBackgroundStreaming, unregisterBackgroundStreaming])

  // 流式跟随滚动: 默认贴底跟随最新内容;用户向上滚动立即脱离跟随(生成中也能自由回看历史),
  // 滚回底部或点"回到底部"按钮恢复跟随。
  // 脱离判定用滚动方向而非旧的"距底<=24"阈值:旧的纯阈值判定会被 scrollIntoView(smooth)
  // 动画自身的 scroll 事件反复重置回 true,加上流式期间每个 chunk 都发起一次新动画,
  // 用户上滑的每一小步都被拉回,表现为"生成时往上滑不动"。程序化滚动恒向下,不会误触发方向检测。
  const shouldAutoScrollRef = useRef(true)
  const prevScrollTopRef = useRef(0)
  const prevScrollHeightRef = useRef(0)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  // 虚拟化尺寸校正的补偿决策要读跟随状态(MessageList 经 bridge 消费):注册 getter,
  // getter 引用恒定,卸载时还原为恒真,避免单例信号指向已卸载面板的状态。
  useEffect(() => {
    registerListFollowing(() => shouldAutoScrollRef.current)
    return () => registerListFollowing(() => true)
  }, [])

  // 滚动容器监听:向上滚=脱离跟随;滚回底部(距底<=8px)=恢复跟随。
  // 此前阈值 40px 会在底部形成拉锯区(用户小幅上滑被跟随定时器拉回),收紧为 8px:
  // 几乎贴底才算"主动滚回",其余位置保留自由回看。
  // 脱离另加意图门槛:程序性位移(TanStack 补偿残留/上方 item 收缩同步下调 top)也满足
  // scrolledUp+距底拉开,但那不是用户在滑 —— 旧判据让一次 -859px 的校正位移永久杀掉
  // 跟随,生成内容在视口下方堆积 2000+px 无人接管。触屏设备只在触摸/滚轮后 400ms
  // 内的 scroll 才算用户上滑;桌面细指针(拖滚动条无 wheel 事件)保留原判定。
  const lastUserIntentRef = useRef(0)
  const coarsePointerRef = useRef(false)
  useEffect(() => {
    const el = messagesScrollEl
    if (!el) return
    coarsePointerRef.current = window.matchMedia('(pointer: coarse)').matches
    const mark = () => { lastUserIntentRef.current = performance.now() }
    el.addEventListener('touchstart', mark, { passive: true, capture: true })
    el.addEventListener('touchmove', mark, { passive: true, capture: true })
    el.addEventListener('wheel', mark, { passive: true, capture: true })
    return () => {
      el.removeEventListener('touchstart', mark, { capture: true })
      el.removeEventListener('touchmove', mark, { capture: true })
      el.removeEventListener('wheel', mark, { capture: true })
    }
  }, [messagesScrollEl])

  useEffect(() => {
    const el = messagesScrollEl
    if (!el) return
    prevScrollTopRef.current = el.scrollTop
    prevScrollHeightRef.current = el.scrollHeight
    const update = () => {
      const scrollHeight = el.scrollHeight
      // 布局收缩(虚拟化把估算高度换成实测值)会连 scrollTop 一起被浏览器夹小,
      // 那不是用户上滑。这一帧不关跟随,真上滑会在下一个 scroll 事件补判。
      const shrank = scrollHeight < prevScrollHeightRef.current - 1
      prevScrollHeightRef.current = scrollHeight
      const distanceFromBottom = scrollHeight - el.scrollTop - el.clientHeight
      const scrolledUp = el.scrollTop < prevScrollTopRef.current - 2
      prevScrollTopRef.current = el.scrollTop
      const intentRecent = performance.now() - lastUserIntentRef.current < 400
      if (
        scrolledUp &&
        !shrank &&
        shouldAutoScrollRef.current &&
        distanceFromBottom > 24 &&
        (!coarsePointerRef.current || intentRecent)
      ) {
        shouldAutoScrollRef.current = false
        setShowScrollToBottom(true)
      } else if (!shouldAutoScrollRef.current && distanceFromBottom <= 8) {
        shouldAutoScrollRef.current = true
        setShowScrollToBottom(false)
      }
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    return () => el.removeEventListener('scroll', update)
  }, [messagesScrollEl])

  // 生成期间贴底跟随:scrollTop 直接赋值(瞬时)而非 smooth 动画,
  // 避免动画与用户滚动形成拉锯;仅在跟随状态下执行。
  // ResizeObserver 驱动:内容把滚动容器撑高即顺势贴底,替代旧的 150ms 轮询
  // (轮询既会在内容静止时空转,又最快滞后 150ms)。
  // 每轮生成开始:强制恢复跟随并立即回底(上一轮的脱离状态不延续)。
  useEffect(() => {
    if (!isLoading) return
    shouldAutoScrollRef.current = true
    setShowScrollToBottom(false)
    const el = messagesScrollEl
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [isLoading, messagesScrollEl])

  // 贴底跟随:只要仍在跟随状态就常驻观察高度变化,不再只限生成中 ——
  // 打开历史会话的虚拟化估算→实测、生成结束后的打字机追平/富文本/公式渲染,
  // 都可能在 isLoading 变 false 之后才把内容撑高;提前断开会让页面停在半空。
  useEffect(() => {
    const el = messagesScrollEl
    if (!el) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (shouldAutoScrollRef.current) el.scrollTop = el.scrollHeight
      })
    })
    // 观察滚动容器本身:overflow-y-auto 的内容增高会改变其 scrollHeight,
    // 但 clientHeight 不变 —— 需观察子树撑高,改观察列表外层包裹
    const contentWrap = el.firstElementChild
    ro.observe(el, { box: 'border-box' })
    if (contentWrap instanceof HTMLElement) ro.observe(contentWrap, { box: 'border-box' })
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [messagesScrollEl])

  // 进入历史会话定位到最新一条:滚动容器挂载时 scrollTop 恒为 0,而消息是 createdAt
  // 升序渲染,顶部即最早的消息 —— 不主动置底就会停在第一条。
  // 只做一次(按 conversationId 重挂载,切会话自然重来);生成中交给上面的贴底跟随,
  // 避免两条路径抢滚动。校正循环在 bridge 里逐帧跟随,用户一旦上滑立即让路。
  const initialScrollDoneRef = useRef(false)
  useEffect(() => {
    if (initialScrollDoneRef.current) return
    const el = messagesScrollEl
    if (!el || isLoading || messages.length === 0) return
    initialScrollDoneRef.current = true
    // 循环自持,不交给 effect cleanup 取消:内联 ref 回调会让 messagesScrollEl 在
    // 重渲染中 null→el 翻转并触发本 effect 重跑,若跟着取消就永远校不完。
    // intentDriven: 让路交给上面的意图状态机(触摸/滚轮门槛),校正期的程序性
    // top 下调不再误触发 scrollTop<assigned 让路。
    pinScrollToBottom(el, () => shouldAutoScrollRef.current, { intentDriven: true })
  }, [messagesScrollEl, isLoading, messages.length])

  // 回到底部按钮:恢复跟随并瞬时滚到最新内容
  const handleScrollToBottom = useCallback(() => {
    const el = messagesScrollEl
    if (!el) return
    shouldAutoScrollRef.current = true
    setShowScrollToBottom(false)
    el.scrollTop = el.scrollHeight
  }, [messagesScrollEl])

  const pendingSendQueueRef = useRef<{ text: string; attachments?: Attachment[] }[]>([])
  const [pendingSendQueue, setPendingSendQueue] = useState<{ count: number; preview: string } | null>(null)

  const cancelPendingSendQueue = useCallback(() => {
    pendingSendQueueRef.current = []
    setPendingSendQueue(null)
  }, [])

  // 当前模型的上下文窗口(B): 供 ContextMeter 计算占用百分比
  const currentContextWindow = useMemo(
    () => mergedModels.find((m) => m.id === currentModel)?.contextWindow ?? 0,
    [mergedModels, currentModel]
  )

  // 当前模型的展示名: 欢迎页副标题使用
  const currentModelName = useMemo(
    () => mergedModels.find((m) => m.id === currentModel)?.name,
    [mergedModels, currentModel]
  )

  // 待注入附件: handleSend 先记录,等 sendMessage 把新 user 消息 push 进 messages 后,
  // 由下方 useEffect 把附件挂到最后一条 user 消息上(与 CompareLane 同款时序)。
  // 不能在 sendMessage 前同步 setMessages —— 那时新 user 消息还不存在,
  // 附件会挂到上一条消息上(或无消息可挂),当轮气泡永远看不到附件卡片。
  const pendingAttachmentsRef = useRef<Attachment[] | undefined>(undefined)

  // 装填快照: pending 装填那一刻已存在的 user 消息 id 集合。挂载 effect 只消费
  // "装填之后新进列的 user 消息"。编辑重答链路 setMessages(截断) 与 AI SDK 乐观消息
  // push 分属两次 commit:截断那一帧的最后一条 user 是旧消息,旧判据会把它误当目标
  // (已带附件→提前清空 pending / 未带→挂错消息),当轮气泡丢图、刷新才回填
  // (2026-10-08 浏览器实测:编辑会话第二条带图消息必丢图,编辑首条不丢)。
  const armedUserIdsRef = useRef<Set<string> | null>(null)
  const armPendingAttachments = useCallback((atts: Attachment[] | undefined) => {
    pendingAttachmentsRef.current = atts && atts.length > 0 ? atts : undefined
    armedUserIdsRef.current =
      atts && atts.length > 0
        ? new Set(messagesRef.current.filter((m) => m.role === 'user').map((m) => m.id))
        : null
  }, [])

  // 消费判据用 messages 闭包直接读,不靠 setMessages 更新器里的标记:更新器在 React 18 可能延后执行。
  // 只在"装填后新出现的最后一条 user 消息"上挂载时才清空;旧消息帧(编辑截断那一帧)直接跳过。
  useEffect(() => {
    const atts = pendingAttachmentsRef.current
    if (!atts || atts.length === 0) return
    let idx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        idx = i
        break
      }
    }
    if (idx === -1) return
    // 装填前就存在的旧 user 消息:不是本次目标,既不挂载也不消费,等真正的新消息进列
    if (armedUserIdsRef.current?.has(messages[idx].id)) return
    if ((messages[idx] as { attachments?: Attachment[] }).attachments) {
      // 该条已带附件(上一轮已挂或服务端回填),不再覆盖
      pendingAttachmentsRef.current = undefined
      armedUserIdsRef.current = null
      return
    }
    setMessages((prev) => {
      const next = [...prev]
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === 'user') {
          next[i] = { ...next[i], attachments: atts } as UIMessage
          break
        }
      }
      return next
    })
    pendingAttachmentsRef.current = undefined
    armedUserIdsRef.current = null
  }, [messages, setMessages])

  // 欢迎页壁纸激活态同步给 shell(WelcomeWallpaperLayer 据此显隐,侧栏/内容列随之变玻璃):
  // 欢迎态 = messages 为空(与下方欢迎分支同判据);卸载(切 tab/进会话)时复位
  const chatWelcomeActive = messages.length === 0
  const setChatWelcomeActive = useChatStore((s) => s.setChatWelcomeActive)
  useEffect(() => {
    setChatWelcomeActive(chatWelcomeActive)
    return () => setChatWelcomeActive(false)
  }, [chatWelcomeActive, setChatWelcomeActive])

  const handleSend = useCallback(
    (text: string, attachments?: Attachment[]) => {
      // 生成中不丢弃输入:入队,本轮结束后由下方 effect 自动发出
      if (isLoadingRef.current) {
        pendingSendQueueRef.current.push({ text, attachments })
        const queue = pendingSendQueueRef.current
        setPendingSendQueue({ count: queue.length, preview: queue[0].text.slice(0, 40) })
        return
      }
      attachmentsRef.current = attachments
      // 新发送无条件覆盖:这里负责让陈旧待注入项不污染下一轮(含装填快照)
      armPendingAttachments(attachments)
      // 工作区快照:桌面端发送前确保新鲜(TTL 内复用缓存,过期/失效才重建,fire-and-forget
      // 不阻塞发送;本次 getter 读到的可能是上一次快照,注入段已向模型声明"可能滞后")
      if (inTauri) void ensureWorkspaceSnapshot()
      sendMessage({ text })
      // 新会话可见性兜底:服务端把会话行建在流开始前,但 X-Conversation-Id 头要等
      // 上游首字节才 flush(上游慢时 20s+ 甚至挂起),期间侧栏看不到新会话。
      // 会话行在请求后 ~1s 落库,1.2s/3.5s 两次补 bump 让列表尽快捕获;
      // 头部已到(conversationIdRef 已设)则跳过,避免无谓 refetch。
      if (!conversationIdRef.current) {
        setTimeout(() => {
          if (!conversationIdRef.current) bumpConversationVersion()
        }, 1200)
        setTimeout(() => {
          if (!conversationIdRef.current) bumpConversationVersion()
        }, 3500)
      }
      // 注意: 此处不能清空 attachmentsRef —— AI SDK sendMessages 首行 await resolve2(body)
      // 会先让出微任务,若本处同步清空,getter 求值时附件已丢失(实测所有附件类型均发送为 undefined)。
      // 保留本次值: 下一次发送由上方赋值覆盖(无附件时为 undefined);
      // regenerate 时 getter 仍返回本次附件,服务端注入到最后一条 user 消息,行为正确。
    },
    [sendMessage, inTauri, bumpConversationVersion, armPendingAttachments]
  )

  // 游戏面板「行动」按钮的直发桥: 深层 MarkdownRenderer 点击 → 事件 → handleSend,
  // 复用完整发送链路(生成中自动入队)。非聊天页无 MarkdownRenderer 触发,监听恒静默。
  useEffect(() => {
    function onSend(e: Event) {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (typeof text !== 'string' || !text.trim()) return
      handleSend(text)
    }
    window.addEventListener(INPUT_SEND_EVENT, onSend)
    return () => window.removeEventListener(INPUT_SEND_EVENT, onSend)
  }, [handleSend])

  // local_file 决策:卡片上用户点「批准」→ 按动作执行(delete=移入回收站;
  // create=覆盖写入)并回填;「拒绝」→ 回填 denied。回填后由 sendAutomaticallyWhen
  // 触发同轮续跑,让模型基于结果向用户收尾。
  // 工作区快照:桌面端挂载即预构建(首次发送前就有),此后写操作触发重建、发送时 TTL 兜底
  useEffect(() => {
    if (inTauri) void ensureWorkspaceSnapshot()
  }, [inTauri])

  // Ctrl+E 快捷开关工作态(仅桌面端;工作态=右侧产物区常驻)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'e') return
      if (!getIsTauri()) return
      e.preventDefault()
      useChatStore.getState().setWorkMode(!useChatStore.getState().workMode)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 待批准操作(需要用户在 LocalFileCard 上点批准的):delete 恒等确认;
  // create 覆盖停在确认卡;exec 非白名单且未开"始终运行"停在确认卡。
  // 其余动作(读/列/白名单 exec 等)自动执行,只是短暂 input-available,不算待批准
  const pendingApprovals = useMemo(() => {
    const out: { id: string; label: string }[] = []
    for (const m of messages) {
      for (const p of m.parts as Array<{ type?: string; state?: string; input?: unknown }>) {
        if (p.type !== `tool-${LOCAL_FILE_TOOL_NAME}` || p.state !== 'input-available') continue
        const input = p.input as LocalFileToolInput | undefined
        const action = input?.action
        const path = typeof input?.path === 'string' && input.path.trim() ? input.path.trim() : ''
        let label: string | null = null
        if (action === 'delete') label = `删除 ${path}`
        else if (action === 'create') label = `覆盖写入 ${path}`
        else if (
          action === 'exec' &&
          !execAutoRunRef.current &&
          !isExecAutoAllowed(typeof input?.command === 'string' ? input.command : '')
        ) {
          label = `执行命令 ${(typeof input?.command === 'string' ? input.command : '').trim()}`
        }
        if (label) {
          out.push({ id: (p as { toolCallId?: string }).toolCallId ?? '', label })
        }
      }
    }
    return out
  }, [messages])

  const gotoPendingApproval = useCallback((toolCallId: string) => {
    const el = document.querySelector(`[data-tcid="${toolCallId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    ;(el as HTMLElement).animate?.(
      [
        { boxShadow: '0 0 0 3px rgba(245,158,11,.85)' },
        { boxShadow: '0 0 0 3px rgba(245,158,11,0)' },
      ],
      { duration: 1600 }
    )
  }, [])

  const handleOpenEditor = useCallback(
    (path: string) => {
      openEditor(path)
    },
    [openEditor]
  )

  // 代码编辑器「让 AI 改这段」:CodeEditor 派发 aichatt:code-ask-ai 事件(带文档全文+指令),
  // 这里构造一条 user 消息发出。code_edit 工具仅在面板打开时注入(见 transport body.codePanelOpen),
  // AI 据指令返回 code_edit → 上方 onToolCall 写 pendingDiff → 编辑器切 Diff 审查。
  useEffect(() => {
    function onAsk(e: Event) {
      const detail = (e as CustomEvent<{
        docId: string
        language: string
        code: string
        selection?: string
        instruction?: string
      }>).detail
      if (!detail || !detail.docId) return
      const selHint = detail.selection
        ? `\n【用户选中区域(请重点改这部分,其余保持稳定)】\n${detail.selection}`
        : ''
      const text =
        `请用 code_edit 工具修改代码文档。\n` +
        `文档 id: ${detail.docId}\n语言: ${detail.language}\n\n` +
        `【当前完整代码】\n${detail.code}\n` +
        selHint +
        `\n\n【改写需求】\n${detail.instruction ?? '(用户未填写,按你理解的合理改写)'}\n\n` +
        `返回 code_edit:docId 用上面这个 id。只发改动涉及的片段——old_text 从上面原文里逐字复制要改的代码块(带前后 1~3 行上下文保证全文唯一),new_text 为改写后的片段;保持无关代码稳定。`
      handleSend(text)
    }
    window.addEventListener('aichatt:code-ask-ai', onAsk)
    return () => window.removeEventListener('aichatt:code-ask-ai', onAsk)
  }, [handleSend])

  const handleLocalFileDecision = useCallback(
    async (
      toolCallId: string,
      path: string,
      approved: boolean,
      decision: {
        action: 'delete' | 'create' | 'exec'
        content?: string
        command?: string
        timeoutMs?: number
      }
    ) => {
      if (executedLocalFileCallsRef.current.has(toolCallId)) return
      executedLocalFileCallsRef.current.add(toolCallId)
      if (!approved) {
        addToolOutput({
          tool: LOCAL_FILE_TOOL_NAME,
          toolCallId,
          output: {
            ok: false,
            action: decision.action,
            denied: true,
            error:
              decision.action === 'create'
                ? '用户拒绝了覆盖写入,原文件保持不变'
                : decision.action === 'exec'
                  ? '用户拒绝执行该命令'
                  : '用户拒绝了删除操作',
          } satisfies LocalFileToolOutput,
        })
        return
      }
      if (decision.action === 'create') {
        const res = await lfWriteFile(path, decision.content ?? '')
        if (res.ok) void refreshWorkspaceSnapshot()
        addToolOutput({
          tool: LOCAL_FILE_TOOL_NAME,
          toolCallId,
          output: { ...res, action: 'create' } satisfies LocalFileToolOutput,
        })
        return
      }
      if (decision.action === 'exec') {
        const res = await lfExecCommand(decision.command ?? '', decision.timeoutMs)
        if (res.ok) void refreshWorkspaceSnapshot()
        addToolOutput({
          tool: LOCAL_FILE_TOOL_NAME,
          toolCallId,
          output: { ...res, action: 'exec' } satisfies LocalFileToolOutput,
        })
        return
      }
      const res = await lfDeleteFile(path)
      if (res.ok) void refreshWorkspaceSnapshot()
      addToolOutput({
        tool: LOCAL_FILE_TOOL_NAME,
        toolCallId,
        output: { ...res, action: 'delete' } satisfies LocalFileToolOutput,
      })
    },
    [addToolOutput]
  )

  // AI 设置控制: 监听 update_settings 工具调用并执行设置变更。
  // 历史回放安全: 历史消息由 toUIMessage 重建,parts 仅含 text/reasoning(工具明细走
  // metadata),不会出现 tool-update_settings part,因此不会误触发执行。
  // 不依赖 status: 工具若发生在流的最后一步,finish 后 status 已回 ready,依赖
  // status==='streaming' 会漏执行;用 toolCallId 去重保证只执行一次。
  const executedSettingsCallIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return
    for (const part of last.parts) {
      if ((part as { type?: string }).type !== 'tool-update_settings') continue
      const p = part as { state?: string; toolCallId?: string; input?: unknown; output?: { ok?: boolean } }
      if (p.state !== 'output-available') continue
      // 服务端 execute 白名单校验未通过(ok=false):前端不再执行
      if (p.output && p.output.ok === false) continue
      const callId = p.toolCallId
      if (!callId || executedSettingsCallIdsRef.current.has(callId)) continue
      executedSettingsCallIdsRef.current.add(callId)
      void executeSettingsOps(p.input, callId)
    }
  }, [messages])

  // 出队: 本轮生成结束(isLoading true→false)且 status 回到 ready 时,自动发出最早一条排队消息。
  // 出错(status='error')不出队,避免连环失败;用户修复后手动发送的下一轮成功结束时继续消化队列。
  const prevIsLoadingRef = useRef(false)
  useEffect(() => {
    const was = prevIsLoadingRef.current
    prevIsLoadingRef.current = isLoading
    if (!was || isLoading || status !== 'ready') return
    const queue = pendingSendQueueRef.current
    if (queue.length === 0) return
    const next = queue.shift()
    setPendingSendQueue(
      queue.length > 0 ? { count: queue.length, preview: queue[0].text.slice(0, 40) } : null
    )
    if (next) handleSend(next.text, next.attachments)
  }, [isLoading, status, handleSend])

  // 跳转桥: /chat?q= 自动发送一次(外部入口,如 bento AI 卡片「继续对话」)。
  // 仅空会话触发;发出后立即清掉 URL 参数,刷新不会重发;
  // consumedRef 兜底防 React 严格模式双调用重复发送。
  const autoSendConsumedRef = useRef(false)
  useEffect(() => {
    if (!autoSendText || autoSendConsumedRef.current) return
    if (messages.length > 0 || isLoadingRef.current) return
    autoSendConsumedRef.current = true
    const url = new URL(window.location.href)
    if (url.searchParams.has('q')) {
      url.searchParams.delete('q')
      const qs = url.searchParams.toString()
      window.history.replaceState({}, '', url.pathname + (qs ? `?${qs}` : ''))
    }
    handleSend(autoSendText)
  }, [autoSendText, messages.length, handleSend])

  // A 流式恢复: 轮询服务端草稿行快照(1.2s),streaming=false 时定格。
  // 定格内容以库中为准(可能是最终内容,比本地快照新)。
  useEffect(() => {
    if (!remoteStreamingId || !conversationId) return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages?limit=1`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        const latest = data.messages?.[0]
        if (cancelled || !latest || latest.role !== 'assistant') return
        if (latest.id !== remoteStreamingId) {
          // 草稿行已消失(流出错且无快照时被服务端删除):停止轮询
          setRemoteStreamingId(null)
          return
        }
        const stillStreaming = latest.streaming === true
        if (!stillStreaming) {
          setRemoteStreamingId(null)
          bumpConversationVersion()
        }
        const text = typeof latest.content === 'string' ? latest.content : ''
        const reasoning =
          typeof latest.reasoning === 'string' && latest.reasoning.trim() ? latest.reasoning : null
        if (!text && !reasoning) return
        // 进行中标注 state:'streaming'(而非恒 'done'): MessageBubble 的流式判定
        // (最后一个 text part 的 state)据此成立,打字机才能启用 —— 否则每 1.2s
        // 的快照替换会整段跳字,且生成期间就进富渲染反复全量重排(闪烁源之一)
        const partState = stillStreaming ? ('streaming' as const) : ('done' as const)
        setMessages((prev) =>
          prev.map((m) =>
            m.id !== remoteStreamingId
              ? m
              : {
                  ...m,
                  parts: [
                    ...(reasoning
                      ? [{ type: 'reasoning' as const, text: reasoning, state: partState }]
                      : []),
                    ...(text ? [{ type: 'text' as const, text, state: partState }] : []),
                  ],
                } as UIMessage
          )
        )
      } catch {
        // 网络抖动:下个周期重试
      }
    }
    void poll()
    const timer = setInterval(poll, 1200)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [remoteStreamingId, conversationId, setMessages, bumpConversationVersion])

  const handleStop = useCallback(() => {
    // 在真正停止前,记录最后一条 assistant 文本到 store,
    // 让 ChatInput 顶部能展示"接着说"横幅。
    // 注意:messages 引用是 closure 捕获的,所以这里读到的可能不是最新;
    // 但 useChat 的 messages 与 status 同步更新,这里是在同一个 setState 周期内调用,
    // 用户的"点 stop"通常会先让 status → 'ready',messages 也是最新的。
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    const lastText = lastAssistant
      ? lastAssistant.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('')
          .trim()
      : ''
    if (lastText) {
      setPendingContinuation({
        conversationId: conversationIdRef.current ?? null,
        text: lastText,
        modelId: currentModel,
      })
    } else {
      setPendingContinuation(null)
    }
    if (remoteStreamingId) {
      // A 流式恢复: 轮询续显期间没有活动流可 abort,
      // 改为请求服务端定格草稿行,并立即停止本地轮询
      const convId = conversationIdRef.current
      if (convId) {
        fetch(`/api/conversations/${convId}/finalize-draft`, { method: 'POST' }).catch(() => {})
      }
      setRemoteStreamingId(null)
      return
    }
    stop()
  }, [stop, messages, currentModel, setPendingContinuation, remoteStreamingId])

  /**
   * 「接着说」:把停下来的最后一段作为上下文,发送一条提示让模型接着输出。
   * 与 regenerate() 不同,这里不会替换已有内容,而是新增一轮对话。
   */
  const handleContinue = useCallback(() => {
    const pending = pendingContinuation
    if (!pending || !pending.text) {
      setPendingContinuation(null)
      return
    }
    const tail = pending.text.slice(-200).replace(/\s+/g, ' ').trim()
    const prompt = `接着你刚才未完成的内容继续输出，从"${tail.slice(-50)}"之后开始。不要重复之前已经写过的部分。`
    attachmentsRef.current = undefined
    sendMessage({ text: prompt })
    setPendingContinuation(null)
  }, [pendingContinuation, sendMessage, setPendingContinuation])

  const dismissContinuation = useCallback(() => {
    setPendingContinuation(null)
  }, [setPendingContinuation])

  const handleModelChange = useCallback((modelId: string) => {
    setCurrentModel(modelId)
    userToggledDeepThink.current = false // Reset on model change to allow auto-enable
    // Persist to localStorage for new chats to pick up
    localStorage.setItem(MODEL_STORAGE_KEY, modelId)
    // Persist to DB for existing conversations
    const convId = conversationIdRef.current
    if (convId) {
      fetch(`/api/conversations/${convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      }).catch((err) => {
        console.error('Failed to persist model:', err)
        toast.error('模型选择保存失败,刷新后会重置', { title: '注意' })
      })
    }
  }, [])

  const handleDeepThinkChange = useCallback((enabled: boolean) => {
    setDeepThink(enabled)
    userToggledDeepThink.current = true // Mark as manually toggled
    localStorage.setItem(DEEP_THINK_STORAGE_KEY, String(enabled))
  }, [])

  const handleWebSearchChange = useCallback((enabled: boolean) => {
    setWebSearch(enabled)
    localStorage.setItem(WEB_SEARCH_STORAGE_KEY, String(enabled))
  }, [])

  const handleMcpEnabledChange = useCallback((enabled: boolean) => {
    setMcpEnabled(enabled)
    localStorage.setItem(MCP_ENABLED_STORAGE_KEY, String(enabled))
  }, [])

  const handleRetry = useCallback(() => {
    clearError()
    regenerate()
  }, [clearError, regenerate])

  // 切换/清除面具:同步 store;已有会话时持久化到 DB。
  // 不写 localStorage —— 新对话默认不带面具,避免上次的面具被"记忆"延续
  const handleMaskChange = useCallback(
    (maskId: string | null) => {
      setConversationMaskId(maskId)
      setMaskPickerOpen(false)
      const convId = conversationIdRef.current
      if (convId) {
        fetch(`/api/conversations/${convId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maskId }),
        })
          .then(() => {
            // 面具已持久化,通知侧边栏刷新列表(尾随面具徽标同步更新)
            bumpConversationVersion()
          })
          .catch((err) => {
            console.error('Failed to persist mask:', err)
            toast.error('面具切换保存失败', { title: '提示' })
          })
      }
    },
    [setConversationMaskId, bumpConversationVersion]
  )

  const handleRegenerate = useCallback(() => {
    clearError()
    regenerate()
  }, [clearError, regenerate])

  const handleEditMessage = useCallback(
    async (messageId: string, newText: string) => {
      // messages 走 ref 镜像读取(依赖数组保持 [setMessages, sendMessage] 稳定,
      // 原因见 messagesRef 处注释);编辑只在非流式期可点,读到的是最新一次 commit
      const msgs = messagesRef.current
      // C 分支轻量版: 刚发送的消息持有 AI SDK 本地临时 id(与服务端 cuid 不同),
      // 服务端按 id 查不到时会用旧文本回退定位,所以这里附带旧文本一起传
      const oldMessage = msgs.find((m) => m.id === messageId)
      const oldText = oldMessage
        ? oldMessage.parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('')
        : ''
      // 带附件的消息重发时保留原附件(否则编辑文本 = 静默丢图)
      const oldAtts = (oldMessage as (UIMessage & { attachments?: Attachment[] }) | undefined)
        ?.attachments

      // Delete the old message and all subsequent messages from the DB
      const convId = conversationIdRef.current
      // 服务端定位到的真实数据库 id(客户端传临时 id 时与本地 id 不同),
      // 回看链路(archivedRoot / editedFrom)必须用真实 id
      let editedFromId = messageId
      if (convId) {
        let res: Response
        try {
          res = await fetch(
            `/api/conversations/${convId}/messages?messageId=${encodeURIComponent(messageId)}&content=${encodeURIComponent(oldText)}`,
            { method: 'DELETE' }
          )
        } catch (err) {
          console.error('Failed to delete old messages:', err)
          toast.error('编辑失败:旧消息归档未完成,请重试', { title: '编辑消息' })
          throw err
        }
        if (!res.ok) {
          // 归档失败即中止:继续截断+重发会让 DB 残留旧分支行(库/端不一致,重载后新旧并存)
          console.error('Failed to archive old messages:', res.status)
          toast.error('编辑失败:旧消息归档未完成,请重试', { title: '编辑消息' })
          throw new Error(`archive failed: HTTP ${res.status}`)
        }
        const data = await res.json().catch(() => ({}))
        if (typeof data?.archivedRootId === 'string' && data.archivedRootId) {
          editedFromId = data.archivedRootId
        }
      }

      // Truncate local messages to before the edited message
      // 注意: 本地查找必须用原始本地 id(临时 id 或历史 cuid),不能用 editedFromId
      const editIndex = msgs.findIndex((m) => m.id === messageId)
      if (editIndex === -1) return
      const truncated = msgs.slice(0, editIndex)
      setMessages(truncated)

      // 附件随重发带回(与 handleSend 同款时序:transport 在请求时读 ref);
      // 无附件必须清空残留,否则上一轮的图会挂进本轮(与 handleReanswerFrom 同款)
      if (oldAtts && oldAtts.length > 0) {
        attachmentsRef.current = oldAtts
        armPendingAttachments(oldAtts)
      } else {
        attachmentsRef.current = undefined
        pendingAttachmentsRef.current = undefined
        armedUserIdsRef.current = null
      }

      // C 分支轻量版: 新消息带 editedFrom 指向被编辑消息(真实数据库 id),服务端落库后
      // MessageBubble 据此显示"查看历史版本"回看入口
      sendMessage({ text: newText, metadata: { editedFrom: editedFromId } })
    },
    [setMessages, sendMessage, armPendingAttachments]
  )

  const errorInfo = useMemo(
    () => (error ? getErrorMessage(error) : null),
    [error]
  )

  // 错误提示节点。floating 用于会话态：绝对定位浮在消息区下缘、与 672 内容框同轴，
  // 玻璃底压住底下的正文，不再像列顶横幅那样把整条消息流推下去。
  const errorBanner = (floating?: boolean) =>
    error && errorInfo ? (
      <ChatErrorBanner
        info={errorInfo}
        onRetry={handleRetry}
        onClose={() => clearError()}
        provider={mergedModels.find((m) => m.id === currentModel)?.provider}
        modelId={currentModel}
        className={floating
          ? 'mx-0 mt-0 md:mt-0 bg-red-50/95 shadow-lg backdrop-blur-md dark:bg-red-950/85'
          : undefined}
      />
    ) : null

  // 档案采集的「打字也算回答 / 一发正题立刻让位」信号:最近一条用户消息正文。
  // 流式期间末条 user 不变,值稳定,不会每帧惊动采集面板。
  let lastUserText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    lastUserText = messages[i].parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text?: string }).text ?? '')
      .join('')
      .trim()
    break
  }

  // 同一个组件挂进两个互斥分支(欢迎页输入胶囊上方 slot / 会话态输入区上方)。
  // 首启横幅必须在用户还没说话时就出现,只挂会话态等于首次进入永远看不到入口。
  // 但主动打扰只留欢迎页那一份:进了具体会话就不再弹横幅/三选卡(用户口径「不要死缠烂打」),
  // 会话内那一份不再主动弹任何东西,只留「正题进来先停采集 + 顺手抽取」这条兜底逻辑的挂载点。
  const profileProbeWelcome = <ProfileProbe lastUserText={lastUserText} disabled={studyMode} />
  const profileProbe = <ProfileProbe lastUserText={lastUserText} disabled={studyMode} allowPromo={false} />

  // 对比模式: 渲染并排泳道视图(key 确保模型列表变化时重建泳道)
  if (compareMode) {
    return (
      <>
      <ComparePanel
        key={compareModels.join('+')}
        conversationId={initialConversationId}
        initialLaneMessages={laneInitialMessages ?? compareModels.map(() => [])}
        initialCompareModels={compareModels}
        allModels={mergedModels}
        stylePreset={conversationStylePreset}
        maskId={conversationMaskId}
        deepThink={deepThink}
        onDeepThinkChange={handleDeepThinkChange}
        webSearch={webSearch}
        onWebSearchChange={handleWebSearchChange}
        webSearchAvailable={webSearchAvailable}
        onCompareModeChange={handleCompareModeChange}
        compareModeAvailable={!conversationId}
        onConversationCreated={handleCompareConversationCreated}
        initialVote={initialCompareVote ?? null}
      />
      <WriteDocPanel />
<FileEditorPanel />
<CodePanel />
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex flex-col h-full min-w-0 flex-1 relative overflow-hidden">

      {/* Error banner —— 仅欢迎态按列顶常规排布(此时没有消息流可推挤);
          会话态改浮在消息区下缘，见下方 relative wrapper */}
      {messages.length === 0 && errorBanner()}

      {/* Mask bar - 当前生效的面具 chip(仅对话态;欢迎态由输入框下方胶囊行承担入口),点击弹出切换面板 */}
      {activeMask && messages.length > 0 && (
        // data-tauri-drag-region:客户端下这一行本身就是空白带(chip 只占左侧一小块),
        // 整行挂拖动区 → 除 chip 与其弹层外的区域都能抓窗(chat 顶部好抓手 +1)。
        // 注意只挂属性不写 -webkit-app-region,避免子元素继承拖拽区把弹层点击吃掉。
        // max-md:hidden:trial 原型定稿——手机端此 chip 与悬浮圆钮(← ☰/⚙)位置重叠,
        // 面具入口已收进输入框 ⋯「面具」行(带当前面具名),此处整行下线
        <div className="px-4 pt-2 max-md:hidden" data-tauri-drag-region="">
          <div className="relative inline-block">
            <button
              ref={headerMaskMenu.triggerRef}
              onClick={() => setMaskPickerOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs
                bg-surface-subtle text-content-secondary border border-line
                hover:bg-surface-muted transition-colors"
              title="当前面具,点击切换"
            >
              <span aria-hidden>{activeMask.avatar}</span>
              <span>{activeMask.name}</span>
            </button>
            {maskPickerOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMaskPickerOpen(false)} />
                <div
                  className="absolute left-0 top-full mt-1.5 z-50 w-64 flex flex-col overflow-hidden
                    rounded-xl border border-line bg-surface shadow-lg"
                  style={{ maxHeight: headerMaskMenu.maxHeight }}
                  role="menu"
                >
                  <MaskPickerMenu
                    activeMaskId={activeMask.id}
                    userMasks={userMasks}
                    onSelect={handleMaskChange}
                    onManage={() => { setSettingsSection('masks'); setSettingsOpen(true); setMaskPickerOpen(false) }}
                    onClear={() => handleMaskChange(null)}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Messages area 或 欢迎态输入区(messages.length === 0 时由 ChatInput 自己居中渲染) */}
      {messages.length === 0 ? (
        <ChatInput
          variant="welcome"
          welcomeBanner={profileProbeWelcome}
          onSend={handleSend}
          onStop={handleStop}
          isLoading={isLoading}
          models={mergedModels}
          selectedModel={currentModel}
          onModelChange={handleModelChange}
          deepThink={deepThink}
          onDeepThinkChange={handleDeepThinkChange}
          webSearch={webSearch}
          onWebSearchChange={handleWebSearchChange}
          webSearchAvailable={webSearchAvailable}
          searchPlatform={searchPlatform}
          onSearchPlatformChange={setSearchPlatform}
          mcpEnabled={mcpEnabled}
          onMcpEnabledChange={handleMcpEnabledChange}
          mcpAvailable={mcpAvailable}
          compareMode={false}
          compareModeAvailable={!conversationId}
          onCompareModeChange={handleCompareModeChange}
          mask={activeMask}
          onMaskChange={handleMaskChange}
          userMasks={userMasks}
          onManageMasks={() => { setSettingsSection('masks'); setSettingsOpen(true) }}
          welcomeHeader={(
            /* 手机端垂直居中必须上下都 auto:原来写 `my-auto` 又跟一个 `mb-0`,
               下边距被钉死 → 自由空间全给上边距,整块沉到底。
               分隔由 auto 边距负责;variant 类在 Tailwind 里排在无修饰类之后,所以能压住 mb-8(桌面仍走 mb-8) */
            <div className="text-center mb-8 max-md:mt-auto max-md:mb-auto">
              <h2
                className="m-hero-title text-content-primary text-[24px] md:text-[32px] max-md:text-[28px] font-thin leading-[1.2] tracking-[0.02em]"
                style={{
                  fontFamily: "'PingFang SC', 'PingFang SC Sub', 'Microsoft YaHei UI', -apple-system, BlinkMacSystemFont, sans-serif",
                }}
              >
                {/* 主题问候: 六选一,由 配色 + 明暗 走 CSS 门控,不做日期/时段检测 ——
                    换回黑白基线即恢复原问候语。常规版挂 .base-only(格子下另有专属
                    文案),不用 .no-fest —— 后者在格子下仍然可见,会给登录页标语复用。
                    注意 .grid-night 是**暮色**的历史错名,晚上那版叫 .grid-nightfall */}
                <span className="base-only">{getGreeting()}，今天能为你做些什么？</span>
                <span className="fest-night">中秋快乐，今夜月色正圆</span>
                <span className="grid-dawn">天亮了，今天想做点什么？</span>
                <span className="grid-day">日头正好，今天想做点什么？</span>
                <span className="grid-night">暮色四合，今天想做点什么？</span>
                <span className="grid-nightfall">夜深了，今天想做点什么？</span>
              </h2>
              {/* 副标题: 日期 + 当前模型,给问候语增加层次
                  方案 C 手机端:模型名升级为玻璃胶囊(点击弹半屏快切),普通文本仅桌面显示 */}
              <p className="m-hero-sub mt-3 text-xs text-content-muted tracking-wide">
                {getDateLine()}
                <span className="fest-only fest-tag"> · 中秋</span>
                <span className="grid-dawn fest-tag"> · 日出</span>
                <span className="grid-day fest-tag"> · 正午</span>
                <span className="grid-night fest-tag"> · 暮色</span>
                <span className="grid-nightfall fest-tag"> · 夜晚</span>
                <span className="max-md:hidden">{currentModelName ? ` · ${currentModelName}` : ''}</span>
                <span className="max-md:block mt-1.5">
                  <HeroModelChip models={mergedModels} selectedModel={currentModel} onModelChange={handleModelChange} />
                </span>
              </p>
            </div>
          )}
        />
      ) : (
        <>
          {/* relative wrapper: "回到底部"按钮需要相对消息区(而非滚动内容)定位,
              absolute 元素放进滚动容器内会随内容滚走 */}
          <div className="relative flex-1 min-h-0">
            {/* md:pt-12: 桌面端浮动工具簇无底板悬在内容区右上,首条消息(含右对齐用户气泡)须从其下方起排;
                padding 放在滚动容器内,滚动时随内容移出 —— 顶部裁切线保持 y=0,TopFade 渐隐行为不变 */}
            {/* data-tauri-drag-region:容器自身的 md:pt-12 留白带(滚到顶时的顶部 48px)
                即客户端窗口拖动区,滚动后留白移出、拖动随之失效,不挡消息点击与选词。
                只挂属性不写 -webkit-app-region:子元素不继承拖拽区,正文选择/按钮不受影响 */}
            <div
              ref={setMessagesScrollEl}
              data-tauri-drag-region=""
              className="h-full overflow-y-auto overflow-x-hidden scroll-contain md:pt-12 max-md:pt-[var(--m-chat-pad-top)] chat-scroll-fade [scroll-behavior:auto]"
            >
              {/* error 时给内容尾部留出一张卡片的高度：浮层会压住正文下缘，
                  滚到底时最后一条(往往是断掉的回复)仍能完整露出 */}
              <div className={`flex min-h-full${error ? ' pb-28' : ''}`}>
                <MessageList
                  messages={messages}
                  isStreaming={isLoading}
                  isPending={status === 'submitted'}
                  className="min-h-full flex-1"
                  virtualized
                  scrollElement={messagesScrollEl}
                  onRegenerate={handleRegenerate}
                  onEditMessage={handleEditMessage}
                  onClarifySubmit={handleSend}
                  onLocalFileDecision={handleLocalFileDecision}
                  onOpenEditor={handleOpenEditor}
                  hasEarlier={!!onLoadEarlier}
                  earlierCount={earlierCount}
                  earlierLoading={earlierLoading}
                  restoreAnchor={restoreAnchor}
                  onLoadEarlier={onLoadEarlier ? () => void handleLoadEarlier() : undefined}
                />
                {/* 资料面板占住右墙时,刻度列不隐藏,只按面板实际宽度整体左移;
                    drawer 打开时右墙由 fixed 抽屉接管,刻度列才撤下 */}
                {!drawerOpen && (
                  <OutlineSidebar
                    messages={messages}
                    scrollContainer={messagesScrollEl}
                    rightOffset={
                      infoSlotOccupied ? (infoPanelOpen ? INFO_PANEL_WIDTH : INFO_TAB_WIDTH) : 0
                    }
                  />
                )}
              </div>
            </div>
            {showScrollToBottom && (
              <button
                type="button"
                onClick={handleScrollToBottom}
                aria-label="回到底部"
                title="回到底部"
                className="absolute bottom-4 right-5 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-content-secondary shadow-sm transition-colors hover:bg-surface-subtle hover:text-content-primary"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            )}

            {/* 错误条落位 B：贴在消息区下缘(输入框正上方)、收成 max-w-2xl 与内容框同轴。
                绝对定位 → 不再把整条消息流往下推；玻璃底压住身后的正文。
                wrapper 用 pointer-events-none 让两侧留白不吞掉正文点击，卡片自身恢复可点。 */}
            {errorBanner(true) && (
              <div className="pointer-events-none absolute inset-0 z-40 flex items-end justify-center px-3 pb-2">
                {/* max-h 锚在消息区高度上：极矮窗口里卡片自身滚动，顶部不再被列的 overflow-hidden 裁掉 */}
                <div className="pointer-events-auto max-h-[calc(100%-8px)] w-full max-w-2xl overflow-y-auto overscroll-contain">
                  {errorBanner(true)}
                </div>
              </div>
            )}
          </div>

          {/* 输入区上方的辅助行: 左侧排队发送横幅(F),右侧上下文用量仪表(B)。
              与输入框同宽对齐(ChatInput 内层同为 max-w-2xl 居中),仪表贴在输入框右缘正上方 */}
          {(pendingSendQueue || (conversationId && currentContextWindow > 0)) && (
            <div className="px-3 pb-1">
              <div className="mx-auto flex w-full max-w-2xl items-end justify-between gap-2">
                {pendingSendQueue ? (
                  <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-subtle/60 px-2.5 py-1 text-[11px] text-content-secondary">
                    <span className="truncate">
                      AI 回复后将自动发送
                      {pendingSendQueue.count > 1 ? `（排队 ${pendingSendQueue.count} 条）` : ''}：
                      {pendingSendQueue.preview}
                    </span>
                    <button
                      onClick={cancelPendingSendQueue}
                      className="shrink-0 rounded px-1 text-[10px] text-content-muted transition-colors hover:text-content-primary"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <span />
                )}
                {conversationId && currentContextWindow > 0 && (
                  <ContextMeter
                    conversationId={conversationId}
                    contextWindow={currentContextWindow}
                    refreshSignal={messages.length}
                  />
                )}
              </div>
            </div>
          )}

          {/* 待批准操作钉住横幅(P0):不用滚聊天流找确认卡,点击一键定位 */}
          {pendingApprovals.length > 0 && (
            <div className="flex justify-center px-4 pb-1.5">
              <button
                type="button"
                onClick={() => gotoPendingApproval(pendingApprovals[0].id)}
                className="inline-flex max-w-full items-center gap-2.5 rounded-full bg-[#1d1d21] px-4 py-2 text-xs text-white
                  shadow-lg transition-transform hover:-translate-y-0.5"
              >
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
                <span className="truncate">
                  {pendingApprovals.length} 个操作待批准 · {pendingApprovals[0].label}
                </span>
                {pendingApprovals.length > 1 && (
                  <span className="shrink-0 text-[10px] text-white/50">共 {pendingApprovals.length} 个</span>
                )}
                <span className="shrink-0 font-medium text-blue-300">定位 →</span>
              </button>
            </div>
          )}

          {/* 通用档案采集(波2):首启横幅 / 换学年三选卡 / 一问一气泡的采集面板。
              与输入框同宽贴在上方,气泡不落库;学习模式与对比模式不弹 */}
          {profileProbe}

          {/* Input area - fixed at bottom */}
          <ChatInput
            onSend={handleSend}
            onStop={handleStop}
            isLoading={isLoading}
            mask={activeMask}
            onMaskChange={handleMaskChange}
            userMasks={userMasks}
            onManageMasks={() => { setSettingsSection('masks'); setSettingsOpen(true) }}
            models={mergedModels}
            selectedModel={currentModel}
            onModelChange={handleModelChange}
            deepThink={deepThink}
            onDeepThinkChange={handleDeepThinkChange}
            webSearch={webSearch}
            onWebSearchChange={handleWebSearchChange}
            webSearchAvailable={webSearchAvailable}
            searchPlatform={searchPlatform}
            onSearchPlatformChange={setSearchPlatform}
            mcpEnabled={mcpEnabled}
            onMcpEnabledChange={handleMcpEnabledChange}
            mcpAvailable={mcpAvailable}
            compareMode={false}
            compareModeAvailable={!conversationId}
            onCompareModeChange={handleCompareModeChange}
            pendingContinuationExists={!!pendingContinuation}
            onContinue={handleContinue}
            onDismissContinuation={dismissContinuation}
          />
        </>
      )}

      <WriteDocPanel />
      <ChatPreviewPanel />
      </div>

      {/* [P1]常驻 Side Pane:预览/文件树/编辑器/代码 四 tab 并存,取代互斥覆盖面板 */}
      <WorkSidePane messages={messages} />

      {/* 对话资料:聊天列右侧的并列一列(in-flow),留在 app-shell 圆角容器内,不越界;
          抽屉打开时整列撤下,由 fixed 抽屉接管右墙 */}
      {infoSlotOccupied && (
        <InfoAsidePanel
          conversationId={conversationId}
          messages={messages}
        />
      )}
    </div>
  )
}
