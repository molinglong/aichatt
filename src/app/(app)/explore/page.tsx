'use client'

import { Scale, Loader2, Sparkles, ChevronRight } from 'lucide-react'
import { Suspense, useState, useCallback, useRef, useEffect } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { OpponentLane } from '@/components/explore/OpponentLane'
import { UserLane } from '@/components/explore/UserLane'
import { AssistantPanel } from '@/components/explore/AssistantPanel'
import { FactCheckModal } from '@/components/explore/FactCheckModal'
import { TruthSummary } from '@/components/explore/TruthSummary'
import { ModelSelector } from '@/components/explore/ModelSelector'
import type { SearchStructured } from '@/components/explore/SearchResults'
import type { ModelDefinition } from '@/lib/ai/types'
import { queryKeys, STALE } from '@/lib/query/keys'
import { fetchJson } from '@/lib/query/fetcher'
import { useFocusLock } from '@/lib/focus-lock-store'

// 辩题类型
interface Topic {
  id: string
  title: string
  description: string
  proLabel: string
  conLabel: string
}

// 默认辩题库
const DEFAULT_TOPICS: Topic[] = [
  {
    id: 'short-video',
    title: '短视频对青少年利大于弊',
    description: '讨论短视频对青少年学习、生活、认知的影响',
    proLabel: '正方：利大于弊',
    conLabel: '反方：弊大于利',
  },
  {
    id: 'ai-creativity',
    title: 'AI 创作能否超越人类创造力',
    description: '探讨人工智能在艺术、文学等创意领域的潜力',
    proLabel: '正方：AI 能超越',
    conLabel: '反方：AI 不能超越',
  },
  {
    id: 'social-media',
    title: '社交媒体让人更孤独',
    description: '分析社交媒体对人际关系和心理健康的影响',
    proLabel: '正方：让人更孤独',
    conLabel: '反方：让人更连接',
  },
]

// 发言类型
interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  citations?: Citation[]
  factCheckResult?: FactCheckResult
}

interface Citation {
  title: string
  url: string
  snippet: string
  source: 'google' | 'baidu'
}

interface FactCheckResult {
  claim: string
  status: 'verified' | 'disputed' | 'unverifiable' | 'false'
  details: string[]
  suggestion?: string
}

// 对手发言
interface OpponentMessage {
  id: string
  content: string
  timestamp: Date
}

// 当前状态
interface DebateState {
  topic: Topic | null
  userMessages: Message[]
  opponentMessages: OpponentMessage[]
  round: number
  status: 'idle' | 'user_turn' | 'opponent_turn' | 'finished'
  exhaustionDetected: boolean
}

const initialState: DebateState = {
  topic: null,
  userMessages: [],
  opponentMessages: [],
  round: 0,
  status: 'idle',
  exhaustionDetected: false,
}

export default function ExplorePage() {
  return (
    // Suspense 兜底:虽然 cache hit 时直接同步 render,
    // 但极端冷启场景下 useSuspenseQuery 仍会抛 promise → fallback
    <AuthErrorBoundary>
      <Suspense>
        <ClientOnly>
          <ExploreContent />
        </ClientOnly>
      </Suspense>
    </AuthErrorBoundary>
  )
}

function ExploreContent() {
  // ── 探索页专用的「可用模型」缓存 ──
  // 不能复用 queryKeys.providers():TopBar 预取写的是未过滤的原始列表,同 key 命中会
  // 把没 Key 的 GPT-5.5 当默认值(2026-11-20 上线前测试实测)。独立 key 避免互相污染。
  const { data: builtinModelsRaw = [] } = useSuspenseQuery<ModelDefinition[]>({
    queryKey: [...queryKeys.providers(), 'available'],
    queryFn: async () => {
      const payload = await fetchJson<
        | Array<{ effectiveModels: Array<ModelDefinition & { hasKey?: boolean; publicPool?: boolean }>; hasKey?: boolean }>
        | { providers: Array<{ effectiveModels: Array<ModelDefinition & { hasKey?: boolean; publicPool?: boolean }>; hasKey?: boolean }> }
      >('/api/providers')
      const list = Array.isArray(payload) ? payload : payload.providers ?? []
      // A15:只留「可用」模型——公共池门面(全员服务端出钱)或该 provider 配了 Key;
      // 否则内置目录里没 Key 的 GPT-5.5 之类会被当默认值展示,选了必挂。
      // publicPool 标志保留:ModelSelector 也靠它豁免「已配置 Key」过滤。
      return list.flatMap((p) =>
        (p.effectiveModels || [])
          .filter((m) => m.publicPool || p.hasKey || m.hasKey)
          .map((m) => ({ ...m, hasKey: undefined }))
      )
    },
    staleTime: STALE.providers,
  })
  const builtinModels = builtinModelsRaw

  const { data: customModels = [] } = useSuspenseQuery<ModelDefinition[]>({
    queryKey: queryKeys.customModels(),
    queryFn: async () => {
      const data = await fetchJson<ModelDefinition[] | { items?: ModelDefinition[] }>(
        '/api/custom-models'
      )
      return Array.isArray(data) ? data : data?.items ?? []
    },
    staleTime: STALE.customModels,
  })

  const userModelFromList = builtinModels[0]?.id || customModels[0]?.id || ''
  const opponentModelFromList = builtinModels[1]?.id || builtinModels[0]?.id || customModels[0]?.id || ''
  const [userModel, setUserModel] = useState(userModelFromList)
  const [opponentModel, setOpponentModel] = useState(opponentModelFromList)
  const [assistantModel, setAssistantModel] = useState(userModelFromList)

  // 模型列表数据 refresh 后,如果当前选中的 model 已被移除/不存在,回退到默认。
  // 这里用 useEffect 而不是 useState updater,因为我们只在新数据进入时同步。
  useEffect(() => {
    const all = [...builtinModels, ...customModels]
    if (all.length === 0) return
    if (!all.some((m) => m.id === userModel)) {
      setUserModel(all[0]?.id ?? '')
    }
    if (!all.some((m) => m.id === opponentModel)) {
      setOpponentModel(all[1]?.id ?? all[0]?.id ?? '')
    }
    if (!all.some((m) => m.id === assistantModel)) {
      setAssistantModel(all[0]?.id ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtinModels, customModels])

  const allModels = [...builtinModels, ...customModels]
  const availableModels = allModels.length > 0 ? allModels : []

  const [state, setState] = useState<DebateState>(initialState)
  const [customTopic, setCustomTopic] = useState('')
  const [showTopicSelector, setShowTopicSelector] = useState(true)
  const [factCheckTarget, setFactCheckTarget] = useState<{
    content: string
    role: 'user' | 'opponent'
    messageId: string
  } | null>(null)
  const [showSummary, setShowSummary] = useState(false)
  const [searchingEvidence, setSearchingEvidence] = useState(false)
  const [evidenceResults, setEvidenceResults] = useState<string | null>(null)
  const [evidenceStructured, setEvidenceStructured] = useState<SearchStructured | null>(null)
  const [assistantAnalysis, setAssistantAnalysis] = useState<string | null>(null)

  // 监管模式锁内门槛(2026-11-18 C 案挑稿,接 focus-lock-restrict R1):辩论锁内暂停。
  // 放 hooks 尾部、条件 return 之前——组件不卸载,辩论 state 全保留,解锁原地恢复。
  const { locked: focusLocked } = useFocusLock()

  const messageListRef = useRef<HTMLDivElement>(null)

  // 消息历史用 ref 持有,避免 callback 依赖 state.userMessages/opponentMessages
  // (否则每次发消息引用都变,导致 <UserLane> 子树被卸载重建,润色预览/草稿丢失)
  // 注意:赋值必须放在 useEffect 里,不能在 render 体内直接 stateRef.current = state,
  // 后者会让 React 看到 hook 输入每次都不同,触发并发渲染下的级联更新。
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // 标记对手请求是否正在进行:防止异常路径下用户连发导致重复请求 + 状态机紊乱
  const opponentInFlightRef = useRef(false)

  // 自动滚动到底部
  // 列表最新在上: 当新消息加入时, 把 scrollTop 设为 0 滚到顶部
  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = 0
    }
  }, [state.userMessages, state.opponentMessages])

  // 选择辩题
  const handleSelectTopic = useCallback(async (topic: Topic | 'custom') => {
    if (topic === 'custom') {
      if (!customTopic.trim()) return
      const newTopic: Topic = {
        id: 'custom-' + Date.now(),
        title: customTopic,
        description: '自定义辩题',
        proLabel: '正方',
        conLabel: '反方',
      }
      setState(prev => ({ ...prev, topic: newTopic }))
    } else {
      setState(prev => ({ ...prev, topic }))
    }
    setShowTopicSelector(false)

    // 对手发表第一轮观点
    await generateOpponentMessage(topic === 'custom' ? customTopic : topic.title)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customTopic, opponentModel])

  // 生成对手发言:不依赖 state.userMessages/opponentMessages,改从 stateRef 读取
  // deps 稳定 → handleSelectTopic/handleSendMessage 引用稳定 → UserLane 不被重建
  const generateOpponentMessage = useCallback(async (topicTitle: string) => {
    // 防止重复请求:同一时刻只允许一个对手发言请求
    if (opponentInFlightRef.current) return
    opponentInFlightRef.current = true
    setState(prev => ({ ...prev, status: 'opponent_turn' }))

    try {
      const snapshot = stateRef.current
      const res = await fetch('/api/explore/opponent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topicTitle,
          model: opponentModel,
          conversationHistory: snapshot.userMessages.map(m => ({
            role: 'user',
            content: m.content,
          })),
          opponentHistory: snapshot.opponentMessages.map(m => ({
            role: 'assistant',
            content: m.content,
          })),
        }),
      })

      if (!res.ok) throw new Error('生成对手发言失败')

      const data = await res.json()
      const opponentMsg: OpponentMessage = {
        id: `opp-${Date.now()}`,
        content: data.content,
        timestamp: new Date(),
      }

      setState(prev => ({
        ...prev,
        opponentMessages: [...prev.opponentMessages, opponentMsg],
        round: prev.round + 1,
        status: 'user_turn',
      }))
    } catch (err) {
      console.error('Failed to generate opponent message:', err)
      // 失败时切回 user_turn,让用户能重发或换模型
      setState(prev =>
        prev.status === 'opponent_turn' ? { ...prev, status: 'user_turn' } : prev
      )
    } finally {
      opponentInFlightRef.current = false
    }
  }, [opponentModel])

  // 用户发送消息:同样从 stateRef 读取 topic,deps 只保留 generateOpponentMessage
  const handleSendMessage = useCallback(async (content: string) => {
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date(),
    }

    setState(prev => ({
      ...prev,
      userMessages: [...prev.userMessages, userMsg],
      status: 'opponent_turn',
    }))

    // 清空助手分析
    setAssistantAnalysis(null)
    setEvidenceResults(null)
    setEvidenceStructured(null)

    // 对手回应:传最新 topic(避免用 ref 拿到闭包旧值)
    const topicTitle = stateRef.current.topic?.title || ''
    await generateOpponentMessage(topicTitle)
  }, [generateOpponentMessage])

  // 搜索论据
  const handleSearchEvidence = useCallback(async (query: string) => {
    if (!query.trim()) return
    setSearchingEvidence(true)
    setEvidenceResults(null)
    setEvidenceStructured(null)

    try {
      const res = await fetch('/api/explore/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '搜索失败')

      setEvidenceStructured(data.structured ?? null)
      setEvidenceResults(data.results ?? null)
    } catch (err) {
      console.error('Failed to search evidence:', err)
      setEvidenceStructured(null)
      setEvidenceResults('搜索失败：' + (err instanceof Error ? err.message : '请稍后重试'))
    } finally {
      setSearchingEvidence(false)
    }
  }, [])

  // 助手分析
  const handleAssistantAnalysis = useCallback(async (content: string) => {
    setAssistantAnalysis('分析中...')

    try {
      const res = await fetch('/api/explore/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'logic',
          content,
          topic: state.topic?.title,
          model: assistantModel,
          conversationHistory: [
            ...state.opponentMessages.map(m => ({ role: 'assistant', content: m.content })),
            ...state.userMessages.map(m => ({ role: 'user', content: m.content })),
          ],
        }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '分析失败')

      setAssistantAnalysis(data.analysis)
    } catch (err) {
      console.error('Failed to analyze:', err)
      setAssistantAnalysis('分析失败：' + (err instanceof Error ? err.message : '请稍后重试'))
    }
  }, [assistantModel, state.topic, state.opponentMessages, state.userMessages])

  // 事实核查
  const handleFactCheck = useCallback(async (content: string, role: 'user' | 'opponent', messageId: string) => {
    setFactCheckTarget({ content, role, messageId })
  }, [])

  // 润色发言
  const handlePolishText = useCallback(async (content: string): Promise<string> => {
    try {
      const res = await fetch('/api/explore/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          topic: state.topic?.title,
          model: assistantModel,
        }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '润色失败')

      return data.polished
    } catch (err) {
      console.error('Failed to polish:', err)
      return content
    }
  }, [assistantModel, state.topic])

  // 草稿润色（输入框内）: 调用助手API的 polish 类型, 结果自动填回输入框
  const [draftPolished, setDraftPolished] = useState<string | null>(null)
  const [isDraftPolishing, setIsDraftPolishing] = useState(false)

  const handleDraftPolish = useCallback(async (content: string): Promise<string> => {
    setIsDraftPolishing(true)
    try {
      const res = await fetch('/api/explore/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'polish',
          content,
          topic: state.topic?.title,
          model: assistantModel,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '润色失败')
      const polished = (data.analysis || '').trim()
      if (polished && polished !== content) {
        setDraftPolished(polished)
      }
      return polished || content
    } catch (err) {
      console.error('Draft polish failed:', err)
      return content
    } finally {
      setIsDraftPolishing(false)
    }
  }, [assistantModel, state.topic])

  const handleDraftFactCheck = useCallback((content: string) => {
    // 用事实核查 modal, role=user 表示是用户自己的草稿
    setFactCheckTarget({ content, role: 'user', messageId: '__draft__' })
  }, [])

  // 结束辩论
  const handleFinishDebate = useCallback(() => {
    setShowSummary(true)
    setState(prev => ({ ...prev, status: 'finished' }))
  }, [])

  // 重置
  const handleReset = useCallback(() => {
    setState(initialState)
    setShowTopicSelector(true)
    setShowSummary(false)
    setFactCheckTarget(null)
    setAssistantAnalysis(null)
    setEvidenceResults(null)
    setEvidenceStructured(null)
  }, [])

  // 新辩题
  const handleNewTopic = useCallback(() => {
    handleReset()
  }, [handleReset])

  // ── 监管模式锁内门槛:整页换黄油纸卡 + 小鸡(绘本主题与 FocusLock 同款色,
  //    纸卡恒黄油色不随深浅翻转;正在进行的辩题回合解锁后原地恢复)──────────
  if (focusLocked) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <div className="relative w-full max-w-[400px] rounded-[18px] border-[2.5px] border-[#e8d98a] bg-[#fff6c9] px-7 pt-9 pb-6 text-center shadow-[0_10px_28px_rgba(120,90,10,0.18)]">
          {/* 胶带 */}
          <div
            aria-hidden
            className="absolute -top-3 left-1/2 h-[22px] w-[88px] -translate-x-1/2 -rotate-2 rounded-[3px] border border-dashed border-[#b4a050]/50 bg-white/55"
          />
          {/* 小鸡蹲守 + 铅笔虚线地平线 */}
          <svg className="mx-auto" width="130" height="86" viewBox="0 0 130 86" aria-hidden>
            <line x1="10" y1="74" x2="120" y2="74" stroke="#c9b96a" strokeWidth="2.6" strokeDasharray="8 7" strokeLinecap="round" />
            <circle cx="66" cy="54" r="17" fill="#ffd75e" />
            <path d="M66 33 q9 3 7 12" fill="none" stroke="#e0b83a" strokeWidth="2.4" strokeLinecap="round" />
            <circle cx="60" cy="50" r="2.3" fill="#4a3f1e" />
            <circle cx="71" cy="50" r="2.3" fill="#4a3f1e" />
            <path d="M62 56 l4.5 3.4 4.5-3.4" fill="none" stroke="#e0862a" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M49 58 q-7 1 -8 6" fill="none" stroke="#e0b83a" strokeWidth="2.4" strokeLinecap="round" />
            <path d="M60 71 l-2.5 5 M72 71 l2.5 5" stroke="#c9902a" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          <div className="text-[20px] font-extrabold tracking-wider text-[#4a3f1e]">专注锁定中</div>
          <p className="mt-2 text-[13px] leading-7 text-[#6b5c2e]">
            辩论先歇一歇,小鸡帮你看着时间 ——
            <br />
            到点就回来,辩题进度不会丢。
          </p>
          <div className="mt-3.5 text-[11.5px] text-[#8a7a44]">观点探索 · 锁定期间暂停</div>
        </div>
      </div>
    )
  }

  // 辩题选择界面
  if (showTopicSelector) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <div className="w-full max-w-2xl">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-4">
              <Scale className="w-8 h-8 text-accent" />
            </div>
            <h1 className="text-2xl font-bold mb-2">观点探索</h1>
            <p className="text-content-secondary">选择一个辩题，与 AI 对手展开辩论</p>
          </div>

          {/* 模型选择 */}
          <div className="mb-6 p-4 rounded-xl bg-surface-muted border border-line/60">
            <div className="text-xs text-content-muted mb-3 font-medium">模型配置</div>
            {/* 小屏单列避免模型选择器被压到 ~140px;sm 起恢复双列 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-content-secondary mb-1 block">你的模型</label>
                <ModelSelector
                  models={availableModels}
                  value={userModel}
                  onChange={setUserModel}
                />
              </div>
              <div>
                <label className="text-[11px] text-content-secondary mb-1 block">对手模型</label>
                <ModelSelector
                  models={availableModels}
                  value={opponentModel}
                  onChange={setOpponentModel}
                />
              </div>
              <div className="col-span-2">
                <label className="text-[11px] text-content-secondary mb-1 block">助手模型</label>
                <ModelSelector
                  models={availableModels}
                  value={assistantModel}
                  onChange={setAssistantModel}
                />
              </div>
            </div>
          </div>

          {/* 辩题列表 */}
          <div className="space-y-3">
            {DEFAULT_TOPICS.map((topic) => (
              <button
                key={topic.id}
                onClick={() => handleSelectTopic(topic)}
                className="w-full p-4 rounded-xl border border-line/60 bg-surface hover:bg-surface-subtle hover:border-accent/40 transition-all text-left group"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-medium mb-1 group-hover:text-accent transition-colors">
                      {topic.title}
                    </h3>
                    <p className="text-sm text-content-secondary">{topic.description}</p>
                    <div className="flex items-center gap-3 mt-2 text-xs text-content-muted">
                      <span className="text-emerald-600 dark:text-emerald-400">{topic.proLabel}</span>
                      <ChevronRight className="w-3 h-3" />
                      <span className="text-red-600 dark:text-red-400">{topic.conLabel}</span>
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-content-muted group-hover:text-accent transition-colors" />
                </div>
              </button>
            ))}

            {/* 自定义辩题 */}
            <div className="p-4 rounded-xl border border-line/60 bg-surface">
              <div className="text-sm font-medium mb-2">自定义辩题</div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customTopic}
                  onChange={(e) => setCustomTopic(e.target.value)}
                  placeholder="输入你的辩题..."
                  className="flex-1 px-3 py-2 rounded-lg bg-surface-muted border border-line/60 text-sm placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customTopic.trim()) {
                      handleSelectTopic('custom')
                    }
                  }}
                />
                <button
                  onClick={() => handleSelectTopic('custom')}
                  disabled={!customTopic.trim()}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    customTopic.trim()
                      ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
                      : 'bg-surface-muted text-content-muted cursor-not-allowed'
                  )}
                >
                  开始
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // 真相摘要界面
  if (showSummary && state.topic) {
    return (
      <div className="h-full overflow-y-auto">
        <TruthSummary
          topic={state.topic}
          userMessages={state.userMessages}
          opponentMessages={state.opponentMessages}
          onNewTopic={handleNewTopic}
          onBack={() => {
            setShowSummary(false)
            setState(prev => ({ ...prev, status: 'user_turn' }))
          }}
        />
      </div>
    )
  }

  // 辩论主界面
  return (
    <div className="h-full flex flex-col">
      {/* 顶部栏(data-tauri-drag-region="deep":客户端下即本页「标题栏」,
          deep = 整块(含标题文字/图标)按下都能拖窗,双击转最大化;
          右侧按钮等可点元素由 Tauri 脚本自动排除,照旧可点) */}
      <div
        data-tauri-drag-region="deep"
        className="shrink-0 px-4 py-2 border-b border-line/60 flex items-center justify-between"
      >
        <div className="flex items-center gap-3">
          <Scale className="w-4 h-4 text-accent" />
          <div>
            <div className="text-sm font-medium">{state.topic?.title}</div>
            <div className="text-xs text-content-muted">
              第 {state.round} 轮 · 
              <span className={cn(
                'ml-1',
                state.status === 'user_turn' && 'text-emerald-500',
                state.status === 'opponent_turn' && 'text-amber-500',
              )}>
                {state.status === 'user_turn' ? '请发表你的观点' : '对手思考中...'}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleFinishDebate}
            disabled={state.userMessages.length === 0}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-muted hover:bg-surface-subtle border border-line/60 transition-colors disabled:opacity-50"
          >
            真相摘要
          </button>
          <button
            onClick={handleNewTopic}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-muted hover:bg-surface-subtle border border-line/60 transition-colors"
          >
            新辩题
          </button>
        </div>
      </div>

      {/* 模型选择栏（可折叠） */}
      <div className="shrink-0 px-4 py-2 bg-surface-muted/50 border-b border-line/40 flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-content-muted">你的模型:</span>
          <ModelSelector
            models={availableModels}
            value={userModel}
            onChange={setUserModel}
            compact
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-content-muted">对手模型:</span>
          <ModelSelector
            models={availableModels}
            value={opponentModel}
            onChange={setOpponentModel}
            compact
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-content-muted">助手模型:</span>
          <ModelSelector
            models={availableModels}
            value={assistantModel}
            onChange={setAssistantModel}
            compact
          />
        </div>
      </div>

      {/* 对手泳道（只读） */}
      <OpponentLane
        messages={state.opponentMessages}
        isLoading={state.status === 'opponent_turn'}
        onFactCheck={(content, id) => handleFactCheck(content, 'opponent', id)}
      />

      {/* 分隔线 */}
      <div className="shrink-0 px-4 py-1 flex items-center gap-2 bg-surface-muted/30">
        <div className="flex-1 h-px bg-line/40" />
        <span className="text-[10px] text-content-muted uppercase tracking-wider">你的发言</span>
        <div className="flex-1 h-px bg-line/40" />
      </div>

      {/* 用户泳道 + 助手面板 —— 移动端垂直堆叠,桌面端横向并排 */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0">
        {/* 用户泳道 */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden min-h-[200px] md:min-h-0">
          <UserLane
            messages={state.userMessages}
            onSend={handleSendMessage}
            onPolish={handlePolishText}
            onFactCheck={(content, id) => handleFactCheck(content, 'user', id)}
            disabled={state.status !== 'user_turn'}
            isPolishing={false}
            onDraftPolish={handleDraftPolish}
            onDraftFactCheck={handleDraftFactCheck}
            isDraftPolishing={isDraftPolishing}
            draftPolished={draftPolished}
            onDiscardDraftPolished={() => setDraftPolished(null)}
          />
        </div>

        {/* 助手面板 */}
        <AssistantPanel
          topic={state.topic?.title}
          userMessage={state.userMessages[state.userMessages.length - 1]?.content}
          opponentMessage={state.opponentMessages[state.opponentMessages.length - 1]?.content}
          onSearch={handleSearchEvidence}
          onAnalyze={handleAssistantAnalysis}
          searching={searchingEvidence}
          analysis={assistantAnalysis}
          evidenceResults={evidenceResults}
          evidenceStructured={evidenceStructured}
        />
      </div>

      {/* 事实核查弹窗 */}
      {factCheckTarget && (
        <FactCheckModal
          content={factCheckTarget.content}
          role={factCheckTarget.role}
          topic={state.topic?.title}
          onClose={() => setFactCheckTarget(null)}
        />
      )}
    </div>
  )
}
