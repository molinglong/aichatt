'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { extractHeadings } from '@/lib/outline'
import { getListScrollFacade } from './chat-list-bridge'
import type { UIMessage } from 'ai'

interface OutlineSidebarProps {
  messages: UIMessage[]
  /** 滚动容器(MessageList 的外层 overflow-y-auto 那个 div)。 */
  scrollContainer?: HTMLElement | null
  className?: string
  /** 右墙被别的面板(对话资料)占住时的让位宽度,整列随之左移 */
  rightOffset?: number
}

type Tick = {
  domId: string | null
  messageId: string
  /** 该 tick 对应消息在 messages 数组中的下标(虚拟化 facade 的 spy 判定用) */
  msgIndex: number
  label: string
  level: number
}

/** extractHeadings 的逐条结果(不含 msgIndex —— 下标随新消息漂移,每次组装) */
type OutlineLabel = Omit<Tick, 'msgIndex'>

/**
 * 逐条消息的大纲标签缓存: messageId → { fp, label }。
 * ticks 的依赖是 messages 引用,流式期 useChat 每 50ms 节流就换一个引用 ——
 * 无缓存时每次都要对全部历史 assistant 文本重跑 extractHeadings(长对话 O(n) 热点,
 * "对话一长、生成期间掉帧"的主因)。命中条件用 id+文本长度指纹:
 * 已完成消息引用恒定长度恒定,唯一直变的是生成中那条,每轮只重算它一条。
 */
const labelCache = new Map<string, { fp: number; label: OutlineLabel }>()
const LABEL_CACHE_MAX = 1200

function outlineLabelOf(m: UIMessage): OutlineLabel {
  let text = ''
  for (const p of m.parts) {
    if (p.type === 'text') text += p.text
  }
  const fp = text.length
  const hit = labelCache.get(m.id)
  if (hit && hit.fp === fp) return hit.label
  const headings = extractHeadings(text)
  const label: OutlineLabel =
    headings.length > 0
      ? { domId: `${m.id}-${headings[0].id}`, messageId: m.id, label: headings[0].text, level: headings[0].level }
      : (() => {
          // 无标题时取首个"有内容"的行做标签;跳过块标记行(:::gamestatus / :::material 等),
          // 否则以面板块开头的消息会把 ":::xxx" 当成节点名(游戏/试卷块都会踩)
          const firstLine =
            text
              .trim()
              .split(/\r?\n/)
              .find((s) => s.trim().length > 0 && !/^:::/.test(s.trim())) ?? ''
          const cleaned = firstLine.replace(/^#+\s*/, '').trim()
          return { domId: null, messageId: m.id, label: cleaned.length > 0 ? cleaned : '新消息', level: 2 }
        })()
  if (labelCache.size > LABEL_CACHE_MAX) labelCache.clear()
  labelCache.set(m.id, { fp, label })
  return label
}

/**
 * 右侧"对话节点"面板 —— 与左侧 Sidebar 镜像,但只在对话页出现。
 *
 * 设计要点:
 *   - 整体 fixed 顶到顶 / 底到底,靠右 6px, 镜像参考 Sidebar 的圆角 + backdrop-blur
 *   - 平时(bubble 模式): 只剩中间那列 tick —— 屏幕右边极简的进度指示器
 *   - hover 整面板: tick 列左边"原地长出" Popover —— 文本列表 + tick 同步高亮
 *   - Popover 关闭 / 折叠按钮: 整体面板缩回窄列
 *   - scroll-spy: 滚动聊天区时,激活态实时跟随
 */
export function OutlineSidebar({
  messages,
  scrollContainer,
  className,
  rightOffset = 0,
}: OutlineSidebarProps) {
  const ticks = useMemo<Tick[]>(() => {
    const list: Tick[] = []
    messages.forEach((m, msgIndex) => {
      if (m.role !== 'assistant') return
      list.push({ ...outlineLabelOf(m), msgIndex })
    })
    return list
  }, [messages])

  const [activeIndex, setActiveIndex] = useState(0)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  // messageId → DOM 节点缓存:scroll-spy 每帧只读 offsetTop,全文档查询
  // 仅发生在缓存未命中(首次见到该消息)时 —— 此前每帧对每个 tick 都做一次
  // querySelector 属性扫描(标题 id 从未写入 DOM,getElementById 必 miss),
  // 是滚动掉帧的主要 JS 开销
  const nodeCacheRef = useRef<Map<string, HTMLElement | null>>(new Map())
  // Popover 仍是悬浮窗:默认隐藏,鼠标进入右侧面板区域才打开。
  // 但打开后,mouseleave 走 600ms 延时 + Bridge 桥接,不会因为穿越间隙就关闭。
  const [popoverOpen, setPopoverOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // scroll-spy
  useEffect(() => {
    if (ticks.length === 0) return
    const container = scrollContainer
    if (!container) return

    let raf = 0
    const update = () => {
      raf = 0
      const scrollTop = container.scrollTop
      const containerHeight = container.clientHeight
      const scrollHeight = container.scrollHeight
      const visibleTop = scrollTop
      const visibleBottom = scrollTop + containerHeight
      if (scrollHeight - visibleBottom < 4) {
        // 滚到底:激活态永远在最后一项. bail out 防御 —— 当前已激活就不更新
        setActiveIndex((prev) => (prev === ticks.length - 1 ? prev : ticks.length - 1))
        return
      }

      // 激活项定位优先走虚拟化 facade:屏外消息不在 DOM,一次二分
      // (视口顶 24px 处的消息下标)+ 一次线性走 tick,零 DOM 访问。
      // 未注册 facade(非虚拟化路径)回退 DOM 查询 + nodeCache:命中缓存且
      // 仍连接着就直接读 offsetTop,全文档查询只在首次见到某消息时发生一次
      // —— 此前每帧对每个 tick 都 querySelector 属性扫描,是滚动掉帧的主因。
      const facade = getListScrollFacade()
      const at = facade?.messageIndexAtTop(visibleTop + 24)
      let current = 0
      if (at != null) {
        for (let i = 0; i < ticks.length; i++) {
          if (ticks[i].msgIndex <= at) current = i
          else break
        }
      } else {
        const nodeCache = nodeCacheRef.current
        const resolveTop = (tick: Tick): number | null => {
          const cached = nodeCache.get(tick.messageId)
          if (cached && cached.isConnected) return cached.offsetTop
          let node: HTMLElement | null = null
          if (tick.domId) node = document.getElementById(tick.domId)
          if (!node) node = document.querySelector(`[data-message-id="${tick.messageId}"]`)
          nodeCache.set(tick.messageId, node)
          return node ? node.offsetTop : null
        }
        for (let i = 0; i < ticks.length; i++) {
          const top = resolveTop(ticks[i])
          if (top == null) continue
          if (top <= visibleTop + 24) current = i
          else break
        }
      }
      // 关键: setState 前后 bail out —— current 没变就不调用 setActiveIndex,
      // 避免每次 DOM mutation 都触发 React render → 反复调用 update 的循环源头之一
      setActiveIndex((prev) => (prev === current ? prev : current))
    }

    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(update)
    }

    update()
    container.addEventListener('scroll', onScroll, { passive: true })
    const mo = new MutationObserver(() => {
      if (!raf) raf = requestAnimationFrame(update)
    })
    mo.observe(container, { childList: true, subtree: true })

    return () => {
      container.removeEventListener('scroll', onScroll)
      mo.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ticks, scrollContainer])

  // 鼠标离开整个面板区域,延时关闭。
  // 关闭延迟设大一点(600ms),用户从 trigger 滑向 Popover 时,即使指针稍微偏离
  // 也不会瞬间关闭 —— "延迟 + 容差"双保险消除硬切感
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setPopoverOpen(false), 600)
  }
  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  // 点击行后不立即关闭 —— 用户连续跳转多个节点是常见操作,
  // 关闭并重开 hover 区域会"打架"。改为点击后短暂保持打开,
  // 给用户一个"我刚跳过去,可以再跳下一个"的窗口。
  const handleJump = (idx: number) => {
    if (!scrollContainer) return
    const tick = ticks[idx]
    if (!tick) return
    // 虚拟化模式:屏外消息节点不存在,由 facade 经虚拟化测量数据跳转
    if (getListScrollFacade()?.jumpToMessage(tick.messageId)) {
      setActiveIndex(idx)
      cancelClose()
      return
    }
    let node: HTMLElement | null = null
    if (tick.domId) node = document.getElementById(tick.domId)
    if (!node) node = document.querySelector(`[data-message-id="${tick.messageId}"]`)
    if (!node) return
    const containerTop = scrollContainer.getBoundingClientRect().top
    const nodeTop = node.getBoundingClientRect().top
    scrollContainer.scrollTo({
      top: scrollContainer.scrollTop + (nodeTop - containerTop) - 24,
      behavior: 'smooth',
    })
    setActiveIndex(idx)
    // 不立即关闭 —— 让用户在 Popover 内继续点击下一个节点。
    // 关闭时机改由 scheduleClose 控制:鼠标离开整个面板才关
    cancelClose()
  }

  // ---------------------------------------------------------------
  // 长按触发:鼠标按下并停留 LONG_PRESS_MS 不松开,自动跳转。
  // 这样在 Popover 内不必先点一下再松开,符合"按住 = 跳转"的直觉
  // (类似画图的填充手势)。
  // 关键点:
  //   - 与 click 区分:click 是"按下立即松开",长按是"按下后停留"
  //   - 鼠标轻微抖动(tolerance)也算按住,避免误判中断
  //   - 离开 tick / 松开都会取消
  // ---------------------------------------------------------------
  const LONG_PRESS_MS = 220
  const LONG_PRESS_TOLERANCE_PX = 6
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressStart = useRef<{ x: number; y: number } | null>(null)
  const longPressFired = useRef(false)

  const startLongPress = (idx: number, e: React.PointerEvent | React.MouseEvent) => {
    longPressFired.current = false
    longPressStart.current = { x: e.clientX, y: e.clientY }
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true
      handleJump(idx)
    }, LONG_PRESS_MS)
  }
  const moveLongPress = (e: React.PointerEvent | React.MouseEvent) => {
    if (!longPressStart.current) return
    const dx = Math.abs(e.clientX - longPressStart.current.x)
    const dy = Math.abs(e.clientY - longPressStart.current.y)
    if (dx > LONG_PRESS_TOLERANCE_PX || dy > LONG_PRESS_TOLERANCE_PX) {
      cancelLongPress()
    }
  }
  const endLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    longPressStart.current = null
  }
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    longPressStart.current = null
  }

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  if (ticks.length === 0) return null

  return (
    <aside
      aria-label="阅读进度与章节导航"
      className={cn(
        // aside 自身不拦截鼠标,只作逻辑容器,内部子元素各自 fixed 定位
        'hidden md:block fixed inset-0 z-30 select-none pointer-events-none',
        className,
      )}
      /* 让位:aside 的右边界往里收,配合 transform 让它成为内部 fixed 子元素的包含块,
         于是整列(trigger / bridge / popover)一起左移,而不是叠到对话资料面板上 */
      style={rightOffset ? { right: rightOffset, transform: 'translateZ(0)' } : undefined}
    >
      {/* ============================================================
          Bridge 隐形桥接层:Bridge 跨越 trigger + 一点点右偏移 + 极少 Popover 右缘
          的区域,用来吸收鼠标穿过间隙时的 mouseleave,从而不会触发关闭。
          它本身完全透明,不渲染视觉。

          关键:宽度必须 ≤ OutlineSidebar 右侧 trigger 列的左缘位置,
          否则会延伸到聊天内容区,吞掉 MermaidBlock 等右侧按钮的点击
          (历史上 w-[286px] 时,会把 Maximize 按钮大部分挡住,只能从左下角点到)。
          现在只覆盖 trigger 40px + right-1.5 偏移 6px + 14px Popover 缓冲 = 60px,
          聊天内容在中等视口(≥ 1024px)下完全不受影响。
         ============================================================ */}
      <div
        aria-hidden
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        className={cn(
          // 固定在视口右墙,垂直居中
          'fixed top-1/2 -translate-y-1/2 right-0 z-30',
          // 缩窄到只覆盖 trigger + 缓冲,不再延伸到聊天内容区
          'h-[60vh] w-[60px] pointer-events-auto bg-transparent',
        )}
      />
      {/* ============================================================
          Popover:左侧文本列表(独立浮层,不撑宽 aside)
          定位:
            - right = aside 宽 40px + 右偏移 6px = 46px (近似 right-[46px])
            - 短高 + 垂直居中(不再顶满屏), 细线 + 极简卡片
            - 视觉重量轻,接近"小气泡"而非"完整 sidebar"
          默认显示:用户进入对话时,Popover 默认半透明可见,鼠标进入则完全清晰。
          这样既不挡视线,又让人一眼知道"右侧可以导航",无需摸索 hover 区域。
          动画:scaleX(0→1) + opacity, transform-origin: right center
                → 从右侧 trigger 列"原地长出来"
         ============================================================ */}
      <div
        role="dialog"
        aria-label="对话节点"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        className={cn(
          // 垂直居中 + 高度按 tick 自适应,不再顶天立地
          'fixed top-1/2 -translate-y-1/2 right-[46px] z-40',
          // 紧凑尺寸
          'w-[240px] max-h-[60vh]',
          // 极简:细线 + 轻微背景 + 圆角,不要 glass/blur/shadow
          'rounded-lg bg-background border border-line/70',
          // 内部 flex + 拦截指针事件(因为父 aside 是 pointer-events-none)
          'flex flex-col overflow-hidden pointer-events-auto',
          // 动画关键:从右侧 trigger 列"长出来"
          'origin-right will-change-transform',
          'transition-all duration-200 ease-out',
          popoverOpen
            ? 'opacity-100 scale-x-100'
            : 'opacity-0 scale-x-[0.02]',
        )}
      >
        {/* 标题区 —— 紧凑 */}
        <div className="px-3 pt-2.5 pb-1.5 flex items-center justify-between">
          <h2 className="text-[10px] font-medium text-content-muted/80 uppercase tracking-wider">
            对话节点
          </h2>
          <span className="text-[10px] text-content-muted/60 tabular-nums">
            {ticks.length}
          </span>
        </div>

        {/* 列表 —— 紧凑 */}
        <ul
          className="flex-1 overflow-y-auto px-1 pb-1.5 space-y-0.5"
          style={{ scrollbarWidth: 'thin' }}
        >
          {ticks.map((tick, idx) => {
            const isActive = idx === activeIndex
            const isHover = idx === hoverIndex
            const highlighted = isHover || isActive
            return (
              <li key={`${tick.messageId}-pop-${idx}`}>
                <button
                  type="button"
                  onClick={() => {
                    // 长按已触发时不再走 click(避免双跳)
                    if (longPressFired.current) {
                      longPressFired.current = false
                      return
                    }
                    handleJump(idx)
                  }}
                  // 长按触发跳转;快速点击走 onClick
                  onMouseDown={(e) => startLongPress(idx, e)}
                  onMouseMove={moveLongPress}
                  onMouseUp={endLongPress}
                  onMouseLeave={() => {
                    setHoverIndex((prev) => (prev === idx ? null : prev))
                    endLongPress()
                  }}
                  onMouseEnter={() => setHoverIndex(idx)}
                  className={cn(
                    'group relative w-full min-w-0 flex items-center gap-2',
                    'rounded pl-2 pr-1.5 py-1',
                    'text-[12.5px] leading-snug text-left',
                    'transition-colors duration-100',
                    highlighted
                      ? 'bg-accent/10 text-accent'
                      : 'text-content-primary hover:bg-surface-hovered',
                  )}
                >
                  {/* 节点序号 —— 跟外侧 tick 一一对应,提供视觉锚点 */}
                  <span
                    aria-hidden
                    className={cn(
                      'shrink-0 w-4 text-[10px] tabular-nums font-mono',
                      'transition-colors duration-150',
                      highlighted
                        ? 'text-accent'
                        : 'text-content-muted/50',
                    )}
                  >
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  {/* 文本(截断三件套) */}
                  <span
                    className={cn(
                      'flex-1 min-w-0 truncate',
                      tick.level === 1 && 'font-medium',
                      tick.level >= 3 && 'pl-2 text-[12px]',
                    )}
                    title={tick.label}
                  >
                    {tick.label}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {/* ============================================================
          触发列(主列):右侧那列 tick, 始终贴在视口右墙
          fixed 定位在 right-1.5, z 介于 Bridge (z-30) 和 Popover (z-40) 之间
          让它视觉上"托住" Popover,但不阻挡 trigger 点击
         ============================================================ */}
      <div
        onMouseEnter={() => {
          cancelClose()
          setPopoverOpen(true)
        }}
        onMouseLeave={scheduleClose}
        className={cn(
          // fixed 在视口右墙,垂直居中
          'fixed top-1/2 -translate-y-1/2 right-1.5 z-30',
          // 紧凑窄列:只有 tick + 一点水平 padding,无背景/边框/阴影
          'w-10 flex flex-col items-stretch justify-center py-2',
          // 拦截指针
          'pointer-events-auto',
        )}
      >
        {/* 高度自适应,等分 tick;tick 多时内部可滚动 */}
        <div
          className="flex flex-col items-center w-full max-h-[50vh] overflow-y-auto"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {ticks.map((tick, idx) => {
            const isActive = idx === activeIndex
            const isHover = idx === hoverIndex
            const highlighted = isHover || isActive
            return (
              <button
                key={`${tick.messageId}-trigger-${idx}`}
                type="button"
                aria-label={tick.label || `跳转到第 ${idx + 1} 条消息`}
                onClick={() => handleJump(idx)}
                onMouseEnter={() => setHoverIndex(idx)}
                onMouseLeave={() =>
                  setHoverIndex((prev) => (prev === idx ? null : prev))
                }
                className="outline-tick group relative flex-1 w-full flex items-center justify-center min-h-[10px] py-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span
                  className={cn(
                    'block rounded-full transition-all duration-150',
                    highlighted
                      ? 'h-3 w-[5px] bg-accent'
                      : isActive
                        ? 'h-2.5 w-[4px] bg-content-primary'
                        : 'h-1.5 w-[3px] bg-content-muted/60 group-hover:bg-content-secondary',
                  )}
                />
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
