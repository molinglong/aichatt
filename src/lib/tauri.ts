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

/**
 * 安卓壳:生成期间启动前台服务(通知栏常驻「正在生成」)。
 *
 * 目的不只是提示:服务运行期间 WryActivity 不暂停 WebView,切后台后 JS/SSE
 * 继续跑,完成那一刻前端才能调系统通知。返回是否成功启动(失败时沿用旧路径)。
 */
export async function startGenerationNotification(): Promise<boolean> {
  if (!isAndroidTauriShell()) return false
  try {
    // 前台服务通知与完成通知共用 Android 13+ 的通知权限。
    // 必须在用户还看得见页面时请求;切后台后系统不会展示权限框。
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
    if (!(await isPermissionGranted())) await requestPermission()
  } catch {
    // 权限请求失败不阻塞:服务仍可启动,只是通知不可见
  }
  try {
    await androidInvoke('generation_notification_start')
    return true
  } catch (err) {
    console.error('[tauri] startGenerationNotification failed:', err)
    return false
  }
}

/** 安卓壳:停止生成前台服务,移除常驻通知。非安卓 no-op。 */
export async function stopGenerationNotification(): Promise<void> {
  if (!isAndroidTauriShell()) return
  try {
    await androidInvoke('generation_notification_stop')
  } catch (err) {
    console.error('[tauri] stopGenerationNotification failed:', err)
  }
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

/** 桌面壳事件监听:非桌面环境返回空清理函数(与 listenAndroidEvent 对称) */
export function listenDesktopEvent(event: string, handler: (payload: unknown) => void): () => void {
  if (!getIsTauri()) return () => {}
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

/** 深链带图提问载荷(与 Rust DeepLinkAsk 字段对齐,2026-11-19 浏览器截图链路) */
export interface DeepLinkAskPayload {
  img: string | null
  text: string | null
  server: string | null
  id: string | null
  kind: string | null
}

/**
 * 桌面壳:取走未消费的深链提问(冷启动兜底)。
 * 热唤起时 Rust 会 emit "deeplink://ask" 实时事件,由 DeepLinkBridge 监听;
 * 冷启动时 webview 未就绪事件会丢,Rust 落了 pending,这里补领(拿到即删)。
 */
export async function takeDeepLinkAsk(): Promise<DeepLinkAskPayload | null> {
  return invoke<DeepLinkAskPayload | null>('deep_link_ask_take')
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

/** focus_lock_status 返回(与 Rust FlStatus 字段对齐,serde camelCase) */
export interface FocusLockStatus {
  locked: boolean
  /** 锁定截止时刻(墙钟毫秒);未锁定为 0;正计时档恒 0 */
  endsAtMs: number
  /** 剩余毫秒(正计时档 = 已专注毫秒);未锁定为 0 */
  remainingMs: number
  /** 正计时档(D13):无截止时刻,按 startedAtMs 起累计,唯一出口 focusLockEnd */
  countUp: boolean
  /** 锁开始时刻(正计时计秒起点;倒计时档用于续锁展示);未锁定为 0 */
  startedAtMs: number
  /** 失焦自动拉回是否开启 */
  refocus: boolean
  /** 第 2 波课程画中画窗口 URL;第 1 波恒为 null */
  courseUrl: string | null
  /** 本次进程启动是否由 boot 续锁(前端据此弹「已恢复锁定」提示) */
  restored: boolean
}

/** course_get_state 返回(与 Rust CourseState 字段对齐) */
export interface CourseState {
  /** 预创建是否完成(boot 后短暂 false,期间命令报「未就绪」) */
  ready: boolean
  /** 面板是否打开(course webview 可见) */
  open: boolean
  /** 课程区宽度占窗口宽度比例 0.30–0.55 */
  split: number
  /** 当前页面地址(on_navigation 主框架导航时更新) */
  url: string
  locked: boolean
}

/** course_screenshot 返回(与 Rust CourseScreenshot 字段对齐) */
export interface CourseScreenshotPayload {
  /** PNG 整图 base64(无 data: 前缀) */
  data: string
  width: number
  height: number
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
   * 监管模式:启动窗口锁定(真全屏 + 置顶 + 拦关闭/最小化 + 失焦拉回)。
   * Rust 侧校验 5..=240 分钟;失败 reject 原因文案,由调用方 toast。
   * countUp = 正计时档(D13):无截止时刻,minutes 被忽略;唯一出口 focusLockEnd。
   * Web 端 invoke 返回 null —— 调用方以 useIsTauri 门控入口,这里不做 UI 假装。
   */
  async focusLockStart(
    minutes: number,
    refocus: boolean,
    courseUrl?: string | null,
    testSeconds?: number,
    countUp?: boolean
  ): Promise<FocusLockStatus | null> {
    const st = await invoke<FocusLockStatus>('focus_lock_start', {
      minutes,
      refocus,
      courseUrl: courseUrl ?? null,
      testSeconds: testSeconds ?? null,
      countUp: countUp ?? false,
    })
    if (st === null) throw new Error('仅桌面客户端支持监管模式')
    return st
  },

  /** 监管模式:查询锁状态;旧 exe / Web 端返回 null(调用方静默按未锁定处理) */
  async focusLockStatus(): Promise<FocusLockStatus | null> {
    try {
      return await invoke<FocusLockStatus>('focus_lock_status')
    } catch (err) {
      console.error('[tauri] focus_lock_status failed:', err)
      return null
    }
  },

  /** 监管模式:测试阶段手动暂停锁定并还原窗口(验收后随测试入口移除) */
  async focusLockStop(): Promise<FocusLockStatus | null> {
    const st = await invoke<FocusLockStatus>('focus_lock_stop')
    return st
  },

  /** 监管模式:正计时档手动结束(D15,主动结束不算破戒);倒计时锁 Rust 侧拒绝 */
  async focusLockEnd(): Promise<FocusLockStatus | null> {
    const st = await invoke<FocusLockStatus>('focus_lock_end')
    return st
  },

  /** 监管模式:锁定期用户试图关闭/最小化等,推送剩余毫秒(拦截回执) */
  onFocusLockBlocked(handler: (remainingMs: number) => void): () => void {
    return listenDesktopEvent('focus-lock://blocked', (p) =>
      handler(Number((p as { remainingMs?: number })?.remainingMs ?? 0))
    )
  },

  /** 监管模式:到点/手动解锁前的退场过场信号(payload = 本次锁定分钟数);
      收到后窗口仍全屏锁定,约 2.7s 后 ended 到达(窗口已还原) */
  onFocusLockEnding(handler: (totalMin: number) => void): () => void {
    return listenDesktopEvent('focus-lock://ending', (p) =>
      handler(Number((p as { totalMin?: number })?.totalMin ?? 0))
    )
  },

  /** 监管模式:自然到期解锁(payload = 本次锁定分钟数) */
  onFocusLockEnded(handler: (totalMin: number) => void): () => void {
    return listenDesktopEvent('focus-lock://ended', (p) =>
      handler(Number((p as { totalMin?: number })?.totalMin ?? 0))
    )
  },

  /** 监管模式:重启后自动续锁(payload = 剩余毫秒) */
  onFocusLockRestored(handler: (leftoverMs: number) => void): () => void {
    return listenDesktopEvent('focus-lock://restored', (p) =>
      handler(Number((p as { leftoverMs?: number })?.leftoverMs ?? 0))
    )
  },

  // ── 课堂分栏浏览器(course_browser.rs,§3.2)────────────────────────

  /** 课程面板:打开并可选直接导航;split/Rust 侧管理,DOM 壳由 CourseBrowser 渲染 */
  async coursePanelShow(url?: string | null): Promise<void> {
    await invoke('course_panel_show', { url: url ?? null })
  },

  /** 课程面板:收起(course webview 隐藏,聊天恢复全宽) */
  async coursePanelHide(): Promise<void> {
    await invoke('course_panel_hide')
  },

  /** 课程面板:分隔条松手后一次性调(0.30–0.55,Rust 侧 clamp) */
  async coursePanelResize(split: number): Promise<void> {
    await invoke('course_panel_resize', { split })
  },

  /** 课程面板:导航(无 scheme 自动补 https://;面板未开时隐含打开) */
  async courseNavigate(url: string): Promise<void> {
    await invoke('course_navigate', { url })
  },

  /** 课程面板:后退/前进/刷新 —— eval history API,整 webview 级无跨域限制 */
  async courseGoBack(): Promise<void> {
    await invoke('course_go_back')
  },
  async courseGoForward(): Promise<void> {
    await invoke('course_go_forward')
  },
  async courseReload(): Promise<void> {
    await invoke('course_reload')
  },
  /** 课程面板:回主页(启动首页)——停媒体+隐藏原生层+清地址,前端空态显示 */
  async courseHome(): Promise<void> {
    await invoke('course_home')
  },

  /** 课程面板:读状态(boot 后短暂 not ready,调用方按 closed 处理) */
  async courseGetState(): Promise<CourseState | null> {
    try {
      return await invoke<CourseState>('course_get_state')
    } catch (err) {
      console.error('[tauri] course_get_state failed:', err)
      return null
    }
  },

  /**
   * 课堂截图提问:GDI 截 course webview 物理矩形(含视频帧),PNG base64 回传,
   * 上传走前端 /api/upload(落 UploadFile 记录,不受孤儿清扫误伤)。
   * 面板未打开/没加载页面 reject,由调用方 toast。
   */
  async courseScreenshot(): Promise<CourseScreenshotPayload> {
    const shot = await invoke<CourseScreenshotPayload>('course_screenshot')
    if (!shot || !shot.data) throw new Error('course screenshot unavailable')
    return shot
  },

  /**
   * 框选配合(2026-11-20 方案 B):临时隐藏/恢复 course webview。
   * 课程区是原生子窗口,会盖住 DOM 框选层;截图后藏起来,框完立即恢复。
   * 不动面板开合状态(工具栏/分栏布局保持),隐藏时静默暂停媒体。
   */
  async courseSetVeiled(veiled: boolean): Promise<void> {
    await invoke('course_set_veiled', { veiled })
  },

  /** 课程面板:主框架导航后 Rust 推送地址(payload = url 字符串) */
  onCourseNavigated(handler: (url: string) => void): () => void {
    return listenDesktopEvent('course://navigated', (p) => handler(String(p ?? '')))
  },

  /** 课程面板:锁定期门卫拒绝导航(payload = 被拒 url);前端节流弹提示 */
  onCourseBlocked(handler: (url: string) => void): () => void {
    return listenDesktopEvent('course://blocked', (p) => handler(String(p ?? '')))
  },

  /** 课程面板:锁定期结束面板自动收起(Rust 已隐 webview,前端收 DOM 壳恢复全宽) */
  onCourseLockEnded(handler: () => void): () => void {
    return listenDesktopEvent('course://lock-ended', () => handler())
  },

  /**
   * 查询窗口是否最大化(窗口圆角 CSS 门控用;Web 端恒 false)。
   */
  async isMaximized(): Promise<boolean> {
    if (!getIsTauri()) return false
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return await getCurrentWindow().isMaximized()
    } catch {
      return false
    }
  },

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

