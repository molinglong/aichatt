'use client'

import { useEffect, useState } from 'react'
import type { UiStyle } from '@/lib/theme'

/**
 * 读 html[data-style] 的 React 钩子(样式维度,见 lib/theme.ts 的 UiStyle)。
 * 只观察不写入 —— 写入方是 theme.ts applyAppearance / layout 首帧内联脚本。
 * 样式切换是低频操作,MutationObserver 带 attributeFilter 后,
 * 只有 data-style 真的变化才触发一次 setState。
 * 用途:各套样式的**结构级**分歧(不是颜色/材质那种 CSS 能门控的)
 * 在组件层各自渲染各自的 DOM,互不污染 —— 2026-10-25 用户定案:外观独立。
 */
function readStyle(): UiStyle {
  if (typeof window === 'undefined') return 'bigsur'
  const v = document.documentElement.getAttribute('data-style')
  return v === 'classic' || v === 'google' ? v : 'bigsur'
}

export function useUiStyle(): UiStyle {
  // 首次渲染必须与服务端一致（bigsur），否则整棵树 hydration mismatch：
  // data-style 是首帧脚本写在 <html> 上的，服务端拿不到。挂载后 effect 立即
  // 同步真实值，再做一次重渲染 —— 结构会切换一次，但不会触发 React 重建整页。
  const [style, setStyle] = useState<UiStyle>('bigsur')

  useEffect(() => {
    const root = document.documentElement
    const sync = () => setStyle(readStyle())
    sync()
    const ob = new MutationObserver(sync)
    ob.observe(root, { attributes: true, attributeFilter: ['data-style'] })
    return () => ob.disconnect()
  }, [])

  return style
}
