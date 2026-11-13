'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import type { UIMessage } from 'ai'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/store/chat-store'
import type { ModelDefinition } from '@/lib/ai/types'
import type { Attachment } from './FileUpload'
import { CompareLane, type LaneApi } from './CompareLane'
import { ChatInput } from './ChatInput'
import { PROVIDER_DOT } from './ModelSelector'
import { toast } from '@/lib/toast'

const COMPARE_MODELS_STORAGE_KEY = 'chat:compareModels'

/** E 对比模式投票: 最新一轮投票(高亮胜出泳道) */
interface CompareVoteInfo {
  groupId: string
  votedModel: string
}

interface ComparePanelProps {
  conversationId?: string
  /** 每个泳道的初始消息(与 compareModels 对齐) */
  initialLaneMessages: UIMessage[][]
  /** 初始对比模型(来自 DB 或默认值) */
  initialCompareModels: string[]
  allModels: ModelDefinition[]
  stylePreset: string
  /** 面具 id(对比模式下所有泳道共享) */
  maskId: string | null
  deepThink: boolean
  onDeepThinkChange: (enabled: boolean) => void
  /** 联网搜索(对比模式下所有泳道共享一个开关) */
  webSearch: boolean
  onWebSearchChange: (enabled: boolean) => void
  webSearchAvailable: boolean
  /** 关闭对比模式(仅新对话时可关闭,由父级提供) */
  onCompareModeChange?: (enabled: boolean) => void
  compareModeAvailable?: boolean
  /** 会话创建后通知父级(用于隐藏切换开关) */
  onConversationCreated?: (convId: string) => void
  /** E 对比模式投票: 会话已保存的最新一轮投票(回显高亮用) */
  initialVote?: CompareVoteInfo | null
}

export function ComparePanel({
  conversationId: initialConversationId,
  initialLaneMessages,
  initialCompareModels,
  allModels,
  stylePreset,
  maskId,
  deepThink,
  onDeepThinkChange,
  webSearch,
  onWebSearchChange,
  webSearchAvailable,
  onCompareModeChange,
  compareModeAvailable,
  onConversationCreated,
  initialVote,
}: ComparePanelProps) {
  const [compareModels, setCompareModels] = useState<string[]>(initialCompareModels)
  const [latestVote, setLatestVote] = useState<CompareVoteInfo | null>(initialVote ?? null)
  const [anyLoading, setAnyLoading] = useState(false)
  // 单独继续聊天: 弹窗选中的泳道模型,确认后转换/克隆
  const [soloModelId, setSoloModelId] = useState<string | null>(null)
  const [converting, setConverting] = useState(false)
  // 移动端泳道 Tab: 当前查看的泳道模型(桌面端并排显示,移动端切单泳道)
  const [mobileLaneModelId, setMobileLaneModelId] = useState<string | null>(null)
  // 移动端 Tab 流式指示: 正在生成的模型集合(loadingStates ref 的可渲染镜像)
  const [loadingModelIds, setLoadingModelIds] = useState<ReadonlySet<string>>(new Set())

  // 共享 ref
  const conversationIdRef = useRef<string | null>(initialConversationId ?? null)
  const groupIdRef = useRef<string>('')
  const laneApis = useRef<Map<string, LaneApi>>(new Map())
  const loadingStates = useRef<Map<string, boolean>>(new Map())
  const compareModelsRef = useRef(compareModels)

  const setCurrentConversationId = useChatStore((s) => s.setCurrentConversationId)
  const setConversationTitle = useChatStore((s) => s.setConversationTitle)
  const bumpConversationVersion = useChatStore((s) => s.bumpConversationVersion)

  // 同步模型列表 ref —— 必须在 useEffect 里写,不能在 render 体直接写 .current,
  // 否则 React 18 并发渲染下会触发 Maximum update depth exceeded 错误。
  useEffect(() => {
    compareModelsRef.current = compareModels
  }, [compareModels])

  // 同步会话到全局 store(侧边栏)
  useEffect(() => {
    setCurrentConversationId(initialConversationId ?? null)
  }, [initialConversationId, setCurrentConversationId])

  const handleConvIdFromHeader = useCallback(
    (newConvId: string, newConvTitle?: string | null) => {
      if (newConvId && newConvId !== conversationIdRef.current) {
        const isNew = conversationIdRef.current === null
        conversationIdRef.current = newConvId
        setCurrentConversationId(newConvId)
        if (isNew) bumpConversationVersion() // 服务端兜底建会话,通知侧边栏刷新
        if (newConvTitle) {
          setConversationTitle(decodeURIComponent(newConvTitle))
        }
        window.history.replaceState(null, '', `/chat/c/${newConvId}`)
        if (isNew) onConversationCreated?.(newConvId)
      }
    },
    [setCurrentConversationId, setConversationTitle, bumpConversationVersion, onConversationCreated]
  )

  const registerApi = useCallback((modelId: string, api: LaneApi | null) => {
    if (api) {
      laneApis.current.set(modelId, api)
    } else {
      laneApis.current.delete(modelId)
    }
  }, [])

  const handleLoadingChange = useCallback((modelId: string, isLoading: boolean) => {
    loadingStates.current.set(modelId, isLoading)
    setAnyLoading(Array.from(loadingStates.current.values()).some(Boolean))
    // 同步到 state,供移动端泳道 Tab 显示流式指示
    setLoadingModelIds((prev) => {
      const next = new Set(prev)
      if (isLoading) next.add(modelId)
      else next.delete(modelId)
      return next
    })
  }, [])

  // 首轮发送前先创建对比会话,规避 N 个并发请求各自建会话的竞态
  const handleSend = useCallback(
    async (text: string, attachments?: Attachment[]) => {
      let convId = conversationIdRef.current
      if (!convId) {
        try {
          const res = await fetch('/api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: text.slice(0, 40) || '新对话',
              model: compareModelsRef.current[0],
              stylePreset,
              replyLength: useChatStore.getState().conversationReplyLength,
              maskId,
              mode: 'compare',
              compareModels: compareModelsRef.current,
            }),
          })
          if (res.ok) {
            const conv = await res.json()
            convId = conv.id
            conversationIdRef.current = conv.id
            setCurrentConversationId(conv.id)
            bumpConversationVersion() // 预创建成功,通知侧边栏刷新
            if (conv.title) {
              setConversationTitle(conv.title)
            }
            window.history.replaceState(null, '', `/chat/c/${conv.id}`)
            onConversationCreated?.(conv.id)
          }
        } catch (err) {
          // 预创建失败时由服务端兜底创建(响应头回调会同步 id)
          console.error('Failed to pre-create compare conversation:', err)
        }
      }
      groupIdRef.current = crypto.randomUUID()
      // 把 attachments 直接传给每个泳道 —— 不再用共享 ref,避免后调用的泳道读到的已被清空
      for (const modelId of compareModelsRef.current) {
        laneApis.current.get(modelId)?.send(text, attachments)
      }
    },
    [stylePreset, maskId, setCurrentConversationId, setConversationTitle, bumpConversationVersion, onConversationCreated]
  )

  const handleStop = useCallback(() => {
    // 生成已与客户端连接解耦:断连不再等于停止,必须显式通知服务端中止,
    // 否则各泳道会在后台继续跑完并落库(对比模式一次会停掉该会话的所有在途流)。
    const convId = conversationIdRef.current
    if (convId) {
      fetch(`/api/conversations/${convId}/finalize-draft`, { method: 'POST' }).catch(() => {})
    }
    laneApis.current.forEach((api) => api.stop())
  }, [])

  // E 对比模式投票: 服务端按 modelId 反查最新轮 groupId,前端无需感知
  const handleVote = useCallback(async (modelId: string) => {
    const convId = conversationIdRef.current
    if (!convId) return
    try {
      const res = await fetch(`/api/conversations/${convId}/compare-vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '投票失败')
      setLatestVote({ groupId: data.groupId, votedModel: data.votedModel })
      toast.success('已记录你的选择', { title: '对比投票' })
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '投票失败,请重试')
    }
  }, [])

  const handleCompareModelsChange = useCallback(
    (models: string[]) => {
      setCompareModels(models)
      localStorage.setItem(COMPARE_MODELS_STORAGE_KEY, JSON.stringify(models))
      // 已有会话时同步到 DB
      const convId = conversationIdRef.current
      if (convId) {
        fetch(`/api/conversations/${convId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ compareModels: models }),
        }).catch((err) => console.error('Failed to persist compare models:', err))
      }
    },
    []
  )

  // 原地转换: 当前会话转为与所选模型的单聊,刷新后由服务端渲染单聊视图
  const handleConvertInPlace = useCallback(async () => {
    const convId = conversationIdRef.current
    if (!soloModelId || !convId) return
    setConverting(true)
    try {
      const res = await fetch(`/api/conversations/${convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'single', model: soloModelId }),
      })
      if (!res.ok) throw new Error('Convert failed')
      window.location.href = `/chat/c/${convId}`
    } catch (err) {
      console.error('Failed to convert to single chat:', err)
      toast.error('转换失败，请重试')
      setConverting(false)
    }
  }, [soloModelId])

  // 另存为新对话: 克隆用户消息 + 所选模型回答到新会话,保留原对比会话
  const handleCloneAsNew = useCallback(async () => {
    const convId = conversationIdRef.current
    if (!soloModelId || !convId) return
    setConverting(true)
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloneFrom: convId, model: soloModelId }),
      })
      if (!res.ok) throw new Error('Clone failed')
      const conv = await res.json()
      window.location.href = `/chat/c/${conv.id}`
    } catch (err) {
      console.error('Failed to clone conversation:', err)
      toast.error('创建新会话失败，请重试')
      setConverting(false)
    }
  }, [soloModelId])

  // 移动端激活泳道: 未手动选过时回落第一条;模型被移除后自动回落,避免越界空白
  const activeLaneModelId =
    mobileLaneModelId && compareModels.includes(mobileLaneModelId)
      ? mobileLaneModelId
      : compareModels[0]

  const soloModelDef = soloModelId ? allModels.find((m) => m.id === soloModelId) : undefined

  return (
    <div className="flex flex-col h-full relative overflow-hidden">
      {/* 移动端泳道 Tab 栏: 并排泳道在窄屏放不下,降级为单泳道+模型胶囊切换 */}
      <div className="md:hidden flex items-center gap-1.5 px-3 pt-2 pb-1.5 overflow-x-auto shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {compareModels.map((modelId) => {
          const modelDef = allModels.find((m) => m.id === modelId)
          const isActive = modelId === activeLaneModelId
          const isLoading = loadingModelIds.has(modelId)
          return (
            <button
              key={modelId}
              type="button"
              onClick={() => setMobileLaneModelId(modelId)}
              className={cn(
                'flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-full border text-xs whitespace-nowrap transition-colors active:scale-95 touch-manipulation',
                isActive
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-line/60 text-content-secondary hover:bg-surface-subtle'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  modelDef ? (PROVIDER_DOT[modelDef.provider] ?? 'bg-content-muted') : 'bg-content-muted',
                  isLoading && 'animate-pulse'
                )}
              />
              {modelDef?.name ?? modelId}
            </button>
          )
        })}
      </div>

      {/* Messages area: 桌面端 N 泳道并排;移动端单泳道 */}
      {/* 显式行 minmax(0,1fr) 让泳道高度撑满容器,否则隐式 auto 行高会按内容撑开导致内部无法滚动 */}
      {/* 移动端未激活泳道用 display:none 隐藏而非卸载 —— CompareLane 持有消息/流式状态,卸载即丢 */}
      <div className="flex-1 min-h-0 overflow-hidden md:grid md:grid-flow-col md:auto-cols-fr md:grid-rows-[minmax(0,1fr)]">
        {compareModels.map((modelId, index) => {
          const modelDef = allModels.find((m) => m.id === modelId)
          return (
            <div
              key={modelId}
              className={cn(
                'h-full min-w-0 border-line/60',
                index < compareModels.length - 1 && 'md:border-r',
                modelId !== activeLaneModelId && 'hidden md:block'
              )}
            >
              {modelDef ? (
                <CompareLane
                  modelId={modelId}
                  modelDef={modelDef}
                  initialMessages={initialLaneMessages[index] ?? []}
                  conversationIdRef={conversationIdRef}
                  groupIdRef={groupIdRef}
                  stylePreset={stylePreset}
                  maskId={maskId}
                  deepThink={deepThink}
                  webSearch={webSearch}
                  onConvIdFromHeader={handleConvIdFromHeader}
                  registerApi={(api) => registerApi(modelId, api)}
                  onLoadingChange={(loading) => handleLoadingChange(modelId, loading)}
                  onRequestSolo={setSoloModelId}
                  isVoted={latestVote?.votedModel === modelId}
                  onVote={handleVote}
                />
              ) : (
                <div className="h-full flex items-center justify-center px-4">
                  <p className="text-xs text-content-muted text-center">模型不可用</p>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Input area - fixed at bottom */}
      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        isLoading={anyLoading}
        models={allModels}
        selectedModel={compareModels[0] ?? ''}
        onModelChange={() => {}}
        deepThink={deepThink}
        onDeepThinkChange={onDeepThinkChange}
        webSearch={webSearch}
        onWebSearchChange={onWebSearchChange}
        webSearchAvailable={webSearchAvailable}
        compareMode
        compareModeAvailable={compareModeAvailable}
        onCompareModeChange={onCompareModeChange}
        compareModels={compareModels}
        onCompareModelsChange={handleCompareModelsChange}
      />

      {/* 单独继续聊天弹窗: 原地转换 / 另存为新对话 */}
      {soloModelId && soloModelDef && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-[12px] saturate-150 dark:bg-white/15 dark:saturate-150"
            onClick={() => !converting && setSoloModelId(null)}
          />
          <div className="confirm-card-in relative w-[360px] max-w-[90vw] rounded-2xl border border-line/60 bg-surface p-5 shadow-2xl">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'w-2 h-2 rounded-full shrink-0',
                  PROVIDER_DOT[soloModelDef.provider] ?? 'bg-content-muted'
                )}
              />
              <h3 className="text-sm font-semibold text-content-primary truncate">
                与 {soloModelDef.name} 单独继续聊天
              </h3>
            </div>
            <p className="mt-2 text-xs text-content-secondary leading-relaxed">
              将带着当前对话上下文与该模型继续，请选择方式：
            </p>
            <div className="mt-4 space-y-2">
              <button
                onClick={handleConvertInPlace}
                disabled={converting}
                className="w-full text-left rounded-xl border border-line/60 bg-surface/60 hover:bg-surface-subtle hover:border-accent/50 px-3.5 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="block text-xs font-semibold text-content-primary">原地转换</span>
                <span className="block mt-0.5 text-[11px] text-content-secondary leading-relaxed">
                  当前会话直接转为单聊，其他模型的回答将被隐藏（数据仍保留在库中）
                </span>
              </button>
              <button
                onClick={handleCloneAsNew}
                disabled={converting}
                className="w-full text-left rounded-xl border border-line/60 bg-surface/60 hover:bg-surface-subtle hover:border-accent/50 px-3.5 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="block text-xs font-semibold text-content-primary">另存为新对话</span>
                <span className="block mt-0.5 text-[11px] text-content-secondary leading-relaxed">
                  保留原对比会话，复制「用户消息 + 该模型回答」到新会话继续
                </span>
              </button>
            </div>
            <button
              onClick={() => setSoloModelId(null)}
              disabled={converting}
              className="mt-3 w-full py-2 rounded-lg text-xs text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
