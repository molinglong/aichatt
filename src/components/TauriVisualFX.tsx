'use client'

import { useEffect, useState } from 'react'
import { useIsTauri, tauri } from '@/lib/tauri'

/**
 * 客户端(Tauri)专属视觉增强宿主。Web 端渲染 null,零影响。
 *
 * 失焦降饱和:监听窗口焦点,失焦时 html 上挂 data-tauri-blurred;
 * 灰罩(.tauri-blur-overlay)与红绿灯变灰由 CSS 门控生效。
 */
export function TauriVisualFX() {
  const isTauri = useIsTauri()
  const [blurred, setBlurred] = useState(false)

  useEffect(() => {
    if (!isTauri) return
    const cleanupFocus = tauri.onFocusChange(setBlurred)
    return () => {
      cleanupFocus()
    }
  }, [isTauri])

  // 焦点态写入 html 属性:纯 CSS 门控,避免全树重渲染
  useEffect(() => {
    if (!isTauri) return
    if (blurred) document.documentElement.setAttribute('data-tauri-blurred', '')
    else document.documentElement.removeAttribute('data-tauri-blurred')
  }, [isTauri, blurred])

  // 最大化态写入 html 属性:透明窗口的 CSS 圆角在最大化时会于四角裁出透明
  // 缺口(桌面透出),圆角由 CSS 按 data-win-max 归零
  useEffect(() => {
    if (!isTauri) return
    let alive = true
    const apply = async () => {
      const maxed = await tauri.isMaximized()
      if (!alive) return
      if (maxed) document.documentElement.setAttribute('data-win-max', '')
      else document.documentElement.removeAttribute('data-win-max')
    }
    apply()
    const cleanup = tauri.onResized(apply)
    return () => {
      alive = false
      cleanup()
    }
  }, [isTauri])

  if (!isTauri) return null
  return <div className="tauri-blur-overlay" aria-hidden="true" />
}
