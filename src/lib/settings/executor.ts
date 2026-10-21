import { useChatStore } from '@/store/chat-store'
import { toast } from '@/lib/toast'
import { setThemeMode, type ThemeMode } from '@/lib/theme'
import {
  getSettingDef,
  isAllowedValue,
  formatSettingValue,
  type SettingKey,
} from '@/lib/settings/registry'

/**
 * AI 设置控制 —— 前端执行器（仅客户端使用，勿在服务端 import：
 * 依赖 localStorage / zustand / window.matchMedia）
 *
 * 职责：
 * - buildSettingsSnapshot(): 请求前组装客户端设置快照，随 body 上报
 *   （DB 项由 chat route 直查 User 表，不经此上报，见 settings-tool.ts）
 * - executeSettingsOps(): 监听到 update_settings tool part 后按注册表分发执行。
 *   未知 key（含总开关 aiSettingsControl——注册表内无 apply 分支）一律拒绝，
 *   构成 AI 无法触碰元开关的第三道防线。
 */

/** 客户端设置快照：只含注册表中有"当前值"的项（open_settings 是动作型，不进快照） */
export function buildSettingsSnapshot(): Partial<Record<SettingKey, string>> {
  if (typeof window === 'undefined') return {}
  const s = useChatStore.getState()
  return {
    theme: localStorage.getItem('theme') ?? 'system',
    sidebar: s.sidebarOpen ? 'open' : 'close',
    search_engine: s.searchEngine,
    style_preset: s.conversationStylePreset,
    reply_length: s.conversationReplyLength,
    mask: s.conversationMaskId ?? 'off',
  }
}

export interface SettingsOpResult {
  key: string
  value: string
  ok: boolean
  /** 失败原因（unknown_key / invalid_value / 执行异常），成功时 undefined */
  reason?: string
}

/** 单条 op 的执行器：与 SettingsModal 手动操作的写法保持一致 */
const APPLY: Partial<Record<SettingKey, (value: string) => void | Promise<void>>> = {
  // 只改「明暗」这一维(配色与格子不在 AI 白名单内)。
  // 月白·桂花金仅深色: 若当前配色是桂花金而 AI 把它设成浅色,setThemeMode 会连带回落黑白基线
  theme: (value) => {
    setThemeMode(value as ThemeMode)
  },
  sidebar: (value) => {
    useChatStore.getState().setSidebarOpen(value === 'open')
  },
  search_engine: (value) => {
    if (value === 'qianfan' || value === 'deepseek' || value === 'tavily') {
      useChatStore.getState().setSearchEngine(value)
    }
  },
  style_preset: (value) => {
    useChatStore.getState().setConversationStylePreset(value)
    // 与 SettingsModal 手动切换同款:store 即时生效,会话归属的持久化仍以界面操作为准
    localStorage.setItem('chat:stylePreset', value)
  },
  reply_length: (value) => {
    useChatStore.getState().setConversationReplyLength(value)
    // 与 style_preset 同款:store 即时生效(下一轮请求 body 带上),会话落库以界面操作为准
    localStorage.setItem('chat:replyLength', value)
  },
  mask: (value) => {
    useChatStore.getState().setConversationMaskId(value === 'off' ? null : value)
  },
  open_settings: (value) => {
    const s = useChatStore.getState()
    s.setSettingsSection(value)
    s.setSettingsOpen(true)
  },
  // ── P2: DB 存储项,复用现有的手动开关/设置面板写入路径(PATCH 端点自带鉴权与校验)
  clarify: async (value) => {
    const res = await fetch('/api/settings/clarify', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: value === 'on' }),
    })
    if (!res.ok) throw new Error(`PATCH /api/settings/clarify ${res.status}`)
  },
  memory: async (value) => {
    const res = await fetch('/api/memories/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: value === 'on' }),
    })
    if (!res.ok) throw new Error(`PATCH /api/memories/settings ${res.status}`)
  },
  image_model: async (value) => {
    // 端点内校验内置模型 ID(与 registry 同源 image-models.config)
    const res = await fetch('/api/image-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { imageModel: value } }),
    })
    if (!res.ok) throw new Error(`PATCH /api/image-settings ${res.status}`)
  },
  image_size: async (value) => {
    const res = await fetch('/api/image-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { imageSize: value } }),
    })
    if (!res.ok) throw new Error(`PATCH /api/image-settings ${res.status}`)
  },
}

/** 每次 AI 设置改动的原值日志：toolCallId → (key → 改动前的值)。仅当轮会话内存内有效 */
const settingsEditLog = new Map<string, Map<string, string>>()

/** 前端能读到改动前原值、因此可撤销的客户端设置项（DB 项与动作型 open_settings 不可回退） */
const REVERTABLE_KEYS = new Set<string>(['theme', 'sidebar', 'search_engine', 'style_preset', 'mask'])

function ensureEditLog(toolCallId: string): Map<string, string> {
  let m = settingsEditLog.get(toolCallId)
  if (!m) {
    m = new Map()
    settingsEditLog.set(toolCallId, m)
  }
  return m
}

/** 读某设置项当前值（注册表 value 形式）；DB 项 / 动作型读不到时返回 undefined */
function readCurrentValue(key: string): string | undefined {
  if (key === 'theme') return localStorage.getItem('theme') ?? undefined
  const s = useChatStore.getState()
  switch (key) {
    case 'sidebar':
      return s.sidebarOpen ? 'open' : 'close'
    case 'search_engine':
      return s.searchEngine
    case 'style_preset':
      return s.conversationStylePreset
    case 'mask':
      return s.conversationMaskId ?? 'off'
  }
  return undefined
}

/** 该设置项是否支持前端撤销（有前端可见的原值） */
export function isRevertableSetting(key: string): boolean {
  return REVERTABLE_KEYS.has(key)
}

/** 撤销单条设置：回到 AI 改动前的原值；非可回退项或记录缺失时返回 false */
export function revertSettingsOp(toolCallId: string, key: string): boolean {
  if (!REVERTABLE_KEYS.has(key)) return false
  const prev = settingsEditLog.get(toolCallId)?.get(key)
  if (prev === undefined) return false
  const applyFn = APPLY[key as SettingKey]
  if (!applyFn) return false
  try {
    void applyFn(prev)
    return true
  } catch {
    return false
  }
}

/**
 * 执行一轮 update_settings 的全部操作。
 * 幂等（同值重复设置无害）+ toolCallId 由调用方去重，多泳道重复调用安全。
 * 返回逐条结果并统一 toast。
 */
export async function executeSettingsOps(
  input: unknown,
  toolCallId?: string
): Promise<SettingsOpResult[]> {
  const ops = (input as { operations?: unknown } | null | undefined)?.operations
  if (!Array.isArray(ops)) return []

  const log = toolCallId ? ensureEditLog(toolCallId) : undefined
  const results: SettingsOpResult[] = []
  for (const op of ops) {
    const key = (op as { key?: unknown } | null | undefined)?.key
    const value = (op as { value?: unknown } | null | undefined)?.value
    if (typeof key !== 'string' || typeof value !== 'string') {
      results.push({ key: String(key ?? ''), value: String(value ?? ''), ok: false, reason: 'malformed' })
      continue
    }

    // 防线 3:注册表外的 key（含 aiSettingsControl）无 apply 分支,一律拒绝
    const def = getSettingDef(key)
    const applyFn = APPLY[key as SettingKey]
    if (!def || !applyFn) {
      results.push({ key, value, ok: false, reason: 'unknown_key' })
      continue
    }
    if (!isAllowedValue(key, value)) {
      results.push({ key, value, ok: false, reason: 'invalid_value' })
      continue
    }

    try {
      // 记录改动前原值，供后续撤销该条时回退（只记前端可读的客户端项）
      if (log && isRevertableSetting(key)) {
        const prev = readCurrentValue(key)
        if (prev !== undefined) log.set(key, prev)
      }
      await applyFn(value)
      results.push({ key, value, ok: true })
    } catch (err) {
      console.error('[settings] Failed to apply op:', key, value, err)
      results.push({ key, value, ok: false, reason: 'apply_error' })
    }
  }

  // 统一 toast 反馈:成功合并一条,失败逐条
  const okLabels = results
    .filter((r) => r.ok)
    .map((r) => `${getSettingDef(r.key)?.label ?? r.key} → ${formatSettingValue(r.key, r.value)}`)
  if (okLabels.length > 0) {
    toast.success(`已更新设置：${okLabels.join('、')}`)
  }
  for (const r of results.filter((x) => !x.ok)) {
    if (r.reason === 'unknown_key') {
      toast.error(`AI 尝试修改了不受支持的设置项（${r.key}），已忽略`)
    } else if (r.reason === 'invalid_value') {
      toast.error(`设置值无效（${r.key}=${r.value}），已忽略`)
    } else {
      toast.error('设置修改失败，请重试')
    }
  }
  return results
}
