'use client'

import { useEffect, useRef } from 'react'

/** 两次触发的最短间隔:visibilitychange / focus / pageshow 常常同一瞬间连发,只认一次 */
const MIN_GAP_MS = 1500

/**
 * 「人回来了」的统一入口:页面从后台切回前台时调一次 callback。
 *
 * 场景:电脑上聊完,手机切回 App 要能自己把新消息补出来,而不是手动刷新。
 * 项目没有 WebSocket 推送,跨端同步是拉取式 —— 那就在最该拉的那一刻拉一次。
 *
 * 三个事件一起听,各覆盖一种"回来":
 *   - visibilitychange → visible:安卓壳 / 浏览器从后台切回(WebView.onResume 会把它补发)
 *   - focus:桌面端在两个窗口之间切回来(页面始终 visible,不会触发 visibilitychange)
 *   - pageshow:iOS Safari / bfcache 恢复
 * 三者常同帧连发,用时间阈值合并成一次;挂载时不触发(首屏数据由正常加载负责)。
 */
export function useForegroundResume(callback: () => void) {
  const callbackRef = useRef(callback)
  callbackRef.current = callback
  const lastRunRef = useRef(0)

  useEffect(() => {
    if (typeof document === 'undefined') return
    const fire = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastRunRef.current < MIN_GAP_MS) return
      lastRunRef.current = now
      callbackRef.current()
    }
    document.addEventListener('visibilitychange', fire)
    window.addEventListener('focus', fire)
    window.addEventListener('pageshow', fire)
    return () => {
      document.removeEventListener('visibilitychange', fire)
      window.removeEventListener('focus', fire)
      window.removeEventListener('pageshow', fire)
    }
  }, [])
}
