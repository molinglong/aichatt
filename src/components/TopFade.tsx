'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * 内容区上沿渐隐(仅 ≥md,视觉定义见 globals.css 的 .top-fade)。
 *
 * 顶栏下沉后内容滚到容器上沿本会被硬切一刀,而浮簇(TopBar ≥md 分支)自身没有底板 ——
 * 正文笔画直接从按钮下沿断开。这层把「硬切」换成「渐隐」。
 *
 * 只在内容确实被滚上去时才显形。常显的代价实测过:静置(滚到顶)时首段起于 y=14px,
 * 正落在渐隐带里 —— 首行墨迹只剩 0%、y=36 仅 18%,等于每次滚到顶前两行都读不了。
 * 所以静置 / 短会话(内容不足一屏)时完全不出现,也就不必给消息区留白。
 */

/** 参与判定的滚动容器:项目里消息区用 .scroll-contain;其余 tab 的纵向滚动容器以类名兜住 */
const SCROLL_SEL = '.scroll-contain, [class*="overflow-y-auto"], [class*="overflow-auto"]'

export function TopFade() {
  const ref = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const pathname = usePathname()

  // 滚动监听:scroll 事件不冒泡,但在捕获阶段能在祖先拿到后代的滚动 —— 挂内容列一处即可,
  // 不必逐 tab / 逐会话接线。用 matches 过滤(不读 scrollTop 之外的布局属性),避免代码块
  // 之类横向滚动容器把状态带偏。
  useEffect(() => {
    const host = ref.current?.parentElement
    if (!host) return
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | null
      if (!el || typeof el.matches !== 'function' || !el.matches(SCROLL_SEL)) return
      setScrolled(el.scrollTop > 4)
    }
    host.addEventListener('scroll', onScroll, true)
    return () => host.removeEventListener('scroll', onScroll, true)
  }, [])

  // 换会话/换 tab 后补测:新滚动容器可能已被程序滚到中段(打开长会话会自动滚到底),
  // 不经过用户滚动就没有 scroll 事件。补测两次 —— 挂载首帧 + 布局稳定后。
  useEffect(() => {
    const host = ref.current?.parentElement
    if (!host) return
    const scan = () => {
      const scrollers = Array.from(host.querySelectorAll<HTMLElement>(SCROLL_SEL))
      setScrolled(scrollers.some((el) => el.scrollTop > 4))
    }
    const raf = requestAnimationFrame(scan)
    const timer = window.setTimeout(scan, 150)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [pathname])

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        'top-fade pointer-events-none absolute inset-x-0 top-0 z-10 hidden md:block transition-opacity duration-200',
        scrolled ? 'opacity-100' : 'opacity-0'
      )}
    />
  )
}
