'use client'

import { useEffect, useRef, useState } from 'react'

const DEFAULT_EXIT_MS = 180

/**
 * 面板开合的存在感控制：负责“关闭时先播完退场，再卸载”。
 *
 * 定位、遮罩、外点/Esc 仍由各面板自己负责；这里只收拢「什么时候挂载」。
 * 动效本体在 globals.css 的 .panel-motion（open/closed 两态），
 * 所以以后改时长/曲线只改一处，不需要每个按钮各配一遍。
 *
 * - open=true   → 立即挂载，state=open（入场动画由 CSS 播）
 * - open=false  → 保持挂载，state=closed，exitMs 后卸载
 * - reduced-motion → 跳过退场，立即卸载
 */
export function usePanelPresence(open: boolean, exitMs = DEFAULT_EXIT_MS) {
  const [rendered, setRendered] = useState(open)
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (open) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setRendered(true)
      setClosing(false)
      return
    }

    if (!rendered) return

    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    setClosing(true)
    if (reduced) {
      setRendered(false)
      setClosing(false)
      return
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setRendered(false)
      setClosing(false)
    }, exitMs)

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [open, rendered, exitMs])

  /** 跳过退场立即卸载：用于「A 面板里点开 B 面板」的接力，避免两层同时可见 */
  function dismiss() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setRendered(false)
    setClosing(false)
  }

  return { rendered, closing, dismiss }
}
