'use client'

import { useEffect } from 'react'

/**
 * 打印监察上报：打印对话框真实弹出（beforeprint，打印按钮 / Ctrl+P 皆覆盖）即上报一次，
 * 「今晚测验」队列据此判定今天打印过哪张卷。失败静默，绝不影响打印本身。
 *
 * 现接入：拟卷卷面（kind='composed'）。背词卷/英语短文是否纳入监察是产品决策，未拍板不接；
 * 数据侧 /api/study/print-event 已按 kind 落库，后续纳管只需在对应产物加一行调用。
 */
export function usePrintEvent(kind: string, targetId: string | null | undefined) {
  useEffect(() => {
    if (!targetId) return
    const report = () => {
      try {
        fetch('/api/study/print-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, targetId }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        // ignore
      }
    }
    window.addEventListener('beforeprint', report)
    return () => window.removeEventListener('beforeprint', report)
  }, [kind, targetId])
}
