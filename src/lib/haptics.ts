/**
 * 触感反馈:手机端菜单弹出/选中时震动一下。
 *
 * 双路实现:
 * - Tauri 壳(安卓 APK):走官方 @tauri-apps/plugin-haptics,与系统菜单同一套
 *   impact/selection 语义;插件未授权或机型不支持时降级到 Web Vibration API。
 * - 手机浏览器直连:走 navigator.vibrate(安卓 Chrome/WebView 可用,iOS Safari 静默跳过)。
 *
 * 只在触屏主指针(pointer: coarse)下生效 —— 桌面右键菜单不震。
 * 调用方无需 await:失败一律静默,触感属于锦上添花,不能影响主流程。
 */

import { getIsTauriShell } from '@/lib/tauri'

export type HapticKind = 'light' | 'selection' | 'warning'

/** Web 降级档位(ms)。安卓各厂商对短震动的最低识别时长不一,取 5~14ms 短促档 */
const WEB_VIBRATE_MS: Record<HapticKind, number | number[]> = {
  light: 8,
  selection: 5,
  warning: [14, 40, 14],
}

function isTouchPrimary(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
}

function vibrateFallback(kind: HapticKind) {
  try {
    navigator.vibrate?.(WEB_VIBRATE_MS[kind])
  } catch {
    // WebView 不支持/被系统禁用 — 静默
  }
}

/**
 * 触发一次触感反馈。必须在用户手势调用栈内调用(click/touchend),
 * 否则 Web Vibration API 可能因缺少用户激活被忽略。
 */
export function haptic(kind: HapticKind): void {
  if (typeof window === 'undefined') return
  if (!isTouchPrimary()) return

  if (!getIsTauriShell()) {
    vibrateFallback(kind)
    return
  }

  // 动态引入:Web 端永不加载插件 chunk;安卓壳内走原生触感
  void import('@tauri-apps/plugin-haptics')
    .then(async (mod) => {
      const res =
        kind === 'light'
          ? await mod.impactFeedback('light')
          : kind === 'selection'
            ? await mod.selectionFeedback()
            : await mod.notificationFeedback('warning')
      // 插件返回结构化错误(如机型无马达)时退回 Web 震动,也静默
      if (res && res.status !== 'ok') vibrateFallback(kind)
    })
    .catch(() => vibrateFallback(kind))
}
