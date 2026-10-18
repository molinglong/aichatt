'use client'

import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { useRenderProbe } from '@/lib/client-diagnostics'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MessageBubble } from './MessageBubble'
import { useChatStore } from '@/store/chat-store'
import {
  estimateMessageHeight,
  isListFollowing,
  messageHeightStore,
  registerListScrollFacade,
  type ListScrollFacade,
} from './chat-list-bridge'
import type { UIMessage } from 'ai'

/** 保活预算:已访问过的消息最多保留这么多条挂载(离当前窗口最远的先淘汰) */
const KEEP_MAX = 80

interface MessageListProps {
  messages: UIMessage[]
  isStreaming: boolean
  className?: string
  onRegenerate?: () => void
  /** 「保存并重答」:归档该消息及其后续后以新文本重发 */
  onEditMessage?: (messageId: string, newText: string) => void | Promise<void>
  /** 澄清问答:提交回答文本(通常接 ChatPanel 的 handleSend,复用排队/发送全链路) */
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
  /** 请求已提交但模型首 token 未到(useChat submitted 阶段)——列表末尾渲染"生成中"占位 */
  isPending?: boolean
  /**
   * 虚拟化开关(仅 ChatPanel 单聊路径传 true):只挂载视口附近的 MessageBubble,
   * 长会话 DOM 规模从「全会话常驻」降为「视口 + overscan」。CompareLane 泳道不传,
   * 走原渲染分支。useVirtualizer 每个滚动帧都会触发所属组件重渲染,所以虚拟化
   * 必须收在 MessageList 这一层 —— 每帧 reconcile 的只有 memo 过的气泡和 sized div,
   * ChatPanel 完全不参与滚动期渲染。
   */
  virtualized?: boolean
  /** 虚拟化的滚动容器(ChatPanel 的 messagesScrollEl,与 OutlineSidebar 同源) */
  scrollElement?: HTMLDivElement | null
  /** 首屏分页:存在未下发的更早消息时渲染顶部"查看更早"入口(仅滚动容器内,in-flow) */
  hasEarlier?: boolean
  /** 更早消息剩余条数(未知时不显示数字) */
  earlierCount?: number
  /** 更早页拉取中:按钮换成转圈并禁用重复点击 */
  earlierLoading?: boolean
  /** 更早页前插后要复位的那条消息(id + 距容器顶像素 + 每次点击自增的 token) */
  restoreAnchor?: { id: string; top: number; token: number } | null
  onLoadEarlier?: () => void
}

export function MessageList({
  messages,
  isStreaming,
  isPending,
  className,
  onRegenerate,
  onEditMessage,
  onClarifySubmit,
  onLocalFileDecision,
  onOpenEditor,
  virtualized,
  scrollElement,
  hasEarlier,
  earlierCount,
  earlierLoading,
  restoreAnchor,
  onLoadEarlier,
}: MessageListProps) {
  useRenderProbe('MessageList')
  // 键盘导航:收集每个消息的 ref,按 id 索引
  const messageRefsMap = useRef<Map<string, HTMLDivElement>>(new Map())
  const focusedMessageId = useChatStore((s) => s.focusedMessageId)
  const setFocusedMessageId = useChatStore((s) => s.setFocusedMessageId)

  // ── 虚拟化:滚动容器 padding 实测 → scrollMargin ─────────────────────────
  // 滚动容器有 md:pt-12 的顶部留白,列表真实起点在其下。scrollMargin 让
  // virtualizer 的 measurement.start 直接对齐 scrollTop 坐标系(等价 DOM offsetTop),
  // scroll-spy / 跳转不再需要手工坐标换算。断点切换/缩放时重测。
  const [scrollPadTop, setScrollPadTop] = useState(0)
  useEffect(() => {
    const el = scrollElement
    if (!virtualized || !el) return
    const measure = () => {
      const px = parseFloat(getComputedStyle(el).paddingTop) || 0
      setScrollPadTop((prev) => (prev === px ? prev : px))
    }
    measure()
    const mq = window.matchMedia('(min-width: 768px)')
    mq.addEventListener('change', measure)
    window.addEventListener('resize', measure)
    return () => {
      mq.removeEventListener('change', measure)
      window.removeEventListener('resize', measure)
    }
  }, [virtualized, scrollElement])

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    // 非虚拟化路径(CompareLane)传 count=0 + null 滚动容器:实例保持惰性,
    // 不观察任何滚动,也不产生渲染开销
    count: virtualized ? messages.length : 0,
    getScrollElement: () => (virtualized ? scrollElement ?? null : null),
    estimateSize: (i) => {
      const m = messages[i]
      if (!m) return 120
      // 优先用上一次会话里实测过的高度(bridge 缓存),估算只兜首帧
      return messageHeightStore.get(m.id) ?? estimateMessageHeight(m)
    },
    getItemKey: (i) => messages[i]?.id ?? `idx-${i}`,
    overscan: 6,
    scrollMargin: scrollPadTop,
    // 程序化滚动(start 对齐)让目标顶边离开容器沿 24px,复刻旧 DOM 跳转的语义
    scrollPaddingStart: 24,
  })

  // 尺寸校正补偿开关(3.17 是实例可覆写字段,不在 options 上):贴底跟随/校正期间
  // 禁用 TanStack 补偿 —— 补偿把 scrollTop 推离贴底位置,与 ChatPanel 每帧贴底赋值
  // 互相拉扯,整列表上下跳(移动端表现为打开会话一直闪)。跟随时贴底逻辑已保证
  // 视口=底部,上方 item 校正无需补偿;自由浏览时保留默认语义(上方 item 变化才
  // 补偿),回看不跳变。卸载时还原,避免单例字段泄漏。
  useEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, v) => {
      if (isListFollowing()) return false
      return item.start < (v.scrollOffset ?? 0)
    }
    return () => {
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined
    }
  }, [virtualizer])

  // refs 惯例:render 体不写 .current,统一在 effect 同步(React 18 并发安全)
  const virtualizerRef = useRef(virtualizer)
  const scrollElRef = useRef<HTMLDivElement | null>(scrollElement ?? null)
  // 保活集:已挂载过的消息 id。快速滚动掉帧的根源是"滚到哪里挂到哪里"—— 回看
  // 已看过的消息时组件重新挂载,react-markdown/KaTeX/高亮全部重跑(实测快速滚动
  // p90 帧 81ms)。保活让回看零重挂载,DOM 规模由 KEEP_MAX 封顶。写入都在渲染
  // 分支内且幂等(同一输入必得同一集合),并发双渲染安全。
  const keptRef = useRef<Set<string>>(new Set())
  // 空闲预热:打开会话后用 idle 时间把前 KEEP_MAX 条渐进挂载(每步 3 条),
  // 用户开始滚动时通常已热 —— 首遍滚动的解析尖峰(旧架构付在打开时的那部分)
  // 被摊进交互不会用到的空闲帧里。rIC 只在空闲时触发,交互自动让路。
  const prewarmCountRef = useRef(0)
  const [prewarmCount, setPrewarmCount] = useState(0)
  // 渲染期要用的 id→下标(保活组装是渲染逻辑,必须与本次 messages 同源);
  // facade 在事件回调里读取,走 effect 同步的 ref
  const indexById = useMemo(() => {
    const map = new Map<string, number>()
    for (let i = 0; i < messages.length; i++) map.set(messages[i].id, i)
    return map
  }, [messages])
  const indexByIdRef = useRef(indexById)
  useEffect(() => {
    virtualizerRef.current = virtualizer
  }, [virtualizer])
  useEffect(() => {
    indexByIdRef.current = indexById
  }, [indexById])
  // 空闲预热循环:每步 3 条,直到预算满(KEEP_MAX)或用户浏览已占满预算。
  // rIC 只在空闲帧触发,打字/滚动时自动让路;timeout 300ms 保证最终进度。
  useEffect(() => {
    if (!virtualized) return
    let cancelled = false
    let idleId = 0
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const budget = Math.min(messages.length, KEEP_MAX)
    const schedule = () => {
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(step, { timeout: 300 })
      } else {
        timeoutId = setTimeout(step, 200)
      }
    }
    const step = () => {
      if (cancelled) return
      if (prewarmCountRef.current >= budget || keptRef.current.size >= KEEP_MAX) return
      prewarmCountRef.current = Math.min(prewarmCountRef.current + 3, budget)
      setPrewarmCount(prewarmCountRef.current)
      schedule()
    }
    schedule()
    return () => {
      cancelled = true
      if (idleId) window.cancelIdleCallback(idleId)
      if (timeoutId) clearTimeout(timeoutId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualized, messages.length])
  useEffect(() => {
    scrollElRef.current = scrollElement ?? null
  }, [scrollElement])

  // 虚拟化 facade:屏外消息不在 DOM,OutlineSidebar 的 scroll-spy 与跳转
  // 经这里改走虚拟化测量数据(二分查找,零 DOM 访问)。坐标系与 scrollTop 一致
  // (scrollMargin 已把容器 padding 计入 measurement.start)。
  const facade = useMemo<ListScrollFacade | null>(() => {
    if (!virtualized) return null
    return {
      messageIndexAtTop: (topPx) => {
        const v = virtualizerRef.current
        if (!v) return null
        return v.getVirtualItemForOffset(topPx)?.index ?? null
      },
      jumpToMessage: (messageId) => {
        const v = virtualizerRef.current
        const idx = indexByIdRef.current.get(messageId)
        if (!v || idx === undefined) return false
        const targetOf = (): number | null => {
          const got = v.getOffsetForIndex(idx, 'start')
          return got ? got[0] : null
        }
        const target = targetOf()
        if (target == null) return false
        v.scrollToOffset(target, { behavior: 'smooth' })
        // 目标若从未渲染过,首跳落点基于估算高度;等目标 item 挂载并被
        // measureElement 实测后按真实位置补一跳(450ms ≈ 平滑滚动结束)。
        // 用户已大幅手动滚走(>200px)则不打扰。
        window.setTimeout(() => {
          const vv = virtualizerRef.current
          const el = scrollElRef.current
          if (!vv || !el) return
          const t2 = targetOf()
          if (t2 == null) return
          const drifted = Math.abs(el.scrollTop - target)
          if (drifted <= 200 && Math.abs(el.scrollTop - t2) > 2) {
            vv.scrollToOffset(t2, { behavior: 'auto' })
          }
        }, 450)
        return true
      },
    }
  }, [virtualized])

  useEffect(() => {
    registerListScrollFacade(facade)
    return () => registerListScrollFacade(null)
  }, [facade])

  // ── 更早页前插后的位置复位 ──
  // 只按「消息」复位,不按 scrollHeight 增量:新页在虚拟化列表里是估算高度,
  // 增量法会把视口拽偏上千米(实测 1.5k px ≈ 几十条消息)。
  // 先按索引把锚点拉回渲染范围,再用它渲染后的真实 rect 精修;
  // 最多 12 帧收敛到 ±2px,超帧即停手,不跟用户抢滚动。
  const handledAnchorTokenRef = useRef(0)
  useEffect(() => {
    if (!restoreAnchor || restoreAnchor.token === handledAnchorTokenRef.current) return
    handledAnchorTokenRef.current = restoreAnchor.token
    const el = scrollElRef.current
    if (!el) return
    const { id, top } = restoreAnchor
    let frame = 0
    const step = () => {
      const node = el.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
      if (node) {
        const drift = node.getBoundingClientRect().top - el.getBoundingClientRect().top - top
        if (Math.abs(drift) <= 2 || frame >= 12) return
        el.scrollTop += drift
      } else {
        const v = virtualizerRef.current
        const idx = indexByIdRef.current.get(id)
        if (!v || idx === undefined || frame >= 12) return
        const got = v.getOffsetForIndex(idx, 'start')
        if (got) v.scrollToOffset(got[0] - top, { behavior: 'auto' })
      }
      if (++frame >= 12) return
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [restoreAnchor])

  // 跟随滚动的判定与执行已上移到 ChatPanel(那里持有滚动容器 DOM):
  // 用户向上滚动即脱离跟随、可自由回看历史,滚回底部或点"回到底部"按钮恢复跟随。

  // 键盘导航滚动:虚拟化走 scrollToIndex(等价 scrollIntoView 的 nearest 语义),
  // 屏外消息无需先挂载;非虚拟化维持 DOM scrollIntoView
  const scrollToReveal = useCallback(
    (index: number, messageId: string) => {
      if (virtualized) {
        virtualizerRef.current?.scrollToIndex(index, { align: 'auto' })
        return
      }
      const el = messageRefsMap.current.get(messageId)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    },
    [virtualized]
  )

  // 收敛 lastAssistantIndex —— messages 数组变化时只有这一处需要重算
  const lastAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  }, [messages])

  // canRegenerate / canEdit 收敛成常量,避免每次渲染创建新值
  const canRegenerateAll = !isStreaming && !!onRegenerate
  const canEditAll = !isStreaming && !!onEditMessage

  // 键盘导航(j/k): 仅在未聚焦 input 时触发,流式期间禁用
  useEffect(() => {
    // 流式期间禁用键盘导航,避免选中半截生成中的消息
    if (isStreaming || messages.length === 0) return

    function handleKeyDown(e: KeyboardEvent) {
      // 如果焦点在输入框/textarea/contenteditable,不拦截
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      const currentIndex = focusedMessageId
        ? messages.findIndex((m) => m.id === focusedMessageId)
        : -1

      if (e.key === 'j' || e.key === 'J') {
        // 下一条
        e.preventDefault()
        const nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, messages.length - 1)
        const nextId = messages[nextIndex]?.id
        if (nextId) {
          setFocusedMessageId(nextId)
          scrollToReveal(nextIndex, nextId)
        }
      } else if (e.key === 'k' || e.key === 'K') {
        // 上一条
        e.preventDefault()
        const prevIndex = currentIndex === -1 ? messages.length - 1 : Math.max(currentIndex - 1, 0)
        const prevId = messages[prevIndex]?.id
        if (prevId) {
          setFocusedMessageId(prevId)
          scrollToReveal(prevIndex, prevId)
        }
      } else if (e.key === 'Enter' && focusedMessageId) {
        // 选中状态下 Enter → 快捷复制(触发 Copy 按钮)
        e.preventDefault()
        const el = messageRefsMap.current.get(focusedMessageId)
        if (el) {
          // 找到这条消息内的第一个复制按钮
          const copyBtn = el.querySelector<HTMLButtonElement>('button[aria-label="复制"]')
          copyBtn?.click()
        }
      } else if (e.key === 'Escape' && focusedMessageId) {
        // Esc 清除选中
        e.preventDefault()
        setFocusedMessageId(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [messages, isStreaming, focusedMessageId, setFocusedMessageId, scrollToReveal])

  // 每条消息对应的"前一条用户消息文本"(存错题本时,assistant 消息用它配对题干)
  const prevUserContentById = useMemo(() => {
    const map = new Map<string, string | null>()
    let last: string | null = null
    for (const msg of messages) {
      map.set(msg.id, last)
      if (msg.role === 'user') {
        const t = msg.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
          .trim()
        if (t) last = t
      }
    }
    return map
  }, [messages])

  // 澄清问答"已答"判定:该 assistant 消息之后存在任意 user 消息
  // (无论用户是点选卡片提交还是直接打字,都视为已回答)
  const answeredAssistantIds = useMemo(() => {
    const set = new Set<string>()
    let seenUser = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'user') seenUser = true
      else if (msg.role === 'assistant' && seenUser) set.add(msg.id)
    }
    return set
  }, [messages])

  // 两个分支共用的气泡 props(wrapperRef 每渲染新建是既有行为,memo 比较器明确忽略它)
  const bubbleProps = (message: UIMessage, index: number) => ({
    message,
    prevUserContent: prevUserContentById.get(message.id),
    isStreaming,
    isLastAssistant: index === lastAssistantIndex,
    // "正在生成"判定必须用 isLastMessage 而非 isLastAssistant:submitted 阶段
    // (请求在途、assistant 占位还没进 messages)旧 assistant 仍是 lastAssistant,
    // 若用它豁免会把上一条卡片误退回纯文本,闪回原始 JSON
    isLastMessage: index === messages.length - 1,
    canRegenerate: canRegenerateAll,
    onRegenerate,
    canEdit: canEditAll,
    onEdit: onEditMessage,
    onClarifySubmit,
    onLocalFileDecision,
    onOpenEditor,
    clarifyAnswered: answeredAssistantIds.has(message.id),
    isFocused: message.id === focusedMessageId,
    wrapperRef: (el: HTMLDivElement | null) => {
      if (el) {
        messageRefsMap.current.set(message.id, el)
      } else {
        messageRefsMap.current.delete(message.id)
      }
    },
  })

  const pendingPlaceholder =
    isPending && messages.length > 0 && messages[messages.length - 1].role === 'user' ? (
      <div className="flex gap-2.5 px-4 max-md:px-[15px] py-2" aria-hidden>
        <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center bg-accent text-accent-foreground mt-0.5 max-md:hidden">
          <Bot className="w-3 h-3" />
        </div>
        <div className="flex items-center gap-1.5 py-1">
          <span className="w-2 h-2 bg-content-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 bg-content-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-2 h-2 bg-content-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    ) : null

  // 虚拟化分支:视口窗口挂载 + 已访问消息保活。sized div 高度是 totalSize
  // (scrollMargin 已被 getTotalSize 扣除),item 的 translateY 要减回
  // scrollMargin(它已含在 measurement.start 里)。measureElement 挂在外层
  // 定位 div 上(须带 data-index),保活项同样挂着,尺寸变化实时回传。
  // 顶部"查看更早"入口:放在滚动容器内容流里(虚拟化分支的定高轨道之前),
  // 滚上去即消失;拉取中显示转圈并禁点,防止重复请求。
  const earlierHeader = hasEarlier ? (
    <div className="max-w-2xl mx-auto px-4 pt-3 pb-1 flex justify-center">
      {earlierLoading ? (
        <span className="flex items-center gap-2 py-1.5 text-[11px] text-content-muted">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-content-muted border-t-transparent" />
          正在加载更早消息…
        </span>
      ) : (
        <button
          type="button"
          onClick={onLoadEarlier}
          className="rounded-full border border-line bg-surface/70 px-4 py-1.5 text-[11px] text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
        >
          {earlierCount && earlierCount > 0 ? `查看更早消息(还有 ${earlierCount} 条)` : '查看更早消息'}
        </button>
      )}
    </div>
  ) : null

  if (virtualized && scrollElement) {
    const items = virtualizer.getVirtualItems()
    const measurements = virtualizer.measurementsCache
    const activeIdx = new Set(items.map((vi) => vi.index))
    // 登记本轮活跃项进保活集
    for (const vi of items) {
      const id = messages[vi.index]?.id
      if (id) keptRef.current.add(id)
    }
    // 登记空闲预热区间(从头数前 prewarmCount 条,已被用户看过的自然跳过)
    const warm = Math.min(prewarmCount, messages.length)
    for (let i = 0; i < warm; i++) {
      const id = messages[i]?.id
      if (id) keptRef.current.add(id)
    }
    // 预算淘汰:超出 KEEP_MAX 时,离当前窗口最远的保活项先卸载
    if (keptRef.current.size > KEEP_MAX) {
      const lo = items[0]?.index ?? 0
      const hi = items[items.length - 1]?.index ?? lo
      const dist = (idx: number | undefined) =>
        idx === undefined ? Number.MAX_SAFE_INTEGER : idx < lo ? lo - idx : idx > hi ? idx - hi : 0
      const sorted = Array.from(keptRef.current).sort(
        (a, b) => dist(indexById.get(b)) - dist(indexById.get(a))
      )
      for (const id of sorted.slice(0, keptRef.current.size - KEEP_MAX)) keptRef.current.delete(id)
    }
    // 组装渲染列表:虚拟窗口项 + 窗口外的保活项。保活项**不套 content-visibility**:
    // CV 的"进入视口集中排版"在快速滚动下每帧都发生(p50 反而从 17ms 涨到 36ms);
    // 保活集被 KEEP_MAX 封顶后,常驻布局的 DOM 只有几千节点,样式重算远比逐条重排版便宜。
    const rendered = items.map((vi) => ({ key: vi.key as string, index: vi.index, start: vi.start }))
    keptRef.current.forEach((id) => {
      const idx = indexById.get(id)
      if (idx === undefined || activeIdx.has(idx)) return
      const m = measurements[idx]
      if (m) rendered.push({ key: id, index: idx, start: m.start })
    })
    rendered.sort((a, b) => a.index - b.index)

    return (
      <div className={cn('w-full', className)}>
        {earlierHeader}
        <div className="max-w-2xl mx-auto overflow-x-hidden">
          <div
            style={{ height: virtualizer.getTotalSize(), minHeight: '100%', position: 'relative' }}
          >
            {rendered.map((r) => {
              const message = messages[r.index]
              if (!message) return null
              return (
                <div
                  key={r.key}
                  data-index={r.index}
                  // measureElement 是实例方法(引用恒定):逐帧重渲染不会反复解绑/重绑,
                  // 也就不会在 commit 阶段逐 item 强制同步布局。refsMap 由气泡内部
                  // wrapper 的 wrapperRef 跟踪(仅 Map 操作,无布局读取)
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${r.start - scrollPadTop}px)`,
                  }}
                >
                  <MessageBubble {...bubbleProps(message, r.index)} contentVisibilityOff />
                </div>
              )
            })}
          </div>
          {pendingPlaceholder}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('w-full min-h-full overflow-x-hidden flex flex-col', className)}>
      {earlierHeader}
      <div className="max-w-2xl mx-auto overflow-x-hidden w-full">
        {messages.map((message, index) => (
          <MessageBubble key={message.id} {...bubbleProps(message, index)} />
        ))}
        {pendingPlaceholder}
      </div>
    </div>
  )
}
