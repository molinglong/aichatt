/**
 * 主题体系单点控制 —— 外观是**一维**的: 选设置里的「主题」等于选一件事。
 *   light / dark / system → 黑白基线
 *   grid                  → 格子,自带光态: 白天(正午) / 暮色(日落) / 晚上(深夜)
 *   wallpaper             → 壁纸(用户自拍的那张云),明暗另配(浅色/深色/跟随系统)
 * 设置面板随之分两排: 上面那排是主题(五选一),下面那排按主题切换内容 ——
 * 非格子非壁纸时选配色(黑白基线),格子时选白天/暮色/晚上,壁纸时选明暗。
 * 「月白·桂花金」配色已于 2026-10-25 删除,存量存储值一律回落黑白基线。
 *
 * CSS 侧由四个属性驱动(样式层不必知道这套一维模型):
 *   html.dark              → 明暗(格子下 = gridTone === 'night',壁纸下 = wallpaperScheme)
 *   html[data-pal]         → base | grid | wallpaper
 *   html[data-grid-tone]   → dawn | day | dusk | night(仅格子写,区分四个光态)
 *   html[data-style]       → classic | bigsur(形状/材质维度,与明暗配色正交,见 UiStyle)
 *   html[data-wallpaper]   → on | off(壁纸层显隐唯一判据,纯 CSS 驱动)
 * 格子的光态由 gridTone 决定,且不覆盖用户的明暗偏好 —— 退出格子时原样恢复。
 * 壁纸同理: 明暗记在 wallpaperScheme,不动 theme 键。
 *
 * 三个写入方共用本模块,行为必须一致:
 *   1) src/app/layout.tsx 首帧内联脚本(不能 import,逻辑等价照抄,防首帧闪白)
 *   2) src/components/SettingsModal.tsx 外观选择器(手动)
 *   3) src/lib/settings/executor.ts AI 设置工具(update_settings 的 theme 分支)
 *
 * 历史值归一: 'dusk'(暮色·落霞)已并入格子,读取时映射为 grid。
 */

export type ThemeMode = 'light' | 'dark' | 'system'
/** 写进 html[data-pal] 的取值(「月白·桂花金」已删除,存量值在读取时回落 base)。
 *  wallpaper 与 grid 同类: 它只用来记住「当前主题是壁纸」这一个事实 */
export type PaletteId = 'base' | 'grid' | 'wallpaper'
/** 能出现在「配色」选择器里的 —— 格子/壁纸不算配色,它们是主题 */
export type SelectablePalette = Exclude<PaletteId, 'grid' | 'wallpaper'>
/** 格子的四个光态(一扇窗的一天,按时间序):
 *  日出(右上低角·冷暖对峙·浅底) / 白天(正午顶光·浅底) /
 *  暮色(日落暖橙·浅底) / 晚上(深夜冷蓝·深底) */
export type GridTone = 'dawn' | 'day' | 'dusk' | 'night'
/** 光态偏好的存储取值: 具体哪一态,或 'auto'(交给时间自动决定,见 resolveAutoTone)。
 *  只有 localStorage 存这个;写到 html[data-grid-tone] 的永远是具体四值之一 ——
 *  故 CSS 侧(globals.css 的四个门控块)完全不需要知道"智能"存在 */
export type GridTonePref = GridTone | 'auto'
/** 「主题」选择器里被选中的那一项 */
export type ThemeChoice = ThemeMode | 'grid' | 'wallpaper'
/** 壁纸的明暗子档: 壁纸主题下「下面那排」选的就是这个,不动用户的 theme 偏好 */
export type WallpaperScheme = ThemeMode

/**
 * UI 样式维度(第二维,与明暗/配色正交): 管**形状与材质**,不管颜色。
 *   classic = 现行基线(玻璃只给浮层)
 *   bigsur  = Big Sur 玻璃(玻璃扩到侧栏/顶栏/输入岛,双层软阴影 + 双环描边,
 *             黑白基线强调色换系统蓝)。参数定稿自 GitHub 参考
 *             (PuruVJ/macos-web 窗口阴影/描边、tauri-apps/window-vibrancy),
 *             预览见 public/preview-ui-style.html。
 *   google  = Google 2020(Gmail 侧栏 + Google Chat 会话):浅灰蓝侧栏、白底内容、
 *             8px 卡片、#1A73E8 主色、顶栏搜索框;移动端固定顶栏 + M2 底部导航。
 *             预览见 public/preview-material3.html(文件名沿用旧版,内容是 Google 2020)。
 * 缺省(无存储值)取 bigsur —— trial 验收默认即新样式;想回旧观感选 classic。
 */
export type UiStyle = 'classic' | 'bigsur' | 'google'

export const THEME_STORAGE_KEY = 'theme'
export const PALETTE_STORAGE_KEY = 'palette'
export const GRID_TONE_STORAGE_KEY = 'gridTone'
export const UI_STYLE_STORAGE_KEY = 'uiStyle'
export const WALLPAPER_SCHEME_STORAGE_KEY = 'wallpaperScheme'

/** 设置面板「样式」一排。
 *  2026-10-31 用户指令:暂时只保留 Big Sur 玻璃,经典 / Google 2020 从选择入口隐藏 ——
 *  类型、CSS 渲染分支、首帧脚本全部保留,恢复时把下面两行注释解开即可。
 *  已选经典/Google 的浏览器存量偏好不受影响(仍按旧值渲染,只是设置里不再出现选项)。 */
export const UI_STYLES: { value: UiStyle; label: string }[] = [
  // { value: 'classic', label: '经典' },
  { value: 'bigsur', label: 'Big Sur 玻璃' },
  // { value: 'google', label: 'Google 2020' },
]

/** 格子: 日出 / 白天 / 暮色 / 晚上 */
export const GRID_PALETTE = 'grid' as const
/** 壁纸: 只用来记住「当前主题是壁纸」(与 GRID_PALETTE 同一套路) */
export const WALLPAPER_PALETTE = 'wallpaper' as const

/** 上面那排: 主题(明暗三态 + 格子 + 壁纸) */
export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
  { value: 'grid', label: '格子' },
  { value: 'wallpaper', label: '壁纸' },
]

/** 下面那排(主题 = 壁纸时): 壁纸的明暗。默认跟随系统 */
export const WALLPAPER_SCHEMES: { value: WallpaperScheme; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

/** 下面那排(主题 = 格子时): 格子的光态,按一天的时间序排 —— 一扇窗的四个时刻 */
export const GRID_TONES: { value: GridTone; label: string }[] = [
  { value: 'dawn', label: '日出' },
  { value: 'day', label: '白天' },
  { value: 'dusk', label: '暮色' },
  { value: 'night', label: '晚上' },
]

/** 智能光态的时段表(本地钟点,固定 —— 不随季节/经纬度变化)。
 *  from 含、to 不含;表上没覆盖到的时段(19:30–次日 05:00)归晚上,故不必列出来。
 *  ⚠ 改这张表必须同步 src/app/layout.tsx 首帧内联脚本里的同一张表(那边不能 import)。 */
export const GRID_TONE_AUTO_SLOTS: { from: number; to: number; tone: GridTone }[] = [
  { from: 5, to: 8, tone: 'dawn' },
  { from: 8, to: 17, tone: 'day' },
  { from: 17, to: 19.5, tone: 'dusk' },
]

/** 按本地时间解析出此刻应处的光态(智能选择的唯一判据,首帧脚本里有一份等价实现) */
export function resolveAutoTone(now: Date = new Date()): GridTone {
  const h = now.getHours() + now.getMinutes() / 60
  for (const slot of GRID_TONE_AUTO_SLOTS) {
    if (h >= slot.from && h < slot.to) return slot.tone
  }
  return 'night'
}

/** 下面那排(主题 ≠ 格子时): 配色。桂金删除后只剩黑白基线一项 */
export const PALETTES: {
  value: SelectablePalette
  label: string
  hint: string
  swatch: string
}[] = [
  { value: 'base', label: '黑白基线', hint: '中性灰', swatch: 'rgb(63 63 70)' },
]

/** 外观的完整状态,与设置面板的三个 state 一一对应 */
export interface Appearance {
  choice: ThemeChoice
  /** choice 不是格子时生效 */
  palette: SelectablePalette
  /** choice 是格子时生效。智能模式下它是"此刻解析出来的结果",不是用户手选值 */
  gridTone: GridTone
  /** choice 是格子时生效: 光态是否交给时间自动决定(存 'auto',见 GridTonePref) */
  gridToneAuto: boolean
  /** 样式维度。可缺省: 老调用点(不关心样式)不传时,applyAppearance 沿用当前存储值 */
  style?: UiStyle
  /** choice 是壁纸时生效: 壁纸的明暗子档。缺省时沿用存储值(默认 system) */
  wallpaperScheme?: WallpaperScheme
}

/** 明暗模式的最终判据: system 跟随系统偏好 */
export function resolveDark(mode: ThemeMode): boolean {
  if (typeof window === 'undefined') return false
  if (mode === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches
  return mode === 'dark'
}

/**
 * 合法化: 格子接管明暗,「配色」这一栏对它没有意义 → 回落黑白基线
 * (「月白·桂花金」已删除,存量 palette 值在 readAppearance 读取时即已回落)
 * 壁纸同理: 它的「下面那排」是明暗,不是配色
 */
export function normalizeAppearance(next: Appearance): Appearance {
  if (next.choice === 'grid') return { ...next, palette: 'base' }
  if (next.choice === 'wallpaper') return { ...next, palette: 'base' }
  return next
}

/** 只写「明暗偏好」这一个键(格子的白天/暮色不落在这里) */
function persistThemeMode(mode: ThemeMode): void {
  if (mode === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
  else localStorage.setItem(THEME_STORAGE_KEY, mode)
}

function readStoredThemeMode(): ThemeMode {
  const v = localStorage.getItem(THEME_STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

/** 样式维度: 显式存 classic / google,未知值一律回落 bigsur(trial 默认即新样式) */
export function readStoredStyle(): UiStyle {
  const v = localStorage.getItem(UI_STYLE_STORAGE_KEY)
  return v === 'classic' || v === 'google' ? v : 'bigsur'
}

/** 壁纸的明暗子档: 未知值/缺省一律跟随系统 */
export function readStoredWallpaperScheme(): WallpaperScheme {
  const v = localStorage.getItem(WALLPAPER_SCHEME_STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

/** 读出当前外观 —— 选择器三个 state 的初值 */
export function readAppearance(): Appearance {
  if (typeof window === 'undefined') {
    return { choice: 'system', palette: 'base', gridTone: 'day', gridToneAuto: false, style: 'bigsur' }
  }

  // 未知值一律回落白天(存量只可能是 day/dusk;'night'/'dawn'/'auto' 是后续新增值)。
  // 判据逐个列出目标取值,不用"等于 day 之外都算"这类反推 —— 新增光态时不会误吃
  const storedTone = localStorage.getItem(GRID_TONE_STORAGE_KEY)
  const gridToneAuto = storedTone === 'auto'
  const gridTone: GridTone = gridToneAuto
    ? resolveAutoTone()
    : storedTone === 'dawn' || storedTone === 'dusk' || storedTone === 'night'
      ? storedTone
      : 'day'
  const v = localStorage.getItem(PALETTE_STORAGE_KEY)
  // 'dusk' 是废弃的暮色·落霞配色,已并入格子
  if (v === GRID_PALETTE || v === 'dusk') {
    return { choice: 'grid', palette: 'base', gridTone, gridToneAuto, style: readStoredStyle() }
  }
  // 壁纸与格子同一套路: palette 键里存的是「当前主题是壁纸」这个事实
  if (v === WALLPAPER_PALETTE) {
    return {
      choice: 'wallpaper',
      palette: 'base',
      gridTone,
      gridToneAuto,
      style: readStoredStyle(),
      wallpaperScheme: readStoredWallpaperScheme(),
    }
  }

  const choice = readStoredThemeMode()
  // 「月白·桂花金」配色已删除: 存量值('guihua')与未知值一律回落黑白基线
  const palette: SelectablePalette = 'base'
  return { choice, palette, gridTone, gridToneAuto, style: readStoredStyle() }
}

/** 外观唯一写入路径: localStorage + <html> 的 class/attr(CSS 全部由它们驱动) */
export function applyAppearance(input: Appearance): void {
  const next = normalizeAppearance(input)
  const isGrid = next.choice === 'grid'
  const isWallpaper = next.choice === 'wallpaper'
  const root = document.documentElement
  // 智能模式下光态以"此刻"为准: 不信任外部传进来的 gridTone,
  // 免得定时器或一份过期的 state 把一个已经过时的光态写进去
  const tone: GridTone = next.gridToneAuto ? resolveAutoTone() : next.gridTone

  // 格子/壁纸下不写 theme 键 —— 用户原先的明暗偏好留着,退出时原样恢复
  if (isGrid) {
    const pref: GridTonePref = next.gridToneAuto ? 'auto' : tone
    localStorage.setItem(GRID_TONE_STORAGE_KEY, pref)
  } else if (!isWallpaper) persistThemeMode(next.choice as ThemeMode)

  if (isGrid) {
    // 四个光态里只有「晚上」是深底 —— 它是格子下唯一会写 .dark 的态
    // (日出/白天/暮色都是浅底,一律不写)。
    // 写 .dark 是必须的: 下游(toast / TauriVisualFX / 代码编辑器 / 地图卡)
    // 都靠 .dark 判断明暗,不写就会在深底上渲染浅色视觉(白输入框/亮滚动条);
    // 深底 token 由 [data-pal="grid"][data-grid-tone="night"] 压制 .dark。
    // 智能模式跨到晚上时也会走到这里 —— 即"日落自动转深色",这是设计不是副作用。
    root.setAttribute('data-grid-tone', tone)
    root.classList.toggle('dark', tone === 'night')
  } else {
    root.removeAttribute('data-grid-tone')
    // 壁纸: 明暗走自己的子档(不动 theme 键),与格子同理
    const scheme: WallpaperScheme = next.wallpaperScheme ?? readStoredWallpaperScheme()
    if (isWallpaper) localStorage.setItem(WALLPAPER_SCHEME_STORAGE_KEY, scheme)
    root.classList.toggle('dark', resolveDark(isWallpaper ? scheme : (next.choice as ThemeMode)))
  }

  // 壁纸层显隐的唯一判据(纯 CSS 驱动,首帧脚本写同一个值)
  root.setAttribute('data-wallpaper', isWallpaper ? 'on' : 'off')

  const palette: PaletteId = isGrid ? GRID_PALETTE : isWallpaper ? WALLPAPER_PALETTE : next.palette
  localStorage.setItem(PALETTE_STORAGE_KEY, palette)
  root.setAttribute('data-pal', palette)

  // 样式维度: 调用点没带 style(老入口)时沿用当前存储值,不做任何"纠正"
  const style: UiStyle = next.style ?? readStoredStyle()
  localStorage.setItem(UI_STYLE_STORAGE_KEY, style)
  root.setAttribute('data-style', style)
}

/**
 * 只改明暗(给 AI 设置工具等外部入口用)。
 * 格子外观下明暗不是由 theme 决定的,这里只把偏好记下,等退出格子后再生效。
 */
export function setThemeMode(mode: ThemeMode): void {
  if (typeof window === 'undefined') return
  const cur = readAppearance()
  if (cur.choice === 'grid') {
    persistThemeMode(mode)
    return
  }
  applyAppearance({ ...cur, choice: mode })
}

/** 智能光态的复查间隔。10 分钟足够细(最粗的时段也有 2.5 小时),
 *  又不至于让一个常驻定时器变成负担 */
const AUTO_TONE_TICK_MS = 10 * 60 * 1000

/**
 * 智能光态的看门人(常驻,挂在 Providers 这个全局客户端根上):
 * 每 10 分钟查一次 + 窗口重新聚焦时补一次(合盖/切走再回来期间不会漏掉跨段),
 * **只在解析结果变了才写** —— 不跨段就一次 DOM 写入都不发生。
 * 非智能模式(手选光态)下它什么都不做,手选值不会被抢走。
 * 返回取消订阅函数,供 useEffect 清理。
 */
export function startAutoGridToneWatch(): () => void {
  if (typeof window === 'undefined') return () => {}
  let last: GridTone | null = null
  const tick = () => {
    const cur = readAppearance()
    // gridTone 这个键在退出格子后仍保留(用户手选/智能偏好要留着,回到格子时原样恢复),
    // 故这里必须连 choice 一起判 —— 否则用户在浅色/深色下待着,
    // 每当跨过时段边界都会被这个"看门人"白写一次 DOM(结果虽然相同,但没必要)
    if (!cur.gridToneAuto || cur.choice !== 'grid') {
      last = null
      return
    }
    const tone = resolveAutoTone()
    if (tone === last) return
    last = tone
    applyAppearance({ ...cur, gridTone: tone })
  }
  tick()
  const timer = window.setInterval(tick, AUTO_TONE_TICK_MS)
  const onWake = () => tick()
  window.addEventListener('focus', onWake)
  document.addEventListener('visibilitychange', onWake)
  return () => {
    window.clearInterval(timer)
    window.removeEventListener('focus', onWake)
    document.removeEventListener('visibilitychange', onWake)
  }
}