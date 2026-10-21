/**
 * AI 可控设置注册表 —— 单一数据源（isomorphic 纯数据，无 DOM/Node 依赖）
 *
 * 服务端（settings-tool.ts）：由 SETTING_KEYS 生成 update_settings 工具的
 * zod 枚举 —— 注册表之外的 key 对模型而言"不存在"，幻觉输入直接被校验拒绝。
 * 前端（executor.ts）：按 key 查表分发执行。
 *
 * ⚠ 元开关 aiSettingsControl（总控本功能）刻意不登记在此表中：
 * 它只能通过 设置 → 通用 的手动开关（PATCH /api/settings/ai-control）修改，
 * AI 的全部出口（工具枚举、前端执行器）都不包含该 key。
 */

import { BUILTIN_MASKS } from '@/lib/ai/builtin-masks'
import { STYLE_PRESETS } from '@/lib/ai/style-presets'
import { REPLY_LENGTH_LEVELS } from '@/lib/ai/reply-length'
import { BUILTIN_IMAGE_MODELS } from '@/lib/ai/image-models.config'

export const SETTING_KEYS = [
  'theme',
  'sidebar',
  'search_engine',
  'style_preset',
  'reply_length',
  'mask',
  'open_settings',
  // P2: DB 存储项（PATCH /api/settings/clarify、/api/memories/settings、/api/image-settings）
  'clarify',
  'memory',
  'image_model',
  'image_size',
] as const

export type SettingKey = (typeof SETTING_KEYS)[number]

/**
 * 生图尺寸白名单（单一数据源）：image-settings PATCH 端点的 VALID_SIZES
 * 从这里导入，避免两处清单漂移。
 */
export const IMAGE_SIZE_WHITELIST = ['1024*1024', '720*1280', '1280*720'] as const

export interface SettingDef {
  key: SettingKey
  /** 中文名：注入 system prompt + 卡片展示 */
  label: string
  /** 白名单取值：服务端 execute 兜底校验 + 前端执行前再校验 */
  allowedValues: readonly string[]
}

export const SETTINGS_REGISTRY: readonly SettingDef[] = [
  {
    key: 'theme',
    label: '主题',
    allowedValues: ['light', 'dark', 'system'],
  },
  {
    key: 'sidebar',
    label: '侧边栏',
    allowedValues: ['open', 'close'],
  },
  {
    key: 'search_engine',
    label: '联网搜索引擎',
    allowedValues: ['qianfan', 'deepseek', 'tavily'],
  },
  {
    key: 'style_preset',
    label: '对话风格',
    allowedValues: ['balanced', 'practical', 'dev', 'editor', 'mentor', 'scholar', 'concise', 'humorous', 'creative'],
  },
  {
    key: 'reply_length',
    label: '回复长度',
    allowedValues: REPLY_LENGTH_LEVELS.map((l) => l.id),
  },
  {
    key: 'mask',
    label: '面具',
    // 内置面具 id 白名单（自定义面具存 DB，暂不对 AI 开放）
    allowedValues: ['off', ...BUILTIN_MASKS.map((m) => m.id)],
  },
  {
    key: 'open_settings',
    label: '打开设置分区',
    allowedValues: [
      'overview', 'providers', 'models', 'search', 'image', 'memory',
      'clarify', 'masks', 'usage', 'general', 'help', 'about',
    ],
  },
  {
    key: 'clarify',
    label: '澄清提问',
    allowedValues: ['on', 'off'],
  },
  {
    key: 'memory',
    label: '记忆功能',
    allowedValues: ['on', 'off'],
  },
  {
    key: 'image_model',
    label: '生图模型',
    // 与 image-settings PATCH 端点同源（BUILTIN_MODELS = BUILTIN_IMAGE_MODELS）;
    // custom: 前缀的自定义生图模型是动态列表,不对 AI 开放
    allowedValues: BUILTIN_IMAGE_MODELS.map((m) => m.id),
  },
  {
    key: 'image_size',
    label: '生图尺寸',
    allowedValues: IMAGE_SIZE_WHITELIST,
  },
]

/** 按 key 查定义；未知 key 返回 undefined（元开关等不在表内的 key 走此分支） */
export function getSettingDef(key: string): SettingDef | undefined {
  return SETTINGS_REGISTRY.find((d) => d.key === key)
}

/** value 是否在该 key 的白名单内；未知 key 一律 false */
export function isAllowedValue(key: string, value: string): boolean {
  const def = getSettingDef(key)
  return !!def && def.allowedValues.includes(value)
}

/** 各 key 的取值→中文显示映射（与设置界面文案保持一致） */
const VALUE_LABELS: Record<string, Record<string, string>> = {
  theme: { light: '浅色', dark: '深色', system: '跟随系统' },
  sidebar: { open: '展开', close: '收起' },
  search_engine: { qianfan: '百度千帆', deepseek: 'DeepSeek', tavily: 'Tavily' },
  style_preset: Object.fromEntries(STYLE_PRESETS.map((p) => [p.id, p.label])),
  reply_length: Object.fromEntries(REPLY_LENGTH_LEVELS.map((l) => [l.id, l.label])),
  mask: { off: '关闭' },
  clarify: { on: '开启', off: '关闭' },
  memory: { on: '开启', off: '关闭' },
  open_settings: {
    overview: '总览',
    providers: '服务商 API Key',
    models: '自定义模型',
    search: '联网搜索',
    image: '生图',
    memory: '记忆',
    clarify: '澄清提问',
    masks: '面具管理',
    usage: '用量统计',
    general: '通用',
    help: '帮助',
    about: '关于',
  },
}

/**
 * 设置值的中文显示：优先查映射；面具 id 回退到内置面具名（如 🌍 翻译官）；
 * 兜底原样返回（未知值不阻塞卡片/快照渲染）。
 */
export function formatSettingValue(key: string, value: string): string {
  const mapped = VALUE_LABELS[key]?.[value]
  if (mapped) return mapped
  if (key === 'mask') {
    const mask = BUILTIN_MASKS.find((m) => m.id === value)
    if (mask) return `${mask.avatar} ${mask.name}`
  }
  return value
}
