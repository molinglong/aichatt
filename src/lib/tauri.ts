'use client'

import { useEffect, useState } from 'react'

/**
 * Tauri API 封装。
 *
 * Web 端开发时(`npm run dev`)所有 invoke 都是 no-op,
 * 这样开发者不用启动 Tauri 也能在浏览器里看到完整 UI,
 * 只是红绿灯不会响应(因为浏览器没这些 API)。
 *
 * 检测方法:`__TAURI_INTERNALS__` 是 Tauri 运行时注入的全局变量,
 * 仅在 WebView 内存在。
 */

/**
 * 始终返回 false（在 SSR 和非 Tauri 环境）。
 * 组件需要用 getIsTauri() + useEffect 来做延迟判断，
 * 避免 module 求值时 __TAURI_INTERNALS__ 尚未注入导致 SSR/CSR 不一致。
 */
export const isTauri = false

/**
 * 运行时检测是否在 Tauri 桌面壳内(不含安卓壳)。
 * 必须在 useEffect（客户端渲染后）里调用，因为 __TAURI_INTERNALS__
 * 在模块加载时可能还没注入到 window。
 *
 * 安卓壳只该有「原生能力」(通知等)，不该长出桌面 chrome(窗口控制/红绿灯/
 * 拖拽区/毛玻璃特效)，所以桌面专用逻辑一律走这里，能力检测走 getIsTauriShell。
 */
export function getIsTauri(): boolean {
  return getIsTauriShell() && !isAndroidShell()
}

/** 是否在任何 Tauri 壳内(桌面 + 安卓) */
export function getIsTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 安卓 WebView 的 UA 必含 "Android"，桌面壳为 Windows NT */
function isAndroidShell(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)
}

/**
 * 只在「安卓 Tauri 壳」里为真。
 * 不能只看 UA:手机浏览器(Chrome、Via 之类)UA 同样含 Android,而它没有
 * 被插件 init script 改写过的 window.Notification —— 那里 sendNotification
 * 会走真正的 Web Notifications API,定时字段直接被忽略、通知当场弹出来。
 */
export function isAndroidTauriShell(): boolean {
  return getIsTauriShell() && isAndroidShell()
}

/**
 * React hook: 只在 Tauri 客户端渲染内容。
 * SSR 和首次渲染时返回 false，mount 后返回真实值。
 */
export function useIsTauri(): boolean {
  const [v, setV] = useState(false)
  useEffect(() => {
    setV(getIsTauri())
  }, [])
  return v
}

/**
 * React hook: 是否在**任意** Tauri 壳内(桌面 + 安卓)。
 * useIsTauri 排除了安卓壳(它管的是桌面专属 chrome),而系统通知这类
 * 原生能力安卓壳同样有 —— 设置里那些开关得按这个口径露出。
 */
export function useIsTauriShell(): boolean {
  const [v, setV] = useState(false)
  useEffect(() => {
    setV(getIsTauriShell())
  }, [])
  return v
}

/**
 * React hook: 只在 Tauri 客户端渲染内容。
 * 用法:
 *   const DesktopOnly = ({ children }) => useDesktopOnly(children, null)
 *   const el = useDesktopOnly(<div>仅客户端</div>, <div>web备选</div>)
 */
export function useDesktopOnly(clientContent: React.ReactNode, fallback: React.ReactNode = null) {
  return useIsTauri() ? clientContent : fallback
}

async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!getIsTauri()) return null
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

/**
 * 安卓壳专用 invoke:与上面 invoke 的门控相反(只认安卓,排除桌面与浏览器)。
 * 桌面/浏览器调用一律返回 null,永不发命令。
 */
async function androidInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T | null> {
  if (!isAndroidTauriShell()) return null
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

/** 安卓壳事件监听:非安卓环境返回空清理函数,监听失败静默降级 */
function listenAndroidEvent(event: string, handler: (payload: unknown) => void): () => void {
  if (!isAndroidTauriShell()) return () => {}
  let cleanup: (() => void) | null = null
  ;(async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      cleanup = await listen(event, (e) => handler(e.payload))
    } catch (err) {
      console.error(`[tauri] listen ${event} failed:`, err)
    }
  })()
  return () => {
    cleanup?.()
  }
}

/** updater_check 返回的更新信息(与 Rust UpdateInfo 字段对齐,serde camelCase) */
export interface AppUpdateInfo {
  version: string
  notes: string
  size: number
  /** update.apk 已完整落盘,可直接唤起安装器 */
  downloaded: boolean
  /** 同一版本的半成品字节数(>0 表示可从断点继续) */
  partialBytes: number
}

/** updater_status 返回的下载状态(与 Rust UpdateStatus 字段对齐) */
export interface AppUpdateStatus {
  downloading: boolean
  received: number
  total: number
  partialBytes: number
  /** 后台下载失败时事件可能丢,回前台用这里补错误文案 */
  lastError: string | null
  /** 已完整落盘的版本号 */
  downloadedVersion: string | null
}

/** 用户点「忽略此版本」记录的版本号 localStorage key */
const UPDATE_IGNORED_KEY = 'app:updateIgnoredVersion'

export function getUpdateIgnoredVersion(): string | null {
  try {
    return localStorage.getItem(UPDATE_IGNORED_KEY)
  } catch {
    return null
  }
}

export function setUpdateIgnoredVersion(version: string | null) {
  try {
    if (version === null) localStorage.removeItem(UPDATE_IGNORED_KEY)
    else localStorage.setItem(UPDATE_IGNORED_KEY, version)
  } catch {
    // ignore
  }
}

/** 回复完成通知开关 localStorage key('0'=关,缺省开) */
const NOTIFY_ON_REPLY_KEY = 'chat:notifyOnReply'

/**
 * 预约提醒的固定通知 id。
 * 插件的 cancel 是按 requestCode(= 通知 id)精确撤 AlarmManager 的闹钟,
 * 所以必须自持一个不会变的 id,而不是从 pending() 里捞 —— 捞出来的列表里
 * 混着别的通知,一刀切会误伤。
 */
const REPLY_REMINDER_ID = 47001

/**
 * 提醒文案。刻意不说「回复已完成」:闹钟响的那一刻我们并不知道结果 ——
 * 人一走 JS 就冻住,生成多半还停在半路。只催「回来看看」,两种情况都不撒谎。
 */
const REPLY_REMINDER_TITLE = 'aichatt · 回复提醒'
const REPLY_REMINDER_BODY = '刚发出的回复这会儿该有结果了,回来看一眼'

/** 通知正文摘要:多行 Markdown 压平成一行,超出 80 字截断 */
function squashForNotification(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

export const tauri = {
  isTauri: false, // safe fallback; use getIsTauri() for runtime checks

  /**
   * 打开设置独立子窗口(可拖出主窗口外)。
   * 窗口在 tauri.conf.json 预声明(visible:false),这里 show+focus;
   * 被用户关过时兜底重建。主窗口所有设置入口经 chat-store 拦截统一走到这里。
   */
  async openSettings() {
    if (!getIsTauri()) return
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      const existing = await WebviewWindow.getByLabel('settings')
      if (existing) {
        // 防导航漂移:窗口常驻保活,WebView 可能被留在别的页面(如服务异常时的
        // 404 页上点了“返回主页”→ 停在 /)。JS 侧无跨 WebView 读 URL/导航的
        // API(2.11 权限表也不提供),show+校验+拉回统一收口到 Rust 命令。
        await invoke('show_settings_window')
        return
      }
      const win = new WebviewWindow('settings', {
        url: '/settings-window/',
        title: '设置',
        width: 780,
        height: 640,
        minWidth: 560,
        minHeight: 480,
        center: true,
        decorations: false,
        shadow: true,
        resizable: true,
      })
      win.once('tauri://error', (e) => {
        console.error('[tauri] settings window create failed:', e)
      })
    } catch (err) {
      console.error('[tauri] openSettings failed:', err)
    }
  },

  /** 隐藏当前窗口(设置子窗口的“关闭”= 隐藏保活,下次打开瞬时) */
  async hideCurrentWindow() {
    if (!getIsTauri()) return
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().hide()
    } catch (err) {
      console.error('[tauri] hideCurrentWindow failed:', err)
    }
  },

  /**
   * 关闭窗口:先播「缩小淡出」退场动画(globals.css 的 tauri-app-out,
   * html 上 data-closing 门控),180ms 后再真正关窗。
   * 关闭失败(极少见)时回滚动画,窗口恢复可用。
   */
  close: () => {
    if (!getIsTauri()) return invoke('close_window')
    const html = document.documentElement
    if (html.hasAttribute('data-closing')) return Promise.resolve(null) // 防重复触发
    html.setAttribute('data-closing', '')
    return new Promise((resolve) => {
      window.setTimeout(() => {
        invoke('close_window')
          .catch(() => html.removeAttribute('data-closing'))
          .finally(() => resolve(null))
      }, 180)
    })
  },
  minimize: () => invoke('minimize_window'),
  toggleFullscreen: () => invoke('toggle_fullscreen'),
  toggleMaximize: () => invoke('toggle_maximize'),

  /**
   * 监听窗口状态变化(全屏/最大化进入退出),
   * 用于红绿灯图标的视觉反馈。
   */
  onResized(handler: () => void): () => void {
    if (!getIsTauri()) return () => {}
    let cleanup: (() => void) | null = null
    ;(async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      const unlisten = await win.onResized(handler)
      cleanup = unlisten
    })()
    return () => {
      cleanup?.()
    }
  },

  /**
   * 监听窗口焦点变化(失焦降饱和 / 红绿灯变灰,macOS 行为)。
   * handler 收到 true=获得焦点, false=失焦。Web 端为 no-op。
   */
  onFocusChange(handler: (focused: boolean) => void): () => void {
    if (!getIsTauri()) return () => {}
    let cleanup: (() => void) | null = null
    ;(async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      const unlisten = await win.onFocusChanged(({ payload }) => handler(payload))
      cleanup = unlisten
    })()
    return () => {
      cleanup?.()
    }
  },

  /**
   * AI 回复完成的系统通知(仅 Tauri 客户端)。
   * 触发条件:通知开关开启 + 窗口失焦(用户正看着窗口时不打扰)。
   * Web 端 no-op;系统通知权限未授予时静默放弃,不阻塞聊天主流程。
   */
  async notifyReplyDone(title: string, body: string) {
    if (!getIsTauriShell()) return
    if (!getNotifyOnReply()) return
    try {
      // document.hasFocus():WebView 失焦(最小化/被其他窗口遮挡/切走应用)时为 false,
      // 与 TauriVisualFX 的 focus 监听同语义,这里直接读文档焦点免维护全局状态
      if (document.hasFocus()) return
      const { isPermissionGranted, requestPermission, sendNotification } =
        await import('@tauri-apps/plugin-notification')
      let granted = await isPermissionGranted()
      if (!granted) {
        const permission = await requestPermission()
        granted = permission === 'granted'
      }
      if (!granted) return
      sendNotification({ title, body: squashForNotification(body) })
    } catch (err) {
      console.error('[tauri] notifyReplyDone failed:', err)
    }
  },

  /**
   * 预约一条「回来看回复」的系统通知(仅安卓壳)。
   *
   * 为什么必须预约而不是生成完再发:壳切后台时 WryActivity.onPause() 会同时调
   * Rust.pause() 和 mWebView.onPause(),后者按 Android 文档会暂停 JS 执行 ——
   * 也就是说人一走,前端既收不到流、也发不出通知,任何「完成时通知」的想法都落空。
   * 唯一还能在后台工作的东西是预约给系统的 AlarmManager 定时通知:
   * 发信那一刻(JS 必然还活着)先把闹钟挂上,人在前台看到完成就取消。
   *
   * 代价(定案时已认):时长是估的。到点时回复可能还在生成、也可能早写完了,
   * 所以文案只催「回来看」,不声称「已完成」。
   */
  async armReplyReminder() {
    if (!isAndroidTauriShell()) return
    if (!getNotifyOnReply()) return
    const delaySec = getReplyReminderDelaySec()
    if (delaySec <= 0) return
    try {
      const { isPermissionGranted, requestPermission, sendNotification, Schedule } =
        await import('@tauri-apps/plugin-notification')
      let granted = await isPermissionGranted()
      if (!granted) {
        const permission = await requestPermission()
        granted = permission === 'granted'
      }
      if (!granted) return
      // id 固定:cancel 只认 requestCode == 这个 id 的闹钟,同时保证连发多次
      // 是同一条闹钟(FLAG_CANCEL_CURRENT 覆盖),不会攒出一串提醒。
      sendNotification({
        id: REPLY_REMINDER_ID,
        title: REPLY_REMINDER_TITLE,
        body: REPLY_REMINDER_BODY,
        // repeating=false;allowWhileIdle=true → 走 setAndAllowWhileIdle。
        // 壳没申请 SCHEDULE_EXACT_ALARM(Android 13+ 新装默认拒绝),
        // 精确闹钟那条路 canScheduleExactAlarms()=false,只能靠这个档。
        schedule: Schedule.at(new Date(Date.now() + delaySec * 1000), false, true),
      })
    } catch (err) {
      console.error('[tauri] armReplyReminder failed:', err)
    }
  },

  /**
   * 取消预约的那条提醒。人在前台、回复已经落在屏幕上时它就没意义了。
   * 插件的 cancel(id) = 撤闹钟 + 撤已显示的通知 + 删存储三件事一起做,
   * 所以闹钟已经抢在回来之前响过的情况下,这一调用会把通知一并收掉。
   */
  async cancelReplyReminder() {
    if (!isAndroidTauriShell()) return
    try {
      const { cancel } = await import('@tauri-apps/plugin-notification')
      await cancel([REPLY_REMINDER_ID])
    } catch (err) {
      console.error('[tauri] cancelReplyReminder failed:', err)
    }
  },

  /**
   * 应用内自更新三件套(仅安卓壳,见 updater.rs)。
   * 旧 APK 上命令不存在 → invoke 抛错,一律吞掉返回 null/false:
   * 横幅在旧版上必须永远安静,所以错误不上报只打日志。
   */
  async updateCheck(): Promise<AppUpdateInfo | null> {
    try {
      return await androidInvoke<AppUpdateInfo | null>('updater_check')
    } catch (err) {
      console.error('[tauri] updater_check failed:', err)
      return null
    }
  },

  /** 启动后台下载;已完整落盘时 Rust 直接推 updater://done */
  async updateDownload(): Promise<boolean> {
    try {
      await androidInvoke('updater_download')
      return true
    } catch (err) {
      console.error('[tauri] updater_download failed:', err)
      return false
    }
  },

  /**
   * 下载状态查询。WebView 切后台会冻住 JS,期间的 progress/done/error 事件可能丢,
   * 回前台后靠它补齐;旧 APK 没有这条命令,invoke 抛错返回 null(横幅退回旧行为)。
   */
  async updateStatus(): Promise<AppUpdateStatus | null> {
    try {
      return await androidInvoke<AppUpdateStatus>('updater_status')
    } catch (err) {
      console.error('[tauri] updater_status failed:', err)
      return null
    }
  },

  /**
   * 唤起系统安装器。成功返回 null;失败返回 Rust 侧原文(含被回收的 Java 异常 toString),
   * 由横幅直接显示——真机没有控制台,错误必须上屏。
   */
  async updateInstall(): Promise<string | null> {
    try {
      await androidInvoke('updater_install')
      return null
    } catch (err) {
      console.error('[tauri] updater_install failed:', err)
      return err instanceof Error ? err.message : String(err)
    }
  },

  /** 下载进度 updater://progress {received,total}(Rust 侧 200ms 节流) */
  onUpdateProgress(handler: (received: number, total: number) => void): () => void {
    return listenAndroidEvent('updater://progress', (payload) => {
      const p = payload as { received: number; total: number }
      handler(p.received, p.total)
    })
  },

  /** 下载完成 updater://done */
  onUpdateDone(handler: () => void): () => void {
    return listenAndroidEvent('updater://done', handler)
  },

  /** 下载失败 updater://error(负载为错误文案);半截包保留在缓存里,重试自动续传 */
  onUpdateError(handler: (message: string) => void): () => void {
    return listenAndroidEvent('updater://error', (payload) => handler(String(payload)))
  },
}

/** 回复完成通知是否开启(设置弹窗「聊天行为」开关,默认开) */
export function getNotifyOnReply(): boolean {
  try {
    return localStorage.getItem(NOTIFY_ON_REPLY_KEY) !== '0'
  } catch {
    return true
  }
}

/** 写入回复完成通知开关(设置弹窗切换) */
export function setNotifyOnReply(enabled: boolean) {
  try {
    localStorage.setItem(NOTIFY_ON_REPLY_KEY, enabled ? '1' : '0')
  } catch {
    // ignore
  }
}

/** 预约提醒的等待时长(秒)localStorage key;'0' = 关掉提醒 */
const REPLY_REMINDER_DELAY_KEY = 'chat:replyReminderDelaySec'

/** 提醒默认 45s:常规问答多数 10~30s 出结果,留一点余量再催 */
const REPLY_REMINDER_DEFAULT_SEC = 45

/** 回复提醒延时秒数(设置弹窗「聊天行为」可调)。0=关;脏值回落到默认档 */
export function getReplyReminderDelaySec(): number {
  try {
    const raw = localStorage.getItem(REPLY_REMINDER_DELAY_KEY)
    if (raw === null) return REPLY_REMINDER_DEFAULT_SEC
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : REPLY_REMINDER_DEFAULT_SEC
  } catch {
    return REPLY_REMINDER_DEFAULT_SEC
  }
}

/** 写入回复提醒延时秒数(设置弹窗切换) */
export function setReplyReminderDelaySec(sec: number) {
  try {
    localStorage.setItem(REPLY_REMINDER_DELAY_KEY, String(Math.max(0, Math.trunc(sec))))
  } catch {
    // ignore
  }
}