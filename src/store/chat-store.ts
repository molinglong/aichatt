import { create, type StateCreator, type StoreApi, type UseBoundStore } from 'zustand'
import {
  loadDrafts,
  type DraftEntry,
  type DraftsMap,
} from '@/lib/draft-storage'
import {
  loadLastReadAt,
  persistLastReadAt,
  removeLastReadAt,
} from '@/lib/last-read'
import type { PreviewCheckToolOutput } from '@/lib/ai/preview-check-tool'
import {
  toSearchPlatformId,
  type SearchPlatformId,
} from '@/lib/ai/search-platforms'
import type { SearchEngineId } from '@/lib/ai/search-engines'

/** 最近使用模型历史上限:超过此值的最旧条目会被淘汰 */
const MAX_RECENT_MODELS = 10

/** 一次性面具信号:侧边栏「选面具开新对话」写入,ChatPanel 新对话挂载时消费并立即清除。
 *  新对话默认不带面具(上次的面具总忘记关),只有这里的显式选择才会带入。 */
export const NEW_CHAT_MASK_SIGNAL_KEY = 'chat:newChatMaskSignal'

/** 背景模式(设置 → 通用 → 背景):
 *  - off      纯色界面
 *  - image    新对话欢迎页铺内置壁纸(仅欢迎页) */
export type BackdropMode = 'off' | 'image'

const BACKDROP_MODE_KEY = 'chat:backdropMode'

/** 读背景模式,并把旧壁纸开关(chat:welcomeWallpaper = 'true')一次性迁移成 image 回写 */
export function readBackdropMode(): BackdropMode {
  try {
    const saved = localStorage.getItem(BACKDROP_MODE_KEY)
    if (saved === 'off' || saved === 'image') return saved
    let mode: BackdropMode = 'off'
    if (localStorage.getItem('chat:welcomeWallpaper') === 'true') {
      mode = 'image'
    }
    localStorage.setItem(BACKDROP_MODE_KEY, mode)
    return mode
  } catch {
    return 'off'
  }
}

/** 从 localStorage 读取字符串数组,失败/缺失返回 fallback */
function loadStringArray(key: string, fallback: string[] = []): string[] {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : fallback
  } catch {
    return fallback
  }
}

interface ChatState {
  sidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  /** 编辑器面板(写作画布/代码)打开前侧边栏的展开状态,null=当前无面板占用。
   *  面板打开时自动折叠侧边栏(否则中栏被两侧夹击),面板全关时恢复;
   *  用户在面板打开期间手动切换侧边栏即接管控制权(清空,关闭面板不再自动恢复)。
   *  纯内存不落 localStorage:面板状态本身不持久化,刷新后面板已关,
   *  侧边栏由 getInitialSidebarOpen 回到用户偏好即可。 */
  prePanelSidebarOpen: boolean | null
  /** 客户端是否已完成 hydrate. 只在第一次客户端渲染完成后翻为 true,
   *  跨 layout 跳转时 Sidebar 重新挂载但 hydrated 仍为 true, 避免 "先展开再收起" 闪烁. */
  hydrated: boolean
  setHydrated: (v: boolean) => void
  currentConversationId: string | null
  setCurrentConversationId: (id: string | null) => void
  conversationTitle: string | null
  setConversationTitle: (title: string | null) => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  /** 打开设置弹窗时指定的目标 section（如 'masks'）；消费后置 null */
  settingsSection: string | null
  setSettingsSection: (section: string | null) => void
  previewCode: string | null
  setPreviewCode: (code: string | null) => void
  /** 右侧「对话资料」竖排面板:搜索 / 摘要 / 附件一列排下来,点条目跳转到对应消息。
   *  桌面端常驻,默认展开(与 sidebarOpen 同款 localStorage 记忆)。 */
  infoPanelOpen: boolean
  setInfoPanelOpen: (open: boolean) => void
  toggleInfoPanel: () => void
  /** 会话列表刷新信号：新会话创建时 +1，侧边栏监听此值重新拉取列表 */
  conversationVersion: number
  bumpConversationVersion: () => void
  /** 后台生成跟踪:生成中切走的会话 ID → 注册时刻.
   *  useBackgroundStreamWatcher(Sidebar 常驻)轮询这些会话的最新消息,
   *  生成完成后 bumpConversationVersion 点亮侧边栏蓝点并移除跟踪. */
  backgroundStreaming: Record<string, number>
  registerBackgroundStreaming: (conversationId: string) => void
  unregisterBackgroundStreaming: (conversationId: string) => void
  /** 新对话重置信号:每次「开新对话」动作 +1.
   *  chat/page.tsx 把它拼进 ChatPanel 的 key —— 即使 React 因
   *  history.replaceState 造成的路由状态与树不一致而复用同一棵 page
   *  子树,key 变化也会强制 ChatPanel 卸载重建,彻底回到空白新对话. */
  newChatNonce: number
  bumpNewChatNonce: () => void
  /** 当前对话的风格预设 id(balanced/practical/dev/editor/mentor/scholar). 默认 balanced. */
  conversationStylePreset: string
  setConversationStylePreset: (preset: string) => void
  /** 当前对话的回复长度档 id(minimal/short/standard/detailed). 默认 standard(不额外限制篇幅). */
  conversationReplyLength: string
  setConversationReplyLength: (level: string) => void
  /** 当前对话的面具 id(内置面具见 @/lib/ai/builtin-masks). null 表示未启用面具. */
  conversationMaskId: string | null
  setConversationMaskId: (maskId: string | null) => void
  /** 当前联网搜索引擎：qianfan | tavily | deepseek，默认 qianfan */
  searchEngine: SearchEngineId
  setSearchEngine: (engine: SearchEngineId) => void
  /** 联网搜索平台定向口径：'auto'(默认，模型按问题自判) | 'all'(强制全网) | 具体平台 id(强制站内)。
   *  纯本地偏好，持久化 localStorage('chat:searchPlatform')；见 @/lib/ai/search-platforms */
  searchPlatform: SearchPlatformId
  setSearchPlatform: (platform: SearchPlatformId) => void
  /** 思考框自动折叠:思考完毕后自动收起思考框(可在设置中关闭)。持久化到 localStorage */
  autoCollapseReasoning: boolean
  setAutoCollapseReasoning: (v: boolean) => void
  /** 背景模式:off=纯色 / image=新对话欢迎页内置壁纸。
      纯本地偏好,持久化到 localStorage('chat:backdropMode');旧壁纸开关偏好在读取时自动迁移 */
  backdropMode: BackdropMode
  setBackdropMode: (v: BackdropMode) => void
  /** 壁纸激活态(运行时信号,不持久化):当前渲染的是新对话欢迎页。
      shell 层壁纸层与侧栏/内容列的半透明化都以此为开关 */
  chatWelcomeActive: boolean
  setChatWelcomeActive: (v: boolean) => void
  /** 输入草稿:按会话 key 索引. SSR 期间为空,客户端 hydrate 后从 localStorage 灌入 */
  drafts: DraftsMap
  /** 设置某个会话的草稿(null 表示删除) */
  setDraft: (convKey: string, entry: DraftEntry | null) => void
  /** 从 localStorage 重新加载(供跨 tab storage 事件触发) */
  reloadDrafts: () => void
  /** 接着说:用户点了 ⏹ 后保存到 store,ChatInput 顶部横幅可一键恢复 */
  pendingContinuation: { conversationId: string | null; text: string; modelId: string } | null
  setPendingContinuation: (
    p: { conversationId: string | null; text: string; modelId: string } | null
  ) => void
  /** 已读时间:按会话 ID 索引,持久化到 localStorage.
   *  在 store 里维护是为了让 ConversationItem 在不同时间点能一致地读同一个值
   *  (避免每个组件各自读 localStorage 出现 SSR/CSR 不一致). */
  lastReadAt: Record<string, number>
  /** 把指定会话标为"已读当下",写入 store + localStorage.
   *  debounced 防抖由调用方负责(避免快速切换闪烁). */
  markConversationRead: (conversationId: string) => void
  /** 删除会话时同步清理已读记录 */
  removeConversationRead: (conversationId: string) => void
  /** 聊天内嵌写作画布面板:当前打开的文档 id,null=关闭(豆包式右侧滑出,不跳转页面)。
   *  与代码编辑器面板互斥(同位置滑出,同时只留一个)。 */
  writePanelDocId: string | null
  openWritePanel: (docId: string) => void
  closeWritePanel: () => void
  /** 本地文件编辑器面板:当前打开的工作区相对路径,null=关闭(与写作画布同款右侧滑出)。
   *  diff=true 时以「审查模式」打开:DiffEditor 左侧展示磁盘现状,右侧为编辑缓冲。 */
  editorFile: { path: string; diff: boolean } | null
  openEditor: (path: string, diff?: boolean) => void
  closeEditor: () => void
  /** 聊天内嵌代码编辑器面板:右侧滑出(与写作画布同款)。
   *  [P1 改版]codePanelOpen/editorFile/workFile 等不再各自开覆盖面板,
   *  而是驱动右侧 WorkSidePane 的 tab;codePanelOpen=true = 代码 tab 打开。 */
  codePanelOpen: boolean
  codePanelDocId: string | null
  /** 打开代码面板;docId 缺省=打开空面板(当前会话无代码产物时顶栏入口用) */
  openCodePanel: (docId?: string) => void
  closeCodePanel: () => void
  /** Side Pane 激活 tab:preview/files(工作区两视图)、editor(文件编辑器)、code(代码文档) */
  sideTab: 'preview' | 'files' | 'editor' | 'code'
  setSideTab: (t: 'preview' | 'files' | 'editor' | 'code') => void
  /** Side Pane 宽度(px),持久化到 localStorage,拖拽分隔条时更新 */
  sidePaneWidth: number
  setSidePaneWidth: (w: number) => void
  /** AI code_edit 工具产出的待审查 Diff:original=原文,modified=AI 版本。
   *  docId 必须匹配当前打开文档,匹配则编辑器切 Diff 模式,用户采纳/放弃后清空。 */
  codePendingDiff: { docId: string; original: string; modified: string } | null
  setCodePendingDiff: (d: { docId: string; original: string; modified: string } | null) => void
  /** preview_check 预览验证:CodeEditor iframe 捕获到的错误缓冲(按 docId,最新一次渲染清零)。
   *  供 AI 检查回填与预览工具条错误角标/「把报错发给 AI」按钮共用。 */
  previewErrors: { docId: string; items: string[] } | null
  pushPreviewError: (docId: string, text: string) => void
  clearPreviewErrors: (docId: string) => void
  /** AI 发起的预览检查请求:ChatPanel.onToolCall 写入(preview_check),CodeEditor 认领执行
   *  (切预览渲染→静默期收集错误→resolve)。nonce 保证同文档连续两次检查也能触发 effect。 */
  previewCheckRequest: { docId: string; nonce: number } | null
  /** ChatPanel 挂起的 resolver:CodeEditor 完成检查后经 finishPreviewCheck 回传结果 */
  beginPreviewCheck: (
    docId: string,
    resolve: (output: PreviewCheckToolOutput) => void
  ) => void
  finishPreviewCheck: (output: PreviewCheckToolOutput) => void
  /** 工作态开关(仅桌面客户端):true=右侧「产物区」滑出并常驻,对话保持左主位。
   *  与上面几个右侧面板的区别:这是「模式」不是「面板」——持久化到 localStorage,
   *  刷新后保持;且不参与 prePanelSidebarOpen 机制(工作态不折叠会话栏)。
   *  右侧覆盖式面板(写作画布/代码/文件编辑器)打开时右栏临时让位,面板关回来。 */
  workMode: boolean
  setWorkMode: (on: boolean) => void
  /** 工作区右栏当前定位的文件(相对工作区根的路径);null=未定位,预览区给引导 */
  workFile: string | null
  setWorkFile: (relPath: string | null) => void
  /** 工作区右栏视图:preview=预览优先(默认) / files=全部文件(工作区文件树) */
  workView: 'preview' | 'files'
  setWorkView: (view: 'preview' | 'files') => void
  /** 键盘导航(j/k)选中的消息 ID,null 表示未选中任何消息 */
  focusedMessageId: string | null
  setFocusedMessageId: (id: string | null) => void
  /** 引用回复:被引用的消息(显示在 ChatInput 顶部横幅),null 表示无引用 */
  replyingTo: { id: string; role: string; text: string } | null
  setReplyingTo: (msg: { id: string; role: string; text: string } | null) => void
  /** ⭐ 收藏的模型 ID 列表(顺序=用户添加顺序).持久化到 localStorage. */
  favoriteModels: string[]
  /** 切换某个模型的收藏状态(add 或 remove) */
  toggleFavoriteModel: (modelId: string) => void
  /** 🕐 最近使用的模型 ID 列表(按时间倒序,头部最新).持久化到 localStorage. */
  recentModels: string[]
  /** 记录一次模型使用:挪到头部,去重,最多保留 MAX_RECENT_MODELS 个. */
  recordModelUsage: (modelId: string) => void
  /** ⭐/🕐 分组的折叠状态(本次会话内),不持久化. */
  modelSpecialSectionsCollapsed: { favorites: boolean; recent: boolean }
  toggleModelSpecialSection: (section: 'favorites' | 'recent') => void
}

const getInitialSearchEngine = (): SearchEngineId => {
  if (typeof window === 'undefined') return 'qianfan'
  const saved = localStorage.getItem('chat:searchEngine')
  return saved === 'tavily' || saved === 'deepseek' ? saved : 'qianfan'
}

/** 平台定向初值：非法/过期取值一律落 'auto'（默认行为 = 改造前，不干涉模型） */
const getInitialSearchPlatform = (): SearchPlatformId => {
  if (typeof window === 'undefined') return 'auto'
  return toSearchPlatformId(localStorage.getItem('chat:searchPlatform'))
}

/** preview_check 的 resolver 存放处(模块级,函数不进 zustand state) */
const previewCheckResolverRef: { current: ((output: PreviewCheckToolOutput) => void) | null } = {
  current: null,
}

/**
 * 代码编辑器实时内容镜像(模块级单例,非响应式):CodeEditor 每次 latestRef 同步时顺手写入,
 * code_edit 片段替换时用它拿「含未保存改动」的当前值,避免读 DB 落后于防抖保存窗口。
 * 只有一个编辑器实例(面板单文档),docId 不匹配时调用方回落 GET 接口读落库版本。
 */
export const liveCodeDoc: { docId: string; content: string } = { docId: '', content: '' }

/** 读取侧边栏折叠偏好: 桌面端用户上次的选择 */
const getInitialSidebarOpen = (): boolean => {
  if (typeof window === 'undefined') return true
  const v = localStorage.getItem('chat:sidebarOpen')
  // 缺失值或 'true' 视为展开;'false' 才视为折叠
  return v === null ? true : v === 'true'
}

/** 右侧「对话资料」面板默认展开(缺省即展开),用户手动收起后记住 */
const getInitialInfoPanelOpen = (): boolean => {
  if (typeof window === 'undefined') return true
  return localStorage.getItem('chat:infoPanelOpen') !== 'false'
}

const storeInitializer: StateCreator<ChatState> = (set) => ({
  // 两个右侧编辑器面板互斥:同位置(z-[80] 右侧滑出)叠加会互相遮挡,只保留最近打开的一个。
  // 打开面板时同步折叠侧边栏(记住原状态,面板全关时恢复),避免中栏被左右夹击
  prePanelSidebarOpen: null,
  sidebarOpen: typeof window !== 'undefined' ? getInitialSidebarOpen() : true,
  hydrated: false,
  setHydrated: (v) => set({ hydrated: v }),
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarOpen
      if (typeof window !== 'undefined') {
        localStorage.setItem('chat:sidebarOpen', String(next))
      }
      // 手动切换 = 接管控制权,清掉面板占用的恢复记忆
      return { sidebarOpen: next, prePanelSidebarOpen: null }
    }),
  setSidebarOpen: (open) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('chat:sidebarOpen', String(open))
    }
    // 手动设置 = 接管控制权(同 toggleSidebar)
    set({ sidebarOpen: open, prePanelSidebarOpen: null })
  },
  currentConversationId: null,
  setCurrentConversationId: (id) => set({ currentConversationId: id }),
  conversationTitle: null,
  setConversationTitle: (title) => set({ conversationTitle: title }),
  settingsOpen: false,
  // 设置 = 主窗口内模态(TopBar/Sidebar/ChatPanel/CompareLane/AI 工具 update_settings
  // 等所有入口统一走这里)。曾短暂改为 Tauri 独立子窗口,因断点/样式连锁问题按用户
  // 要求回退;子窗口基础设施(tauri.openSettings/show_settings_window/settings-window
  // 路由)保留未拆,后续需要时可再启用。
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  settingsSection: null,
  setSettingsSection: (section) => set({ settingsSection: section }),
  previewCode: null,
  setPreviewCode: (code) => set({ previewCode: code }),
  infoPanelOpen: typeof window !== 'undefined' ? getInitialInfoPanelOpen() : true,
  setInfoPanelOpen: (open) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('chat:infoPanelOpen', String(open))
    }
    set({ infoPanelOpen: open })
  },
  toggleInfoPanel: () =>
    set((state) => {
      const next = !state.infoPanelOpen
      if (typeof window !== 'undefined') {
        localStorage.setItem('chat:infoPanelOpen', String(next))
      }
      return { infoPanelOpen: next }
    }),
  conversationVersion: 0,
  bumpConversationVersion: () =>
    set((state) => ({ conversationVersion: state.conversationVersion + 1 })),
  backgroundStreaming: {},
  registerBackgroundStreaming: (conversationId) => {
    if (!conversationId) return
    set((state) =>
      state.backgroundStreaming[conversationId]
        ? state // 已注册:返回原引用,避免触发无关订阅
        : { backgroundStreaming: { ...state.backgroundStreaming, [conversationId]: Date.now() } }
    )
  },
  unregisterBackgroundStreaming: (conversationId) => {
    if (!conversationId) return
    set((state) => {
      if (!(conversationId in state.backgroundStreaming)) return state
      const next = { ...state.backgroundStreaming }
      delete next[conversationId]
      return { backgroundStreaming: next }
    })
  },
  newChatNonce: 0,
  bumpNewChatNonce: () =>
    set((state) => ({ newChatNonce: state.newChatNonce + 1 })),
  conversationStylePreset: 'balanced',
  setConversationStylePreset: (preset) => set({ conversationStylePreset: preset }),
  conversationReplyLength: 'standard',
  setConversationReplyLength: (level) => set({ conversationReplyLength: level }),
  conversationMaskId: null,
  setConversationMaskId: (maskId) => set({ conversationMaskId: maskId }),
  searchEngine: typeof window !== 'undefined' ? getInitialSearchEngine() : 'qianfan',
  setSearchEngine: (engine) => {
    localStorage.setItem('chat:searchEngine', engine)
    set({ searchEngine: engine })
  },
  searchPlatform: typeof window !== 'undefined' ? getInitialSearchPlatform() : 'auto',
  setSearchPlatform: (platform) => {
    localStorage.setItem('chat:searchPlatform', platform)
    set({ searchPlatform: platform })
  },
  // 默认开:与无设置时的展示行为一致,避免 SSR/客户端 hydration 不一致
  autoCollapseReasoning: typeof window !== 'undefined' ? localStorage.getItem('chat:autoCollapseReasoning') !== 'false' : true,
  setAutoCollapseReasoning: (v) => {
    localStorage.setItem('chat:autoCollapseReasoning', String(v))
    set({ autoCollapseReasoning: v })
  },
  // 背景模式:读取时自动迁移旧壁纸开关偏好(见 readBackdropMode);
  // SSR 期间恒为 off,客户端 hydration 后从 localStorage 灌入
  backdropMode: typeof window !== 'undefined' ? readBackdropMode() : 'off',
  setBackdropMode: (v) => {
    try {
      localStorage.setItem(BACKDROP_MODE_KEY, v)
    } catch {}
    set({ backdropMode: v })
  },
  chatWelcomeActive: false,
  setChatWelcomeActive: (v) => set({ chatWelcomeActive: v }),
  drafts: typeof window !== 'undefined' ? loadDrafts() : {},
  setDraft: (convKey, entry) =>
    set((state) => {
      const next: DraftsMap = { ...state.drafts }
      if (entry === null) {
        delete next[convKey]
      } else {
        next[convKey] = entry
      }
      return { drafts: next }
    }),
  reloadDrafts: () => set({ drafts: loadDrafts() }),
  pendingContinuation: null,
  setPendingContinuation: (p) => set({ pendingContinuation: p }),
  lastReadAt: typeof window !== 'undefined' ? loadLastReadAt() : {},
  markConversationRead: (conversationId) => {
    if (!conversationId) return
    const ts = Date.now()
    persistLastReadAt(conversationId, ts)
    set((state) => ({
      lastReadAt: { ...state.lastReadAt, [conversationId]: ts },
    }))
  },
  removeConversationRead: (conversationId) => {
    if (!conversationId) return
    removeLastReadAt(conversationId)
    set((state) => {
      const next = { ...state.lastReadAt }
      delete next[conversationId]
      return { lastReadAt: next }
    })
  },
  // 两个右侧编辑器面板互斥:同位置(z-[80] 右侧滑出)叠加会互相遮挡,只保留最近打开的一个
  writePanelDocId: null,
  openWritePanel: (docId) =>
    set((state) => {
      const patch: Partial<ChatState> = { writePanelDocId: docId, codePanelDocId: null }
      // 首个面板打开且侧边栏展开中:折叠并记住(手动接管过则 prePanelSidebarOpen 已非 null,不重复记)
      if (state.prePanelSidebarOpen === null && state.sidebarOpen) {
        patch.prePanelSidebarOpen = true
        patch.sidebarOpen = false
      }
      return patch
    }),
  closeWritePanel: () =>
    set((state) => {
      const patch: Partial<ChatState> = { writePanelDocId: null }
      // 面板全关:恢复打开前的侧边栏状态
      if (state.prePanelSidebarOpen !== null) {
        patch.sidebarOpen = state.prePanelSidebarOpen
        patch.prePanelSidebarOpen = null
      }
      return patch
    }),
  editorFile: null,
  openEditor: (path, diff = false) => set({ editorFile: { path, diff }, sideTab: 'editor' }),
  closeEditor: () =>
    set((state) => ({
      editorFile: null,
      ...(state.sideTab === 'editor' ? { sideTab: 'preview' as const } : {}),
    })),
  codePanelOpen: false,
  codePanelDocId: null,
  openCodePanel: (docId) =>
    set((state) => {
      const patch: Partial<ChatState> = {
        codePanelOpen: true,
        codePanelDocId: docId ?? null,
        writePanelDocId: null,
        sideTab: 'code',
      }
      if (state.prePanelSidebarOpen === null && state.sidebarOpen) {
        patch.prePanelSidebarOpen = true
        patch.sidebarOpen = false
      }
      return patch
    }),
  closeCodePanel: () =>
    set((state) => {
      const patch: Partial<ChatState> = {
        codePanelOpen: false,
        codePanelDocId: null,
        codePendingDiff: null,
      }
      if (state.sideTab === 'code') patch.sideTab = 'preview'
      if (state.prePanelSidebarOpen !== null) {
        patch.sidebarOpen = state.prePanelSidebarOpen
        patch.prePanelSidebarOpen = null
      }
      return patch
    }),
  sideTab: 'preview',
  setSideTab: (t) => set({ sideTab: t }),
  // Side Pane 宽度:持久化,钳制 300~660
  sidePaneWidth:
    typeof window !== 'undefined'
      ? Math.min(660, Math.max(300, Number(localStorage.getItem('chat:sidePaneWidth')) || 420))
      : 420,
  setSidePaneWidth: (w) => {
    const clamped = Math.min(660, Math.max(300, Math.round(w)))
    if (typeof window !== 'undefined') {
      localStorage.setItem('chat:sidePaneWidth', String(clamped))
    }
    set({ sidePaneWidth: clamped })
  },
  codePendingDiff: null,
  setCodePendingDiff: (d) => set({ codePendingDiff: d }),
  previewErrors: null,
  pushPreviewError: (docId, text) =>
    set((state) => {
      // docId 变化=换文档渲染,旧缓冲直接丢弃;同文档追加(上限 50 条,防长刷爆内存)
      if (!state.previewErrors || state.previewErrors.docId !== docId) {
        return { previewErrors: { docId, items: [text] } }
      }
      if (state.previewErrors.items.length >= 50) return state
      return { previewErrors: { docId, items: [...state.previewErrors.items, text] } }
    }),
  clearPreviewErrors: (docId) =>
    set((state) => (state.previewErrors?.docId === docId ? { previewErrors: null } : state)),
  previewCheckRequest: null,
  beginPreviewCheck: (docId, resolve) => {
    // resolver 挂模块级 ref(函数不进 state,避免序列化/比较问题);state 只放触发信号
    previewCheckResolverRef.current = resolve
    set((state) => ({
      previewCheckRequest: { docId, nonce: (state.previewCheckRequest?.nonce ?? 0) + 1 },
      // 新一轮检查开始:清空上一轮错误缓冲,CodeEditor 从干净状态收集
      previewErrors: null,
    }))
  },
  finishPreviewCheck: (output) => {
    set({ previewCheckRequest: null })
    const resolve = previewCheckResolverRef.current
    previewCheckResolverRef.current = null
    resolve?.(output)
  },
  // 默认关(与旧行为一致=纯聊天);用户上次的选择在下次启动读回。
  // 仅桌面客户端显示入口,Web 端该值为 false 且不可改
  workMode: typeof window !== 'undefined' ? localStorage.getItem('chat:workMode') === 'true' : false,
  setWorkMode: (on) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('chat:workMode', String(on))
    }
    set({ workMode: on })
  },
  workFile: null,
  setWorkFile: (relPath) => set({ workFile: relPath }),
  workView: 'preview',
  setWorkView: (view) => set({ workView: view }),
  focusedMessageId: null,
  setFocusedMessageId: (id) => set({ focusedMessageId: id }),
  replyingTo: null,
  setReplyingTo: (msg) => set({ replyingTo: msg }),
  favoriteModels:
    typeof window !== 'undefined' ? loadStringArray('chat:favoriteModels') : [],
  toggleFavoriteModel: (modelId) =>
    set((state) => {
      const isFav = state.favoriteModels.includes(modelId)
      const next = isFav
        ? state.favoriteModels.filter((id) => id !== modelId)
        : [...state.favoriteModels, modelId]
      if (typeof window !== 'undefined') {
        localStorage.setItem('chat:favoriteModels', JSON.stringify(next))
      }
      return { favoriteModels: next }
    }),
  recentModels:
    typeof window !== 'undefined' ? loadStringArray('chat:recentModels') : [],
  recordModelUsage: (modelId) =>
    set((state) => {
      // 去掉已有,挪到头部
      const filtered = state.recentModels.filter((id) => id !== modelId)
      const next = [modelId, ...filtered].slice(0, MAX_RECENT_MODELS)
      if (typeof window !== 'undefined') {
        localStorage.setItem('chat:recentModels', JSON.stringify(next))
      }
      return { recentModels: next }
    }),
  modelSpecialSectionsCollapsed: { favorites: false, recent: false },
  toggleModelSpecialSection: (section) =>
    set((state) => ({
      modelSpecialSectionsCollapsed: {
        ...state.modelSpecialSectionsCollapsed,
        [section]: !state.modelSpecialSectionsCollapsed[section],
      },
    })),
})

/** 防止 Next.js dev 模式 HMR 重新执行 create() 破坏单例:
 *  在 globalThis 上缓存 store 实例,跨模块重载共享同一个 store.
 *  同时 SSR/CSR 各自持有一份实例,SSR 渲染结束即丢弃,不会泄漏到客户端 hydration. */
/** zustand 4:create<ChatState>(...) 返回的是 hook 形式(useBoundStore),也是 store API */
export type ChatStoreHook = UseBoundStore<StoreApi<ChatState>>

const globalForStore = globalThis as unknown as { __chatStore?: ChatStoreHook }

const created: ChatStoreHook = (globalForStore.__chatStore
  ?? (create<ChatState>(storeInitializer) as ChatStoreHook))

export const useChatStore: ChatStoreHook = created

if (typeof window !== 'undefined' && !globalForStore.__chatStore) {
  globalForStore.__chatStore = created
}
