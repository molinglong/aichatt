/**
 * iziToast 封装层
 * - 客户端单例: 全局只初始化一次
 * - 视觉: macOS 通知式主题毛玻璃 —— 浅色=白玻璃深字,夜间=深灰玻璃白字;
 *   语义色只用于 SVG 图标点缀,不再整块染色,与全站黑白灰体系一致
 * - 暴露命令式 API,供 UI 各处调用,无需 Provider 包裹
 *
 * 注意: 仅可在 'use client' 组件 / 事件回调中使用,不要在 Server Component 中 import。
 */

import type iziToastType from 'izitoast'

type Izitoast = typeof iziToastType

/** iziToast 实例: 挂在模块作用域供兜底分支复用 */
let instance: Izitoast | null = null
let cssLoaded = false
let initPromise: Promise<Izitoast> | null = null

/** 实际加载 + 初始化,失败即抛(由 ensureClient 统一收口) */
async function loadIziToast(): Promise<Izitoast> {
  // 动态加载 JS 即可,CSS 已由 globals.css 顶部 @import 静态内联(修 Next 14.2 css chunk 关联 bug)
  // iziToast 是 CJS 包(`module.exports = ...`),在 Next.js webpack ESM 互操作下,
  // 既可能是整个 module,也可能被包成 `{ default: <module> }`。
  // 兼容两种形态,以及 iziToast 自己挂在 `.iziToast` 上的 UMD 形态。
  const mod = await import('izitoast')

  if (!cssLoaded) cssLoaded = true

  const iziToast = (mod as any)?.iziToast ?? (mod as any)?.default ?? mod
  if (!iziToast || typeof iziToast.show !== 'function') {
    console.error('[toast] iziToast loaded but .show() not found. mod keys:', Object.keys(mod || {}))
    throw new Error('iziToast failed to load')
  }

  iziToast.settings({
    // 全局默认值,可在单次调用时覆盖
    position: 'topRight',
    timeout: 5000,
    closeOnClick: true,
    closeOnEscape: true,
    drag: true,
    // 鼠标悬浮暂停倒计时 —— 方便用户阅读/复制错误内容
    pauseOnHover: true,
    // 暂停时把进度条也停下(更直观能看到时间被冻结)
    resetOnHover: false,
    progressBar: true,
    progressBarEasing: 'linear',
    transitionIn: 'fadeInDown',
    transitionOut: 'fadeOutUp',
    // 视觉外壳不在这里注入 —— 每个 toast 通过 buildKindOptions 传入自己的
    // onOpening(会覆盖全局同名回调),携带 kind 点缀色与亮/暗两套配色
    layout: 2,
    balloon: false,
    maxWidth: 380,
    theme: 'light',
    iconText: '',
  })

  return iziToast
}

/**
 * 取 iziToast 实例;不可用时返回 null,由调用方降级到零依赖兜底提示。
 *
 * 关键一:失败绝不缓存。dev 重启后旧页面 runtime 引用的动态 chunk 会瞬时 404
 * (ChunkLoadError),一旦把 rejected promise memo 住,整个会话的 toast 就永久报废
 * 且不再重试 —— 复位后下一次调用还能把 toast 救回来。
 * 关键二:加载失败只记日志,不向上抛。toast 是提示通道而非业务链路,
 * 让它冒泡只会变成 Next 全屏 Unhandled Runtime Error,把真正的报错文案一起吞掉。
 */
async function ensureClient(): Promise<Izitoast | null> {
  if (typeof window === 'undefined') return null
  if (instance) return instance

  if (!initPromise) {
    initPromise = loadIziToast().then(
      (loaded) => {
        instance = loaded
        return loaded
      },
      (err) => {
        initPromise = null
        throw err
      },
    )
  }

  try {
    return await initPromise
  } catch (err) {
    console.warn('[toast] iziToast 加载失败,降级为兜底提示:', err)
    return null
  }
}

export type ToastKind = 'error' | 'success' | 'warning' | 'info'

interface ToastOptions {
  title?: string
  message: string
  /** 毫秒;0 = 不自动关闭 */
  timeout?: number
  /** 覆盖默认位置 */
  position?:
    | 'topRight'
    | 'topCenter'
    | 'topLeft'
    | 'bottomRight'
    | 'bottomCenter'
    | 'bottomLeft'
    | 'center'
  /**
   * 点击 toast 主体时触发;返回 false 时不自动关闭(让调用方决定何时 hide)。
   * 设置后默认会关闭整 toast 的 closeOnClick,避免用户点了按钮又被自动关掉。
   */
  onClick?: (hide: () => void) => void | boolean
}

/**
 * 语义点缀色: 只用于 SVG 图标着色,不再染色底/标题/竖条/进度条。
 * info 用系统灰 --content-muted —— 与项目"单一中灰强调色"体系一致。
 */
const KIND_CONFIG: Record<ToastKind, { accent: string }> = {
  error: { accent: '#ef4444' },
  success: { accent: '#10b981' },
  warning: { accent: '#f59e0b' },
  info: { accent: 'rgb(var(--content-muted))' },
}

/**
 * 语义图标(Lucide 描边风格): stroke 继承 currentColor,
 * 由 applyToastChrome 注入并以 KIND_CONFIG.accent 着色。
 */
const KIND_ICON: Record<ToastKind, string> = {
  error:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  success:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="8.5 12.5 11 15 15.5 9.5"/></svg>',
  warning:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
}

interface ToastPalette {
  background: string
  border: string
  titleColor: string
  messageColor: string
  shadow: string
  /** 进度条中性色: 自带透明度,不再染语义色(彩色进度条在深色玻璃上会喧宾夺主) */
  progressBar: string
  /** 深色玻璃上的深色 close × 需要反相才可见 */
  invertClose: boolean
}

/**
 * 跟随主题材质的毛玻璃配色(macOS 通知式): 浅色=白玻璃深字,夜间=深玻璃白字。
 * 色值全部引用 globals.css 的 token —— 内联样式里的 var() 会实时解析,
 * 深浅两套与任意配色(如月白·桂花金)自动跟随,不再有硬编码色值露馅。
 * show 时实时读取 <html>.dark,与 layout.tsx 的主题同步逻辑保持一致。
 */
function palette(): ToastPalette {
  const isDark = document.documentElement.classList.contains('dark')
  if (isDark) {
    // 夜间: toast 取比面板更亮一档的玻璃浮起
    return {
      background: 'rgb(var(--surface-muted) / 0.78)',
      border: 'rgb(var(--foreground) / 0.1)',
      titleColor: 'rgb(var(--content-primary))',
      messageColor: 'rgb(var(--content-primary) / 0.68)',
      shadow: '0 12px 32px rgba(0,0,0,0.5)',
      progressBar: 'rgb(var(--content-primary) / 0.22)',
      invertClose: true,
    }
  }
  // 浅色: 白玻璃与浅色界面同族
  return {
    background: 'rgb(var(--surface-glass) / 0.72)',
    border: 'rgb(var(--foreground) / 0.08)',
    titleColor: 'rgb(var(--content-primary))',
    messageColor: 'rgb(var(--content-primary) / 0.6)',
    shadow: '0 12px 32px rgba(0,0,0,0.18)',
    progressBar: 'rgb(var(--content-primary) / 0.15)',
    invertClose: false,
  }
}

/** 外壳统一样式: 毛玻璃底、描边、圆角、SVG 语义图标、字体 */
function applyToastChrome(
  toastEl: HTMLElement,
  iconSvg: string,
  accent: string,
  pal: ToastPalette,
): void {
  // 跟随全站系统字体栈,替换 iziToast 内置的 Lato/Tahoma
  toastEl.style.fontFamily = 'inherit'
  toastEl.style.borderRadius = '12px'
  toastEl.style.border = `1px solid ${pal.border}`
  // 毛玻璃: 全站统一配方(与 globals.css .glass-blur 同参),低不透明度底色才能透出被覆盖的聊天内容
  toastEl.style.backdropFilter = 'blur(20px) saturate(180%)'
  const style = toastEl.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }
  style.webkitBackdropFilter = 'blur(20px) saturate(180%)'
  toastEl.style.overflow = 'hidden'
  // 纯外阴影: iziToast 自带的 ::after 阴影层(含 inset 内阴影)已在 globals.css 关闭
  toastEl.style.boxShadow = pal.shadow

  // SVG 语义图标: 复刻 iziToast 原生 icon 的绝对定位(挂在 body 左侧),
  // 同时把 texts 的 padding 让出图标宽度,避免重叠
  const bodyEl = toastEl.querySelector('.iziToast-body')
  if (bodyEl instanceof HTMLElement) {
    bodyEl.style.paddingLeft = '30px'
    const holder = document.createElement('span')
    holder.setAttribute('aria-hidden', 'true')
    holder.style.cssText = [
      'position:absolute',
      'left:0',
      'top:50%',
      'transform:translateY(-50%)',
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'width:20px',
      'height:20px',
      `color:${accent}`,
    ].join(';')
    holder.innerHTML = iconSvg
    bodyEl.insertBefore(holder, bodyEl.firstChild)
  }
  // iziToast 原生 icon 容器(若有)一律隐藏,避免与 SVG 图标重复
  const iconEl = toastEl.querySelector('.iziToast-icon')
  if (iconEl instanceof HTMLElement) iconEl.style.display = 'none'

  // 进度条保持中性: 轨道隐形,只留一条细倒计时线,不与图标争色
  const pbEl = toastEl.querySelector('.iziToast-progressbar')
  if (pbEl instanceof HTMLElement) pbEl.style.background = 'transparent'

  // close × 对比度: 深色玻璃上反相为白,亮玻璃上仅降透明度
  const closeEl = toastEl.querySelector('.iziToast-close')
  if (closeEl instanceof HTMLElement) {
    closeEl.style.filter = pal.invertClose ? 'invert(1)' : 'none'
    closeEl.style.opacity = '0.55'
  }
}

function buildKindOptions(kind: ToastKind, opts: ToastOptions) {
  const cfg = KIND_CONFIG[kind]
  // 错误类默认更长(8s),其他 5s。
  // 鼠标悬浮会暂停倒计时,所以即使默认长也不会影响用户操作。
  const defaultTimeout = kind === 'error' ? 8000 : 5000
  const pal = palette()
  return {
    title: opts.title ?? defaultTitle(kind),
    message: opts.message,
    backgroundColor: pal.background,
    class: `iziToast--aichatt`,
    // 仅在显式传入时才附加 position,否则会覆盖 settings() 默认值,
    // 且 iziToast 不接受 undefined(它会 console.warn 并丢弃整个 toast)
    ...(opts.position ? { position: opts.position } : {}),
    timeout: opts.timeout ?? defaultTimeout,
    titleSize: '13px',
    titleColor: pal.titleColor,
    messageColor: pal.messageColor,
    messageSize: '13px',
    progressBarColor: pal.progressBar,
    progressBarOpacity: 1,
    iconText: '',
    // per-toast onOpening 覆盖全局 settings 的同名回调,携带 kind 图标与点缀色
    onOpening: (_instance: unknown, toastEl: HTMLElement) => {
      applyToastChrome(toastEl, KIND_ICON[kind], cfg.accent, pal)
    },
  }
}

function defaultTitle(kind: ToastKind): string {
  switch (kind) {
    case 'error':
      return '出错了'
    case 'success':
      return '操作成功'
    case 'warning':
      return '请注意'
    case 'info':
      return '提示'
  }
}

/**
 * 零依赖兜底提示 —— iziToast 不可用时(动态 chunk 404 / show() 抛异常)的降级通道。
 * 提示通道的职责是把"保存失败:已存在相同或相似的记忆"这类真实原因送到眼前,
 * 因此它自身故障时不能连消息一起丢掉。样式沿用全站 token 与玻璃配方,
 * 与 iziToast 主题观感一致。
 */
const FALLBACK_STACK_PREFIX = 'aichatt-toast-fallback-'

function fallbackToast(kind: ToastKind, opts: ToastOptions): void {
  try {
    const pal = palette()
    const cfg = KIND_CONFIG[kind]
    const timeout = opts.timeout ?? (kind === 'error' ? 8000 : 5000)
    const position = opts.position ?? 'topRight'
    const side = position.startsWith('bottom') ? 'bottom' : 'top'

    const stackId = FALLBACK_STACK_PREFIX + side
    let stack = document.getElementById(stackId)
    if (!stack) {
      stack = document.createElement('div')
      stack.id = stackId
      stack.setAttribute('role', 'status')
      stack.setAttribute('aria-live', 'polite')
      // 位置对齐 iziToast 手机端重排(globals.css 同名规则): top 挂 --m-chrome-top
      // 体系避开刘海/挖孔,bottom 让出手势条;手机端居中,桌面保持右上角。
      // inline style 里引用 var() 实时解析,与 globals.css 的变量自动同步。
      const mobile = window.matchMedia('(max-width: 767px)').matches
      const pos = [
        side === 'bottom'
          ? 'bottom:max(var(--sab, 0px), 12px)'
          : 'top:calc(var(--m-chrome-top, 16px) + 88px)',
      ]
      if (mobile) {
        pos.push('left:0', 'right:0', 'align-items:center')
      } else {
        pos.push('right:16px')
      }
      stack.style.cssText = [
        'position:fixed',
        'z-index:99999',
        ...pos,
        'display:flex',
        `flex-direction:${side === 'bottom' ? 'column-reverse' : 'column'}`,
        'gap:8px',
        'pointer-events:none',
      ].join(';')
      document.body.appendChild(stack)
    }

    const item = document.createElement('div')
    item.style.cssText = [
      'display:flex',
      'align-items:flex-start',
      'gap:10px',
      'max-width:380px',
      'min-width:220px',
      'padding:10px 12px',
      'border-radius:12px',
      `background:${pal.background}`,
      `border:1px solid ${pal.border}`,
      'backdrop-filter:blur(20px) saturate(180%)',
      '-webkit-backdrop-filter:blur(20px) saturate(180%)',
      `box-shadow:${pal.shadow}`,
      'font-family:inherit',
      'font-size:13px',
      'line-height:1.5',
      'cursor:pointer',
      'pointer-events:auto',
      'opacity:0',
      `transform:${side === 'bottom' ? 'translateY(6px)' : 'translateY(-6px)'}`,
      'transition:opacity .18s ease, transform .18s ease',
    ].join(';')

    const iconEl = document.createElement('span')
    iconEl.setAttribute('aria-hidden', 'true')
    iconEl.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'flex:0 0 auto',
      `color:${cfg.accent}`,
    ].join(';')
    iconEl.innerHTML = KIND_ICON[kind]
    item.appendChild(iconEl)

    const texts = document.createElement('div')
    texts.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0'
    if (opts.title) {
      const titleEl = document.createElement('div')
      titleEl.textContent = opts.title
      titleEl.style.cssText = `font-weight:600;color:${pal.titleColor}`
      texts.appendChild(titleEl)
    }
    const msgEl = document.createElement('div')
    msgEl.textContent = opts.message
    msgEl.style.cssText = `color:${pal.messageColor};word-break:break-word`
    texts.appendChild(msgEl)
    item.appendChild(texts)

    const dismiss = () => {
      item.style.opacity = '0'
      item.style.transform = side === 'bottom' ? 'translateY(6px)' : 'translateY(-6px)'
      window.setTimeout(() => item.remove(), 180)
    }
    // 悬浮暂停倒计时 —— 与 iziToast 行为一致,长错误文案不至于读不完就消失
    let timer: number | null = null
    const start = () => {
      if (timeout > 0) timer = window.setTimeout(dismiss, timeout)
    }
    const stop = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }
    item.addEventListener('mouseenter', stop)
    item.addEventListener('mouseleave', start)
    item.addEventListener('click', () => {
      stop()
      dismiss()
    })

    stack.appendChild(item)
    // 下一帧再置位,确保 transition 真正跑起来
    requestAnimationFrame(() => {
      item.style.opacity = '1'
      item.style.transform = 'translateY(0)'
      start()
    })
  } catch (err) {
    console.error('[toast] 兜底提示显示失败:', err)
  }
}

/** 通用入口,内部用 —— 永不抛错,任何失败都降级到兜底提示 */
async function show(kind: ToastKind, opts: ToastOptions): Promise<void> {
  const it = await ensureClient()
  if (it) {
    try {
      it.show(buildKindOptions(kind, opts))
      return
    } catch (err) {
      console.warn('[toast] iziToast.show 异常,降级为兜底提示:', err)
    }
  }
  fallbackToast(kind, opts)
}

type ToastApi = {
  error: (message: string, opts?: Omit<ToastOptions, 'message'>) => Promise<void>
  success: (message: string, opts?: Omit<ToastOptions, 'message'>) => Promise<void>
  warning: (message: string, opts?: Omit<ToastOptions, 'message'>) => Promise<void>
  info: (message: string, opts?: Omit<ToastOptions, 'message'>) => Promise<void>
  /**
   * 通道① 轻提示: 底部居中无标题胶囊, 2s 自动收。
   * 只用于"已复制/已重新生成/已删除"这类即时回执 —— 需要用户决策的一律走确认框, 不要用它。
   */
  hint: (message: string) => Promise<void>
  /** 长驻 toast,需要用户主动关闭 */
  sticky: (kind: ToastKind, opts: ToastOptions) => Promise<void>
  /** 销毁所有 toast(测试 / 路由切换时使用) */
  destroy: () => Promise<void>
}

export const toast: ToastApi = {
  error: (message, opts) => show('error', { message, ...opts }),
  success: (message, opts) => show('success', { message, ...opts }),
  warning: (message, opts) => show('warning', { message, ...opts }),
  info: (message, opts) => show('info', { message, ...opts }),
  hint: (message) => show('info', { message, title: '', position: 'bottomCenter', timeout: 2000 }),
  sticky: (kind, opts) => show(kind, { ...opts, timeout: 0 }),
  destroy: async () => {
    try {
      const it = await ensureClient()
      it?.destroy()
    } catch (err) {
      console.warn('[toast] iziToast destroy 失败:', err)
    }
    document
      .querySelectorAll(`[id^="${FALLBACK_STACK_PREFIX}"]`)
      .forEach((node) => node.remove())
  },
}

/** 预热入口, ToasterBridge 在挂载时调用 */
export { ensureClient }

/**
 * SSR 守卫: 用于在事件回调 / effect 中预检
 */
export const isClient = () => typeof window !== 'undefined'