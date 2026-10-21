'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Save, Trash2, Loader2, Timer, CheckCircle, AlertCircle, Key, KeyRound, Eye, EyeOff, Zap, ExternalLink, Brain, Plus, Settings2, HelpCircle, Info, MessageSquare, GitBranch, Cpu, Wrench, BarChart3, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Filter, LayoutDashboard, Sparkles, ImageIcon, Check, RefreshCw, Globe, Search, LogOut, User, CalendarDays, Pencil, X, FileUp, Download, Copy, VenetianMask, RotateCcw, Plug, MapPin, FolderOpen, Gauge, Ticket, Gift, Smartphone, FileJson } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'
import { cn } from '@/lib/utils'
import {
  applyAppearance,
  FEST_PALETTE,
  GRID_TONES,
  normalizeAppearance,
  PALETTES,
  readAppearance,
  resolveAutoTone,
  THEME_CHOICES,
  type Appearance,
  type GridTone,
  type SelectablePalette,
  type ThemeChoice,
} from '@/lib/theme'
import { useCustomModels, type CustomModelForm, type SavedCustomModel, CUSTOM_MODEL_DOT } from '@/hooks/useCustomModels'
import { useWindowDrag } from '@/hooks/useWindowDrag'
import { useBackToClose } from '@/hooks/useBackToClose'
import { useToggleMap } from '@/hooks/useToggleMap'
import { useProviderModels, type ProviderModelOverrideForm, makeEmptyForm as makeEmptyProviderForm } from '@/hooks/useProviderModels'
import { detectModelCapabilities } from '@/lib/ai/model-capabilities'
import { useChatStore, type BackdropMode } from '@/store/chat-store'
import { StylePicker } from '@/components/chat/StylePicker'
import { getStylePresetLabel, STYLE_PRESETS } from '@/lib/ai/style'
import { ReplyLengthSlider } from '@/components/chat/ReplyLengthSlider'
import { getReplyLengthLabel, REPLY_LENGTH_LEVELS } from '@/lib/ai/reply-length'
import { useIsTauri, useIsTauriShell, getNotifyOnReply, setNotifyOnReply, getReplyReminderDelaySec, setReplyReminderDelaySec } from '@/lib/tauri'
import { pickWorkspaceDir, getWorkspaceDir, LOCAL_FILES_SYNC_KEY } from '@/lib/tauri-files'
import { toast } from '@/lib/toast'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query/keys'
import { parseMemoryText, COMMON_IMPORT_SOURCES, MEMORY_IMPORT_REFERENCE, type ParsedMemoryDraft } from '@/lib/memory/import-parser'
import MasksSettings from '@/components/settings/MasksSettings'
import { PortableSettings } from '@/components/settings/PortableSettings'
import QuotaAdminSection from '@/components/settings/QuotaAdminSection'
import QuotaPersonalCard from '@/components/settings/QuotaPersonalCard'
import McpSettings from '@/components/settings/McpSettings'
import { confirmDialog } from '@/components/ui/ConfirmDialog'
import { generalFieldLabel, type GeneralFields } from '@/lib/profile/general'
import { applicableProbeFields, pendingProbeFields, probeFieldLabel } from '@/lib/profile/probe'
import { ProfileProbeDialog } from '@/components/profile/ProfileProbeDialog'
import type { DerivedStage } from '@/lib/profile/academic'

const STYLE_OFFSET_STORAGE_KEY = 'chat:stylePreset'
const REPLY_LENGTH_STORAGE_KEY = 'chat:replyLength'

/** 背景 设置的选项 */
const BACKDROP_CHOICES: { value: BackdropMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'image', label: '壁纸' },
]

/** 后台回复提醒的等待档位(秒)。存 localStorage,0 = 不提醒 */
const REMINDER_DELAY_CHOICES: { value: string; label: string }[] = [
  { value: '30', label: '30秒' },
  { value: '45', label: '45秒' },
  { value: '90', label: '1分半' },
  { value: '0', label: '关闭' },
]

interface ProviderInfo {
  id: string
  name: string
  models: string[]
}

interface KeyInfo {
  id: string
  provider: string
  maskedKey: string
  updatedAt: string
}

interface MemoryInfo {
  id: string
  category: string
  content: string
  source: string
  sourceDetail?: string | null
  updatedAt: string
  /** active 生效 | superseded 已被新记忆取代(不注入 AI,可在「已被取代」里恢复) */
  status?: string
  /** 取代本条的记忆 id(仅 superseded) */
  supersededBy?: string | null
}

/** 服务端算好的一组相互矛盾的记忆(本地槽位/常识判定,零 LLM) */
interface MemoryConflictGroup {
  ids: string[]
  winnerId: string
  reason: string
}

interface UserProfileInfo {
  name: string | null
  nickname?: string | null
  email: string | null
  image: string | null
  createdAt: string
}

/** /api/profiles GET 的返回（档案 + 学年推算 + 到期判定） */
interface ProfileStateInfo {
  exists: boolean
  enabled: boolean
  fields: GeneralFields
  displayName: string
  lastConfirmedAt: string | null
}

interface EphemeralConversationInfo {
  id: string
  title: string | null
  updatedAt: string
  messageCount: number
}

interface EphemeralPreviewMessage {
  id: string
  role: string
  content: string
  createdAt: string
}

interface UsageStats {
  chat: ChatUsageStats
  image: ImageUsageStats
}

interface ChatUsageStats {
  totals: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    messages: number
  }
  byModel: {
    model: string
    promptTokens: number
    completionTokens: number
    totalTokens: number
    messages: number
  }[]
  byDay: { date: string; totalTokens: number }[]
}

interface ImageUsageStats {
  totals: { count: number }
  byModel: { model: string; count: number }[]
  bySize: { size: string; count: number }[]
  byDay: { date: string; count: number }[]
}

// 环中心数字紧凑格式：K/M/B 分级缩写（≥10 后省小数），控制字符数避免长数字撑出圆环
function fmtCompactNum(n: number): string {
  for (const [div, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (n >= div) {
      const v = n / div
      return v >= 10 ? `${Math.round(v)}${unit}` : `${v.toFixed(1).replace(/\.0$/, '')}${unit}`
    }
  }
  return n.toLocaleString()
}

// ── 用量「总览」tab ──────────────────────────────────────────────────────────
// 升级为「图表主导」：聊天块 = Token 圆环（输入/输出）+ 模型消耗排行；生图块 = 模型饼图；活跃块 = 加大 sparkline。
function OverviewTab({ usageStats }: { usageStats: UsageStats }) {
  // ── 聊天：输入/输出比例（用于圆环图）─────────────────────────────────────
  const chatPrompt = usageStats.chat.totals.promptTokens
  const chatCompletion = usageStats.chat.totals.completionTokens
  const chatTotal = chatPrompt + chatCompletion
  const chatInputRatio = chatTotal > 0 ? chatPrompt / chatTotal : 0
  const chatOutputRatio = chatTotal > 0 ? chatCompletion / chatTotal : 0
  // 环中心显示文案（紧凑缩写，按字符数自适应字号防溢出）
  const chatTotalLabel = fmtCompactNum(chatTotal)

  // 聊天模型消耗排行（byModel 已按 totalTokens 排序，取 Top 5）
  const chatModelRanking = usageStats.chat.byModel.slice(0, 5)
  const chatMaxModelTokens = Math.max(...chatModelRanking.map((m) => m.totalTokens), 1)

  // 生图模型分布（byModel 已按 count 排序，取 Top 5）
  const imageModelRanking = usageStats.image.byModel.slice(0, 5)
  const imageTotal = usageStats.image.totals.count
  const imageTotalLabel = fmtCompactNum(imageTotal)
  // 生图饼图配色（按排序固定色，与 sparkline 风格保持一致）
  const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#94a3b8']

  // 聊天：最近一次非零日
  const lastChatDay = [...usageStats.chat.byDay]
    .reverse()
    .find((d) => d.totalTokens > 0)?.date ?? null
  // 生图：最近一次非零日
  const lastImageDay = [...usageStats.image.byDay]
    .reverse()
    .find((d) => d.count > 0)?.date ?? null

  // 活跃天数：30 天内 chat 有 token 或 image 有图的天数
  const activeDays = usageStats.chat.byDay.reduce(
    (acc, day, i) => {
      const hasChat = day.totalTokens > 0
      const hasImage = (usageStats.image.byDay[i]?.count ?? 0) > 0
      return acc + (hasChat || hasImage ? 1 : 0)
    },
    0
  )

  // Sparkline 数据：聊天 token 归一化 + 生图张数归一化，叠加
  const sparkDays = usageStats.chat.byDay
  const chatMax = Math.max(...sparkDays.map((d) => d.totalTokens), 1)
  const imageMax = Math.max(...usageStats.image.byDay.map((d) => d.count), 1)

  return (
    <div className="space-y-3">
      {/* 💬 聊天 - 主块：Token 圆环图 + 模型消耗排行 */}
      <div className="rounded-xl border border-line/60 bg-surface/40 px-3.5 py-3.5">
        <div className="flex items-center gap-1.5 mb-2.5">
          <MessageSquare className="w-3.5 h-3.5 text-content-muted" />
          <p className="text-xs font-medium text-content-secondary">聊天</p>
        </div>

        <div className="flex items-start gap-3">
          {/* Token 圆环图：输入/输出占比 */}
          <div className="relative shrink-0" style={{ width: 72, height: 72 }}>
            {chatTotal > 0 ? (
              <>
                <svg viewBox="0 0 42 42" className="w-full h-full -rotate-90">
                  {/* 背景环 */}
                  <circle
                    cx="21"
                    cy="21"
                    r="15.9155"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="6"
                    className="text-line/40"
                  />
                  {/* 输入 token 段（蓝） */}
                  <circle
                    cx="21"
                    cy="21"
                    r="15.9155"
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth="6"
                    strokeDasharray={`${chatInputRatio * 100} 100`}
                    strokeDashoffset="0"
                    strokeLinecap="butt"
                  />
                  {/* 输出 token 段（绿） */}
                  <circle
                    cx="21"
                    cy="21"
                    r="15.9155"
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="6"
                    strokeDasharray={`${chatOutputRatio * 100} 100`}
                    strokeDashoffset={`${-chatInputRatio * 100}`}
                    strokeLinecap="butt"
                  />
                </svg>
                {/* 环中心数字（紧凑缩写，5 字符以上缩字号防溢出） */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <span
                    className={cn(
                      'font-mono font-semibold text-content-primary tabular-nums',
                      chatTotalLabel.length >= 5 ? 'text-xs' : 'text-sm'
                    )}
                  >
                    {chatTotalLabel}
                  </span>
                </div>
              </>
            ) : (
              <div className="w-full h-full rounded-full border-2 border-dashed border-line/60 flex items-center justify-center">
                <span className="text-[10px] text-content-muted">暂无</span>
              </div>
            )}
          </div>

          {/* 输入/输出数字 + 比例 */}
          <div className="flex-1 min-w-0 pt-0.5 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm bg-blue-500 inline-block shrink-0" />
              <span className="text-[10px] text-content-muted">输入</span>
              <span className="ml-auto font-mono text-xs font-semibold text-content-primary tabular-nums">
                {chatPrompt.toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block shrink-0" />
              <span className="text-[10px] text-content-muted">输出</span>
              <span className="ml-auto font-mono text-xs font-semibold text-content-primary tabular-nums">
                {chatCompletion.toLocaleString()}
              </span>
            </div>
            <div className="text-[10px] text-content-muted tabular-nums pt-0.5">
              {Math.round(chatInputRatio * 100)}% / {Math.round(chatOutputRatio * 100)}%
            </div>
          </div>
        </div>

        {/* 模型消耗排行（按 Token） - 紧凑条形 */}
        {chatModelRanking.length > 0 && (
          <div className="mt-3 pt-2.5 border-t border-line/40 space-y-1">
            {chatModelRanking.slice(0, 4).map((m) => {
              const pct = (m.totalTokens / chatMaxModelTokens) * 100
              return (
                <div key={m.model} className="flex items-center gap-2 text-[10px]">
                  <span className="font-mono text-content-secondary truncate flex-1 min-w-0">
                    {m.model}
                  </span>
                  <div className="w-16 h-1 rounded-full bg-line/40 overflow-hidden shrink-0">
                    <div
                      className="h-full bg-accent/70 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="font-mono text-content-muted tabular-nums shrink-0 w-12 text-right">
                    {m.totalTokens >= 1000
                      ? `${(m.totalTokens / 1000).toFixed(1)}K`
                      : m.totalTokens}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {lastChatDay && (
          <p className="mt-2.5 text-[10px] text-content-muted">
            上次聊天 {lastChatDay.slice(5)}
          </p>
        )}
      </div>

      {/* 🖼 生图 - 辅块：模型分布饼图 */}
      <div className="rounded-xl border border-line/60 bg-surface/40 px-3.5 py-3.5">
        <div className="flex items-center gap-1.5 mb-2.5">
          <ImageIcon className="w-3.5 h-3.5 text-content-muted" />
          <p className="text-xs font-medium text-content-secondary">生图</p>
        </div>

        {imageTotal > 0 ? (
          <div className="flex items-center gap-3">
            {/* 饼图 */}
            <div className="relative shrink-0" style={{ width: 56, height: 56 }}>
              <svg viewBox="0 0 42 42" className="w-full h-full -rotate-90">
                {(() => {
                  let offset = 0
                  return imageModelRanking.map((m, i) => {
                    const pct = (m.count / imageTotal) * 100
                    const dasharray = `${pct} 100`
                    const dashoffset = -offset
                    offset += pct
                    return (
                      <circle
                        key={m.model}
                        cx="21"
                        cy="21"
                        r="15.9155"
                        fill="none"
                        stroke={PIE_COLORS[i] ?? '#94a3b8'}
                        strokeWidth="6"
                        strokeDasharray={dasharray}
                        strokeDashoffset={dashoffset}
                        strokeLinecap="butt"
                      />
                    )
                  })
                })()}
              </svg>
              {/* 环中心数字（紧凑缩写，小环 4 字符以上即缩字号防溢出） */}
              <div className="absolute inset-0 flex items-center justify-center">
                <span
                  className={cn(
                    'font-mono font-semibold text-content-primary tabular-nums',
                    imageTotalLabel.length >= 4 ? 'text-xs' : 'text-sm'
                  )}
                >
                  {imageTotalLabel}
                </span>
              </div>
            </div>

            {/* 图例 - 紧凑 */}
            <ul className="flex-1 min-w-0 space-y-0.5">
              {imageModelRanking.slice(0, 4).map((m, i) => {
                const pct = Math.round((m.count / imageTotal) * 100)
                return (
                  <li key={m.model} className="flex items-center gap-1.5 text-[10px]">
                    <span
                      className="w-1.5 h-1.5 rounded-sm shrink-0"
                      style={{ background: PIE_COLORS[i] ?? '#94a3b8' }}
                    />
                    <span className="font-mono text-content-secondary truncate flex-1 min-w-0">
                      {m.model}
                    </span>
                    <span className="font-mono text-content-muted tabular-nums shrink-0">
                      {pct}%
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono font-semibold text-content-secondary">0</span>
            <span className="text-[10px] text-content-muted">暂无生图记录</span>
          </div>
        )}

        {lastImageDay && imageTotal > 0 && (
          <p className="mt-2.5 text-[10px] text-content-muted">
            上次生图 {lastImageDay.slice(5)}
          </p>
        )}
      </div>

      {/* 📅 活跃 - 次主块：主数字适中 + sparkline 紧凑 */}
      <div className="rounded-xl border border-line/60 bg-surface/40 px-3.5 py-3.5">
        <div className="flex items-center gap-1.5 mb-2.5">
          <CalendarDays className="w-3.5 h-3.5 text-content-muted" />
          <p className="text-xs font-medium text-content-secondary">活跃</p>
        </div>
        <p className="text-xl font-semibold text-content-primary font-mono leading-tight text-left">
          {activeDays}
          <span className="text-xs font-normal text-content-muted ml-1.5">天 / 30 天</span>
        </p>
        {/* Sparkline：聊天 token 与生图张数各自归一化，叠加展示 */}
        <div className="mt-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] text-content-muted">
            <span className="w-2 h-2 rounded-sm bg-accent/70 inline-block" />
            <span>聊天</span>
            <span className="ml-auto font-mono tabular-nums">
              {usageStats.chat.totals.totalTokens.toLocaleString()} tokens
            </span>
          </div>
          <div className="flex items-end gap-[2px] h-5">
            {sparkDays.map((d) => {
              const h = d.totalTokens > 0
                ? Math.max((d.totalTokens / chatMax) * 100, 8)
                : 4
              return (
                <div
                  key={d.date}
                  className="flex-1 bg-accent/70 rounded-[1px]"
                  style={{ height: `${h}%` }}
                  title={`${d.date.slice(5)} · ${d.totalTokens.toLocaleString()} tokens`}
                />
              )
            })}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-content-muted pt-0.5">
            <span className="w-2 h-2 rounded-sm bg-emerald-500/70 inline-block" />
            <span>生图</span>
            <span className="ml-auto font-mono tabular-nums">
              {usageStats.image.totals.count.toLocaleString()} 张
            </span>
          </div>
          <div className="flex items-end gap-[2px] h-5">
            {usageStats.image.byDay.map((d) => {
              const h = d.count > 0
                ? Math.max((d.count / imageMax) * 100, 8)
                : 4
              return (
                <div
                  key={d.date}
                  className="flex-1 bg-emerald-500/70 rounded-[1px]"
                  style={{ height: `${h}%` }}
                  title={`${d.date.slice(5)} · ${d.count} 张`}
                />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
// Custom model types 已迁移至 @/hooks/useCustomModels（统一导出）

const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  user_info: '身份',
  preference: '偏好',
  habit: '习惯',
  project: '项目',
  skill: '技能',
  manual: '手动',
  other: '其他',
  general: '其他',
}

const PROVIDER_URL: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com',
  deepseek: 'https://platform.deepseek.com',
  qianwen: 'https://dashscope.aliyun.com',
  wenxin: 'https://cloud.baidu.com/product/qianfan',
  google: 'https://aistudio.google.com/apikey',
  mistral: 'https://console.mistral.ai/api-keys',
  xai: 'https://console.x.ai/',
  groq: 'https://console.groq.com/keys',
  moonshot: 'https://platform.moonshot.cn/console/api-keys',
  zhipu: 'https://open.bigmodel.cn/console/apikey/index',
  doubao: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  yi: 'https://platform.lingyiwanwu.com/apikeys',
}

type SectionId = 'overview' | 'session' | 'providers' | 'models' | 'search' | 'memory' | 'clarify' | 'localfiles' | 'masks' | 'mcp' | 'general' | 'help' | 'mobileapp' | 'about' | 'usage' | 'image' | 'buddy' | 'account' | 'apitokens' | 'portable' | 'quota' | 'redeem' | 'regcodes'

type NavItem = { id: SectionId; label: string; icon: typeof Key; adminOnly?: boolean }
type NavGroup = { title: string; items: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  {
    title: '模型',
    items: [
      { id: 'providers', label: '服务商 API Key', icon: Key },
      { id: 'models', label: '自定义模型', icon: Cpu },
    ],
  },
  {
    title: '能力',
    items: [
      { id: 'search', label: '联网搜索', icon: Globe },
      { id: 'image', label: '生图', icon: ImageIcon },
      { id: 'memory', label: '记忆', icon: Brain },
      { id: 'clarify', label: '澄清提问', icon: HelpCircle },
      { id: 'localfiles', label: '本地文件', icon: FolderOpen },
      { id: 'masks', label: '面具管理', icon: VenetianMask },
      { id: 'mcp', label: 'MCP 工具', icon: Plug },
    ],
  },
  {
    title: '账户',
    items: [
      { id: 'account', label: '用户中心', icon: User },
      { id: 'apitokens', label: 'API 令牌', icon: KeyRound },
      { id: 'portable', label: '对话搬运', icon: FileJson },
      { id: 'usage', label: '用量统计', icon: BarChart3 },
    ],
  },
  {
    title: '应用',
    items: [
      { id: 'general', label: '通用', icon: Settings2 },
      { id: 'help', label: '帮助', icon: HelpCircle },
      { id: 'mobileapp', label: '手机客户端', icon: Smartphone },
      { id: 'about', label: '关于', icon: Info },
    ],
  },
  // 管理员专属分组:整组 adminOnly,两个导航渲染位按 isAdmin 过滤后普通用户不可见;
  // 号池(公共池/公共模型/服务端 Key/用户用量)、激活码(额度分发)、注册码(注册准入)各占一 tab
  {
    title: '管理',
    items: [
      { id: 'quota', label: '额度号池', icon: Gauge, adminOnly: true },
      { id: 'redeem', label: '激活码', icon: Gift, adminOnly: true },
      { id: 'regcodes', label: '注册码', icon: Ticket, adminOnly: true },
    ],
  },
]

// 「总览」独立放在分组之上(欢迎页语义)
const TOP_ITEM: NavItem = { id: 'overview', label: '总览', icon: LayoutDashboard }

// 临时聊天模式的精简设置:会话管理 + 无账户语义的应用板块(通用/关于)。
// 「帮助」板块的 API Key 申请指引对访客无意义,临时导航不含此项;
// 其余板块(API Key/记忆/账号等)依赖被服务端 403 拦截的账户管理接口
const EPHEMERAL_SESSION_ITEM: NavItem = { id: 'session', label: '会话管理', icon: Timer }
// 总览作为独立项(两种模式共用,内容按 isEphemeral 分叉);
// 会话管理归入「会话」分组;帮助板块的 API Key 指引对访客无意义,临时导航不含
const EPHEMERAL_NAV_GROUPS: NavGroup[] = [
  { title: '会话', items: [EPHEMERAL_SESSION_ITEM] },
  ...NAV_GROUPS
    .filter((g) => g.title === '应用')
    .map((g) => ({ ...g, items: g.items.filter((i) => i.id !== 'help') })),
]
// 「手机客户端」访客也留:没登录的人正是最可能想装 App 的那批
const EPHEMERAL_SAFE_SECTIONS = new Set<SectionId>(['overview', 'session', 'general', 'mobileapp', 'about'])

// 单个侧边栏项:macOS 风格左侧 3px accent 指示条 + 极淡背景
function NavButton({
  item,
  active,
  onClick,
  badge,
}: {
  item: NavItem
  active: boolean
  onClick: () => void
  badge?: number
}) {
  const Icon = item.icon
  return (
    <button
      onClick={onClick}
      className={cn(
        // 移动端:横向胶囊;桌面端:左侧 3px accent 指示条
        'group relative flex items-center gap-2 pl-3 pr-2 py-1 rounded-md text-[13px] text-left transition-colors touch-manipulation whitespace-nowrap',
        // 移动端:更紧凑、上下间距 1
        'py-1 md:py-1',
        active
          ? 'bg-accent/[0.10] text-content-primary font-medium'
          : 'text-content-secondary hover:bg-surface-subtle/60',
        // 桌面端加 pl-3(留给指示条);移动端去掉
        'md:pl-3'
      )}
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      {/* 左侧指示条 —— 仅桌面端可见 */}
      <span
        className={cn(
          'hidden md:block absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full transition-colors',
          active ? 'bg-accent' : 'bg-transparent'
        )}
      />
      <Icon className="w-4 h-4 shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
      {badge !== undefined && (
        <span
          className={cn(
            'text-[10.5px] min-w-[18px] h-[16px] px-1 flex items-center justify-center rounded-full font-mono tabular-nums shrink-0',
            active
              ? 'bg-accent text-accent-foreground'
              : 'bg-surface-subtle text-content-muted group-hover:bg-surface-subtle/80'
          )}
        >
          {badge}
        </span>
      )}
    </button>
  )
}

// 移动端一级列表行：图标块 + 标签 + 当前值摘要 + ›（桌面端不用，见 NavButton）
function MobileSettingsRow({
  item,
  summary,
  onClick,
  lead,
}: {
  item: NavItem
  summary?: string
  onClick: () => void
  lead?: React.ReactNode
}) {
  const Icon = item.icon
  return (
    <button
      onClick={onClick}
      className="flex w-full min-h-[52px] items-center gap-3 px-3.5 py-2 text-left touch-manipulation active:bg-surface-subtle/70"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      {lead ?? (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-content-primary">
          <Icon className="h-4 w-4" />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[15.5px] text-content-primary">{item.label}</span>
      {summary ? (
        <span className="max-w-[46%] shrink-0 truncate text-[13.5px] text-content-muted">{summary}</span>
      ) : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-content-muted/50" />
    </button>
  )
}

/* ── 二级页控件原语（P3 统一行式，2026-10-05 定案）─────────────────────────
   桌面端保持既有「卡片 + 分段器」形态一像素不动；≤md 一律收成 ≥52px 的行：
   开关 → 行右侧大开关；分段 / 配色网格 → 「标签 + 当前值 + ›」，点开推入第三层单选页。
   单一真源：选项、当前值、写回函数只声明一次，两个断点共用同一份数据。 */
type PickerOption = { value: string; label: string; hint?: string; swatch?: string }
type PickerSpec = {
  title: string
  help?: string
  value: string
  options: PickerOption[]
  onPick: (value: string) => void
}
type OpenPicker = (spec: PickerSpec) => void
const MobilePickerCtx = createContext<OpenPicker | null>(null)

/** 开关滑块:移动端 46×28(拇指可稳按),桌面端维持原 36×20 */
function MSwitch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative shrink-0 rounded-full transition-colors',
        on ? 'bg-accent' : 'bg-surface-subtle',
        'h-[28px] w-[46px] md:h-5 md:w-9'
      )}
    >
      <span
        className={cn(
          'absolute rounded-full bg-white transition-transform dark:bg-surface',
          'left-[2px] top-[2px] h-6 w-6',
          on ? 'translate-x-[18px]' : 'translate-x-0',
          'md:left-0.5 md:top-0.5 md:h-4 md:w-4',
          on && 'md:translate-x-4'
        )}
      />
    </span>
  )
}

/**
 * 「记忆里的你」(波2)：把 AI 每轮真正看到的两段文本摊开给用户读。
 * 档案段由服务端算好回传，界面不重算——注入规则只在一处，不会和实际注入漂移。
 */
function ProfileMirror({
  section,
  enabled,
  derivedNote,
  alwaysMemories,
}: {
  section: string
  enabled: boolean
  derivedNote: string
  alwaysMemories: { id: string; content: string }[]
}) {
  return (
    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2" data-profile-mirror>
      <div>
        <p className="text-xs font-medium text-content-secondary">记忆里的你</p>
        <p className="text-[10px] text-content-muted/70 mt-0.5 max-md:hidden">
          下面就是 AI 每一轮实际看到的文本，只读；要改回上面的档案或「记忆」板块。
        </p>
      </div>

      {section ? (
        <div className="rounded-lg border border-line/50 bg-surface-muted/50 px-2.5 py-2">
          <p className="text-[11px] leading-relaxed text-content-secondary whitespace-pre-line break-words">
            {section}
          </p>
          <p className="mt-1.5 text-[10px] text-content-muted/70">
            档案段 {section.length} / 200 字符{enabled ? '' : ' · 开关已关，当前不注入'}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-content-muted">档案段还是空的，AI 目前只从记忆里认识你。</p>
      )}

      {derivedNote && <p className="text-[11px] leading-snug text-content-muted">{derivedNote}</p>}

      <div className="space-y-1">
        <p className="text-[10px] text-content-muted/70">
          记忆流里每轮必带的 {alwaysMemories.length} 条
          {alwaysMemories.length > 5 ? '（列前 5 条）' : ''}
        </p>
        {alwaysMemories.slice(0, 5).map((m) => (
          <p key={m.id} className="text-[11px] leading-snug text-content-secondary break-words">
            · {m.content}
          </p>
        ))}
        {alwaysMemories.length === 0 && (
          <p className="text-[11px] text-content-muted">还没有这类记忆。</p>
        )}
      </div>
    </div>
  )
}

/** 开关行。调用方把它放进既有的卡片容器里即可,两断点共用同一份 label/help */
function MSwitchRow({
  label,
  help,
  checked,
  onChange,
  className,
  disabled,
}: {
  label: string
  help?: string
  checked: boolean
  onChange: (next: boolean) => void
  className?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex min-h-[52px] w-full items-center justify-between gap-3 py-2 text-left touch-manipulation active:bg-surface-subtle/50 md:min-h-0',
        disabled && 'cursor-not-allowed opacity-40',
        className
      )}
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <span className="min-w-0">
        <span className="block truncate text-[15.5px] text-content-primary md:text-xs md:text-content-secondary">{label}</span>
        {help && <span className="mt-0.5 block text-[12.5px] leading-snug text-content-muted md:text-[11px] max-md:hidden">{help}</span>}
      </span>
      <MSwitch on={checked} />
    </button>
  )
}

/** 移动端摘要行:标签 + 当前值 + ›,点开推入第三层单选页。桌面端不渲染 */
function MPickerRow<T extends string>({
  label,
  options,
  value,
  onPick,
  help,
  className,
}: {
  label: string
  options: readonly { value: T; label: string; hint?: string; swatch?: string }[]
  value: T
  onPick: (next: T) => void
  help?: string
  className?: string
}) {
  const openPicker = useContext(MobilePickerCtx)
  const current = options.find((o) => o.value === value)
  return (
    <button
      onClick={() =>
        openPicker?.({
          title: label,
          help,
          value,
          options: options.map((o) => ({ value: o.value, label: o.label, hint: o.hint, swatch: o.swatch })),
          onPick: (v) => onPick(v as T),
        })
      }
      className={cn(
        'flex min-h-[52px] w-full items-center gap-3 py-2 text-left touch-manipulation active:bg-surface-subtle/70 md:hidden',
        className
      )}
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <span className="min-w-0 flex-1 truncate text-[15.5px] text-content-primary">{label}</span>
      <span className="max-w-[46%] shrink-0 truncate text-[13.5px] text-content-muted">{current?.label ?? value}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-content-muted/50" />
    </button>
  )
}

/** 单选一行的两种皮肤:桌面 = 卡片内分段胶囊;移动 = 摘要行 + 推入单选页 */
function MSegRow<T extends string>({
  label,
  options,
  value,
  onChange,
  help,
  className,
}: {
  label: string
  options: readonly { value: T; label: string; hint?: string; swatch?: string }[]
  value: T
  onChange: (next: T) => void
  help?: string
  /** 桌面端分段器容器附加类(通常是 mt-2.5 这类与卡片头的间距) */
  className?: string
}) {
  return (
    <>
      <div className={cn('hidden md:flex rounded-lg bg-surface-muted p-0.5 gap-0.5', className)}>
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            aria-pressed={value === opt.value}
            className={cn(
              'flex-1 whitespace-nowrap px-2 py-1.5 rounded-md text-xs font-medium transition-colors',
              value === opt.value
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-content-muted hover:text-content-primary'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <MPickerRow
        label={label}
        options={options}
        value={value}
        onPick={onChange}
        help={help}
        className={className}
      />
    </>
  )
}

/** 第三层:推入式单选页(仅移动端)。盖满卡片,自带与三簇同一条 14px 基线的页头。
 *  shown 由父层的「挂载 → double RAF → true」驱动,右推/右出用 translate-x 过渡 */
function MobilePickerPage({ spec, back, shown, onClose }: { spec: PickerSpec; back: string; shown: boolean; onClose: () => void }) {
  return (
    <div
      data-m-picker
      className={cn(
        'absolute inset-0 z-40 flex flex-col bg-background md:hidden transition-transform duration-300 ease-out',
        shown ? 'translate-x-0' : 'translate-x-full'
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line/60 bg-surface pl-5 pr-[var(--m-chrome-inset)] pt-[var(--m-chrome-top)] pb-2">
        <button
          onClick={onClose}
          aria-label={`返回${back}`}
          className="-ml-3 flex h-10 shrink-0 items-center rounded-lg px-2 text-content-secondary touch-manipulation active:bg-surface-subtle/70"
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <ChevronLeft className="h-[22px] w-[22px]" />
        </button>
        <h3 className="min-w-0 truncate text-[17px] font-semibold text-content-primary">{spec.title}</h3>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
        {/* 手机端统一去「介绍」:选择页顶部说明不再渲染(2026-10-06 用户定案);help 数据仍保留,便于回调复用 */}
        <div className="mt-2 divide-y divide-line/50 overflow-hidden rounded-xl border border-line/60 bg-surface">
          {spec.options.map((o) => {
            const on = o.value === spec.value
            return (
              <button
                key={o.value}
                onClick={() => {
                  spec.onPick(o.value)
                  onClose()
                }}
                className="flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left touch-manipulation active:bg-surface-subtle/70"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                {o.swatch && (
                  <span aria-hidden className="h-4 w-4 shrink-0 rounded-full border border-line/70" style={{ background: o.swatch }} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15.5px] text-content-primary">{o.label}</span>
                  {o.hint && <span className="block text-[12.5px] leading-snug text-content-muted">{o.hint}</span>}
                </span>
                {on && <Check className="h-[18px] w-[18px] shrink-0 text-accent" />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function SettingsModal({
  forceOpen = false,
  onRequestClose,
}: {
  /** 独立子窗口模式：忽略 store 开关恒渲染；所有“关闭”请求转交宿主(如隐藏子窗口) */
  forceOpen?: boolean
  onRequestClose?: () => void
} = {}) {
  const storeSettingsOpen = useChatStore((s) => s.settingsOpen)
  const storeSetSettingsOpen = useChatStore((s) => s.setSettingsOpen)
  // 独立子窗口模式下遮蔽 store action：组件内全部 setSettingsOpen(false) 调用点
  // (红点按钮/ESC/移动端关闭)自动转交宿主，无需逐处修改
  const setSettingsOpen = forceOpen
    ? (open: boolean) => { if (!open) onRequestClose?.() }
    : storeSetSettingsOpen
  const settingsOpen = forceOpen || storeSettingsOpen
  const settingsSection = useChatStore((s) => s.settingsSection)
  const setSettingsSection = useChatStore((s) => s.setSettingsSection)
  const currentConversationId = useChatStore((s) => s.currentConversationId)
  const conversationStylePreset = useChatStore((s) => s.conversationStylePreset)
  const setConversationStylePreset = useChatStore((s) => s.setConversationStylePreset)
  const conversationReplyLength = useChatStore((s) => s.conversationReplyLength)
  const setConversationReplyLength = useChatStore((s) => s.setConversationReplyLength)
  const bumpConversationVersion = useChatStore((s) => s.bumpConversationVersion)
  // 聊天行为:思考完毕自动折叠思考框(纯本地偏好,localStorage 持久化,不入 AI 可控注册表)
  const autoCollapseReasoning = useChatStore((s) => s.autoCollapseReasoning)
  const setAutoCollapseReasoning = useChatStore((s) => s.setAutoCollapseReasoning)
  // 背景:关 / 内置壁纸(纯本地偏好,localStorage 持久化,不入 AI 可控注册表)
  const backdropMode = useChatStore((s) => s.backdropMode)
  const setBackdropMode = useChatStore((s) => s.setBackdropMode)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [keys, setKeys] = useState<KeyInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [initialLoadComplete, setInitialLoadComplete] = useState(false)
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [testResult, setTestResult] = useState<Record<string, 'success' | 'error'>>({})
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({})
  // 服务商卡片折叠:未记录时回落默认值(已配置收起/未配置展开),无需 effect 同步
  const [providerCardsExpanded, { set: setCardExpanded }] = useToggleMap({})
  const [memories, setMemories] = useState<MemoryInfo[]>([])
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  const [clarifyEnabled, setClarifyEnabled] = useState(true)
  const [aiControlEnabled, setAiControlEnabled] = useState(true)
  // 用户中心:用户名 + 称呼 + 档案草稿(打开设置时随 /api/profiles 一起拉取)
  const [profile, setProfile] = useState<UserProfileInfo | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [nameSaving, setNameSaving] = useState(false)
  // 用户中心:称呼 + 通用档案(档案卡只读,填写一律走采集弹窗)
  const [nicknameDraft, setNicknameDraft] = useState('')
  const [nicknameSaving, setNicknameSaving] = useState(false)
  const [profileState, setProfileState] = useState<ProfileStateInfo | null>(null)
  const [profileDerived, setProfileDerived] = useState<DerivedStage | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)
  const [probeDialogOpen, setProbeDialogOpen] = useState(false)
  // 「记忆里的你」:服务端算好的注入段原文,界面不复刻注入规则
  const [profileSection, setProfileSection] = useState('')
  // ── 临时聊天(访客模式):访客密码 + 隔离区管理 + 记忆注入开关 ──
  const [ephemeralSettings, setEphemeralSettings] = useState<{ hasGuestPassword: boolean; ephemeralMemoryInjection: boolean } | null>(null)
  const [ephemeralItems, setEphemeralItems] = useState<EphemeralConversationInfo[]>([])
  const [guestPwdEditing, setGuestPwdEditing] = useState(false)
  const [guestPwdDraft, setGuestPwdDraft] = useState('')
  const [guestMainPwdDraft, setGuestMainPwdDraft] = useState('')
  const [guestPwdSaving, setGuestPwdSaving] = useState(false)
  const [memInjectSaving, setMemInjectSaving] = useState(false)
  const [ephemeralPreviewId, setEphemeralPreviewId] = useState<string | null>(null)
  const [ephemeralPreviewMsgs, setEphemeralPreviewMsgs] = useState<EphemeralPreviewMessage[] | null>(null)
  const [ephemeralPreviewLoading, setEphemeralPreviewLoading] = useState(false)
  const [ephemeralActingId, setEphemeralActingId] = useState<string | null>(null)
  const [memoryDraft, setMemoryDraft] = useState('')
  const [memorySaving, setMemorySaving] = useState(false)
  const [memoryDeleting, setMemoryDeleting] = useState<string | null>(null)
  // ── 记忆单条编辑(D) ────────────────────────────────────
  const [memoryEditingId, setMemoryEditingId] = useState<string | null>(null)
  const [memoryEditDraft, setMemoryEditDraft] = useState('')
  const [memorySavingEdit, setMemorySavingEdit] = useState(false)
  // ── 记忆矛盾消解：冲突裁决 + 已被取代分组 ──────────────────
  const [memoryConflicts, setMemoryConflicts] = useState<MemoryConflictGroup[]>([])
  const [supersededMemories, setSupersededMemories] = useState<MemoryInfo[]>([])
  const [supersededOpen, setSupersededOpen] = useState(false)
  const [memoryResolving, setMemoryResolving] = useState<string | null>(null)
  // ── 记忆导入（从 ChatGPT / Claude 等其他 AI 导入）──────────────
  const [memoryImportOpen, setMemoryImportOpen] = useState(false)
  const [memoryImportSource, setMemoryImportSource] = useState('')
  const [memoryImportText, setMemoryImportText] = useState('')
  const [memoryImportDrafts, setMemoryImportDrafts] = useState<ParsedMemoryDraft[]>([])
  const [memoryImportSaving, setMemoryImportSaving] = useState(false)
  const [memoryImportError, setMemoryImportError] = useState<string | null>(null)
  const [refCopied, setRefCopied] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>('overview')
  // 移动端主从：false=一级分组列表，true=当前分区详情（推入）。桌面端不用这个开关
  const [mobileInDetail, setMobileInDetail] = useState(false)
  // 第三层(移动端单选页)。back 记的是打开它时所在的分区名,页头「‹ 分区名」用它
  const [mobilePicker, setMobilePicker] = useState<(PickerSpec & { back: string }) | null>(null)
  // 外观是一维的: 上面那排主题(浅色/深色/跟随系统/格子)四选一,
  // 下面那排按主题切换 —— 非格子时选配色,格子时选日出/白天/暮色/晚上,
  // 那个"按时间自动"开关则决定光态是手选还是由时间解析
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>('system')
  const [paletteChoice, setPaletteChoice] = useState<SelectablePalette>('base')
  const [gridTone, setGridTone] = useState<GridTone>('day')
  const [gridToneAuto, setGridToneAuto] = useState(false)
    const inTauri = useIsTauri()
    // 通知类开关按「在任意壳内」露出:安卓壳一样有系统通知能力,
    // 用 inTauri(桌面专属)会把手机端这两项藏掉,设置里根本调不了。
    const inShell = useIsTauriShell()

    // 安卓安装包清单:nginx /apk/ 与站点同源(见 scripts/android-publish.ps1),
    // 取到才在「手机客户端」分区显示版本号与包体大小,取不到就退化成「重试」。
    const [apkManifest, setApkManifest] = useState<{ version: string; url: string; size: number } | null>(null)
    const [apkLoading, setApkLoading] = useState(false)
    const loadApkManifest = useCallback(() => {
      setApkLoading(true)
      fetch('/apk/latest.json')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j: Record<string, unknown>) =>
          setApkManifest({
            version: String(j.version ?? ''),
            url: String(j.url ?? ''),
            size: Number(j.size) || 0,
          })
        )
        .catch(() => setApkManifest(null))
        .finally(() => setApkLoading(false))
    }, [])
    useEffect(() => {
      if (inShell) return
      loadApkManifest()
    }, [inShell, loadApkManifest])

    // 回复完成系统通知开关:仅桌面端有意义(依赖系统通知能力),偏好存 localStorage(默认开)
    const [notifyOnReply, setNotifyOnReplyState] = useState(true)
    useEffect(() => {
      if (!inShell) return
      setNotifyOnReplyState(getNotifyOnReply())
    }, [inShell])
    const handleToggleNotify = useCallback(() => {
      setNotifyOnReplyState((v) => {
        const next = !v
        setNotifyOnReply(next)
        return next
      })
    }, [])

    // 后台回复提醒(手机壳):发一条消息时向系统预约一条 N 秒后的定时通知。
    // 做成预约式而不是「完成时通知」,是因为壳切后台会冻住 JS(WebView.onPause),
    // 前端等不到完成那一刻;时长只能是估算值。
    const [reminderDelay, setReminderDelayState] = useState('45')
    useEffect(() => {
      if (!inShell) return
      const saved = String(getReplyReminderDelaySec())
      // 只认档位表里的值:localStorage 被手改过或存过别的数,回落到默认档
      setReminderDelayState(REMINDER_DELAY_CHOICES.some((c) => c.value === saved) ? saved : '45')
    }, [inShell])
    const handleChangeReminderDelay = useCallback((next: string) => {
      setReminderDelayState(next)
      setReplyReminderDelaySec(Number(next))
    }, [])

    // ============ AI 本地文件能力(仅桌面端) ============
    // 总开关存 DB(localFilesEnabled),经 /api/settings/local-files 读写;授权工作区根存
    // 客户端 Rust 配置(不入库),这里读回仅用于展示。非 Tauri 环境整块置灰。
    const [localFilesEnabled, setLocalFilesEnabled] = useState(false)
    // exec 命令"始终运行":开启后 AI 执行 PowerShell 命令不再弹确认卡(高危,含写/联网)
    const [localFilesExecAutoRun, setLocalFilesExecAutoRun] = useState(false)
    const [workspaceDir, setWorkspaceDir] = useState<string | null>(null)
    const [pickingDir, setPickingDir] = useState(false)
    useEffect(() => {
      if (!inTauri) return
      let cancelled = false
      getWorkspaceDir()
        .then((dir) => { if (!cancelled) setWorkspaceDir(dir) })
        .catch(() => {})
      return () => { cancelled = true }
    }, [inTauri])

    async function handleToggleLocalFiles(enabled: boolean) {
      setLocalFilesEnabled(enabled)
      try {
        const res = await fetch('/api/settings/local-files', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        if (!res.ok) throw new Error()
        // 同步 ChatPanel 的开关缓存:主窗口内弹窗(默认形态)下 storage 事件不会发给
        // 自己,直接 invalidate 立即 refetch(不受 staleTime 限制);独立子窗口形态下
        // 本窗口无该 active query,invalidate 为空操作,由 storage 广播通知主窗口。
        queryClient.invalidateQueries({ queryKey: ['settings', 'local-files'] })
        try { localStorage.setItem(LOCAL_FILES_SYNC_KEY, String(Date.now())) } catch {}
        toast.success(enabled ? '本地文件能力已开启' : '本地文件能力已关闭')
      } catch {
        setLocalFilesEnabled(!enabled)
        toast.error('切换失败，请重试')
      }
    }

    async function handleToggleExecAutoRun(enabled: boolean) {
      setLocalFilesExecAutoRun(enabled)
      try {
        const res = await fetch('/api/settings/local-files', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ execAutoRun: enabled }),
        })
        if (!res.ok) throw new Error()
        queryClient.invalidateQueries({ queryKey: ['settings', 'local-files'] })
        try { localStorage.setItem(LOCAL_FILES_SYNC_KEY, String(Date.now())) } catch {}
        toast.success(enabled ? '命令始终运行已开启' : '命令始终运行已关闭')
      } catch {
        setLocalFilesExecAutoRun(!enabled)
        toast.error('切换失败，请重试')
      }
    }

    async function handlePickWorkspace() {
      if (pickingDir) return
      setPickingDir(true)
      try {
        const res = await pickWorkspaceDir()
        if (res.ok && res.base) {
          setWorkspaceDir(res.base)
          // 右侧「工作区」产物区读同一个 query（授权根），选完即全局刷新
          queryClient.invalidateQueries({ queryKey: ['workspace'] })
          toast.success('工作区已授权')
        } else if (!res.cancelled) {
          toast.error(res.error || '设置工作区失败')
        }
      } finally {
        setPickingDir(false)
      }
    }

  // 自定义模型：所有 state + handler 已抽离到 useCustomModels hook
  const {
    customModels,
    userPresets,
    allPresets,
    cmForm,
    cmFormOpen,
    cmSaving,
    cmTesting,
    cmDeleting,
    cmFormResult,
    cmTestResult,
    setCmForm,
    setCmFormOpen,
    loadCustomModels,
    applyPreset,
    startEdit,
    saveModel: handleCmSave,
    deleteModel: handleCmDelete,
    testModel: handleCmTest,
    addUserPreset,
    updateUserPreset,
    removeUserPreset,
  } = useCustomModels()

  // 预置模型管理：覆盖 ProviderModelOverride 表（隐藏/添加/删除/更新）
  const {
    overrides: providerOverrides,
    loading: providerOverridesLoading,
    error: providerOverridesError,
    pendingId: providerPendingId,
    fetchOverrides: fetchProviderOverrides,
    hideBuiltin,
    unhideBuiltin,
    addUserModel: addProviderUserModel,
    updateOverride,
    deleteOverride,
  } = useProviderModels()

  // 预置模型管理：内嵌表单（按 provider 折叠，展开时显示「+ 添加模型」表单）
  const [pmFormOpen, setPmFormOpen] = useState(false)
  const [pmForm, setPmForm] = useState<ProviderModelOverrideForm>({
    provider: '',
    modelId: '',
    isHidden: false,
    name: '',
    contextWindow: 32768,
    supportsVision: false,
    supportsFiles: false,
    supportsReasoning: false,
  })
  const [pmTestingId, setPmTestingId] = useState<string | null>(null)
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  // 用户预设增删改的小表单状态（与 cmForm 解耦，独立管理）
  const [presetFormOpen, setPresetFormOpen] = useState(false)
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null)
  const [presetDraft, setPresetDraft] = useState({ name: '', baseURL: '' })

  // Usage stats state
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null)
  const [usageTab, setUsageTab] = useState<'overview' | 'chat' | 'image'>('chat')
  const [usageRefreshing, setUsageRefreshing] = useState(false)

  // Image generation settings state
  const [imageModel, setImageModel] = useState('builtin:wanx2.1-t2i-turbo')
  const [imageSize, setImageSize] = useState('1024*1024')
  const [imageSizeSaving, setImageSizeSaving] = useState(false)
  const [imageBuiltinModels, setImageBuiltinModels] = useState<Record<string, unknown>[]>([])
  const [imageCustomModels, setImageCustomModels] = useState<Record<string, unknown>[]>([])
  const [imageCmForm, setImageCmForm] = useState({ name: '', modelId: '', baseURL: '', apiKeySource: 'provider', apiKey: '', keyProvider: '', supportsSize: true })
  const [imageCmSaving, setImageCmSaving] = useState(false)
  const [imageCmDeleting, setImageCmDeleting] = useState<string | null>(null)
  const [imageFormOpen, setImageFormOpen] = useState(false)
  const [editingImageModelId, setEditingImageModelId] = useState<string | null>(null)

  // 联网搜索：当前选中引擎（来自共享 store，滑块和 ChatPanel 共用）
  const searchEngine = useChatStore((s) => s.searchEngine)
  // update: 修改用户名后刷新 JWT session(侧边栏等处立即生效)
  const { data: session, update: updateSession } = useSession()
  // 临时聊天模式:精简版设置(会话管理/通用/关于,不加载任何账户数据)
  const isEphemeral = session?.ephemeral === true
  // 管理员入口显隐依据 JWT role(登录时固化);服务端 API 一律按 DB 实时值验权,
  // 所以 role 变更/老会话需要重新登录才看到入口,不会出现「看到入口但接口放行」的错配
  const isAdmin = session?.user?.role === 'admin'

  // 导航行统一显隐口径:管理组按 role,「手机客户端」按端 —— 桌面壳自己就是客户端,
  // 安卓壳另有 UpdateBanner 走应用内更新,两处壳里放一个"下载 APK"入口只会误导。
  const navItemVisible = useCallback(
    (item: NavItem) => (!item.adminOnly || isAdmin) && !(item.id === 'mobileapp' && inShell),
    [isAdmin, inShell]
  )

  // 桌面侧栏一个分组的行：滚动区里的普通分组与底部钉住的「管理」共用这一段
  const renderNavGroup = (group: NavGroup) => (
    <div key={group.title} className="flex md:flex-col items-stretch md:items-stretch gap-0.5 md:space-y-2">
      {/* 移动端隐藏分组标题;桌面端显示 */}
      <div className="hidden md:block px-1.5 pb-1 pt-1 text-[10.5px] uppercase tracking-[0.04em] font-medium text-content-muted">
        {group.title}
      </div>
      <div className="flex md:flex-col gap-0.5 md:space-y-px">
        {group.items.filter(navItemVisible).map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={activeSection === item.id}
            onClick={() => setActiveSection(item.id)}
            badge={
              item.id === 'providers' && keys.length > 0 ? keys.length :
              item.id === 'memory' && memories.length > 0 ? memories.length :
              undefined
            }
          />
        ))}
      </div>
    </div>
  )

  // ── 临时会话管理:剩余时间 / 清空本会话对话 / 退出登录 ──
  const [sessionRemaining, setSessionRemaining] = useState<string | null>(null)
  useEffect(() => {
    if (!settingsOpen || !isEphemeral) return
    const calc = () => {
      // 用 JWT 内的真实过期时间(sessionEndsAt);session.expires 是全局 maxAge(30 天),不反映 12h 压缩有效期
      const expires = typeof session?.sessionEndsAt === 'number' ? session.sessionEndsAt : NaN
      if (!Number.isFinite(expires)) { setSessionRemaining(null); return }
      const mins = Math.floor((expires - Date.now()) / 60000)
      if (mins <= 0) { setSessionRemaining('即将过期'); return }
      setSessionRemaining(mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${mins} 分钟`)
    }
    calc()
    const t = setInterval(calc, 30_000)
    return () => clearInterval(t)
  }, [settingsOpen, isEphemeral, session?.sessionEndsAt])

  const [ephCount, setEphCount] = useState<number | null>(null)
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  // 会话管理/总览板块可见时拉取隔离区对话数量(临时模式允许读自己的隔离区列表)
  useEffect(() => {
    if (!settingsOpen || !isEphemeral) return
    if (activeSection !== 'session' && activeSection !== 'overview') return
    let alive = true
    fetch('/api/conversations?scope=ephemeral')
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (!alive) return
        const items = Array.isArray(list?.items) ? list.items : Array.isArray(list) ? list : []
        setEphCount(items.length)
      })
      .catch(() => { if (alive) setEphCount(0) })
    return () => { alive = false }
  }, [settingsOpen, isEphemeral, activeSection])

  const handleClearEphemeral = async () => {
    if (clearing) return
    setClearing(true)
    try {
      // 分页收齐隔离区对话 id(列表接口单页上限 100,原先只取默认 20 条 = 只能清前 20 条)
      const ids: string[] = []
      for (let page = 0; page < 10; page++) {
        const list = await fetch(`/api/conversations?scope=ephemeral&limit=100&offset=${ids.length}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
        const items = Array.isArray(list?.items) ? list.items : []
        ids.push(...items.map((c: { id: string }) => c.id))
        if (items.length < 100) break
      }
      // 批量端点单次上限 200 条;原先这里逐条 DELETE /api/conversations/[id],
      // 而该端点按 ephemeralScope 校验归属(正常模式 isEphemeral:false),
      // 隔离区对话必然 404 —— 清空功能一直是空的,改走 scope=ephemeral 的批量口径。
      let deleted = 0
      let failed = 0
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200)
        const res = await fetch('/api/conversations/batch-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ ids: chunk, scope: 'ephemeral' }),
        }).catch(() => null)
        if (res?.ok) {
          const data = await res.json().catch(() => ({}))
          deleted += typeof data?.deleted === 'number' ? data.deleted : chunk.length
          failed += typeof data?.skipped === 'number' ? data.skipped : 0
        } else {
          failed += chunk.length
        }
      }
      if (failed > 0) {
        toast.error(`${deleted} 条已删除，${failed} 条删除失败，请重试`, { title: '清空临时对话' })
      } else {
        toast.success(`已清空 ${deleted} 条临时对话`, { title: '清空临时对话' })
      }
      setEphCount(failed > 0 ? Math.max(0, (ephCount ?? 0) - deleted) : 0)
      setConfirmClear(false)
      bumpConversationVersion()
    } finally {
      setClearing(false)
    }
  }

  const handleEphemeralSignOut = () => {
    signOut({ callbackUrl: '/login/ephemeral' })
  }

  // 退出登录
  const handleSignOut = async () => {
    await signOut({ callbackUrl: '/login' })
  }

  // 用户中心:保存用户名,并同步刷新 session(JWT 策略下不 update 的话侧边栏仍是旧值)
  const handleSaveName = async () => {
    const newName = nameDraft.trim()
    if (!newName) {
      toast.error('用户名不能为空')
      return
    }
    if (newName.length > 20) {
      toast.error('用户名不能超过 20 个字符')
      return
    }
    setNameSaving(true)
    try {
      const r = await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data?.error || '保存失败，请重试')
      }
      const updated: UserProfileInfo = await r.json()
      setProfile(updated)
      setNameDraft(updated.name ?? '')
      await updateSession({ name: newName })
      toast.success('用户名已更新')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setNameSaving(false)
    }
  }

  // 档案写口(PUT/POST/DELETE)只回档案行,注入段与推算要靠 GET 回读,
  // 保存后补一次拉取,「记忆里的你」才不会显示改之前的那段
  const refreshProfileView = async () => {
    try {
      const res = await fetch('/api/profiles', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json().catch(() => null)
      if (!data?.profile) return
      setProfileState(data.profile)
      setProfileDerived(data.derived ?? null)
      setProfileSection(typeof data.section === 'string' ? data.section : '')
    } catch {
      // 回读失败只影响聚合视图刷新,已保存的档案本身不受影响
    }
  }

  // 用户中心:保存称呼（AI 怎么叫你）。留空即清除，回退链交给用户名
  const handleSaveNickname = async () => {
    setNicknameSaving(true)
    try {
      const res = await fetch('/api/profiles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nicknameDraft.trim() }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '保存失败，请重试')
      setProfileState(data)
      setProfile((p) => (p ? { ...p, nickname: nicknameDraft.trim() || null } : p))
      toast.success('称呼已更新')
      await refreshProfileView()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setNicknameSaving(false)
    }
  }

  // 用户中心:注入开关单独成一次表态(只翻开关不改档位,所以不会重置提醒节奏)
  const handleToggleProfileEnabled = async (next: boolean) => {
    if (!profileState) return
    const prev = profileState
    setProfileState({ ...prev, enabled: next })
    setProfileSaving(true)
    try {
      const res = await fetch('/api/profiles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '保存失败，请重试')
      setProfileState(data)
      await refreshProfileView()
    } catch (err) {
      setProfileState(prev)
      toast.error(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setProfileSaving(false)
    }
  }

  // 换学年推算只给建议：点「升入 X」才把确认值写成 X；传空串=确认已毕业（清掉学段）
  const handleConfirmStage = async (stage: string) => {
    setProfileSaving(true)
    try {
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', stage }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '保存失败，请重试')
      setProfileState(data)
      setProfileDerived(null)
      toast.success(stage ? `已确认：${stage}` : '已确认学段')
      await refreshProfileView()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setProfileSaving(false)
    }
  }

  // 用户中心:清空档案行（称呼是用户自己的字段，不随之清除）
  const handleResetProfile = async () => {
    const ok = await confirmDialog({
      title: '清空档案',
      message: 'AI 将不再了解你的身份、学段与讲解偏好，称呼与用户名不受影响。',
      danger: true,
      okText: '清空',
    })
    if (!ok) return
    setProfileSaving(true)
    try {
      const res = await fetch('/api/profiles', { method: 'DELETE' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '清空失败，请重试')
      setProfileState(data)
      setProfileDerived(null)
      toast.success('档案已清空')
      await refreshProfileView()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清空失败，请重试')
    } finally {
      setProfileSaving(false)
    }
  }

  // 临时聊天:转正后失效正常历史列表缓存(侧边栏立即可见)
  const queryClient = useQueryClient()

  // 临时聊天:加载访客密码状态/记忆注入开关 + 隔离区对话列表(仅正常模式有数据)
  const loadEphemeralData = useCallback(async () => {
    try {
      const [settings, list] = await Promise.all([
        fetch('/api/user/ephemeral-settings').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/ephemeral').then((r) => (r.ok ? r.json() : null)),
      ])
      if (settings && typeof settings === 'object') {
        setEphemeralSettings({
          hasGuestPassword: !!settings.hasGuestPassword,
          ephemeralMemoryInjection: !!settings.ephemeralMemoryInjection,
        })
      }
      setEphemeralItems(Array.isArray(list?.items) ? list.items : [])
    } catch { /* silently fail */ }
  }, [])

  // 临时聊天数据:打开设置时加载(临时模式为访客身份,跳过)
  useEffect(() => {
    if (!settingsOpen || isEphemeral) return
    loadEphemeralData()
  }, [settingsOpen, loadEphemeralData, isEphemeral])

  // 访客密码:设置/修改/清除(均需主密码确认)
  const handleSaveGuestPassword = async (clear: boolean) => {
    if (!clear && !guestPwdDraft.trim()) {
      toast.error('请输入访客密码')
      return
    }
    if (!guestMainPwdDraft) {
      toast.error('请输入主密码确认')
      return
    }
    setGuestPwdSaving(true)
    try {
      const r = await fetch('/api/user/ephemeral-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: guestMainPwdDraft,
          guestPassword: clear ? null : guestPwdDraft.trim(),
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data?.error || '保存失败，请重试')
      setEphemeralSettings((s) => (s ? { ...s, hasGuestPassword: !!data.hasGuestPassword } : s))
      setGuestPwdEditing(false)
      setGuestPwdDraft('')
      setGuestMainPwdDraft('')
      toast.success(clear ? '访客密码已清除，临时登录入口已关闭' : '访客密码已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setGuestPwdSaving(false)
    }
  }

  // 记忆注入开关:不涉及入口凭据,直接切换
  const handleToggleMemoryInjection = async (next: boolean) => {
    setMemInjectSaving(true)
    try {
      const r = await fetch('/api/user/ephemeral-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ephemeralMemoryInjection: next }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data?.error || '保存失败，请重试')
      setEphemeralSettings((s) => (s ? { ...s, ephemeralMemoryInjection: next } : s))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setMemInjectSaving(false)
    }
  }

  // 隔离区:查看(展开消息预览,再次点击收起)
  const handlePreviewEphemeral = async (id: string) => {
    if (ephemeralPreviewId === id) {
      setEphemeralPreviewId(null)
      setEphemeralPreviewMsgs(null)
      return
    }
    setEphemeralPreviewId(id)
    setEphemeralPreviewMsgs(null)
    setEphemeralPreviewLoading(true)
    try {
      const r = await fetch(`/api/ephemeral?id=${encodeURIComponent(id)}`)
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data?.error || '加载失败')
      setEphemeralPreviewMsgs(Array.isArray(data?.messages) ? data.messages : [])
    } catch {
      toast.error('加载预览失败')
      setEphemeralPreviewId(null)
    } finally {
      setEphemeralPreviewLoading(false)
    }
  }

  // 隔离区:转正(回到正常历史) / 删除(级联清理,不可恢复)
  const handleEphemeralAction = async (action: 'restore' | 'delete', id: string) => {
    if (action === 'delete' && !(await confirmDialog({ title: '彻底删除临时对话', message: '消息与附件将一并清除，不可恢复。', danger: true, okText: '彻底删除' }))) return
    setEphemeralActingId(id)
    try {
      const r = await fetch('/api/ephemeral', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data?.error || '操作失败，请重试')
      setEphemeralItems((items) => items.filter((it) => it.id !== id))
      if (ephemeralPreviewId === id) {
        setEphemeralPreviewId(null)
        setEphemeralPreviewMsgs(null)
      }
      if (action === 'restore') {
        queryClient.invalidateQueries({ queryKey: [...queryKeys.all, 'conversations'] })
        toast.success('已转正，对话回到正常历史列表')
      } else {
        toast.success('临时对话已删除')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setEphemeralActingId(null)
    }
  }

  // 联网搜索设置状态
  const [searchQuery, setSearchQuery] = useState('')
  const [searchTesting, setSearchTesting] = useState(false)
  const [searchTestResult, setSearchTestResult] = useState<{
    ok: boolean
    items?: Array<{ title: string; url: string; snippet: string }>
    error?: string
  } | null>(null)

  // 联网搜索 Key 状态（独立于服务商 Key）
  interface SearchKeyInfo { id: string; engine: string; maskedKey: string; updatedAt: string }
  const [searchKeys, setSearchKeys] = useState<SearchKeyInfo[]>([])
  const [searchDraftKeys, setSearchDraftKeys] = useState<Record<string, string>>({})
  const [searchKeySaving, setSearchKeySaving] = useState<Record<string, boolean>>({})
  const [searchKeyDeleting, setSearchKeyDeleting] = useState<string | null>(null)
  const [searchKeyShowPassword, setSearchKeyShowPassword] = useState<Record<string, boolean>>({})

  // 联网搜索多引擎: 支持的引擎列表
  const SEARCH_ENGINE_LIST = [
    { id: 'qianfan' as const, name: '百度千帆', desc: '中文搜索强，需单独申请', docsUrl: 'https://cloud.baidu.com/doc/QIANFAN/s/3l6bavkfm' },
    { id: 'deepseek' as const, name: 'DeepSeek', desc: '自研搜索，成功请求才计费（5 元/千次），中文覆盖待实测', docsUrl: 'https://api-docs.deepseek.com/zh-cn/guides/search/' },
    { id: 'tavily' as const, name: 'Tavily', desc: '英文及多语言，免费额度可用', docsUrl: 'https://docs.tavily.com/documentation/api-reference/endpoint/search' },
  ]

  // 高德地图 Key(plan_trip 行程卡片):设置页配置优先,环境变量兜底;保存后刷新页面生效
  interface AmapKeyInfo { jsKeyMasked: string; secMasked: string | null; wsMasked: string | null }
  const [amapInfo, setAmapInfo] = useState<{ config: AmapKeyInfo | null; env: { jsKey: boolean; sec: boolean; ws: boolean } } | null>(null)
  const [amapDraft, setAmapDraft] = useState({ jsKey: '', sec: '', ws: '' })
  const [amapSaving, setAmapSaving] = useState(false)
  const [amapShow, setAmapShow] = useState({ jsKey: false, sec: true, ws: true })

  // 外部指定的目标 section（如面具菜单的「管理面具」入口）:打开时切换并消费
  useEffect(() => {
    if (!settingsOpen || !settingsSection) return
    const target = settingsSection as SectionId
    // 临时模式:受限板块(账户管理类)一律回落到「总览」
    const next = isEphemeral && !EPHEMERAL_SAFE_SECTIONS.has(target) ? 'overview' : target
    setActiveSection(next)
    // 深链语义是「跳到那一屏」:移动端若停在一级列表,内容列是隐藏的,点了等于没到
    if (next !== 'overview') setMobileInDetail(true)
    setSettingsSection(null)
  }, [settingsOpen, settingsSection, setSettingsSection, isEphemeral])

  // 临时模式:打开设置时把默认/残留的受限 section 归位到「总览」
  useEffect(() => {
    if (!settingsOpen || !isEphemeral) return
    setActiveSection((s) => (EPHEMERAL_SAFE_SECTIONS.has(s) ? s : 'overview'))
  }, [settingsOpen, isEphemeral])

  // 加载联网搜索 Key 列表(临时模式为访客身份,跳过)
  useEffect(() => {
    if (!settingsOpen || isEphemeral) return
    fetch('/api/search/keys')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setSearchKeys(data)
      })
      .catch(() => {/* silently fail */})

    // 高德地图 Key 配置状态(掩码)
    fetch('/api/amap/keys')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setAmapInfo(data)
      })
      .catch(() => {/* silently fail */})
  }, [settingsOpen, isEphemeral])

  // 生图设置自动保存：模型 + 尺寸变化时 PATCH
  const imageSettingsLoadedRef = useRef(false)
  const imageSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingImageSettingsRef = useRef<{ imageModel?: string; imageSize?: string }>({})

  // 用量统计刷新
  const loadUsageStats = useCallback(async () => {
    setUsageRefreshing(true)
    try {
      const res = await fetch('/api/usage').then((r) => r.json()).catch(() => null)
      if (res?.chat && res?.image) setUsageStats(res)
    } finally {
      setUsageRefreshing(false)
    }
  }, [])

  // Provider section collapse states and display filter
  const [configuredCollapsed, setConfiguredCollapsed] = useState(false)
  const [unconfiguredCollapsed, setUnconfiguredCollapsed] = useState(true)
  const [showOnlyConfigured, setShowOnlyConfigured] = useState(false)

  // Fetch data when modal opens(临时模式为访客身份:精简设置不需要账户数据,整批跳过)
  useEffect(() => {
    if (!settingsOpen) return
    if (isEphemeral) {
      // 临时模式:跳过数据加载,但要清除 loading 状态(避免弹窗一直显示加载中)
      setLoading(false)
      setInitialLoadComplete(true)
      setTimeout(() => { imageSettingsLoadedRef.current = true }, 0)
      return
    }
    setLoading(true)
    // 预置模型覆盖记录：设置面板常驻挂载，useProviderModels 仅在挂载时拉一次，
    // 每次打开设置时补拉，保证 AI 卡片（manage_provider_models）等外部入口的改动能同步进来
    void fetchProviderOverrides()
    Promise.all([
      fetch('/api/providers').then((r) => r.json()),
      fetch('/api/keys').then((r) => r.json()),
      fetch('/api/memories').then((r) => r.json()),
      fetch('/api/custom-models').then((r) => r.json()),
      fetch('/api/image-settings').then((r) => r.json()).catch(() => null),
      fetch('/api/usage').then((r) => r.json()).catch(() => null),
      fetch('/api/settings/clarify').then((r) => r.json()).catch(() => null),
      fetch('/api/settings/ai-control').then((r) => r.json()).catch(() => null),
      fetch('/api/user/profile').then((r) => r.json()).catch(() => null),
      fetch('/api/profiles').then((r) => r.json()).catch(() => null),
      fetch('/api/settings/local-files').then((r) => r.json()).catch(() => null),
    ])
      .then(([provs, keyList, memoryData, cmList, imgSettings, usageData, clarifyData, aiControlData, profileData, profileStateData, localFilesData]) => {
        setProviders(provs)
        setKeys(keyList)
        setMemories(memoryData?.memories ?? [])
        setSupersededMemories(memoryData?.superseded ?? [])
        setMemoryConflicts(memoryData?.conflicts ?? [])
        setMemoryEnabled(memoryData?.memoryEnabled ?? true)
        setClarifyEnabled(clarifyData?.clarifyEnabled ?? true)
        setLocalFilesEnabled(localFilesData?.localFilesEnabled ?? false)
        setLocalFilesExecAutoRun(localFilesData?.localFilesExecAutoRun ?? false)
        setAiControlEnabled(aiControlData?.aiSettingsControl ?? true)
        // 账号资料:打开设置时拉取,并同步用户名/称呼草稿
        if (profileData && typeof profileData === 'object') {
          setProfile(profileData)
          setNameDraft(profileData.name ?? '')
          setNicknameDraft(profileData.nickname ?? '')
        }
        // 用户中心档案:只读卡直接读库内值,没有草稿态
        if (profileStateData?.profile) {
          setProfileState(profileStateData.profile)
          setProfileDerived(profileStateData.derived ?? null)
          setProfileSection(
            typeof profileStateData.section === 'string' ? profileStateData.section : ''
          )
        }
        setUsageStats(usageData?.chat && usageData?.image ? usageData : null)
        // Parse custom models: assume cmList is already ModelDefinition format from API
        if (Array.isArray(cmList)) {
          loadCustomModels(cmList as SavedCustomModel[])
        }
        // Load image settings
        if (imgSettings && typeof imgSettings === 'object') {
          if (imgSettings.settings) {
            if (imgSettings.settings.imageModel) setImageModel(imgSettings.settings.imageModel as string)
            if (imgSettings.settings.imageSize) setImageSize(imgSettings.settings.imageSize as string)
          }
          if (Array.isArray(imgSettings.builtinModels)) setImageBuiltinModels(imgSettings.builtinModels)
          if (Array.isArray(imgSettings.customModels)) setImageCustomModels(imgSettings.customModels)
        }
      })
      .catch(() => toast.error('加载数据失败'))
      .finally(() => {
        setLoading(false)
        setInitialLoadComplete(true)
        // 加载完成后再开启自动保存 effect（避免初次 setImage* 触发 PATCH）
        setTimeout(() => { imageSettingsLoadedRef.current = true }, 0)
      })
  }, [settingsOpen, isEphemeral, fetchProviderOverrides])

  // 桌面端浮动窗口：isDesktop + 拖拽位置 (移动端抽屉不参与)
  const cardRef = useRef<HTMLDivElement>(null)
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = () => setIsDesktop(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  
  // ── 移动端抽屉动画：slide-up(开)/slide-down(关)。
  // visible=false 渲染首帧即 off-screen(translate-y-full),double RAF 后切 true 触发过渡;
  // 关闭走 closePending 中间态,等 transform transitionend(450ms 兜底)再真正卸载。
  // transform 归属:移动端抽屉用 translate-y 类(useWindowDrag 在移动端会清掉 inline transform,类得以生效),
  // 桌面拖拽用 inline transform(hook 独占写权),md: 变体保证桌面恒为正常位置 ──
  const [shown, setShown] = useState(false)
  const [closePending, setClosePending] = useState(false)
  const visible = shown && !closePending
  
  useEffect(() => {
    if (!settingsOpen) return
    setMobileInDetail(false) // 每次开面板从一级列表起步，不继承上次停留的详情屏
    setMobilePicker(null) // 第三层单选页同理:重开面板不该还盖在详情上
    setShown(false) // 复位上一次会话残留(桌面等直接 setSettingsOpen 关闭的路径不经过 closePending)
    // double RAF:确保首帧(off-screen)已绘制,下一帧再切 visible 才能触发 slide-up 过渡
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShown(true))
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [settingsOpen])
  useEffect(() => {
    if (!closePending) return
    const el = cardRef.current
    if (!el) { setClosePending(false); setSettingsOpen(false); return }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      setShown(false)
      setClosePending(false)
      setSettingsOpen(false)
    }
    const onEnd = (e: TransitionEvent) => {
      // 只认卡片自身的 transform 过渡(colors 等旁支过渡不算)
      if (e.target === el && e.propertyName === 'transform') finish()
    }
    el.addEventListener('transitionend', onEnd)
    const timer = window.setTimeout(finish, 450) // 兜底:transitionend 丢失(后台标签页/系统动画关闭)
    return () => {
      el.removeEventListener('transitionend', onEnd)
      window.clearTimeout(timer)
    }
  }, [closePending, setSettingsOpen])

  // 统一关闭入口:桌面模态无滑出动画即时关,移动端先播 slide-down 再卸载
  const requestClose = useCallback(() => {
    if (isDesktop) setSettingsOpen(false)
    else setClosePending(true)
  }, [isDesktop, setSettingsOpen])

  // 系统/浏览器「返回」与 Escape 的智能出栈接线在下方 closeMobilePicker 定义之后:
  // 二级/三级要先逐级弹回,一级才整层关闭(旧实现无条件 requestClose,二级按返回直接掉回聊天页)。
  const { onCardPointerDown, onCardPointerMove, onCardPointerUp, onCardPointerCancel, recenter } = useWindowDrag({
    cardRef,
    // 独立子窗口模式禁用卡片内拖拽：拖动改由标题条 data-tauri-drag-region 走原生窗口层
    enabled: isDesktop && !forceOpen,
    active: settingsOpen,
    storageKey: 'chat:settingsWindowPos',
  })

  // Restore the last selected style preset for new chats. Existing chats are initialized by ChatPanel.
  useEffect(() => {
    if (!currentConversationId) {
      const stored = localStorage.getItem(STYLE_OFFSET_STORAGE_KEY)
      if (stored) {
        setConversationStylePreset(stored)
      }
    }
  }, [currentConversationId, setConversationStylePreset])

  // 把风格写进当前会话(桌面端 StylePicker 静止 250ms 后调它;移动端单选页点选即调它)
  const persistStylePreset = useCallback(
    (preset: string) => {
      if (!currentConversationId) {
        // 无会话:仅 toast 一次(不写 DB)
        toast.success(`对话风格已切换为${getStylePresetLabel(preset)}`)
        return
      }
      fetch(`/api/conversations/${currentConversationId}/style`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stylePreset: preset }),
      })
        .then((res) => {
          if (!res.ok) throw new Error('Failed to persist style')
          toast.success(`对话风格已切换为${getStylePresetLabel(preset)}`)
        })
        .catch((err) => {
          console.error('Failed to persist style:', err)
          toast.error('对话风格保存失败，请重试')
        })
    },
    [currentConversationId]
  )

  // 把篇幅写进当前会话(与风格同款:无会话只 toast 不写 DB)
  const persistReplyLength = useCallback(
    (level: string) => {
      if (!currentConversationId) {
        toast.success(`回复长度已设为${getReplyLengthLabel(level)}`)
        return
      }
      fetch(`/api/conversations/${currentConversationId}/style`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyLength: level }),
      })
        .then((res) => {
          if (!res.ok) throw new Error('Failed to persist reply length')
          toast.success(`回复长度已设为${getReplyLengthLabel(level)}`)
        })
        .catch((err) => {
          console.error('Failed to persist reply length:', err)
          toast.error('回复长度保存失败，请重试')
        })
    },
    [currentConversationId]
  )

  // Init appearance from localStorage
  useEffect(() => {
    const a = readAppearance()
    setThemeChoice(a.choice)
    setPaletteChoice(a.palette)
    setGridTone(a.gridTone)
    setGridToneAuto(a.gridToneAuto)
  }, [])

  // 智能模式开着设置面板时,高亮那一段要跟着时间走(每 30s 对一次表,跨段才变);
  // 只同步面板本地的展示状态 —— 真正写 DOM 的是 Providers 上那个看门人
  useEffect(() => {
    if (!gridToneAuto || themeChoice !== 'grid') return
    const id = window.setInterval(() => setGridTone(resolveAutoTone()), 30 * 1000)
    return () => window.clearInterval(id)
  }, [gridToneAuto, themeChoice])

  // 生图设置自动保存：模型 + 尺寸变化时 PATCH
  useEffect(() => {
    if (!imageSettingsLoadedRef.current) return
    pendingImageSettingsRef.current = { ...pendingImageSettingsRef.current, imageModel }
    if (imageSaveTimerRef.current) clearTimeout(imageSaveTimerRef.current)
    imageSaveTimerRef.current = setTimeout(async () => {
      setImageSizeSaving(true)
      try {
        await fetch('/api/image-settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: pendingImageSettingsRef.current }),
        })
      } finally {
        setImageSizeSaving(false)
      }
    }, 400)
    return () => {
      if (imageSaveTimerRef.current) clearTimeout(imageSaveTimerRef.current)
    }
  }, [imageModel])

  useEffect(() => {
    if (!imageSettingsLoadedRef.current) return
    pendingImageSettingsRef.current = { ...pendingImageSettingsRef.current, imageSize }
    if (imageSaveTimerRef.current) clearTimeout(imageSaveTimerRef.current)
    imageSaveTimerRef.current = setTimeout(async () => {
      setImageSizeSaving(true)
      try {
        await fetch('/api/image-settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: pendingImageSettingsRef.current }),
        })
      } finally {
        setImageSizeSaving(false)
      }
    }, 400)
    return () => {
      if (imageSaveTimerRef.current) clearTimeout(imageSaveTimerRef.current)
    }
  }, [imageSize])

  // 外观只有一个写入路径(applyAppearance),本地 state 只负责选中态展示。
  // 合法化统一走 lib/theme 的 normalizeAppearance: 格子接管明暗、桂花金仅深色,
  // 归一化后的结果必须回写 state,否则选中态会与实际渲染对不上。
  function commit(next: Appearance) {
    const safe = normalizeAppearance(next)
    // 智能模式下"哪一段亮着"以此刻的解析结果为准 —— applyAppearance 内部也会
    // 再解析一次(那边刻意不信任外部传入的光态),两处结果必须一致
    const shown = safe.gridToneAuto ? resolveAutoTone() : safe.gridTone
    setThemeChoice(safe.choice)
    setPaletteChoice(safe.palette)
    setGridTone(shown)
    setGridToneAuto(safe.gridToneAuto)
    applyAppearance(safe)
    return safe
  }

  function handleChoiceChange(choice: ThemeChoice) {
    const hadFest = paletteChoice === FEST_PALETTE
    const safe = commit({ choice, palette: paletteChoice, gridTone, gridToneAuto })
    if (hadFest && safe.palette !== FEST_PALETTE) {
      toast.info('月白·桂花金仅深色可用，已切回黑白基线')
    }
  }

  // 配色行只在「主题 ≠ 格子」时渲染,故这里 themeChoice 一定是明暗三态之一
  function handlePaletteChange(palette: SelectablePalette) {
    const choice: ThemeChoice = palette === FEST_PALETTE ? 'dark' : themeChoice
    commit({ choice, palette, gridTone, gridToneAuto })
    if (choice !== themeChoice) {
      toast.info('月白·桂花金仅深色可用，已切到深色')
    }
  }

  // 日出/白天/暮色/晚上这一排只在「主题 = 格子」时渲染。
  // 手点任一时段 = 明确表态,即退出智能(否则会出现"选完 10 分钟被定时器抢回去")
  function handleGridToneChange(tone: GridTone) {
    commit({ choice: 'grid', palette: paletteChoice, gridTone: tone, gridToneAuto: false })
  }

  // 智能开关: 开启时立刻按当前时间解析一次(不等下一次 tick),关闭时保留当前光态
  function handleAutoToneToggle(on: boolean) {
    commit({
      choice: 'grid',
      palette: paletteChoice,
      gridTone: on ? resolveAutoTone() : gridTone,
      gridToneAuto: on,
    })
  }

  // ── 总览(仪表盘化)派生数据:全部来自已加载 state,零新增请求;随渲染重算,量级很小 ──
  const ovChatDays = usageStats?.chat.byDay ?? []
  const ovImgDays = usageStats?.image.byDay ?? []
  const ovLast7 = ovChatDays.slice(-7)
  const ovMaxChat = Math.max(...ovLast7.map((d) => d.totalTokens), 1)
  // 生图按尾部对齐聊天天数(两组 byDay 理论上等长,防错位)
  const ovMaxImg = Math.max(...ovLast7.map((_, i) => ovImgDays[ovImgDays.length - ovLast7.length + i]?.count ?? 0), 1)
  const ovSum7 = ovLast7.reduce((s, d) => s + d.totalTokens, 0)
  const ovTodayTok = ovLast7.length > 0 ? ovLast7[ovLast7.length - 1].totalTokens : 0
  const ovYestTok = ovLast7.length > 1 ? ovLast7[ovLast7.length - 2].totalTokens : 0
  const ovDeltaPct = ovYestTok > 0 ? Math.round(((ovTodayTok - ovYestTok) / ovYestTok) * 100) : null
  const ovActiveDays = ovChatDays.reduce(
    (acc, day, i) => acc + (day.totalTokens > 0 || (ovImgDays[i]?.count ?? 0) > 0 ? 1 : 0),
    0
  )
  const ovTotalModels = providers.reduce((n, p) => n + p.models.length, 0)
  const fmtTok = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString())
  const ovGreeting = (() => {
    const h = new Date().getHours()
    return h < 6 ? '凌晨好' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好'
  })()
  const ovDateLabel = (() => {
    const d = new Date()
    return `${d.getMonth() + 1}月${d.getDate()}日 ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]}`
  })()

  const getKeyForProvider = useCallback(
    (providerId: string) => keys.find((k) => k.provider === providerId),
    [keys]
  )

  // Sort configured providers by update time (newest first)
  const sortedConfigured = useMemo(() => {
    const conf = providers.filter((p) => keys.some((k) => k.provider === p.id))
    return conf.sort((a, b) => {
      const keyA = keys.find((k) => k.provider === a.id)
      const keyB = keys.find((k) => k.provider === b.id)
      if (!keyA && !keyB) return 0
      if (!keyA) return 1
      if (!keyB) return -1
      return new Date(keyB.updatedAt).getTime() - new Date(keyA.updatedAt).getTime()
    })
  }, [providers, keys])

  async function handleSave(providerId: string) {
    const value = draftKeys[providerId]?.trim()
    if (!value) return
    setSaving((s) => ({ ...s, [providerId]: true }))
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, apiKey: value }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '保存失败')
      }
      setDraftKeys((d) => ({ ...d, [providerId]: '' }))
      setCardExpanded(providerId, false) // 配置完成,自动收起卡片
      toast.success(`${providerId} API Key 已保存`)
      const newKeys = await fetch('/api/keys').then((r) => r.json())
      setKeys(newKeys)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '保存失败，请重试')
    } finally {
      setSaving((s) => ({ ...s, [providerId]: false }))
    }
  }

  async function handleDelete(providerId: string) {
    if (!(await confirmDialog({ title: '删除 API Key', message: `确定要删除 ${providerId} 的 API Key 吗？`, danger: true, okText: '删除' }))) return
    try {
      const res = await fetch('/api/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      })
      if (!res.ok) throw new Error('删除失败')
      setKeys((prev) => prev.filter((k) => k.provider !== providerId))
      toast.success(`${providerId} API Key 已删除`)
    } catch {
      toast.error('删除失败，请重试')
    }
  }

  async function handleTest(providerId: string) {
    setTesting((t) => ({ ...t, [providerId]: true }))
    setTestResult((r) => {
      const next = { ...r }
      delete next[providerId]
      return next
    })
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: providers.find((p) => p.id === providerId)?.models[0] ?? '',
          messages: [{ role: 'user', content: 'Hi' }],
          testOnly: true,
        }),
      })
      if (res.ok || res.status === 200) {
        setTestResult((r) => ({ ...r, [providerId]: 'success' }))
      } else {
        setTestResult((r) => ({ ...r, [providerId]: 'error' }))
      }
    } catch {
      setTestResult((r) => ({ ...r, [providerId]: 'error' }))
    } finally {
      setTesting((t) => ({ ...t, [providerId]: false }))
    }
  }

  async function handleSaveSearchKey(engine: string) {
    const value = searchDraftKeys[engine]?.trim()
    if (!value) return
    setSearchKeySaving((s) => ({ ...s, [engine]: true }))
    try {
      const res = await fetch('/api/search/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine, apiKey: value }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '保存失败')
      }
      setSearchDraftKeys((d) => { const n = { ...d }; delete n[engine]; return n })
      toast.success('联网搜索 Key 已保存')
      const refreshed = await fetch('/api/search/keys').then((r) => r.json())
      if (Array.isArray(refreshed)) setSearchKeys(refreshed)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setSearchKeySaving((s) => ({ ...s, [engine]: false }))
    }
  }

  async function handleDeleteSearchKey(engine: string) {
    if (!(await confirmDialog({ title: '删除联网搜索 Key', message: `确定要删除 ${engine} 联网搜索 Key 吗？`, danger: true, okText: '删除' }))) return
    setSearchKeyDeleting(engine)
    try {
      const res = await fetch('/api/search/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      })
      if (!res.ok) throw new Error('删除失败')
      setSearchKeys((prev) => prev.filter((k) => k.engine !== engine))
      toast.success('联网搜索 Key 已删除')
    } catch {
      toast.error('删除失败，请重试')
    } finally {
      setSearchKeyDeleting(null)
    }
  }

  // 高德地图 Key:只提交填了的内容(留空=该项不修改);删除=整条清除回退服务器 env
  async function handleSaveAmapKeys() {
    const body: Record<string, string> = {}
    if (amapDraft.jsKey.trim()) body.jsKey = amapDraft.jsKey.trim()
    if (amapDraft.sec.trim()) body.sec = amapDraft.sec.trim()
    if (amapDraft.ws.trim()) body.ws = amapDraft.ws.trim()
    if (Object.keys(body).length === 0) return
    setAmapSaving(true)
    try {
      const res = await fetch('/api/amap/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '保存失败')
      }
      toast.success('地图 Key 已保存,刷新页面后生效')
      setAmapDraft({ jsKey: '', sec: '', ws: '' })
      const fresh = await fetch('/api/amap/keys').then((r) => (r.ok ? r.json() : null))
      if (fresh) setAmapInfo(fresh)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setAmapSaving(false)
    }
  }

  async function handleDeleteAmapKeys() {
    if (!(await confirmDialog({ title: '删除地图 Key', message: '确定删除地图 Key 配置吗？', detail: '删除后将回退到服务器默认配置。', danger: true, okText: '删除' }))) return
    setAmapSaving(true)
    try {
      const res = await fetch('/api/amap/keys', { method: 'DELETE' })
      if (!res.ok) throw new Error('删除失败')
      toast.success('已删除，回退服务器默认配置')
      const fresh = await fetch('/api/amap/keys').then((r) => (r.ok ? r.json() : null))
      if (fresh) setAmapInfo(fresh)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
    } finally {
      setAmapSaving(false)
    }
  }

  async function handleTestSearch() {
    const q = searchQuery.trim()
    if (!q) {
      toast.error('请输入搜索关键词')
      return
    }
    const currentEngine = searchEngine
    const currentKey = searchKeys.find((k) => k.engine === currentEngine)
    if (!currentKey) {
      toast.error(`请先配置 ${SEARCH_ENGINE_LIST.find((e) => e.id === currentEngine)?.name} 的 API Key`)
      return
    }
    setSearchTesting(true)
    setSearchTestResult(null)
    try {
      const res = await fetch('/api/search/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, engine: currentEngine }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '测试失败')
      setSearchTestResult({ ok: true, items: data.items })
    } catch (err) {
      setSearchTestResult({
        ok: false,
        error: err instanceof Error ? err.message : '搜索失败',
      })
    } finally {
      setSearchTesting(false)
    }
  }

  async function handleToggleMemory(enabled: boolean) {
    setMemoryEnabled(enabled)
    try {
      const res = await fetch('/api/memories/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error()
      toast.success(enabled ? '跨对话记忆已开启' : '跨对话记忆已关闭')
    } catch {
      setMemoryEnabled(!enabled)
      toast.error('切换失败，请重试')
    }
  }

  async function handleToggleClarify(enabled: boolean) {
    setClarifyEnabled(enabled)
    try {
      const res = await fetch('/api/settings/clarify', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error()
      toast.success(enabled ? '澄清提问已开启' : '澄清提问已关闭')
    } catch {
      setClarifyEnabled(!enabled)
      toast.error('切换失败，请重试')
    }
  }

  async function handleToggleAiControl(enabled: boolean) {
    setAiControlEnabled(enabled)
    try {
      const res = await fetch('/api/settings/ai-control', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error()
      toast.success(enabled ? 'AI 设置控制已开启' : 'AI 设置控制已关闭')
    } catch {
      setAiControlEnabled(!enabled)
      toast.error('切换失败，请重试')
    }
  }

  async function handleAddMemory() {
    const content = memoryDraft.trim()
    if (!content) return
    setMemorySaving(true)
    try {
      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '添加失败')
      setMemoryDraft('')
      // 新表述可能取代了库里与之矛盾的旧记忆，整组状态以服务端为准重拉
      if (data.superseded) await refreshMemories()
      else setMemories((prev) => [data, ...prev])
      toast.success(data.superseded ? `已添加，并取代 ${data.superseded} 条矛盾的旧记忆` : '记忆已添加')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '添加失败，请重试')
    } finally {
      setMemorySaving(false)
    }
  }

  async function handleDeleteMemory(id: string) {
    // 与对话/面具删除保持一致的二次确认,防误触
    if (!(await confirmDialog({ title: '删除记忆', message: '确定要删除这条记忆吗？', detail: '删除后不可恢复。', danger: true, okText: '删除' }))) return
    setMemoryDeleting(id)
    try {
      const res = await fetch(`/api/memories/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      // 删除胜者会让被它压住的旧记忆回到生效态，整组状态以服务端为准重拉
      await refreshMemories()
      toast.success('记忆已删除')
    } catch {
      toast.error('删除失败，请重试')
    } finally {
      setMemoryDeleting(null)
    }
  }

  // ── 记忆单条编辑(D) ────────────────────────────────────
  function startMemoryEdit(m: MemoryInfo) {
    setMemoryEditingId(m.id)
    setMemoryEditDraft(m.content)
  }

  function cancelMemoryEdit() {
    setMemoryEditingId(null)
    setMemoryEditDraft('')
  }

  async function handleSaveMemoryEdit(id: string) {
    const content = memoryEditDraft.trim()
    if (!content) return
    setMemorySavingEdit(true)
    try {
      const res = await fetch(`/api/memories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '保存失败')
      setMemoryEditingId(null)
      setMemoryEditDraft('')
      // 正文改了 → 原先针对旧文本的「都保留」裁决作废，冲突组按新内容重算
      await refreshMemories()
      toast.success('记忆已更新')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '保存失败，请重试')
    } finally {
      setMemorySavingEdit(false)
    }
  }

  // ── 记忆矛盾消解 ────────────────────────────────────────
  /** 写操作后统一重拉三态(生效/已被取代/冲突组)，避免本地状态与服务端漂移 */
  async function refreshMemories() {
    const data = await fetch('/api/memories').then((r) => r.json()).catch(() => null)
    if (!data) return
    setMemories(data.memories ?? [])
    setSupersededMemories(data.superseded ?? [])
    setMemoryConflicts(data.conflicts ?? [])
  }

  /**
   * 用户对一组矛盾记忆的裁决。
   * mode='supersede' → keepId 生效、其余标记被它取代；
   * mode='keep-both' → 两条都留下(如"杭州人 + 现居上海"本就是两回事)，不再提示这组。
   */
  async function handleResolveConflict(
    group: MemoryConflictGroup,
    keepId: string | null,
    mode: 'supersede' | 'keep-both'
  ) {
    setMemoryResolving(group.ids.join('-'))
    try {
      const conflictIds = group.ids.filter((id) => id !== keepId)
      const res = await fetch('/api/memories/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keepId: keepId ?? group.ids[0],
          conflictIds: mode === 'keep-both' ? group.ids : conflictIds,
          mode,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '')
      }
      await refreshMemories()
      toast.success(mode === 'keep-both' ? '两条都保留，不再提示这组冲突' : '已按你的选择处理')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '处理失败，请重试')
    } finally {
      setMemoryResolving(null)
    }
  }

  /** 恢复一条被取代的旧记忆（同时反向取代当初压住它的那条） */
  async function handleRestoreMemory(id: string) {
    setMemoryDeleting(id)
    try {
      const res = await fetch(`/api/memories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore' }),
      })
      if (!res.ok) throw new Error()
      await refreshMemories()
      toast.success('已恢复这条记忆')
    } catch {
      toast.error('恢复失败，请重试')
    } finally {
      setMemoryDeleting(null)
    }
  }

  // ── 记忆导入：解析 → 预览 → 批量保存 ─────────────────────────────────
  function openMemoryImport() {
    setMemoryImportOpen(true)
    setMemoryImportError(null)
    setMemoryImportDrafts([])
  }

  function closeMemoryImport() {
    setMemoryImportOpen(false)
    setMemoryImportText('')
    setMemoryImportSource('')
    setMemoryImportDrafts([])
    setMemoryImportError(null)
  }

  // 文本变化时实时解析（用户输入即看到预览）
  function handleImportTextChange(text: string) {
    setMemoryImportText(text)
    if (!text.trim()) {
      setMemoryImportDrafts([])
      setMemoryImportError(null)
      return
    }
    const parsed = parseMemoryText(text)
    setMemoryImportDrafts(parsed)
    if (parsed.length === 0) {
      setMemoryImportError('未能从文本中识别到任何记忆条目，请检查格式')
    } else {
      setMemoryImportError(null)
    }
  }

  function handleRemoveImportDraft(idx: number) {
    setMemoryImportDrafts((prev) => prev.filter((_, i) => i !== idx))
  }

  function handleUpdateImportDraft(idx: number, patch: Partial<ParsedMemoryDraft>) {
    setMemoryImportDrafts((prev) =>
      prev.map((d, i) => (i === idx ? { ...d, ...patch } : d))
    )
  }

  function copyReferencePrompt() {
    navigator.clipboard.writeText(MEMORY_IMPORT_REFERENCE).then(() => {
      setRefCopied(true)
      setTimeout(() => setRefCopied(false), 2000)
    }).catch(() => {
      // fallback: select the text
      const pre = document.querySelector('[data-cursor-element-id="cursor-el-1"] pre')
      if (pre) {
        const range = document.createRange()
        range.selectNodeContents(pre)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
      }
    })
  }

  async function handleConfirmImport() {
    const sourceDetail = memoryImportSource.trim().slice(0, 50)
    if (!sourceDetail) {
      toast.error('请填写导入来源（如 ChatGPT、Claude）')
      return
    }
    if (memoryImportDrafts.length === 0) {
      toast.error('没有可导入的记忆')
      return
    }
    setMemoryImportSaving(true)
    try {
      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: memoryImportDrafts.map((d) => ({
            category: d.category,
            content: d.content,
          })),
          sourceDetail,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : '导入失败')
      const created = typeof data.created === 'number' ? data.created : 0
      const skipped = typeof data.skipped === 'number' ? data.skipped : 0
      const supersededCount = typeof data.superseded === 'number' ? data.superseded : 0
      const extras: string[] = []
      if (skipped > 0) extras.push(`跳过 ${skipped} 条重复`)
      if (supersededCount > 0) extras.push(`取代 ${supersededCount} 条矛盾的旧记忆`)
      toast.success(
        extras.length
          ? `已导入 ${created} 条记忆（${extras.join('，')}）`
          : `已导入 ${created} 条记忆`
      )
      // 三态重拉：新导入的条目可能把站内旧画像挤成「已被取代」，冲突组也会变
      await refreshMemories()
      closeMemoryImport()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败，请重试')
    } finally {
      setMemoryImportSaving(false)
    }
  }

  async function handleSaveImageModel() {
    const { name, modelId, baseURL, apiKeySource, apiKey, keyProvider, supportsSize } = imageCmForm
    if (!name.trim() || !modelId.trim() || !baseURL.trim()) {
      toast.error('名称、模型 ID 和 Base URL 为必填项')
      return
    }
    setImageCmSaving(true)
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        modelId: modelId.trim(),
        baseURL: baseURL.trim(),
        apiKeySource,
        apiKey: apiKeySource === 'own' ? apiKey : '',
        keyProvider: apiKeySource === 'provider' ? keyProvider : '',
        supportsSize,
      }
      if (editingImageModelId) {
        body.action = 'update'
        body.id = editingImageModelId
      } else {
        body.action = 'add'
      }
      const res = await fetch('/api/image-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customModel: body }),
      })
      if (!res.ok) throw new Error(editingImageModelId ? '更新失败' : '添加失败')
      const data = await res.json()
      const finalId = editingImageModelId || data.id
      const next = { id: finalId, name: name.trim(), modelId: modelId.trim(), baseURL: baseURL.trim(), provider: 'custom', apiKeySource, keyProvider, supportsSize }
      if (editingImageModelId) {
        setImageCustomModels((prev) => prev.map((m) => (m.id === editingImageModelId ? next : m)))
        toast.success('自定义模型已更新')
      } else {
        setImageCustomModels((prev) => [...prev, next])
        toast.success('自定义模型已添加')
      }
      setImageCmForm({ name: '', modelId: '', baseURL: '', apiKeySource: 'provider', apiKey: '', keyProvider: '', supportsSize: true })
      setEditingImageModelId(null)
      setImageFormOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setImageCmSaving(false)
    }
  }

  async function handleDeleteImageModel(id: string) {
    if (!(await confirmDialog({ title: '删除自定义模型', message: '确定要删除此自定义模型吗？', danger: true, okText: '删除' }))) return
    setImageCmDeleting(id)
    try {
      await fetch('/api/image-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customModel: { action: 'delete', id } }),
      })
      setImageCustomModels((prev) => prev.filter((m) => m.id !== id))
      if (imageModel === id) setImageModel('builtin:wanx2.1-t2i-turbo')
      if (editingImageModelId === id) {
        setEditingImageModelId(null)
        setImageFormOpen(false)
        setImageCmForm({ name: '', modelId: '', baseURL: '', apiKeySource: 'provider', apiKey: '', keyProvider: '', supportsSize: true })
      }
      toast.success('模型已删除')
    } catch {
      toast.error('删除失败')
    } finally {
      setImageCmDeleting(null)
    }
  }

  const sectionTitle = [
    TOP_ITEM,
    ...(isEphemeral ? [EPHEMERAL_SESSION_ITEM] : []),
    ...(isEphemeral
      ? EPHEMERAL_NAV_GROUPS.flatMap((g) => g.items)
      : NAV_GROUPS.flatMap((g) => g.items)),
  ].find((i) => i.id === activeSection)?.label
  // 二级页里的 MSegRow / MPickerRow 靠它推入第三层单选页;back 用当前分区名,与「‹ 设置」同一套语义。
  // 位置是硬约束:必须在下面那道 `if (!settingsOpen) return null` 之前 —— 守卫之后再排 hook,
  // 关闭态就少一个 hook,一开面板即 "Rendered more hooks than during the previous render"。
  const openMobilePicker = useCallback<OpenPicker>(
    (spec) => setMobilePicker({ ...spec, back: sectionTitle || '设置' }),
    [sectionTitle]
  )

  // 第三层的滑入/滑出:卸载必须等滑出播完,所以关闭走「复位 shown → 300ms 后卸载」。
  // 待卸载的 timer 存进 ref:期间重开要清掉,否则新的单选页会被上一次关闭的尾巴收走。
  const pickerUnmountTimer = useRef<number | null>(null)
  const [pickerShown, setPickerShown] = useState(false)
  useEffect(() => {
    if (!mobilePicker) {
      setPickerShown(false)
      return
    }
    if (pickerUnmountTimer.current !== null) {
      window.clearTimeout(pickerUnmountTimer.current)
      pickerUnmountTimer.current = null
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setPickerShown(true))
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [mobilePicker])
  const closeMobilePicker = useCallback(() => {
    setPickerShown(false)
    if (pickerUnmountTimer.current !== null) window.clearTimeout(pickerUnmountTimer.current)
    pickerUnmountTimer.current = window.setTimeout(() => {
      pickerUnmountTimer.current = null
      setMobilePicker(null)
    }, 300)
  }, [])

  // 系统/浏览器「返回」智能出栈(2026-10-08 用户报障:二级页按返回直接掉回聊天页):
  // 三级单选页 → 回二级;二级详情 → 回一级;一级才整层关闭。
  // 返回 false 告诉 useBackToClose「浮层仍开着」,由它重新入组+补哨兵,下次返回继续先落这里。
  // 内层状态只在移动端真实呈现(md 隐藏分支),桌面(含深链误置的 mobileInDetail)直接整层关。
  // forceOpen 是桌面独立子窗口形态,整页就是设置本身,不参与历史栈,照旧不注册。
  const smartBack = useCallback((): false | void => {
    if (!isDesktop && mobilePicker) {
      closeMobilePicker()
      return false
    }
    if (!isDesktop && mobileInDetail) {
      setMobileInDetail(false)
      return false
    }
    requestClose()
  }, [isDesktop, mobilePicker, mobileInDetail, closeMobilePicker, requestClose])
  useBackToClose(settingsOpen && !forceOpen, smartBack)

  // Escape 与返回键同语义:有内层先弹内层,一级才关(桌面无内层状态,行为不变)。
  // 位置约束:必须在 `if (!settingsOpen) return null` 之前,且引用的 closeMobilePicker 已定义。
  useEffect(() => {
    if (!settingsOpen) return
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') smartBack()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [settingsOpen, smartBack])

  if (!settingsOpen) return null

  const configured = providers.filter((p) => keys.some((k) => k.provider === p.id))
  const unconfigured = providers.filter((p) => !keys.some((k) => k.provider === p.id))
  
  // Use the pre-calculated sorted configured list
  const sortedConfiguredList = sortedConfigured

  // 移动端一级行的「当前值摘要」：只读父层已有的状态。面具 / MCP / API 令牌的数据在各自子组件里
  // （MasksSettings / McpSettings / ApiTokensSection），父层拿不到 —— 宁可不显示也不编数字
  const themeLabel = THEME_CHOICES.find((t) => t.value === themeChoice)?.label
  const sectionSummary: Partial<Record<SectionId, string>> = {
    providers: configured.length ? `${configured.length} 个` : undefined,
    models: customModels.length ? `${customModels.length} 个` : undefined,
    search: SEARCH_ENGINE_LIST.find((e) => e.id === searchEngine)?.name,
    image: imageModel ? imageModel.replace(/^builtin:/, '') : undefined,
    memory: memoryEnabled ? `${memories.length} 条` : '已关闭',
    clarify: clarifyEnabled ? '开' : '关',
    localfiles: inTauri ? (localFilesEnabled ? '开' : '关') : '仅桌面端',
    general: [themeLabel, getStylePresetLabel(conversationStylePreset)].filter(Boolean).join(' · '),
    mobileapp: apkManifest?.version ? `v${apkManifest.version}` : undefined,
    account: profile?.nickname || profile?.name || profile?.email || undefined,
    session: ephCount != null ? `${ephCount} 段` : undefined,
  }

  const renderProviderCard = (provider: ProviderInfo) => {
    const existingKey = getKeyForProvider(provider.id)
    const draft = draftKeys[provider.id] ?? ''
    const isSaving = saving[provider.id] ?? false
    const isTesting = testing[provider.id] ?? false
    const result = testResult[provider.id]
    const isPasswordVisible = showPassword[provider.id] ?? false
    const url = PROVIDER_URL[provider.id]
    // 折叠默认值:已配置收起(留摘要行),未配置展开(引导配置)
    const isExpanded = providerCardsExpanded[provider.id] ?? !existingKey

    return (
      <div
        key={provider.id}
        className={cn(
          'rounded-xl border px-3.5 py-3 space-y-2.5 transition-all duration-200',
          'border-line/60',
          existingKey 
            ? 'bg-green-50/50 dark:bg-green-900/10 border-green-200/60 dark:border-green-800/40'
            : 'bg-surface/60 hover:bg-surface-subtle/40'
        )}
      >
        {/* Header: dot + name + status badge + date + 折叠箭头。点头部折叠,折叠后仅留摘要行 */}
        <button
          type="button"
          onClick={() => setCardExpanded(provider.id, !isExpanded)}
          className="flex items-center gap-2.5 w-full text-left"
          aria-expanded={isExpanded}
        >
          <div className={cn(
            'w-2 h-2 rounded-full shrink-0 transition-colors',
            existingKey ? 'bg-green-500 shadow-sm shadow-green-500/50' : 'bg-content-muted/40'
          )} />
          <span className="text-sm font-medium text-content-primary flex-1 truncate">
            {provider.name}
          </span>
          {existingKey ? (
            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-medium shrink-0">
              ✓ 已配置
            </span>
          ) : (
            <span className="text-[11px] text-content-muted shrink-0">
              {provider.models.length} 个模型
            </span>
          )}
          {existingKey && (
            <span className="text-[10px] text-content-muted shrink-0 whitespace-nowrap">
              {new Date(existingKey.updatedAt).toLocaleDateString('zh-CN').replace(/年/g, '-').replace(/月/g, '-')}
            </span>
          )}
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-content-muted shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-content-muted shrink-0" />
          )}
        </button>

        {/* 折叠区:Key 摘要/输入行/引导/测试结果/获取 Key 链接 */}
        {isExpanded && (
        <>
        {/* Saved key display + actions */}
        {existingKey && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-white/80 dark:bg-surface-muted/80 border border-line/40">
              <Key className="w-3.5 h-3.5 text-content-muted shrink-0" />
              <code className="text-xs text-content-secondary truncate">
                {existingKey.maskedKey}
              </code>
            </div>
            <button
              onClick={() => handleTest(provider.id)}
              disabled={isTesting}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-content-secondary hover:text-content-primary hover:bg-white/60 dark:hover:bg-surface-subtle transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isTesting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : result === 'success' ? (
                <CheckCircle className="w-3.5 h-3.5 text-green-500" />
              ) : result === 'error' ? (
                <AlertCircle className="w-3.5 h-3.5 text-red-500" />
              ) : (
                <Zap className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">测试</span>
            </button>
            <button
              onClick={() => handleDelete(provider.id)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-500/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors shrink-0 active:scale-95"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">删除</span>
            </button>
          </div>
        )}

        {/* 首次配置引导提示 */}
        {!existingKey && !draft && (
          <div className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-blue-50/50 dark:bg-blue-900/10 border border-blue-200/40 dark:border-blue-800/30">
            <Info className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div className="text-[11px] text-blue-700 dark:text-blue-300 space-y-1 leading-relaxed">
              <p className="font-medium">配置步骤：</p>
              <ol className="list-decimal list-inside space-y-0.5 text-blue-600/90 dark:text-blue-400/90">
                <li>点击下方「获取 Key」前往官网</li>
                <li>复制 API Key 并粘贴到输入框</li>
                <li>点击「测试」验证连接（推荐）</li>
                <li>测试成功后点击「保存」</li>
              </ol>
            </div>
          </div>
        )}

        {/* Input row(移动端竖排:Key 输入框整行,测试/保存各整行) */}
        <div className="space-y-2">
          <div className="flex flex-col gap-2 md:flex-row">
            <div className="relative flex-1">
              <input
                type={isPasswordVisible ? 'text' : 'password'}
                value={draft}
                onChange={(e) => setDraftKeys((d) => ({ ...d, [provider.id]: e.target.value }))}
                placeholder={existingKey ? '输入新 Key 替换...' : '粘贴 API Key（如：sk-...）'}
                className={cn(
                  'w-full rounded-lg border px-2.5 py-1.5 pr-8 text-xs',
                  'border-line/60',
                  'bg-surface',
                  'text-content-primary',
                  'placeholder:text-content-muted',
                  'focus:outline-none focus:ring-2 focus:ring-accent/30',
                  'focus:border-accent transition-all'
                )}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => ({ ...s, [provider.id]: !s[provider.id] }))}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-content-muted hover:text-content-primary transition-colors"
                tabIndex={-1}
              >
                {isPasswordVisible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            {draft.trim() && !existingKey && (
              <button
                onClick={() => handleTest(provider.id)}
                disabled={isTesting}
                className={cn(
                  'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5 shrink-0',
                  'bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 active:scale-95',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                测试
              </button>
            )}
            <button
              onClick={() => handleSave(provider.id)}
              disabled={!draft.trim() || isSaving}
              className={cn(
                'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shrink-0',
                draft.trim() && !isSaving
                  ? 'bg-accent text-accent-foreground hover:bg-accent-hover active:scale-95 shadow-sm'
                  : 'bg-surface-muted text-content-muted cursor-not-allowed'
              )}
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              保存
            </button>
          </div>

          {/* 测试结果提示 */}
          {draft.trim() && result === 'success' && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200/60 dark:border-green-800/40">
              <CheckCircle className="w-3.5 h-3.5 text-green-600 dark:text-green-400 shrink-0" />
              <span className="text-[11px] text-green-700 dark:text-green-300 font-medium">
                连接测试成功！可以保存使用了
              </span>
            </div>
          )}
          {draft.trim() && result === 'error' && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200/60 dark:border-red-800/40">
              <AlertCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" />
              <span className="text-[11px] text-red-700 dark:text-red-300">
                连接失败，请检查 Key 是否正确
              </span>
            </div>
          )}
        </div>

        {/* Get key link - 始终显示 */}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors font-medium"
          >
            <ExternalLink className="w-3 h-3" />
            {existingKey ? '前往官网管理' : '获取 API Key →'}
          </a>
        )}
        </>
        )}
      </div>
    )
  }

  return (
    <div className={forceOpen ? 'relative flex h-full w-full' : 'fixed inset-0 z-[100] flex items-end md:items-center justify-center md:justify-center md:pointer-events-none'}>
      {/* Backdrop — 纯色压暗：日间 35% 黑、夜间 65% 黑，去掉模糊与饱和度提升，兼顾模态感与性能；移动端随抽屉滑入/滑出同步淡入淡出。独立子窗口无遮罩(窗口即卡片) */}
      {!forceOpen && (
      <div
        className={`absolute inset-0 bg-black/35 dark:bg-black/65 md:hidden transition-opacity duration-300 ease-out ${visible ? 'opacity-50' : 'opacity-0'}`}
        onClick={requestClose}
      />
      )}

      {/* Modal card —— 移动端是底部抽屉 (贴底、上方圆角、上限 90vh,左右占满),平板是居中模态 (宽度 90%),桌面端固定宽度;
          滑入/滑出由 visible 切 translate-y 类驱动,桌面端被 md: 变体固定、transform 留给 useWindowDrag 拖拽 */}
      <div
        ref={cardRef}
        onPointerDown={onCardPointerDown}
        onPointerMove={onCardPointerMove}
        onPointerUp={onCardPointerUp}
        onPointerCancel={onCardPointerCancel}
        className={`m-set relative flex flex-col overflow-hidden transition-[transform,opacity,background-color,border-color] duration-300 ease-out ${visible ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0 md:translate-y-0 md:opacity-100'} ${forceOpen
          ? 'h-full w-full rounded-none border-0 shadow-none'
          : 'w-full md:w-[90%] lg:w-[750px] max-w-none md:max-w-[calc(100vw-2rem)] h-[100dvh] md:h-[36rem] max-h-none md:max-h-[calc(100dvh-2rem)] rounded-none md:rounded-xl border-0 md:border border-line/60 shadow-2xl md:pointer-events-auto'}`}
      >
        {/* Provider 不产生 DOM 节点,卡片的 flex 布局不受影响;供二级页里的 MSegRow 推入第三层 */}
        <MobilePickerCtx.Provider value={openMobilePicker}>
        {/* Header with macOS red dot —— 移动端(≤md)整块是"页头",✕ 必须与顶部 chrome
            同一基线(设置钮原位),否则 设置钮→面板内关闭 又跳一次;桌面端不用这行。
            进详情不新建第二条页头带(那会私藏一份 padding 破坏 --m-chrome-top 基线),
            而是就地换成「‹ + 分区名」;✕ 只在一级列表呈现——二级页 ‹ 已承担返回,✕ 再占最右
            是重复入口(用户定案:二级页关闭钮隐藏)。页头带底色三级恒为 surface(chrome),
            不随画布走(预览页 .m-head/.n-backbar 同律) */}
        <div className="relative flex items-center justify-between gap-3 pl-5 pr-[var(--m-chrome-inset)] pt-[var(--m-chrome-top)] pb-2 border-b border-line/60 shrink-0 bg-surface md:hidden">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {mobileInDetail ? (
              <>
                {/* 返回只给箭头:「设置」二字与 17px 分区名同量级,页头会挤出两个标题 */}
                <button
                  onClick={() => setMobileInDetail(false)}
                  className="-ml-3 flex h-10 shrink-0 items-center rounded-lg px-2 text-content-secondary touch-manipulation active:bg-surface-subtle/70"
                  aria-label="返回设置列表"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <ChevronLeft className="h-[22px] w-[22px]" />
                </button>
                <h3 className="min-w-0 truncate text-[17px] font-semibold text-content-primary">{sectionTitle}</h3>
              </>
            ) : (
              /* 20px 与 40×40 关闭钮(18px 叉)同量级;26px 大标题在一个只有标题的带里会显得空而贵 */
              <h2 className="text-[20px] font-semibold tracking-[0.01em] text-content-primary">设置</h2>
            )}
          </div>
          {!mobileInDetail && (
            <button
              onClick={requestClose}
              className="shrink-0 flex h-10 w-10 items-center justify-center rounded-lg text-content-secondary active:scale-90 active:bg-surface-subtle/70 transition-transform touch-manipulation"
              aria-label="关闭"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Body: 移动端 nav 在上(横向滚动 Tabs)+ 内容在下;桌面端左侧 nav + 右侧 内容 */}
        <div className="relative flex-1 min-h-0 flex flex-col md:flex-row">
          {/* 缝隙衬底:弹窗本体无底色(透明),侧栏毛玻璃才能透到遮罩后的页面;三条 8px 纯色条填住侧栏悬浮槽,其余区域由 header/content/footer 自身 bg-surface 覆盖 */}
          <div aria-hidden className="hidden md:block absolute left-0 top-0 bottom-0 w-2 bg-surface pointer-events-none" />
          <div aria-hidden className="hidden md:block absolute left-0 top-0 w-48 h-2 bg-surface pointer-events-none" />
          <div aria-hidden className="hidden md:block absolute left-0 bottom-0 w-48 h-2 bg-surface pointer-events-none" />
          {/* Sidebar —— 移动端:顶部水平 Tabs 滚动条;桌面端:左侧固定栏(顶部红点标题栏固定,导航项独立滚动) */}
          <nav className="hidden md:m-2 md:mr-0 md:w-44 shrink-0 bg-surface-muted/60 dark:bg-surface/40 glass-blur md:rounded-xl md:border md:border-line/60 overflow-hidden md:flex md:flex-col md:px-2 md:py-2">
            {/* 桌面端:固定标题栏——红点不随下方导航项滚动;标题栏语义手柄(立即拖动,双击复位居中) */}
            <div
              data-drag-handle
              {...(forceOpen
                ? {
                    // 独立子窗口:仅 data-tauri-drag-region 不够——该机制只认 e.target
                    // 自身带属性,标题文字/红点一盖就失效;补 -webkit-app-region:drag
                    // (子元素继承拖拽区,红点自身 no-drag),与主窗口 TopBar 双保险同构。
                    // 双击:子窗口=最大化切换;卡片内拖拽模式(else 分支)=复位居中。
                    'data-tauri-drag-region': '',
                    style: { WebkitAppRegion: 'drag' } as React.CSSProperties,
                    onDoubleClick: () => {
                      import('@/lib/tauri').then(({ tauri }) => tauri.toggleMaximize())
                    },
                  }
                : { onDoubleClick: recenter })}
              className={`hidden md:flex items-center gap-2.5 px-1 pt-0.5 pb-1.5 shrink-0 select-none touch-none ${forceOpen ? 'pl-3.5' : 'cursor-grab active:cursor-grabbing'}`}
            >
              {/* 独立子窗口：标题条即原生窗口拖动区(卡片内拖拽已禁用)，与 Sidebar 头部同构(灯在左标题在右) */}
              {forceOpen && (
                <span className="ml-1.5 text-[13px] font-semibold tracking-[0.02em] text-content-primary">
                  设置
                </span>
              )}
              <button
                onClick={() => setSettingsOpen(false)}
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                className="flex w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors group items-center justify-center shrink-0"
                aria-label="关闭"
              >
                <svg className="w-1.5 h-1.5 text-red-950 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* 导航项滚动区:移动端横向滚动 Tabs(两端渐隐+隐滚动条,让被切的最后一项读作「可滑」);桌面端纵向滚动(红点固定在上方不随动) */}
            <div className="flex-1 md:min-h-0 overflow-x-auto md:overflow-y-auto md:mt-2 scroll-contain max-md:h-scroll-fade">
              <div className="flex md:flex-col gap-0.5 px-4 py-1.5 md:px-0 md:py-0 md:gap-0 md:space-y-2 min-w-max md:min-w-0">
                {/* 总览(独立项):两种模式均显示,内容按 isEphemeral 分叉 */}
                <NavButton
                  item={TOP_ITEM}
                  active={activeSection === TOP_ITEM.id}
                  onClick={() => setActiveSection(TOP_ITEM.id)}
                />
                {/* 分组（「管理」不在滚动区里：它钉在侧栏底部，见本 nav 末尾） */}
                <div className="md:mt-1 flex md:flex-col gap-0.5 md:gap-0 md:space-y-2 md:flex md:items-stretch">
                  {(isEphemeral ? EPHEMERAL_NAV_GROUPS : NAV_GROUPS)
                    .filter((g) => g.title !== '管理')
                    .map(renderNavGroup)}
                </div>
              </div>
            </div>
            {/* 「管理」钉在侧栏底部：额度号池/激活码/注册码 是 adminOnly 的唯一入口，
                而导航项总高早已超过侧栏可视高——滚轮够不到就等于进不去，所以不给它滚动资格 */}
            {(isEphemeral ? EPHEMERAL_NAV_GROUPS : NAV_GROUPS)
              .filter((g) => g.title === '管理' && g.items.some(navItemVisible))
              .map((g) => (
                <div key={g.title} className="shrink-0 mt-1 border-t border-line/60 pt-1">
                  {renderNavGroup(g)}
                </div>
              ))}
          </nav>

          {/* 移动端一级分组列表（主从）：组标题常驻、一行一分区、右侧当前值摘要。
              桌面端整块 md:hidden（导航仍走上面的侧栏）；进详情时收起，由内容列接管。
              卡片本体在移动端是透明的（桌面端要靠玻璃透出页背），所以这一列必须自带底色，否则组间缝隙露出遮罩；
              列底用 background、行卡用 surface，与预览页 P1 的「凹底 + 浮卡」同构 */}
          <div
            data-m-list
            aria-hidden={mobileInDetail || undefined}
            className={cn(
              'w-full min-h-0 flex-1 overflow-y-auto overscroll-contain bg-background px-4 pb-6 md:hidden',
              // 详情是滑过来的覆盖层,列表留在它身后(这里再 display:none 会在滑动过程中露出透明卡背)
              mobileInDetail && 'pointer-events-none'
            )}
          >
            {/* 顶部行占掉原「总览」位:手机端不再进仪表盘(桌面侧栏的总览不受影响)。
                正常模式 → 用户中心(头像 + 称呼/用户名 + 邮箱摘要);临时模式 → 会话管理(剩余时间)。
                「账户」分组里那行用户中心随之移除,同一列表不留两个入口。 */}
            <div className="pt-3">
              <div className="divide-y divide-line/50 overflow-hidden rounded-xl border border-line/60 bg-surface">
                {isEphemeral ? (
                  <MobileSettingsRow
                    item={EPHEMERAL_SESSION_ITEM}
                    summary={sessionRemaining ?? undefined}
                    onClick={() => {
                      setActiveSection(EPHEMERAL_SESSION_ITEM.id)
                      setMobileInDetail(true)
                    }}
                  />
                ) : (
                  <MobileSettingsRow
                    item={{ id: 'account', label: profile?.nickname || profile?.name || session?.user?.name || '用户中心', icon: User }}
                    summary={profile?.email || session?.user?.email || undefined}
                    onClick={() => {
                      setActiveSection('account')
                      setMobileInDetail(true)
                    }}
                    lead={
                      profile?.image ? (
                        <img
                          src={profile.image}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="h-7 w-7 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[12.5px] font-medium text-accent">
                          {(profile?.name || profile?.email || session?.user?.email || '?').charAt(0).toUpperCase()}
                        </span>
                      )
                    }
                  />
                )}
              </div>
            </div>
            {(isEphemeral ? EPHEMERAL_NAV_GROUPS.filter((g) => g.title !== '会话') : NAV_GROUPS)
              .map((g) => ({ ...g, items: g.items.filter((i) => i.id !== 'account' && navItemVisible(i)) }))
              .filter((g) => g.items.length)
              .map((group) => (
              <div key={group.title} className="pt-4">
                <div className="px-1 pb-1.5 text-[12px] font-semibold tracking-[0.02em] text-content-muted">
                  {group.title}
                </div>
                <div className="divide-y divide-line/50 overflow-hidden rounded-xl border border-line/60 bg-surface">
                  {group.items.map((item) => (
                    <MobileSettingsRow
                      key={item.id}
                      item={item}
                      summary={sectionSummary[item.id]}
                      onClick={() => {
                        setActiveSection(item.id)
                        setMobileInDetail(true)
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* 侧栏圆角缺口衬底:玻璃四角圆角让出的方形小缺口会露出透明页背(看似直角)。
              每块 12x12 衬底用径向渐变实现「反向(凹)圆角」:朝玻璃曲线中心的 12px 半圆保持透明(玻璃照常透出页背),
              以外填 bg-surface(与缝隙色条同色),恰好补齐缺口且不与玻璃重叠 */}
          <div
            aria-hidden
            className="hidden md:block absolute left-2 top-2 w-3 h-3 pointer-events-none"
            style={{ backgroundImage: 'radial-gradient(circle at 100% 100%, transparent 11.5px, rgb(var(--surface)) 12px)' }}
          />
          <div
            aria-hidden
            className="hidden md:block absolute left-[172px] top-2 w-3 h-3 pointer-events-none"
            style={{ backgroundImage: 'radial-gradient(circle at 0% 100%, transparent 11.5px, rgb(var(--surface)) 12px)' }}
          />
          <div
            aria-hidden
            className="hidden md:block absolute left-2 bottom-2 w-3 h-3 pointer-events-none"
            style={{ backgroundImage: 'radial-gradient(circle at 100% 0%, transparent 11.5px, rgb(var(--surface)) 12px)' }}
          />
          <div
            aria-hidden
            className="hidden md:block absolute left-[172px] bottom-2 w-3 h-3 pointer-events-none"
            style={{ backgroundImage: 'radial-gradient(circle at 0% 0%, transparent 11.5px, rgb(var(--surface)) 12px)' }}
          />

          {/* 右列:内容滚动区 + 底部 ESC 提示(桌面端与侧栏并列;移动端是盖在分组列上的「右推层」)。
              移动端不能用 hidden 切进切出 —— display:none 参与不了 transition,推入/弹回就成了瞬切;
              改成绝对定位 + translate-x,off-screen 时被卡片的 overflow-hidden 裁掉,并标 aria-hidden 让探针和读屏都忽略它。
              底色调平:移动端画布取 background(与一级列表列/三级单选页同黑),bg-surface 卡片才浮得出来;
              桌面端维持 surface 不变(max-md: 挡死) */}
          <div
            data-m-detail
            aria-hidden={isDesktop || mobileInDetail ? undefined : true}
            className={cn(
              'flex flex-1 min-h-0 min-w-0 flex-col bg-surface max-md:bg-background',
              'absolute inset-0 z-30 pointer-events-none translate-x-full transition-transform duration-300 ease-out',
              mobileInDetail && 'translate-x-0 pointer-events-auto',
              'md:static md:z-auto md:pointer-events-auto md:translate-x-0'
            )}
          >
          <div data-no-drag className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 pt-3 pb-3 md:pt-0">
            {/* Section title —— 桌面端标题栏语义拖拽手柄:横贯内容宽,按下立即拖动窗口;sticky 钉在滚动区顶部,内容上滑时标题不随滚。
                移动端不在这里显示标题:页头带已经承载「‹ 设置 + 分区名」,再显示一次就是双标题 */}
            <div data-drag-handle className="hidden sticky top-0 z-10 -mx-4 items-center bg-surface px-4 pb-3 pt-5 cursor-grab select-none active:cursor-grabbing md:flex md:touch-none">
              <h3 className="text-base font-semibold text-content-primary text-left">
                {sectionTitle}
              </h3>
            </div>

            {/* 总览(临时模式):欢迎说明 + 会话状态速览 */}
            {activeSection === 'overview' && isEphemeral && (
              <div className="space-y-3">
                {/* 欢迎卡 */}
                <div className="rounded-xl border border-accent/20 bg-gradient-to-br from-accent/10 via-accent/5 to-transparent px-4 py-3.5 text-left">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-accent/20 flex items-center justify-center shrink-0">
                      <Sparkles className="w-5 h-5 text-accent" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-content-primary">临时聊天模式</p>
                      <p className="text-[11px] text-content-muted mt-0.5 leading-relaxed">
                        对话与账号主人的正常历史完全隔离，不写入记忆系统；会话有效期 12 小时，结束后记录保留在隔离区，仅账号主人可查看或清除。
                      </p>
                    </div>
                  </div>
                </div>

                {/* 快捷状态卡(点击进入会话管理) */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setActiveSection('session')}
                    className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5 text-left hover:bg-surface-subtle/40 transition-colors"
                  >
                    <Timer className="w-4 h-4 text-accent mb-1.5" />
                    <p className="text-xs font-medium text-content-primary truncate">
                      {sessionRemaining ?? '—'}
                    </p>
                    <p className="text-[10px] text-content-muted mt-0.5">会话剩余时间</p>
                  </button>
                  <button
                    onClick={() => setActiveSection('session')}
                    className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5 text-left hover:bg-surface-subtle/40 transition-colors"
                  >
                    <MessageSquare className="w-4 h-4 text-accent mb-1.5" />
                    <p className="text-xs font-medium text-content-primary truncate">
                      {ephCount ?? '—'} 条
                    </p>
                    <p className="text-[10px] text-content-muted mt-0.5">本次临时对话</p>
                  </button>
                </div>
              </div>
            )}

            {/* 总览(仪表盘化):问候行 + KPI + 7 天用量图 + 状态网格 + 快速操作;不等 loading,数据缺省为零值 */}
            {activeSection === 'overview' && !isEphemeral && (
              <div className="space-y-3">
                {/* 问候行:合并原欢迎卡与账户卡 */}
                {session?.user && (
                  <div className="flex items-center gap-2.5 py-0.5">
                    <div className="w-9 h-9 rounded-full bg-accent/20 flex items-center justify-center shrink-0 overflow-hidden">
                      {session.user.image ? (
                        <img
                          src={session.user.image}
                          alt={session.user.name ?? '用户'}
                          className="w-full h-full rounded-full object-cover"
                        />
                      ) : (
                        <User className="w-4 h-4 text-accent" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-content-primary leading-tight truncate">
                        {ovGreeting}，{session.user.name ?? '用户'}
                      </p>
                      <p className="text-[11px] text-content-muted truncate">
                        {ovDateLabel}
                        {session.user.email ? ` · ${session.user.email}` : ''}
                      </p>
                    </div>
                    <button
                      onClick={handleSignOut}
                      className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-red-500/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors shrink-0 max-md:hidden"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      退出登录
                    </button>
                  </div>
                )}

                {/* KPI 行:今日 / 30 天 / 活跃天数 */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5 text-left">
                    <p className="text-[10px] text-content-muted">今日 Token</p>
                    <p className="text-[15px] font-semibold font-mono text-content-primary tabular-nums mt-1 leading-none">
                      {loading ? '—' : fmtTok(ovTodayTok)}
                    </p>
                    <p className="text-[10px] text-content-muted mt-1.5">
                      {ovDeltaPct === null ? '暂无对比' : `较昨日 ${ovDeltaPct > 0 ? '+' : ''}${ovDeltaPct}%`}
                    </p>
                  </div>
                  <div className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5 text-left">
                    <p className="text-[10px] text-content-muted">30 天 Token</p>
                    <p className="text-[15px] font-semibold font-mono text-content-primary tabular-nums mt-1 leading-none">
                      {loading ? '—' : fmtTok(usageStats?.chat.totals.totalTokens ?? 0)}
                    </p>
                    <p className="text-[10px] text-content-muted mt-1.5">
                      {usageStats ? `${usageStats.chat.totals.messages.toLocaleString()} 条消息` : '—'}
                    </p>
                  </div>
                  <div className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5 text-left">
                    <p className="text-[10px] text-content-muted">活跃天数</p>
                    <p className="text-[15px] font-semibold font-mono text-content-primary tabular-nums mt-1 leading-none">
                      {loading ? '—' : `${ovActiveDays} 天`}
                    </p>
                    <p className="text-[10px] text-content-muted mt-1.5">近 30 天</p>
                  </div>
                </div>

                {/* 最近 7 天用量:灰白系双柱(聊天=深灰/生图=浅灰),圆角与零值桩样式对齐用量统计页 */}
                <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
                  <div className="flex items-center gap-2.5 mb-2">
                    <p className="text-[11px] font-medium text-content-secondary text-left">最近 7 天用量</p>
                    <span className="flex items-center gap-1 text-[10px] text-content-muted">
                      <span className="w-1.5 h-1.5 rounded-full bg-accent/70" />聊天
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-content-muted">
                      <span className="w-1.5 h-1.5 rounded-full bg-content-muted/50" />生图
                    </span>
                    <button
                      onClick={() => setActiveSection('usage')}
                      className="ml-auto text-[11px] font-medium text-accent hover:underline"
                    >
                      用量详情
                    </button>
                  </div>
                  {loading || ovLast7.length === 0 ? (
                    <p className="text-[11px] text-content-muted text-left py-4">暂无统计数据，发起对话后自动记录。</p>
                  ) : (
                    <>
                      <div className="flex items-end gap-[3px] h-20">
                        {ovLast7.map((d, i) => {
                          const imgCount = ovImgDays[ovImgDays.length - ovLast7.length + i]?.count ?? 0
                          return (
                            <div
                              key={d.date}
                              className="flex-1 flex items-end justify-center gap-[2px] h-full group"
                              title={`${d.date.slice(5)} · ${fmtTok(d.totalTokens)} tok · ${imgCount} 图`}
                            >
                              <div
                                className={cn(
                                  'flex-1 max-w-[14px] rounded-t-[3px] transition-colors',
                                  d.totalTokens > 0 ? 'bg-accent/70 group-hover:bg-accent' : 'bg-surface-subtle/60'
                                )}
                                style={{
                                  height: d.totalTokens > 0 ? `${Math.max((d.totalTokens / ovMaxChat) * 100, 4)}%` : '4px',
                                }}
                              />
                              <div
                                className={cn(
                                  'flex-1 max-w-[14px] rounded-t-[3px] transition-colors',
                                  imgCount > 0 ? 'bg-content-muted/50 group-hover:bg-content-muted' : 'bg-surface-subtle/60'
                                )}
                                style={{
                                  height: imgCount > 0 ? `${Math.max((imgCount / ovMaxImg) * 100, 4)}%` : '4px',
                                }}
                              />
                            </div>
                          )
                        })}
                      </div>
                      <div className="flex items-center justify-between mt-1.5 text-[10px] text-content-muted font-mono">
                        <span>{ovLast7[0].date.slice(5)}</span>
                        <span>{fmtTok(ovSum7)} tok</span>
                        <span>今天</span>
                      </div>
                    </>
                  )}
                </div>

                {/* 快捷状态卡片 */}
                <div className="grid grid-cols-2 gap-2">
                  {/* 服务商状态 */}
                  <button
                    onClick={() => setActiveSection('providers')}
                    className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5 text-left hover:bg-surface-subtle/40 transition-colors group"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <Key className="w-4 h-4 text-accent" />
                      <span className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded-full font-mono',
                        keys.length > 0 
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' 
                          : 'bg-surface-subtle text-content-muted'
                      )}>
                        {keys.length} 服务商
                      </span>
                    </div>
                    <p className="text-xs font-medium text-content-primary">服务商 API Key</p>
                    <p className="text-[10px] text-content-muted mt-0.5 truncate">
                      {keys.length > 0 ? `${ovTotalModels} 个模型可用` : '点击配置'}
                    </p>
                  </button>

                  {/* 记忆状态 */}
                  <button
                    onClick={() => setActiveSection('memory')}
                    className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5 text-left hover:bg-surface-subtle/40 transition-colors group"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <Brain className="w-4 h-4 text-purple-500" />
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-mono bg-surface-subtle text-content-muted">
                        {memories.length} 条
                      </span>
                    </div>
                    <p className="text-xs font-medium text-content-primary">记忆</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <p className="text-[10px] text-content-muted truncate">
                        {memoryEnabled ? '已开启' : '已关闭'}
                      </p>
                      {/* 卡片内开关:span 避免 button 嵌套;stopPropagation 防触发卡片跳转 */}
                      <span
                        role="switch"
                        aria-checked={memoryEnabled}
                        aria-label="记忆开关"
                        onClick={(e) => { e.stopPropagation(); handleToggleMemory(!memoryEnabled) }}
                        className={cn(
                          'relative w-8 h-[18px] rounded-full transition-colors shrink-0 ml-auto cursor-pointer',
                          memoryEnabled ? 'bg-accent' : 'bg-surface-subtle'
                        )}
                      >
                        <span
                          className={cn(
                            'absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white dark:bg-surface transition-transform',
                            memoryEnabled && 'translate-x-[14px]'
                          )}
                        />
                      </span>
                    </div>
                  </button>

                  {/* 自定义模型 */}
                  <button
                    onClick={() => setActiveSection('models')}
                    className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5 text-left hover:bg-surface-subtle/40 transition-colors group"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <Cpu className="w-4 h-4 text-blue-500" />
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-mono bg-surface-subtle text-content-muted">
                        {customModels.length} 个
                      </span>
                    </div>
                    <p className="text-xs font-medium text-content-primary">自定义模型</p>
                    <p className="text-[10px] text-content-muted mt-0.5 truncate">
                      {customModels.length > 0 ? '全部可用' : '点击添加'}
                    </p>
                  </button>

                  {/* 主题 */}
                  <button
                    onClick={() => setActiveSection('general')}
                    className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5 text-left hover:bg-surface-subtle/40 transition-colors group"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <Settings2 className="w-4 h-4 text-amber-500" />
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-mono bg-surface-subtle text-content-muted">
                        {THEME_CHOICES.find((c) => c.value === themeChoice)?.label ?? '跟随系统'}
                      </span>
                    </div>
                    <p className="text-xs font-medium text-content-primary">外观</p>
                    <p className="text-[10px] text-content-muted mt-0.5 truncate">
                      浅色 · 深色 · 跟随系统 · 格子
                    </p>
                  </button>
                </div>

                {/* 快速操作 */}
                <div className="rounded-xl border border-line/60 bg-surface/60 px-3 py-2.5">
                  <p className="text-[11px] font-medium text-content-secondary mb-2 text-left">快速操作</p>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setActiveSection('providers')}
                      className="px-3 py-1.5 rounded-full text-[11px] bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex items-center gap-1.5"
                    >
                      <Plus className="w-3 h-3" /> 添加服务商
                    </button>
                    <button
                      onClick={() => setActiveSection('memory')}
                      className="px-3 py-1.5 rounded-full text-[11px] bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex items-center gap-1.5"
                    >
                      <Plus className="w-3 h-3" /> 新建记忆
                    </button>
                    <button
                      onClick={() => setActiveSection('masks')}
                      className="px-3 py-1.5 rounded-full text-[11px] bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex items-center gap-1.5"
                    >
                      <VenetianMask className="w-3 h-3" /> 面具库
                    </button>
                  </div>
                </div>

              </div>
            )}

            {/* 其他需要数据的页面 - 显示 loading */}
            {activeSection !== 'overview' && loading && (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-5 h-5 animate-spin text-content-muted" />
              </div>
            )}

            {/* 其他页面内容 */}
            {activeSection !== 'overview' && !loading && (
              <>
                {/* 联网搜索 */}
                {activeSection === 'search' && (() => {
                  // 当前选中引擎
                  const engineDef = SEARCH_ENGINE_LIST.find((e) => e.id === searchEngine) ?? SEARCH_ENGINE_LIST[0]
                  // 滑轨三档位置：按列表下标均分（index / (n-1)）
                  const engineIds = SEARCH_ENGINE_LIST.map((e) => e.id)
                  const engineIndex = Math.max(0, engineIds.indexOf(searchEngine))
                  const key = searchKeys.find((k) => k.engine === searchEngine)
                  const draft = searchDraftKeys[searchEngine] ?? ''
                  const saving = searchKeySaving[searchEngine] ?? false
                  const deleting = searchKeyDeleting === searchEngine
                  const passwordVisible = searchKeyShowPassword[searchEngine] ?? false
                  return (
                    <div className="space-y-3">

                      {/* 引擎选择:桌面 = 音量风格滑块轨道;移动 = 整行点开第三层单选页(滑块在 390px 上拇指对不准两档) */}
                      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
                        <div className="mb-2 hidden items-center justify-between md:flex">
                          <div className="flex items-center gap-1.5">
                            <Globe className="w-4 h-4 text-content-secondary" />
                            <p className="text-xs font-medium text-content-secondary">选择引擎</p>
                          </div>
                          <p className="text-xs font-semibold text-accent">
                            {engineDef.name}
                          </p>
                        </div>

                        {/* 滑块轨道(仅桌面) */}
                        <div className="relative hidden md:block">
                          {/* 三段标签 */}
                          <div className="flex justify-between items-center mb-1.5 px-0.5">
                            {SEARCH_ENGINE_LIST.map((e) => (
                              <span
                                key={e.id}
                                className={cn(
                                  'text-[10px] font-medium transition-colors',
                                  searchEngine === e.id ? 'text-accent' : 'text-content-muted'
                                )}
                              >
                                {e.name}
                              </span>
                            ))}
                          </div>

                          {/* 音量风格滑块轨道：thumb 与填充按档位百分比移动 */}
                          <div className="relative h-2 rounded-full bg-surface-muted border border-line/60">
                            {/* 渐变填充 */}
                            <div
                              className="absolute top-0 bottom-0 left-0 rounded-full bg-accent/60 transition-all duration-200"
                              style={{ width: `${(engineIndex / (SEARCH_ENGINE_LIST.length - 1)) * 100}%` }}
                            />
                            {/* 滑块thumb */}
                            <input
                              type="range"
                              min={0}
                              max={SEARCH_ENGINE_LIST.length - 1}
                              step={1}
                              value={engineIndex}
                              onChange={(e) => {
                                const next = SEARCH_ENGINE_LIST[Number(e.target.value)].id
                                useChatStore.getState().setSearchEngine(next)
                                setSearchTestResult(null)
                              }}
                              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                              aria-label="选择联网搜索引擎"
                            />
                            {/* 滑块圆点 */}
                            <div
                              className="absolute top-1/2 w-4 h-4 rounded-full bg-white dark:bg-surface border-2 border-accent shadow-md transition-all duration-200 cursor-pointer -translate-x-1/2 -translate-y-1/2"
                              style={{ left: `${(engineIndex / (SEARCH_ENGINE_LIST.length - 1)) * 100}%` }}
                            />
                          </div>
                        </div>
                        <MPickerRow
                          label="选择引擎"
                          options={SEARCH_ENGINE_LIST.map((e) => ({ value: e.id, label: e.name, hint: e.desc }))}
                          value={searchEngine}
                          onPick={(v) => {
                            useChatStore.getState().setSearchEngine(v)
                            setSearchTestResult(null)
                          }}
                        />
                      </div>

                      {/* 当前引擎 Key 配置卡片 */}
                      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="text-xs font-semibold text-content-primary">{engineDef.name}</p>
                          {key && (
                            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-medium">
                              已配置
                            </span>
                          )}
                        </div>

                        <p className="text-[11px] text-content-secondary leading-relaxed">
                          {engineDef.desc}
                          <a
                            href={engineDef.docsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-1 text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5"
                          >
                            申请地址 <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        </p>

                        {/* 已配置的 Key 显示 */}
                        {key && (
                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1.5 flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-surface-muted/80 border border-line/40">
                              <Key className="w-3.5 h-3.5 text-content-muted shrink-0" />
                              <code className="text-xs text-content-secondary truncate">{key.maskedKey}</code>
                            </div>
                            <button
                              onClick={() => handleDeleteSearchKey(searchEngine)}
                              disabled={deleting}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-500/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors shrink-0"
                            >
                              {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                              删除
                            </button>
                          </div>
                        )}

                        {/* 输入框(移动端竖排:输入框一整行 + 保存整行,横排在 390px 上挤到按不准) */}
                        <div className="flex flex-col gap-2 md:flex-row">
                          <div className="relative flex-1">
                            <input
                              type={passwordVisible ? 'text' : 'password'}
                              value={draft}
                              onChange={(e) => setSearchDraftKeys((d) => ({ ...d, [searchEngine]: e.target.value }))}
                              placeholder={key ? '输入新 Key 替换...' : '粘贴 API Key...'}
                              className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 pr-8 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                            />
                            <button
                              type="button"
                              onClick={() => setSearchKeyShowPassword((s) => ({ ...s, [searchEngine]: !s[searchEngine] }))}
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-content-muted hover:text-content-primary transition-colors"
                              tabIndex={-1}
                            >
                              {passwordVisible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                          <button
                            onClick={() => handleSaveSearchKey(searchEngine)}
                            disabled={!draft.trim() || saving}
                            className={cn(
                              'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5 shrink-0',
                              draft.trim() && !saving
                                ? 'bg-accent text-accent-foreground hover:bg-accent/90 active:scale-[0.97]'
                                : 'bg-surface-muted text-content-muted cursor-not-allowed'
                            )}
                          >
                            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                            保存
                          </button>
                        </div>
                      </div>

                      {/* 工作原理 */}
                      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2">
                        <div className="flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-content-secondary" />
                          <p className="text-xs font-medium text-content-secondary">工作原理</p>
                        </div>
                        <ul className="text-[11px] text-content-secondary space-y-1.5 leading-relaxed">
                          <li>· 配置 Key 后，AI 模型拥有 web_search 工具调用能力</li>
                          <li>· 当 AI 判断需要实时信息时（新闻、数据、最新事件），自动搜索</li>
                          <li>· 支持追问、多轮搜索，结果自动注入对话上下文</li>
                          <li>· 切换引擎后，智能搜索自动使用新引擎</li>
                        </ul>
                      </div>

                      {/* 测试搜索 */}
                      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
                        <div className="flex items-center gap-1.5">
                          <Search className="w-3.5 h-3.5 text-content-secondary" />
                          <p className="text-xs font-medium text-content-secondary">测试搜索</p>
                          <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent font-medium">
                            {engineDef.name}
                          </span>
                        </div>

                        <div className="flex flex-col gap-2 md:flex-row md:items-center">
                          <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleTestSearch() }}
                            placeholder="输入关键词，如：今天上海天气"
                            disabled={searchTesting || !key}
                            className="flex-1 rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30 disabled:opacity-50"
                          />
                          <button
                            onClick={handleTestSearch}
                            disabled={searchTesting || !searchQuery.trim() || !key}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {searchTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                            搜索
                          </button>
                        </div>

                        {searchTestResult && (
                          <div className={cn(
                            'rounded-lg px-2.5 py-2 text-[11px]',
                            searchTestResult.ok
                              ? 'bg-green-50 dark:bg-green-900/20 border border-green-200/60'
                              : 'bg-red-50 dark:bg-red-900/20 border border-red-200/60'
                          )}>
                            {searchTestResult.ok ? (
                              searchTestResult.items && searchTestResult.items.length > 0 ? (
                                <ul className="space-y-2">
                                  {searchTestResult.items.map((item, i) => (
                                    <li key={i} className="leading-relaxed">
                                      <a
                                        href={item.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                                      >
                                        [{i + 1}] {item.title}
                                      </a>
                                      {item.snippet && (
                                        <p className="text-content-secondary mt-0.5">{item.snippet}</p>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-content-secondary">搜索成功但未返回结果。</p>
                              )
                            ) : (
                              <p className="text-red-700 dark:text-red-300">{searchTestResult.error}</p>
                            )}
                          </div>
                        )}
                      </div>

                      {/* 地图服务(plan_trip 行程卡片) */}
                      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <MapPin className="w-3.5 h-3.5 text-content-secondary" />
                          <p className="text-xs font-semibold text-content-primary">地图服务（行程规划）</p>
                          {amapInfo?.config && (
                            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-medium">
                              已配置
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-content-secondary leading-relaxed">
                          「帮我规划 N 日游」的行程地图卡片使用高德地图。配置后刷新页面生效，无需改服务器配置。
                          <a
                            href="https://console.amap.com/dev/key/app"
                            target="_blank"
                            rel="noreferrer"
                            className="ml-1 text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5"
                          >
                            高德控制台 <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        </p>
                        <div className="space-y-2">
                          {([
                            { key: 'jsKey' as const, label: 'JS API Key', show: amapShow.jsKey, ph: '「Web端(JS API)」类型 Key' },
                            { key: 'sec' as const, label: '安全密钥', show: amapShow.sec, ph: '与 JS Key 配套（控制台显示横杠则留空）' },
                            { key: 'ws' as const, label: 'Web服务 Key', show: amapShow.ws, ph: '坐标校准用（控制台需配 IP 白名单）' },
                          ]).map((f) => {
                            const saved = f.key === 'jsKey'
                              ? amapInfo?.config?.jsKeyMasked
                              : f.key === 'sec'
                                ? amapInfo?.config?.secMasked
                                : amapInfo?.config?.wsMasked
                            return (
                              <div key={f.key} className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-2">
                                <span className="shrink-0 text-[11px] text-content-secondary md:w-20">{f.label}</span>
                                <div className="relative flex-1">
                                  <input
                                    type={f.show ? 'text' : 'password'}
                                    value={amapDraft[f.key]}
                                    onChange={(e) => setAmapDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                                    placeholder={saved ? `已保存 ${saved}，输入新值替换` : f.ph}
                                    className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 pr-8 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                                  />
                                  <button
                                    type="button"
                                    tabIndex={-1}
                                    onClick={() => setAmapShow((s) => ({ ...s, [f.key]: !s[f.key] }))}
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-content-muted hover:text-content-primary transition-colors"
                                  >
                                    {f.show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleSaveAmapKeys}
                            disabled={amapSaving || (!amapDraft.jsKey.trim() && !amapDraft.sec.trim() && !amapDraft.ws.trim())}
                            className={cn(
                              'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5 shrink-0',
                              (amapDraft.jsKey.trim() || amapDraft.sec.trim() || amapDraft.ws.trim()) && !amapSaving
                                ? 'bg-accent text-accent-foreground hover:bg-accent/90 active:scale-[0.97]'
                                : 'bg-surface-muted text-content-muted cursor-not-allowed'
                            )}
                          >
                            {amapSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                            保存
                          </button>
                          {amapInfo?.config && (
                            <button
                              onClick={handleDeleteAmapKeys}
                              disabled={amapSaving}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-500/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors shrink-0"
                            >
                              {amapSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                              删除（回退服务器默认）
                            </button>
                          )}
                        </div>
                        <p className="text-[10px] text-content-muted leading-relaxed">
                          · 留空的项沿用服务器默认配置；「Web服务」Key 用于把站点名校准为真实坐标——
                          控制台需把服务器出口 IP 加入其 IP 白名单，否则校准自动跳过（行程仍可用，但路径规划易降级直线）；
                          JS Key 建议配置域名白名单防盗用。
                        </p>
                      </div>
                    </div>
                  )
                })()}

                {/* 生图 */}
                {activeSection === 'image' && (
                  <div className="space-y-3">
                    {/* 内置模型 */}
                    {imageBuiltinModels.length > 0 && (
                      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-medium text-content-secondary text-left">内置模型</p>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle/80 text-content-muted font-mono shrink-0">
                            {imageBuiltinModels.length}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                          {imageBuiltinModels.map((m: Record<string, unknown>) => (
                            <button
                              key={m.id as string}
                              onClick={() => setImageModel(m.id as string)}
                              className={cn(
                                'relative px-3 py-2.5 rounded-xl border text-left transition-all',
                                imageModel === m.id
                                  ? 'border-accent bg-accent/10 ring-2 ring-accent/20'
                                  : 'border-line/60 bg-surface-muted/60 hover:border-line-strong'
                              )}
                            >
                              {imageModel === m.id && (
                                <Check className="absolute top-1.5 right-1.5 w-3 h-3 text-accent" />
                              )}
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <p className="text-xs font-medium text-content-primary">{m.name as string}</p>
                                {(m as { badge?: string }).badge && (
                                  <span className="text-[9px] px-1 py-0.5 rounded bg-accent-soft text-content-muted">
                                    {(m as { badge?: string }).badge}
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-content-muted">{(m as { desc?: string }).desc}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 自定义模型 */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-medium text-content-secondary text-left">我的自定义模型</p>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle/80 text-content-muted font-mono shrink-0">
                            {imageCustomModels.length}
                          </span>
                        </div>
                        <button
                          onClick={() => {
                            setEditingImageModelId(null)
                            setImageCmForm({ name: '', modelId: '', baseURL: '', apiKeySource: 'provider', apiKey: '', keyProvider: '', supportsSize: true })
                            setImageFormOpen(true)
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                        >
                          <Plus className="w-3 h-3" />
                          添加
                        </button>
                      </div>
                      {imageCustomModels.length > 0 ? (
                        <div className="space-y-1.5">
                          {imageCustomModels.map((m: Record<string, unknown>) => (
                            <div
                              key={m.id as string}
                              className={cn(
                                'flex items-center justify-between px-2.5 py-2 rounded-lg border transition-all',
                                imageModel === m.id
                                  ? 'border-accent bg-accent/10'
                                  : 'border-line/40 bg-surface-muted/60'
                              )}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                {imageModel === m.id ? (
                                  <Check className="w-3.5 h-3.5 text-accent shrink-0" />
                                ) : (
                                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
                                )}
                                <div className="min-w-0">
                                  <p className="text-xs text-content-primary truncate">{m.name as string}</p>
                                  <p className="text-[11px] text-content-muted truncate">
                                    {m.modelId as string}
                                    {m.apiKeySource === 'own' ? ' · 独立 Key' : m.keyProvider ? ` · 复用 ${m.keyProvider}` : ''}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {imageModel !== m.id && (
                                  <button
                                    onClick={() => setImageModel(m.id as string)}
                                    className="px-2 py-1 rounded-md text-[11px] font-medium bg-surface text-content-secondary hover:bg-surface-subtle transition-colors"
                                  >
                                    选用
                                  </button>
                                )}
                                <button
                                  onClick={() => {
                                    setEditingImageModelId(m.id as string)
                                    setImageCmForm({
                                      name: (m.name as string) || '',
                                      modelId: (m.modelId as string) || '',
                                      baseURL: (m.baseURL as string) || '',
                                      apiKeySource: ((m.apiKeySource as 'own' | 'provider') || 'provider'),
                                      apiKey: '',
                                      keyProvider: (m.keyProvider as string) || '',
                                      supportsSize: m.supportsSize !== false,
                                    })
                                    setImageFormOpen(true)
                                  }}
                                  className="p-1.5 rounded-lg text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
                                >
                                  <Wrench className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleDeleteImageModel(m.id as string)}
                                  disabled={imageCmDeleting === m.id}
                                  className="p-1.5 rounded-lg text-red-500/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                                >
                                  {imageCmDeleting === m.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] text-content-muted text-left py-1">
                          暂无自定义模型。点击「添加」配置 OpenAI 兼容的生图端点。
                        </p>
                      )}
                    </div>

                    {/* 添加 / 编辑 自定义模型表单（折叠面板） */}
                    <details
                      open={imageFormOpen}
                      onToggle={(e) => setImageFormOpen(e.currentTarget.open)}
                      className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 group"
                    >
                      <summary className="flex items-center justify-between cursor-pointer list-none">
                        <p className="text-xs font-medium text-content-secondary text-left">
                          {editingImageModelId ? '编辑自定义模型' : '添加自定义模型'}
                        </p>
                        <ChevronDown className="w-3.5 h-3.5 text-content-muted transition-transform group-open:rotate-180" />
                      </summary>

                      <div className="space-y-2.5 mt-2.5">
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                          <input
                            type="text"
                            value={imageCmForm.name}
                            onChange={(e) => setImageCmForm((f) => ({ ...f, name: e.target.value }))}
                            placeholder="显示名称 (如: 我的 SDXL)"
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                          <input
                            type="text"
                            value={imageCmForm.modelId}
                            onChange={(e) => setImageCmForm((f) => ({ ...f, modelId: e.target.value }))}
                            placeholder="模型 ID (如: stable-diffusion-xl)"
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                        </div>
                        <input
                          type="text"
                          value={imageCmForm.baseURL}
                          onChange={(e) => setImageCmForm((f) => ({ ...f, baseURL: e.target.value }))}
                          placeholder="Base URL (OpenAI 兼容端点，如: https://api.example.com/v1)"
                          className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                        />
                        <select
                          value={imageCmForm.apiKeySource}
                          onChange={(e) => setImageCmForm((f) => ({ ...f, apiKeySource: e.target.value as 'own' | 'provider' }))}
                          className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                        >
                          <option value="provider">复用已有服务商 Key</option>
                          <option value="own">使用独立 API Key</option>
                        </select>
                        {imageCmForm.apiKeySource === 'provider' && (
                          <select
                            value={imageCmForm.keyProvider}
                            onChange={(e) => setImageCmForm((f) => ({ ...f, keyProvider: e.target.value }))}
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          >
                            <option value="">选择服务商...</option>
                            {keys.map((k) => (
                              <option key={k.provider} value={k.provider}>{k.provider}</option>
                            ))}
                          </select>
                        )}
                        {imageCmForm.apiKeySource === 'own' && (
                          <input
                            type="password"
                            value={imageCmForm.apiKey}
                            onChange={(e) => setImageCmForm((f) => ({ ...f, apiKey: e.target.value }))}
                            placeholder={editingImageModelId ? 'API Key (留空保持原 Key)' : 'API Key'}
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                        )}
                        <label className="flex items-center gap-1.5 text-xs text-content-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            checked={imageCmForm.supportsSize}
                            onChange={(e) => setImageCmForm((f) => ({ ...f, supportsSize: e.target.checked }))}
                            className="accent-accent"
                          />
                          支持自定义尺寸
                        </label>
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={handleSaveImageModel}
                            disabled={imageCmSaving}
                            className={cn(
                              'flex-1 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5',
                              !imageCmSaving && imageCmForm.name.trim() && imageCmForm.modelId.trim() && imageCmForm.baseURL.trim()
                                ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
                                : 'bg-surface-muted text-content-muted cursor-not-allowed'
                            )}
                          >
                            {imageCmSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                            {editingImageModelId ? '保存修改' : '添加'}
                          </button>
                          <button
                            onClick={() => {
                              setImageFormOpen(false)
                              setEditingImageModelId(null)
                              setImageCmForm({ name: '', modelId: '', baseURL: '', apiKeySource: 'provider', apiKey: '', keyProvider: '', supportsSize: true })
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-muted text-content-secondary hover:bg-surface-subtle transition-colors"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    </details>

                    {/* 尺寸设置 */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-content-secondary text-left">图片尺寸</p>
                        {imageSizeSaving && <Loader2 className="w-3 h-3 text-content-muted animate-spin" />}
                      </div>
                      <div className="hidden grid-cols-3 gap-2 md:grid">
                        {[
                          { value: '1024*1024', label: '1:1', desc: '1024×1024' },
                          { value: '720*1280', label: '9:16', desc: '720×1280 (竖)' },
                          { value: '1280*720', label: '16:9', desc: '1280×720 (横)' },
                        ].map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => setImageSize(opt.value)}
                            className={cn(
                              'relative px-3 py-2.5 rounded-xl border text-left transition-all',
                              imageSize === opt.value
                                ? 'border-accent bg-accent/10 ring-2 ring-accent/20'
                                : 'border-line/60 bg-surface-muted/60 hover:border-line-strong'
                            )}
                          >
                            {imageSize === opt.value && (
                              <Check className="absolute top-1.5 right-1.5 w-3 h-3 text-accent" />
                            )}
                            <p className="text-xs font-medium text-content-primary">{opt.label}</p>
                            <p className="text-[11px] text-content-muted mt-0.5">{opt.desc}</p>
                          </button>
                        ))}
                      </div>
                      <MPickerRow
                        label="图片尺寸"
                        help="选完即自动保存;自定义端点可另填尺寸"
                        options={[
                          { value: '1024*1024', label: '1:1', hint: '1024×1024' },
                          { value: '720*1280', label: '9:16 竖', hint: '720×1280' },
                          { value: '1280*720', label: '16:9 横', hint: '1280×720' },
                        ]}
                        value={imageSize}
                        onPick={setImageSize}
                      />
                      <p className="text-[10px] text-content-muted text-left">选择即自动保存</p>
                    </div>
                  </div>
                )}

                {/* 服务商 */}
                {activeSection === 'masks' && <MasksSettings />}

                {activeSection === 'mcp' && <McpSettings />}

                {activeSection === 'providers' && (
                  <div className="space-y-3">

                    {/* Configured providers section */}
                    {(showOnlyConfigured ? configured : [...configured, ...unconfigured]).length > 0 && (
                      <div className="space-y-1.5">
                        <button
                          onClick={() => setConfiguredCollapsed(!configuredCollapsed)}
                          className={cn(
                            'flex items-center gap-1.5 w-full px-0.5 py-1 rounded-lg transition-colors',
                            configuredCollapsed ? 'hover:bg-surface-subtle/60' : ''
                          )}
                        >
                          <div className="flex items-center gap-1.5 flex-1">
                            <span className="text-[11px] font-medium text-content-secondary">已配置</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-mono shrink-0">
                              {configured.length}
                            </span>
                          </div>
                          {configuredCollapsed ? (
                            <ChevronDown className="w-3.5 h-3.5 text-content-muted shrink-0" />
                          ) : (
                            <ChevronUp className="w-3.5 h-3.5 text-content-muted shrink-0" />
                          )}
                        </button>

                        {!configuredCollapsed && (
                          <div className="space-y-2 mt-2">
                            {sortedConfiguredList.map((provider) => (
                              <div key={provider.id} className="animate-in fade-in slide-in-from-top-2 duration-300">
                                {renderProviderCard(provider)}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Unconfigured providers section */}
                    {!showOnlyConfigured && unconfigured.length > 0 && (
                      <div className="space-y-1.5">
                        <button
                          onClick={() => setUnconfiguredCollapsed(!unconfiguredCollapsed)}
                          className={cn(
                            'flex items-center gap-1.5 w-full px-0.5 py-1 rounded-lg transition-colors',
                            unconfiguredCollapsed ? 'hover:bg-surface-subtle/60' : ''
                          )}
                        >
                          <div className="flex items-center gap-1.5 flex-1">
                            <span className="text-[11px] font-medium text-content-secondary">待配置</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle/80 text-content-muted font-mono shrink-0">
                              {unconfigured.length}
                            </span>
                          </div>
                          {unconfiguredCollapsed ? (
                            <ChevronDown className="w-3.5 h-3.5 text-content-muted shrink-0" />
                          ) : (
                            <ChevronUp className="w-3.5 h-3.5 text-content-muted shrink-0" />
                          )}
                        </button>

                        {!unconfiguredCollapsed && (
                          <div className="space-y-2 mt-2">
                            {unconfigured.map((provider) => (
                              <div key={provider.id} className="animate-in fade-in slide-in-from-top-2 duration-300">
                                {renderProviderCard(provider)}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* 自定义模型 */}
                {activeSection === 'models' && (
                  <div className="space-y-3">
                    {/* 预置模型管理：按 provider 分组，可隐藏内置模型 / 添加新模型 */}
                    <PresetModelsManager
                      providers={providers}
                      overrides={providerOverrides}
                      loading={providerOverridesLoading}
                      error={providerOverridesError}
                      pendingId={providerPendingId}
                      testingId={pmTestingId}
                      formOpen={pmFormOpen}
                      form={pmForm}
                      expandedProviders={expandedProviders}
                      onToggleProvider={(id) => {
                        setExpandedProviders((prev) => {
                          const next = new Set(prev)
                          if (next.has(id)) next.delete(id)
                          else next.add(id)
                          return next
                        })
                      }}
                      onOpenAddForm={(provider) => {
                        if (!provider) return
                        const newForm = {
                          provider,
                          modelId: '',
                          isHidden: false,
                          name: '',
                          contextWindow: 32768,
                          supportsVision: false,
                          supportsFiles: false,
                          supportsReasoning: false,
                        }
                        setPmForm(newForm)
                        setPmFormOpen(true)
                      }}
                      onCloseForm={() => {
                        setPmFormOpen(false)
                        setPmForm({
                          provider: '',
                          modelId: '',
                          isHidden: false,
                          name: '',
                          contextWindow: 32768,
                          supportsVision: false,
                          supportsFiles: false,
                          supportsReasoning: false,
                        })
                      }}
                      onFormChange={setPmForm}
                      onSave={async () => {
                        if (!pmForm.provider || !pmForm.modelId) {
                          toast.error('provider 和 modelId 是必填项')
                          return
                        }
                        if (!pmForm.name.trim()) {
                          toast.error('显示名不能为空')
                          return
                        }
                        const created = await addProviderUserModel({
                          provider: pmForm.provider,
                          modelId: pmForm.modelId,
                          name: pmForm.name,
                          contextWindow: pmForm.contextWindow,
                          supportsVision: pmForm.supportsVision,
                          supportsFiles: pmForm.supportsFiles,
                          supportsReasoning: pmForm.supportsReasoning,
                        })
                        if (created) {
                          toast.success(`已添加模型：${created.name}`)
                          setPmFormOpen(false)
                          setPmForm({
                            provider: '',
                            modelId: '',
                            isHidden: false,
                            name: '',
                            contextWindow: 32768,
                            supportsVision: false,
                            supportsFiles: false,
                            supportsReasoning: false,
                          })
                        } else if (providerOverridesError) {
                          toast.error(providerOverridesError)
                        }
                      }}
                      onTest={async () => {
                        if (!pmForm.provider || !pmForm.modelId || !pmForm.name) return
                        setPmTestingId(pmForm.modelId)
                        try {
                          const res = await fetch('/api/provider-models/test', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              provider: pmForm.provider,
                              modelId: pmForm.modelId,
                              name: pmForm.name,
                              contextWindow: pmForm.contextWindow,
                              supportsVision: pmForm.supportsVision,
                              supportsFiles: pmForm.supportsFiles,
                              supportsReasoning: pmForm.supportsReasoning,
                              detectCapabilities: true,
                            }),
                          })
                          const json = await res.json().catch(() => ({})) as {
                            ok?: boolean
                            error?: string
                            capabilities?: { supportsVision: boolean; supportsReasoning: boolean }
                          }
                          if (json.ok) {
                            if (json.capabilities) {
                              const detected: string[] = []
                              if (json.capabilities.supportsVision && !pmForm.supportsVision) {
                                setPmForm(f => ({ ...f, supportsVision: true }))
                                detected.push('视觉')
                              }
                              if (json.capabilities.supportsReasoning && !pmForm.supportsReasoning) {
                                setPmForm(f => ({ ...f, supportsReasoning: true }))
                                detected.push('推理')
                              }
                              if (detected.length > 0) {
                                toast.success(`连接成功，已自动启用：${detected.join('、')}`)
                              } else {
                                toast.success('连接成功，未检测到额外能力')
                              }
                            } else {
                              toast.success('连接测试成功')
                            }
                          } else {
                            toast.error(json.error || `测试失败（HTTP ${res.status}）`)
                          }
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : '测试请求失败')
                        } finally {
                          setPmTestingId(null)
                        }
                      }}
                      onHide={async (provider, modelId, name) => {
                        const ok = await hideBuiltin(provider, modelId, name)
                        if (ok) toast.success(`已隐藏：${name || modelId}`)
                      }}
                      onUnhide={async (provider, modelId, name) => {
                        const ok = await unhideBuiltin(provider, modelId)
                        if (ok) toast.success(`已恢复：${name || modelId}`)
                      }}
                      onDelete={async (id) => {
                        if (!(await confirmDialog({ title: '删除模型', message: '确定要删除这个用户添加的模型吗？', danger: true, okText: '删除' }))) return
                        const ok = await deleteOverride(id)
                        if (ok) toast.success('已删除')
                      }}
                    />

                    <div className="flex items-center justify-between px-0.5">
                      <div className="flex items-center gap-1.5">
                        <Cpu className="w-3.5 h-3.5 text-content-secondary" />
                        <p className="text-xs font-medium text-content-secondary">自定义模型</p>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle/80 text-content-muted font-mono">
                          {customModels.length}
                        </span>
                      </div>
                      <button
                        onClick={() => {
                          setCmForm({
                            id: '',
                            name: '',
                            modelId: '',
                            baseURL: 'https://',
                            protocol: 'auto',
                            keySource: 'own',
                            apiKey: '',
                            provider: '',
                            contextWindow: 8192,
                            supportsVision: false,
                            supportsFiles: false,
                            supportsReasoning: false,
                          })
                          setCmFormOpen(true)
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                        添加
                      </button>
                    </div>

                    {customModels.length > 0 ? (
                      <ul className="space-y-1.5">
                        {customModels.map((model) => (
                          <li
                            key={model.id}
                            className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-surface/60 border border-line/60"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', CUSTOM_MODEL_DOT)} />
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-content-primary truncate">{model.name}</p>
                                <p className="text-[11px] text-content-muted truncate">
                                  {model.modelId}
                                  {' · '}
                                  {model.providerKey ? `复用 ${model.providerKey}` : '独立 Key'}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {cmTestResult[model.dbId] === 'success' && <CheckCircle className="w-4 h-4 text-green-500" />}
                              {cmTestResult[model.dbId] === 'error' && <AlertCircle className="w-4 h-4 text-red-500" />}
                              <button
                                onClick={() => startEdit(model)}
                                className="p-1.5 rounded-lg text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
                              >
                                <Wrench className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleCmDelete(model.dbId)}
                                disabled={cmDeleting === model.dbId}
                                className="p-1.5 rounded-lg text-red-500/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                              >
                                {cmDeleting === model.dbId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[11px] text-content-muted text-left py-1 px-0.5">
                        暂无自定义模型。您可以添加 OpenAI 兼容端点（如 OpenRouter、SiliconFlow、Ollama 等）。
                      </p>
                    )}

                    {/* 快速预设管理：内置 + 用户自定义 */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] font-medium text-content-secondary text-left">快速预设</p>
                        <button
                          onClick={() => {
                            setEditingPresetId(null)
                            setPresetDraft({ name: '', baseURL: '' })
                            setPresetFormOpen((v) => !v)
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                        >
                          <Plus className="w-3 h-3" />
                          添加预设
                        </button>
                      </div>

                      {/* 用户预设：可点击应用 + 悬停编辑/删除 */}
                      {userPresets.length > 0 && (
                        <ul className="space-y-1">
                          {userPresets.map((p) => (
                            <li
                              key={p.id}
                              className="group flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-surface/80 border border-line/40 hover:border-line-strong/40 transition-colors"
                            >
                              <button
                                onClick={() => applyPreset(p)}
                                className="flex-1 min-w-0 text-left"
                                title={`点击应用：${p.baseURL}`}
                              >
                                <p className="text-[12px] font-medium text-content-primary truncate">{p.name}</p>
                                <p className="text-[10.5px] text-content-muted truncate font-mono">{p.baseURL}</p>
                              </button>
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                <button
                                  onClick={() => {
                                    setEditingPresetId(p.id ?? null)
                                    setPresetDraft({ name: p.name, baseURL: p.baseURL })
                                    setPresetFormOpen(true)
                                  }}
                                  className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
                                  title="编辑"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={() => p.id && removeUserPreset(p.id)}
                                  className="p-1 rounded-md text-red-500/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                                  title="删除"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* 内置预设：只读胶囊，仅展示 */}
                      <div className="flex flex-wrap gap-1.5">
                        {allPresets.filter((p) => p.isBuiltIn).map((p) => (
                          <button
                            key={p.name}
                            onClick={() => applyPreset(p)}
                            className="px-2.5 py-1 rounded-lg text-[11px] bg-surface-muted text-content-secondary hover:bg-surface-subtle transition-colors"
                            title={p.baseURL}
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>

                      {/* 添加/编辑预设的内联表单 */}
                      {presetFormOpen && (
                        <div className="space-y-2 pt-1 border-t border-line/40">
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] font-medium text-content-secondary text-left">
                              {editingPresetId ? '编辑预设' : '添加预设'}
                            </p>
                            <button
                              onClick={() => {
                                setPresetFormOpen(false)
                                setEditingPresetId(null)
                                setPresetDraft({ name: '', baseURL: '' })
                              }}
                              className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
                              aria-label="关闭"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                          <input
                            type="text"
                            value={presetDraft.name}
                            onChange={(e) => setPresetDraft((d) => ({ ...d, name: e.target.value }))}
                            placeholder="预设名称（如：我的硅基流动）"
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                          <input
                            type="text"
                            value={presetDraft.baseURL}
                            onChange={(e) => setPresetDraft((d) => ({ ...d, baseURL: e.target.value }))}
                            placeholder="Base URL（如：https://api.example.com/v1）"
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                          <div className="flex justify-end gap-1.5">
                            <button
                              onClick={() => {
                                setPresetFormOpen(false)
                                setEditingPresetId(null)
                                setPresetDraft({ name: '', baseURL: '' })
                              }}
                              className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-content-secondary hover:bg-surface-subtle transition-colors"
                            >
                              取消
                            </button>
                            <button
                              onClick={() => {
                                if (editingPresetId) {
                                  const ok = updateUserPreset(editingPresetId, presetDraft.name, presetDraft.baseURL)
                                  if (ok) {
                                    setPresetFormOpen(false)
                                    setEditingPresetId(null)
                                    setPresetDraft({ name: '', baseURL: '' })
                                  }
                                } else {
                                  const created = addUserPreset(presetDraft.name, presetDraft.baseURL)
                                  if (created) {
                                    setPresetFormOpen(false)
                                    setPresetDraft({ name: '', baseURL: '' })
                                  }
                                }
                              }}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-accent text-accent-foreground hover:bg-accent-hover transition-colors"
                            >
                              <Save className="w-3 h-3" />
                              保存
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 自定义模型表单（折叠面板） */}
                    <details
                      open={cmFormOpen}
                      onToggle={(e) => setCmFormOpen(e.currentTarget.open)}
                      className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 group"
                    >
                      <summary className="flex items-center justify-between cursor-pointer list-none">
                        <p className="text-xs font-medium text-content-secondary text-left">
                          {cmForm.id ? '编辑自定义模型' : '添加自定义模型'}
                        </p>
                        <ChevronDown className="w-3.5 h-3.5 text-content-muted transition-transform group-open:rotate-180" />
                      </summary>

                      <div className="space-y-2.5 mt-2.5">
                        {/* Presets */}
                        <div className="flex flex-wrap gap-1.5">
                          {allPresets.map((preset) => (
                            <button
                              key={preset.id ?? preset.name}
                              onClick={() => applyPreset(preset)}
                              className="px-2.5 py-1 rounded-lg text-[11px] bg-surface-muted text-content-secondary hover:bg-surface-subtle transition-colors"
                            >
                              {preset.name}
                            </button>
                          ))}
                        </div>

                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                          <input
                            type="text"
                            value={cmForm.name}
                            onChange={(e) => setCmForm({ ...cmForm, name: e.target.value })}
                            placeholder="显示名称 (如：我的 DeepSeek)"
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                          <input
                            type="text"
                            value={cmForm.modelId}
                            onChange={(e) => setCmForm({ ...cmForm, modelId: e.target.value })}
                            placeholder="模型 ID (如：deepseek-flash)"
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                        </div>

                        {(() => {
                          const mid = cmForm.modelId.trim()
                          const pid = cmForm.keySource === 'provider' ? cmForm.provider : ''
                          const builtinHit = !!(pid && mid && providers.find(p => p.id === pid)?.models.includes(mid))
                          const ownHit = !!(mid && customModels.some(m => m.modelId === mid && (!cmForm.id || m.dbId !== cmForm.id)))
                          if (builtinHit) return (
                            <p className="text-[10px] text-amber-600 dark:text-amber-400 text-left flex items-center gap-1">
                              <AlertCircle className="w-3 h-3 shrink-0" /> 该模型 ID 已在内置列表中，通常无需重复添加
                            </p>
                          )
                          if (ownHit) return (
                            <p className="text-[10px] text-amber-600 dark:text-amber-400 text-left flex items-center gap-1">
                              <AlertCircle className="w-3 h-3 shrink-0" /> 已存在相同模型 ID 的自定义模型，保存会失败
                            </p>
                          )
                          return null
                        })()}

                        <div className="space-y-1">
                          <input
                            type="text"
                            value={cmForm.baseURL}
                            onChange={(e) => setCmForm({ ...cmForm, baseURL: e.target.value })}
                            placeholder={cmForm.keySource === 'provider'
                              ? 'Base URL (可选：留空使用服务商官方接口)'
                              : 'Base URL (OpenAI 兼容，如：https://api.siliconflow.cn/v1)'}
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                          {cmForm.keySource === 'provider' && (
                            <p className="text-[10px] text-content-muted text-left">
                              留空将直接调用所选服务商官方接口；也可填写代理或网关地址覆盖。
                            </p>
                          )}
                        </div>

                        <select
                          value={cmForm.protocol}
                          onChange={(e) => setCmForm({ ...cmForm, protocol: e.target.value as CustomModelForm['protocol'] })}
                          className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                        >
                          <option value="auto">自动识别接口协议</option>
                          <option value="chat">Chat Completions (/chat/completions)</option>
                          <option value="responses">OpenAI Responses (/responses)</option>
                          <option value="anthropic">Anthropic (/messages)</option>
                        </select>

                        <select
                          value={cmForm.keySource}
                          onChange={(e) => {
                            const v = e.target.value as 'own' | 'provider' | 'none'
                            setCmForm({
                              ...cmForm,
                              keySource: v,
                              baseURL: v === 'provider' ? '' : (cmForm.baseURL || 'https://'),
                            })
                          }}
                          className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                        >
                          <option value="own">使用独立 API Key</option>
                          <option value="provider">复用已有服务商 Key</option>
                          <option value="none">无需鉴权 (本地)</option>
                        </select>

                        {(cmForm.keySource === 'own' || cmForm.keySource === 'provider') && (
                          <div className="space-y-1.5">
                            {cmForm.keySource === 'own' && (
                              <input
                                type="password"
                                value={cmForm.apiKey}
                                onChange={(e) => setCmForm({ ...cmForm, apiKey: e.target.value })}
                                placeholder={cmForm.id ? 'API Key (留空保持原 Key)' : 'API Key'}
                                className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                              />
                            )}
                            {cmForm.keySource === 'provider' && (
                              <select
                                value={cmForm.provider || ''}
                                onChange={(e) => setCmForm({ ...cmForm, provider: e.target.value })}
                                className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                              >
                                <option value="">选择服务商...</option>
                                {keys.map((k) => (
                                  <option key={k.provider} value={k.provider}>{k.provider}</option>
                                ))}
                              </select>
                            )}
                          </div>
                        )}

                        <div className="flex items-center gap-2">
                          <span className="text-xs text-content-secondary shrink-0">上下文窗口</span>
                          <input
                            type="number"
                            value={cmForm.contextWindow}
                            onChange={(e) => setCmForm({ ...cmForm, contextWindow: Number(e.target.value) })}
                            className="flex-1 rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                        </div>

                        <div className="pt-1">
                          <div className="flex items-center justify-between mb-1.5">
                            <p className="text-[11px] text-content-muted">模型能力（不确定就点自动检测）</p>
                            <button
                              type="button"
                              onClick={() => handleCmTest(cmForm.id || undefined, true)}
                              disabled={cmTesting !== null}
                              className="px-2 py-1 rounded-md text-[10px] font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors flex items-center gap-1"
                              title="自动检测视觉和推理能力"
                            >
                              {cmTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                              自动检测
                            </button>
                          </div>
                          <div className="grid grid-cols-1 gap-1.5 md:grid-cols-3">
                            <label
                              className="group relative flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-surface-muted text-xs cursor-pointer md:px-2 md:py-1"
                              title="开启后才能在聊天中发送图片给此模型"
                            >
                              <input
                                type="checkbox"
                                checked={cmForm.supportsVision}
                                onChange={(e) => setCmForm({ ...cmForm, supportsVision: e.target.checked })}
                                className="accent-accent"
                              />
                              <span>视觉</span>
                              <Info className="w-3 h-3 text-content-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                            </label>
                            <label
                              className="group relative flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-surface-muted text-xs cursor-pointer md:px-2 md:py-1"
                              title="开启后才能发送 PDF / txt 等附件"
                            >
                              <input
                                type="checkbox"
                                checked={cmForm.supportsFiles}
                                onChange={(e) => setCmForm({ ...cmForm, supportsFiles: e.target.checked })}
                                className="accent-accent"
                              />
                              <span>文件</span>
                              <Info className="w-3 h-3 text-content-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                            </label>
                            <label
                              className="group relative flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-surface-muted text-xs cursor-pointer md:px-2 md:py-1"
                              title="开启后才能显示思考过程（如 DeepSeek-R1）"
                            >
                              <input
                                type="checkbox"
                                checked={cmForm.supportsReasoning}
                                onChange={(e) => setCmForm({ ...cmForm, supportsReasoning: e.target.checked })}
                                className="accent-accent"
                              />
                              <span>推理</span>
                              <Info className="w-3 h-3 text-content-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                            </label>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={() => handleCmTest(cmForm.id || undefined)}
                            disabled={cmTesting !== null}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-muted text-content-secondary hover:bg-surface-subtle transition-colors shrink-0"
                          >
                            {cmTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                            {cmForm.id ? '测试连接' : '保存前测试'}
                          </button>
                          {cmFormResult === 'success' && <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />}
                          {cmFormResult === 'error' && <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />}
                          <button
                            onClick={handleCmSave}
                            disabled={cmSaving || (cmForm.keySource === 'own' && !cmForm.apiKey && !cmForm.id)}
                            className={cn(
                              'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5 shrink-0',
                              !(cmSaving || (cmForm.keySource === 'own' && !cmForm.apiKey && !cmForm.id))
                                ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
                                : 'bg-surface-muted text-content-muted cursor-not-allowed'
                            )}
                          >
                            {cmSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                            保存
                          </button>
                          <button
                            onClick={() => setCmFormOpen(false)}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-muted text-content-secondary hover:bg-surface-subtle transition-colors shrink-0"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    </details>
                  </div>
                )}

                {/* 用户中心 */}
                {/* API 令牌(外部静态页 Bearer 调用凭证) */}
                {activeSection === 'apitokens' && <ApiTokensSection />}

                {/* 对话搬运(本地 dev ↔ 线上 的会话导出/导入) */}
                {activeSection === 'portable' && <PortableSettings />}

                {/* 管理(管理员专属):号池 / 激活码 / 注册码三 tab 共用同一组件按视图切片;接口自行验权,非管理员只会看到 403 降级态 */}
                {activeSection === 'quota' && <QuotaAdminSection view="pool" />}

                {activeSection === 'redeem' && <QuotaAdminSection view="redeem" />}

                {activeSection === 'regcodes' && <QuotaAdminSection view="register" />}

                {activeSection === 'account' && (
                  <div className="space-y-3 text-left">
                    {/* 用户卡片 */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3.5">
                      <div className="flex items-center gap-3">
                        {profile?.image ? (
                          <img
                            src={profile.image}
                            alt={profile.name || '头像'}
                            className="w-10 h-10 rounded-full shrink-0 object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-sm font-medium text-accent shrink-0">
                            {(profile?.name || profile?.email || session?.user?.email || '?').charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-content-primary truncate">
                            {profile?.nickname || profile?.name || '未设置用户名'}
                          </p>
                          <p className="text-[11px] text-content-muted truncate">
                            {profile?.email || session?.user?.email || '—'}
                          </p>
                        </div>
                      </div>
                      {profile?.createdAt && (
                        <div className="mt-3 pt-2.5 border-t border-line/40 flex items-center gap-1.5 text-[11px] text-content-muted">
                          <CalendarDays className="w-3.5 h-3.5 shrink-0" />
                          注册于 {new Date(profile.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}
                        </div>
                      )}
                    </div>

                    {/* 修改用户名 */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2">
                      <p className="text-xs font-medium text-content-secondary">用户名</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          maxLength={20}
                          placeholder="账户显示名"
                          className="w-full flex-1 min-w-0 rounded-lg border border-line/60 bg-surface px-2.5 py-2 text-[15.5px] text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30 md:py-1.5 md:text-xs"
                        />
                        <button
                          onClick={handleSaveName}
                          disabled={nameSaving || !nameDraft.trim() || nameDraft.trim() === (profile?.name ?? '')}
                          className={cn(
                            'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all shrink-0',
                            nameSaving || !nameDraft.trim() || nameDraft.trim() === (profile?.name ?? '')
                              ? 'bg-surface-muted text-content-muted cursor-not-allowed'
                              : 'bg-accent text-accent-foreground hover:bg-accent-hover'
                          )}
                        >
                          {nameSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          保存
                        </button>
                      </div>
                      <p className="text-[10px] text-content-muted/70 max-md:hidden">
                        用户名显示在侧边栏，也可用于登录。想让 AI 换个称呼请改下面的「称呼」。
                      </p>
                    </div>

                    {/* 称呼（AI 怎么叫你）:可留空，留空回退用户名，不回退邮箱前缀 */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2">
                      <p className="text-xs font-medium text-content-secondary">称呼</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={nicknameDraft}
                          onChange={(e) => setNicknameDraft(e.target.value)}
                          maxLength={20}
                          placeholder={profile?.name ? `默认用用户名：${profile.name}` : '留空则用用户名'}
                          className="w-full flex-1 min-w-0 rounded-lg border border-line/60 bg-surface px-2.5 py-2 text-[15.5px] text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30 md:py-1.5 md:text-xs"
                        />
                        <button
                          onClick={handleSaveNickname}
                          disabled={nicknameSaving || nicknameDraft.trim() === (profile?.nickname ?? '')}
                          className={cn(
                            'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all shrink-0',
                            nicknameSaving || nicknameDraft.trim() === (profile?.nickname ?? '')
                              ? 'bg-surface-muted text-content-muted cursor-not-allowed'
                              : 'bg-accent text-accent-foreground hover:bg-accent-hover'
                          )}
                        >
                          {nicknameSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          保存
                        </button>
                      </div>
                      <p className="text-[10px] text-content-muted/70 max-md:hidden">
                        AI 讲解与问候时这样叫你。当前生效：{profileState?.displayName || '未设置'}
                      </p>
                    </div>

                    {/* 通用档案:只读查看卡——填与改一律走采集弹窗，界面不重复实现一遍档位 */}
                    {!isEphemeral && (
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2" data-profile-card>
                      <MSwitchRow
                        label="让 AI 了解这份档案"
                        help="开启后每次对话都会把这些事实告知模型；关闭则完全不注入"
                        checked={profileState?.enabled ?? false}
                        onChange={(next) => void handleToggleProfileEnabled(next)}
                        disabled={profileSaving || !profileState}
                      />

                      <div
                        className="rounded-lg border border-line/50 bg-surface-muted/40 divide-y divide-line/40"
                        data-profile-fields
                      >
                        {applicableProbeFields(profileState?.fields ?? {}).map((id) => {
                          const value = profileState?.fields[id]
                          return (
                            <div
                              key={id}
                              className="flex min-h-[44px] items-center justify-between gap-3 px-2.5 py-1.5"
                            >
                              <span className="shrink-0 text-[15.5px] text-content-primary md:text-xs md:text-content-secondary">
                                {probeFieldLabel(id)}
                              </span>
                              <span
                                className={cn(
                                  'min-w-0 truncate text-right text-[15.5px] md:text-xs',
                                  value ? 'text-content-primary' : 'text-content-muted/60'
                                )}
                              >
                                {value ? generalFieldLabel(id, value) : '空白'}
                              </span>
                            </div>
                          )
                        })}
                      </div>

                      {profileDerived && profileDerived.kind !== 'keep' && (
                        <div className="rounded-lg border border-line/50 bg-surface-muted/50 px-2.5 py-2">
                          <p className="text-[11px] leading-snug text-content-secondary">
                            {profileDerived.note}
                          </p>
                          <div className="mt-1.5 flex items-center gap-2">
                            <button
                              onClick={() => handleConfirmStage(profileDerived.stage ?? '')}
                              disabled={profileSaving}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-accent text-accent-foreground hover:bg-accent-hover transition-colors disabled:opacity-50"
                            >
                              {profileDerived.kind === 'graduate' ? '确认已毕业' : `确认升入 ${profileDerived.stage}`}
                            </button>
                            <button
                              onClick={() => handleConfirmStage(profileState?.fields.stage ?? '')}
                              disabled={profileSaving}
                              className="px-2.5 py-1 rounded-lg text-[11px] text-content-muted hover:text-content-secondary transition-colors disabled:opacity-50"
                            >
                              保持不变
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => setProbeDialogOpen(true)}
                          className={cn(
                            'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all shrink-0',
                            'bg-accent text-accent-foreground hover:bg-accent-hover'
                          )}
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          {pendingProbeFields(profileState?.fields ?? {}).length > 0
                            ? `补齐 ${pendingProbeFields(profileState?.fields ?? {}).length} 条`
                            : '改一条'}
                        </button>
                        {profileState?.exists && (
                          <button
                            onClick={handleResetProfile}
                            disabled={profileSaving}
                            className="px-3 py-1.5 rounded-lg text-xs text-red-500/90 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 shrink-0"
                          >
                            清空档案
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-content-muted/70 max-md:hidden">
                        这里只看不能改。填或改都进那个一问一答的弹窗（与聊天页同一个入口），
                        答一条存一条；不适用的项不列（非学生不填学段，上班族不填选科）。
                      </p>

                      {probeDialogOpen && profileState && (
                        <ProfileProbeDialog
                          initial={profileState}
                          /* 还缺维度就顺着问下去；已填满则把已答的逐条过一遍（「改一条」的语义） */
                          mode={pendingProbeFields(profileState.fields).length > 0 ? 'fill' : 'review'}
                          onChange={(row) => setProfileState(row)}
                          onClose={() => {
                            setProbeDialogOpen(false)
                            void refreshProfileView()
                          }}
                        />
                      )}
                    </div>
                    )}

                    <ProfileMirror
                      section={profileSection}
                      enabled={profileState?.enabled ?? false}
                      derivedNote={
                        profileDerived && profileDerived.kind !== 'keep' ? profileDerived.note : ''
                      }
                      alwaysMemories={memories.filter(
                        (m) =>
                          m.source === 'manual' ||
                          m.category === 'user_info' ||
                          m.category === 'preference'
                      )}
                    />

                    {/* 访客密码(临时登录入口) */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 text-left">
                          <p className="text-xs font-medium text-content-secondary">访客密码</p>
                          <p className="text-[10px] text-content-muted/70 mt-0.5">
                            {ephemeralSettings?.hasGuestPassword
                              ? '已开启：他人可用访客密码进入临时聊天'
                              : '未开启：设置后可把访客密码借给他人，主密码不受影响'}
                          </p>
                        </div>
                        {!guestPwdEditing && (
                          <button
                            onClick={() => {
                              setGuestPwdEditing(true)
                              setGuestPwdDraft('')
                              setGuestMainPwdDraft('')
                            }}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-surface-muted text-content-secondary hover:bg-surface-subtle transition-colors shrink-0"
                          >
                            {ephemeralSettings?.hasGuestPassword ? '修改' : '设置'}
                          </button>
                        )}
                      </div>
                      {guestPwdEditing && (
                        <div className="space-y-1.5 pt-1">
                          <input
                            type="password"
                            value={guestPwdDraft}
                            onChange={(e) => setGuestPwdDraft(e.target.value)}
                            placeholder={ephemeralSettings?.hasGuestPassword ? '输入新访客密码（4-64 位）' : '设置访客密码（4-64 位）'}
                            autoComplete="new-password"
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                          <input
                            type="password"
                            value={guestMainPwdDraft}
                            onChange={(e) => setGuestMainPwdDraft(e.target.value)}
                            placeholder="输入主密码确认"
                            autoComplete="current-password"
                            className="w-full rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-line-strong/30"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleSaveGuestPassword(false)}
                              disabled={guestPwdSaving || !guestPwdDraft.trim() || !guestMainPwdDraft}
                              className={cn(
                                'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all shrink-0',
                                guestPwdSaving || !guestPwdDraft.trim() || !guestMainPwdDraft
                                  ? 'bg-surface-muted text-content-muted cursor-not-allowed'
                                  : 'bg-accent text-accent-foreground hover:bg-accent-hover'
                              )}
                            >
                              {guestPwdSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                              保存
                            </button>
                            {ephemeralSettings?.hasGuestPassword && (
                              <button
                                onClick={() => handleSaveGuestPassword(true)}
                                disabled={guestPwdSaving || !guestMainPwdDraft}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-500/90 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                清除访客密码
                              </button>
                            )}
                            <button
                              onClick={() => setGuestPwdEditing(false)}
                              className="px-3 py-1.5 rounded-lg text-xs text-content-muted hover:text-content-secondary transition-colors shrink-0"
                            >
                              取消
                            </button>
                          </div>
                          <p className="text-[10px] text-content-muted/70">
                            访客密码须与主密码不同；临时模式无法查看或修改账户设置。连续输错将触发一分钟限速。
                          </p>
                        </div>
                      )}
                    </div>

                    {/* 临时聊天(隔离区管理) */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2">
                      <p className="text-xs font-medium text-content-secondary text-left">临时聊天</p>
                      <p className="text-[10px] text-content-muted/70 text-left">
                        通过访客密码产生的对话保存在这里，正常历史列表不可见。
                      </p>
                      {ephemeralItems.length === 0 ? (
                        <p className="text-[11px] text-content-muted py-1 text-left">暂无临时对话。</p>
                      ) : (
                        <div className="space-y-1.5">
                          {ephemeralItems.map((it) => (
                            <div key={it.id} className="rounded-lg border border-line/40 bg-surface px-2.5 py-2 space-y-1.5">
                              <div className="flex items-center gap-1.5">
                                <div className="min-w-0 flex-1 text-left">
                                  <p className="text-[11px] font-medium text-content-primary truncate">
                                    {it.title || '无标题对话'}
                                  </p>
                                  <p className="text-[10px] text-content-muted">
                                    {it.messageCount} 条消息 · {new Date(it.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                  </p>
                                </div>
                                <button
                                  onClick={() => handlePreviewEphemeral(it.id)}
                                  disabled={ephemeralActingId === it.id}
                                  className={cn(
                                    'p-1.5 rounded-md transition-colors shrink-0',
                                    ephemeralPreviewId === it.id
                                      ? 'text-accent bg-accent/10'
                                      : 'text-content-muted hover:text-content-secondary hover:bg-surface-subtle'
                                  )}
                                  title={ephemeralPreviewId === it.id ? '收起预览' : '查看消息'}
                                >
                                  {ephemeralPreviewId === it.id ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                </button>
                                <button
                                  onClick={() => handleEphemeralAction('restore', it.id)}
                                  disabled={ephemeralActingId === it.id}
                                  className="p-1.5 rounded-md text-content-muted hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-50 shrink-0"
                                  title="转正：回到正常历史列表"
                                >
                                  {ephemeralActingId === it.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                                </button>
                                <button
                                  onClick={() => handleEphemeralAction('delete', it.id)}
                                  disabled={ephemeralActingId === it.id}
                                  className="p-1.5 rounded-md text-content-muted hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 shrink-0"
                                  title="彻底删除"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              {ephemeralPreviewId === it.id && (
                                <div className="pt-1.5 border-t border-line/40 space-y-1.5 max-h-44 overflow-y-auto">
                                  {ephemeralPreviewLoading ? (
                                    <div className="flex items-center gap-1.5 py-1 text-[10px] text-content-muted">
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                      加载中…
                                    </div>
                                  ) : ephemeralPreviewMsgs && ephemeralPreviewMsgs.length > 0 ? (
                                    ephemeralPreviewMsgs.map((m) => (
                                      <div key={m.id} className="text-left">
                                        <span
                                          className={cn(
                                            'text-[10px] font-medium',
                                            m.role === 'user' ? 'text-content-secondary' : 'text-accent/80'
                                          )}
                                        >
                                          {m.role === 'user' ? '访客' : 'AI'}
                                        </span>
                                        <p className="text-[10px] leading-relaxed text-content-muted whitespace-pre-wrap break-all line-clamp-3">
                                          {m.content}
                                        </p>
                                      </div>
                                    ))
                                  ) : (
                                    <p className="text-[10px] text-content-muted py-1 text-left">暂无消息。</p>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 临时模式记忆读取开关 */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 text-left">
                          <p className="text-xs font-medium text-content-secondary">临时模式允许读取我的记忆</p>
                          <p className="text-[10px] text-content-muted/70 mt-0.5">
                            默认关闭：临时聊天不读取你的记忆，也不会写入新记忆。
                          </p>
                        </div>
                        <button
                          onClick={() => handleToggleMemoryInjection(!(ephemeralSettings?.ephemeralMemoryInjection ?? false))}
                          disabled={memInjectSaving}
                          className={cn(
                            'relative w-9 h-5 rounded-full transition-colors shrink-0',
                            (ephemeralSettings?.ephemeralMemoryInjection ?? false) ? 'bg-accent' : 'bg-surface-subtle'
                          )}
                        >
                          <span
                            className={cn(
                              'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white dark:bg-surface transition-transform',
                              (ephemeralSettings?.ephemeralMemoryInjection ?? false) && 'translate-x-4'
                            )}
                          />
                        </button>
                      </div>
                    </div>

                    {/* 危险区隔离:手机端退出登录挂账号页末尾整行居中(2026-10-08 自总览底部迁入——
                        10-05 改版后手机端到不了总览,安卓壳又没有侧栏用户菜单,导致无任何登出入口)。
                        登出无二次确认,重进还要输密码;桌面有侧栏用户菜单,md:hidden 保持桌面零改动 */}
                    {session?.user && (
                      <div className="md:hidden rounded-2xl border border-red-500/25 bg-surface/60 overflow-hidden">
                        <button
                          onClick={handleSignOut}
                          className="w-full min-h-[50px] flex items-center justify-center gap-1.5 text-[13px] font-semibold text-red-500 active:bg-red-50/60 dark:active:bg-red-950/30 transition-colors"
                          style={{ WebkitTapHighlightColor: 'transparent' }}
                        >
                          <LogOut className="w-4 h-4" />
                          退出登录
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* 用量统计 */}
                {activeSection === 'usage' && (
                  <div className="space-y-3">
                    {/* 今日公共额度(本人):与下方个人统计独立取数,池未初始化时自隐藏 */}
                    <QuotaPersonalCard />
                    {!usageStats ? (
                      <p className="text-[11px] text-content-muted text-left py-1">
                        暂无统计数据。发起对话后，每次回复的 Token 消耗会自动记录在这里。
                      </p>
                    ) : (
                      <>
                        {/* Tab 切换 + 刷新 */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="inline-flex p-0.5 rounded-lg bg-surface-muted/60 border border-line/60">
                            {([
                              { id: 'overview' as const, label: '总览' },
                              { id: 'chat' as const, label: '聊天' },
                              { id: 'image' as const, label: '生图' },
                            ]).map((tab) => (
                              <button
                                key={tab.id}
                                onClick={() => setUsageTab(tab.id)}
                                className={cn(
                                  'px-3 py-1 rounded-md text-[11px] font-medium transition-all',
                                  usageTab === tab.id
                                    ? 'bg-surface text-content-primary shadow-sm'
                                    : 'text-content-muted hover:text-content-secondary'
                                )}
                              >
                                {tab.label}
                              </button>
                            ))}
                          </div>
                          <button
                            onClick={loadUsageStats}
                            disabled={usageRefreshing}
                            className={cn(
                              'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
                              usageRefreshing
                                ? 'bg-surface-muted text-content-muted cursor-not-allowed'
                                : 'bg-surface-muted text-content-secondary hover:bg-surface-subtle'
                            )}
                            title="刷新用量统计"
                          >
                            <RefreshCw className={cn('w-3 h-3', usageRefreshing && 'animate-spin')} />
                            刷新
                          </button>
                        </div>

                        {usageTab === 'overview' ? (
                          <OverviewTab usageStats={usageStats} />
                        ) : usageTab === 'chat' ? (
                          <>
                            {/* 总览卡片 */}
                            <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
                              <div className="flex items-end justify-between gap-3">
                                <div className="text-left">
                                  <p className="text-[11px] text-content-muted">累计消耗 Token</p>
                                  <p className="text-xl font-semibold text-content-primary font-mono leading-tight">
                                    {usageStats.chat.totals.totalTokens.toLocaleString()}
                                  </p>
                                </div>
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-muted text-content-muted font-mono shrink-0 mb-0.5">
                                  {usageStats.chat.totals.messages.toLocaleString()} 条回复
                                </span>
                              </div>
                              <div className="space-y-1.5">
                                {(() => {
                                  const t = usageStats.chat.totals
                                  const pct = t.totalTokens > 0
                                    ? Math.round((t.promptTokens / t.totalTokens) * 100)
                                    : 0
                                  return (
                                    <>
                                      <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden flex">
                                        <div
                                          className="h-full bg-accent/70"
                                          style={{ width: `${pct}%` }}
                                          title={`输入 ${t.promptTokens.toLocaleString()}`}
                                        />
                                        <div
                                          className="h-full bg-content-muted/40 flex-1"
                                          title={`输出 ${t.completionTokens.toLocaleString()}`}
                                        />
                                      </div>
                                      <div className="flex items-center justify-between text-[11px]">
                                        <span className="text-content-secondary flex items-center gap-1.5">
                                          <span className="w-2 h-2 rounded-full bg-accent/70 inline-block" />
                                          输入 {t.promptTokens.toLocaleString()}
                                        </span>
                                        <span className="text-content-muted flex items-center gap-1.5">
                                          <span className="w-2 h-2 rounded-full bg-content-muted/40 inline-block" />
                                          输出 {t.completionTokens.toLocaleString()}
                                        </span>
                                      </div>
                                    </>
                                  )
                                })()}
                              </div>
                            </div>

                            {/* 最近 30 天柱状图 */}
                            {usageStats.chat.byDay.length > 0 && (
                              <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
                                <p className="text-[11px] font-medium text-content-secondary mb-2 text-left">
                                  最近 30 天 Token 消耗
                                </p>
                                {(() => {
                                  const days = usageStats.chat.byDay
                                  const max = Math.max(...days.map((d) => d.totalTokens), 1)
                                  const sum30 = days.reduce((s, d) => s + d.totalTokens, 0)
                                  return (
                                    <>
                                      <div className="flex items-end gap-[3px] h-20">
                                        {days.map((d) => (
                                          <div
                                            key={d.date}
                                            className="flex-1 flex items-end h-full group"
                                            title={`${d.date.slice(5)} · ${d.totalTokens.toLocaleString()} tokens`}
                                          >
                                            <div
                                              className={cn(
                                                'w-full rounded-t-[3px] transition-colors',
                                                d.totalTokens > 0
                                                  ? 'bg-accent/70 group-hover:bg-accent'
                                                  : 'bg-surface-subtle/60'
                                              )}
                                              style={{
                                                height: d.totalTokens > 0
                                                  ? `${Math.max((d.totalTokens / max) * 100, 4)}%`
                                                  : '4px',
                                              }}
                                            />
                                          </div>
                                        ))}
                                      </div>
                                      <div className="flex items-center justify-between mt-1.5 text-[10px] text-content-muted font-mono">
                                        <span>{days[0].date.slice(5)}</span>
                                        <span>{sum30.toLocaleString()} tokens</span>
                                        <span>{days[days.length - 1].date.slice(5)}</span>
                                      </div>
                                    </>
                                  )
                                })()}
                              </div>
                            )}

                            {/* 按模型统计 */}
                            {usageStats.chat.byModel.length > 0 && (
                              <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
                                <p className="text-[11px] font-medium text-content-secondary mb-2 text-left">
                                  按模型
                                </p>
                                <ul className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
                                  {usageStats.chat.byModel.map((m) => {
                                    const pct = usageStats.chat.totals.totalTokens > 0
                                      ? Math.round((m.totalTokens / usageStats.chat.totals.totalTokens) * 100)
                                      : 0
                                    return (
                                      <li
                                        key={m.model}
                                        className="rounded-lg bg-surface-muted/60 border border-line/40 px-2.5 py-2"
                                      >
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="text-xs text-content-primary truncate">
                                            {m.model}
                                          </span>
                                          <span className="text-xs font-mono text-content-secondary shrink-0">
                                            {m.totalTokens.toLocaleString()}
                                          </span>
                                        </div>
                                        <div className="mt-1.5 flex items-center gap-2">
                                          <div className="flex-1 h-1 rounded-full bg-surface-subtle overflow-hidden">
                                            <div
                                              className="h-full rounded-full bg-accent/70"
                                              style={{ width: `${pct}%` }}
                                            />
                                          </div>
                                          <span className="text-[10px] text-content-muted font-mono shrink-0 w-9 text-right">
                                            {pct}%
                                          </span>
                                        </div>
                                        <div className="mt-1 flex items-center justify-between text-[10px] text-content-muted">
                                          <span>输入 {m.promptTokens.toLocaleString()} · 输出 {m.completionTokens.toLocaleString()}</span>
                                          <span>{m.messages} 条</span>
                                        </div>
                                      </li>
                                    )
                                  })}
                                </ul>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {/* 生图总览卡片 */}
                            <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
                              <div className="flex items-end justify-between gap-3">
                                <div className="text-left">
                                  <p className="text-[11px] text-content-muted">累计生图</p>
                                  <p className="text-xl font-semibold text-content-primary font-mono leading-tight">
                                    {usageStats.image.totals.count.toLocaleString()}
                                    <span className="text-xs font-normal text-content-muted ml-1">张</span>
                                  </p>
                                </div>
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-muted text-content-muted font-mono shrink-0 mb-0.5">
                                  {usageStats.image.byModel.length} 个模型
                                </span>
                              </div>

                              {/* 尺寸分布 */}
                              {usageStats.image.bySize.length > 0 && (
                                <div className="space-y-1.5">
                                  {(() => {
                                    const total = usageStats.image.totals.count
                                    const SIZE_LABELS: Record<string, string> = {
                                      '1024*1024': '1:1 · 1024×1024',
                                      '720*1280': '9:16 · 720×1280',
                                      '1280*720': '16:9 · 1280×720',
                                    }
                                    return (
                                      <>
                                        <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden flex">
                                          {usageStats.image.bySize.map((s, i) => {
                                            const pct = total > 0 ? (s.count / total) * 100 : 0
                                            const colors = ['bg-accent/70', 'bg-emerald-500/70', 'bg-amber-500/70', 'bg-purple-500/70']
                                            return (
                                              <div
                                                key={s.size}
                                                className={cn('h-full', colors[i % colors.length])}
                                                style={{ width: `${pct}%` }}
                                                title={`${SIZE_LABELS[s.size] ?? s.size} · ${s.count} 张`}
                                              />
                                            )
                                          })}
                                        </div>
                                        <ul className="space-y-1">
                                          {usageStats.image.bySize.map((s, i) => {
                                            const pct = total > 0 ? Math.round((s.count / total) * 100) : 0
                                            const colors = ['bg-accent/70', 'bg-emerald-500/70', 'bg-amber-500/70', 'bg-purple-500/70']
                                            return (
                                              <li key={s.size} className="flex items-center justify-between text-[11px]">
                                                <span className="text-content-secondary flex items-center gap-1.5">
                                                  <span className={cn('w-2 h-2 rounded-full inline-block', colors[i % colors.length])} />
                                                  {SIZE_LABELS[s.size] ?? s.size}
                                                </span>
                                                <span className="text-content-muted font-mono">
                                                  {s.count.toLocaleString()} 张 · {pct}%
                                                </span>
                                              </li>
                                            )
                                          })}
                                        </ul>
                                      </>
                                    )
                                  })()}
                                </div>
                              )}
                            </div>

                            {/* 最近 30 天柱状图 */}
                            {usageStats.image.byDay.length > 0 && (
                              <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
                                <p className="text-[11px] font-medium text-content-secondary mb-2 text-left">
                                  最近 30 天生图张数
                                </p>
                                {(() => {
                                  const days = usageStats.image.byDay
                                  const max = Math.max(...days.map((d) => d.count), 1)
                                  const sum30 = days.reduce((s, d) => s + d.count, 0)
                                  return (
                                    <>
                                      <div className="flex items-end gap-[3px] h-20">
                                        {days.map((d) => (
                                          <div
                                            key={d.date}
                                            className="flex-1 flex items-end h-full group"
                                            title={`${d.date.slice(5)} · ${d.count} 张`}
                                          >
                                            <div
                                              className={cn(
                                                'w-full rounded-t-[3px] transition-colors',
                                                d.count > 0
                                                  ? 'bg-emerald-500/70 group-hover:bg-emerald-500'
                                                  : 'bg-surface-subtle/60'
                                              )}
                                              style={{
                                                height: d.count > 0
                                                  ? `${Math.max((d.count / max) * 100, 4)}%`
                                                  : '4px',
                                              }}
                                            />
                                          </div>
                                        ))}
                                      </div>
                                      <div className="flex items-center justify-between mt-1.5 text-[10px] text-content-muted font-mono">
                                        <span>{days[0].date.slice(5)}</span>
                                        <span>{sum30.toLocaleString()} 张</span>
                                        <span>{days[days.length - 1].date.slice(5)}</span>
                                      </div>
                                    </>
                                  )
                                })()}
                              </div>
                            )}

                            {/* 按模型统计 */}
                            {usageStats.image.byModel.length > 0 && (
                              <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
                                <p className="text-[11px] font-medium text-content-secondary mb-2 text-left">
                                  按模型
                                </p>
                                <ul className="space-y-1.5">
                                  {usageStats.image.byModel.map((m) => {
                                    const pct = usageStats.image.totals.count > 0
                                      ? Math.round((m.count / usageStats.image.totals.count) * 100)
                                      : 0
                                    return (
                                      <li
                                        key={m.model}
                                        className="rounded-lg bg-surface-muted/60 border border-line/40 px-2.5 py-2"
                                      >
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="text-xs text-content-primary truncate">
                                            {m.model}
                                          </span>
                                          <span className="text-xs font-mono text-content-secondary shrink-0">
                                            {m.count.toLocaleString()} 张
                                          </span>
                                        </div>
                                        <div className="mt-1.5 flex items-center gap-2">
                                          <div className="flex-1 h-1 rounded-full bg-surface-subtle overflow-hidden">
                                            <div
                                              className="h-full rounded-full bg-emerald-500/70"
                                              style={{ width: `${pct}%` }}
                                            />
                                          </div>
                                          <span className="text-[10px] text-content-muted font-mono shrink-0 w-9 text-right">
                                            {pct}%
                                          </span>
                                        </div>
                                      </li>
                                    )
                                  })}
                                </ul>
                              </div>
                            )}

                            {usageStats.image.totals.count === 0 && (
                              <p className="text-[11px] text-content-muted text-left py-1">
                                暂无生图记录。在生图工作台或聊天中生成图片后会在这里显示统计。
                              </p>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* 记忆 */}
                {activeSection === 'memory' && (
                  <div className="space-y-2.5">
                    {/* 开关 */}
                    <MSwitchRow
                      label="记忆功能"
                      help="换新对话时 AI 仍记得关于你的信息"
                      checked={memoryEnabled}
                      onChange={handleToggleMemory}
                    />

                    {/* ── 导入入口（收起时显示为按钮，展开时显示完整面板）──────── */}
                    {memoryImportOpen ? (
                      /* 展开的导入面板（独立区域，不受列表滚动影响） */
                      <div className="rounded-xl border border-line/60 bg-surface/40 p-3 space-y-2">
                        {/* 标题栏 */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 text-left min-w-0">
                            <FileUp className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                            <p className="text-xs text-content-secondary font-medium">从其他 AI 导入记忆</p>
                          </div>
                          <button
                            onClick={closeMemoryImport}
                            className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle/60 transition-colors shrink-0"
                            aria-label="关闭导入"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* 来源输入行 */}
                        <div className="flex items-center gap-2">
                          <label className="text-[11px] text-content-muted shrink-0 whitespace-nowrap">来源</label>
                          <input
                            type="text"
                            value={memoryImportSource}
                            onChange={(e) => setMemoryImportSource(e.target.value)}
                            placeholder="ChatGPT / Claude / Grok / ..."
                            maxLength={50}
                            className="flex-1 min-w-0 rounded-md border border-line/60 bg-surface px-2 py-1 text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-1 focus:ring-line-strong/30 focus:border-line-strong"
                          />
                          <select
                            value=""
                            onChange={(e) => {
                              if (e.target.value) setMemoryImportSource(e.target.value)
                            }}
                            className="rounded-md border border-line/60 bg-surface px-1.5 py-1 text-[11px] text-content-secondary cursor-pointer focus:outline-none shrink-0"
                            aria-label="选择常见来源"
                          >
                            <option value="">常用…</option>
                            {COMMON_IMPORT_SOURCES.map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        </div>

                        {/* 格式提示 */}
                        <p className="text-[10px] text-content-muted leading-relaxed text-left">
                          支持格式：① 每行一条 ② <code className="font-mono">[身份信息] 用户名字是张三</code> ③ 类别标题 + <code className="font-mono">*</code> 项（如 <code className="font-mono">1. 人口统计信息：</code> 后跟项目）。「证据：」「导入来源：」行自动跳过。
                        </p>

                        {/* 参考提示（可复制到其他 AI） */}
                        <div className="rounded-lg border border-line/60 bg-surface overflow-hidden">
                          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-surface-muted/50 border-b border-line/40">
                            <span className="text-[11px] font-medium text-content-secondary">参考提示</span>
                            <button
                              onClick={() => copyReferencePrompt()}
                              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-content-muted hover:text-accent hover:bg-accent/10 transition-colors"
                              title="复制提示"
                            >
                              {refCopied
                                ? <><Check className="w-3 h-3 text-green-500" /> 已复制</>
                                : <><Copy className="w-3 h-3" /> 复制</>
                              }
                            </button>
                          </div>
                          <pre className="px-3 py-2 text-[10px] text-content-secondary leading-relaxed whitespace-pre-wrap break-all font-mono max-h-36 overflow-y-auto">{MEMORY_IMPORT_REFERENCE}</pre>
                        </div>

                        {/* 粘贴文本框 */}
                        <textarea
                          value={memoryImportText}
                          onChange={(e) => handleImportTextChange(e.target.value)}
                          placeholder="将 ChatGPT / Claude 等导出的记忆粘贴到这里"
                          rows={5}
                          className="w-full rounded-md border border-line/60 bg-surface px-2 py-1.5 text-xs text-content-primary placeholder:text-content-muted resize-y focus:outline-none focus:ring-1 focus:ring-line-strong/30 focus:border-line-strong font-mono leading-relaxed"
                        />

                        {/* 错误提示 */}
                        {memoryImportError && (
                          <p className="text-[11px] text-amber-600 dark:text-amber-400 text-left">
                            {memoryImportError}
                          </p>
                        )}

                        {/* 解析预览 */}
                        {memoryImportDrafts.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <p className="text-[11px] text-content-secondary">
                                预览：识别到 <span className="font-mono font-semibold text-content-primary">{memoryImportDrafts.length}</span> 条
                              </p>
                              <button
                                onClick={() => setMemoryImportDrafts([])}
                                className="text-[10px] text-content-muted hover:text-red-500 transition-colors"
                              >
                                清空
                              </button>
                            </div>
                            <ul className="space-y-1 max-h-40 overflow-y-auto pr-0.5">
                              {memoryImportDrafts.map((d, idx) => (
                                <li
                                  key={idx}
                                  className="flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-surface-muted/60 border border-line/40"
                                >
                                  <select
                                    value={d.category}
                                    onChange={(e) => handleUpdateImportDraft(idx, { category: e.target.value })}
                                    className="shrink-0 rounded border border-line/60 bg-surface px-1 py-0.5 text-[10px] text-content-secondary focus:outline-none cursor-pointer"
                                  >
                                    {Object.entries(MEMORY_CATEGORY_LABELS).map(([k, v]) => (
                                      <option key={k} value={k}>{v}</option>
                                    ))}
                                  </select>
                                  <textarea
                                    value={d.content}
                                    onChange={(e) => handleUpdateImportDraft(idx, { content: e.target.value })}
                                    rows={1}
                                    className="flex-1 min-w-0 bg-transparent text-xs text-content-secondary resize-none border-0 focus:outline-none focus:ring-0 leading-relaxed"
                                  />
                                  <button
                                    onClick={() => handleRemoveImportDraft(idx)}
                                    className="shrink-0 p-0.5 rounded text-content-muted hover:text-red-500 transition-colors"
                                    aria-label="移除此条"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* 操作按钮 */}
                        <div className="flex items-center justify-end gap-2 pt-1">
                          <button
                            onClick={closeMemoryImport}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-content-secondary hover:text-content-primary transition-colors"
                          >
                            取消
                          </button>
                          <button
                            onClick={handleConfirmImport}
                            disabled={
                              memoryImportSaving ||
                              memoryImportDrafts.length === 0 ||
                              !memoryImportSource.trim()
                            }
                            className={cn(
                              'px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5',
                              memoryImportDrafts.length > 0 && memoryImportSource.trim() && !memoryImportSaving
                                ? 'bg-purple-500 text-white hover:bg-purple-600 active:scale-[0.97]'
                                : 'bg-surface-muted text-content-muted cursor-not-allowed'
                            )}
                          >
                            {memoryImportSaving ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Download className="w-3.5 h-3.5" />
                            )}
                            导入 {memoryImportDrafts.length > 0 ? `${memoryImportDrafts.length} 条` : ''}
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* 收起状态：显示「导入」按钮 */
                      <button
                        onClick={openMemoryImport}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/30 border border-purple-200/60 dark:border-purple-800/40 transition-colors"
                      >
                        <FileUp className="w-3.5 h-3.5" />
                        从其他 AI 导入记忆
                      </button>
                    )}

                    {/* ── 手动添加（仅在导入面板关闭时显示）────────────── */}
                    {!memoryImportOpen && (
                      <div className="flex gap-2 pt-2 border-t border-line/40">
                        <input
                          type="text"
                          value={memoryDraft}
                          onChange={(e) => setMemoryDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                              e.preventDefault()
                              handleAddMemory()
                            }
                          }}
                          placeholder="手动添加一条记忆，如：用户喜欢简洁的设计"
                          className={cn(
                            'flex-1 min-w-0 rounded-lg border px-2.5 py-1.5 text-xs',
                            'border-line/60',
                            'bg-surface',
                            'text-content-primary',
                            'placeholder:text-content-muted',
                            'focus:outline-none focus:ring-2 focus:ring-line-strong/30',
                            'focus:border-line-strong'
                          )}
                        />
                        <button
                          onClick={handleAddMemory}
                          disabled={!memoryDraft.trim() || memorySaving}
                          className={cn(
                            'px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shrink-0',
                            memoryDraft.trim() && !memorySaving
                              ? 'bg-accent text-accent-foreground hover:bg-accent-hover active:scale-[0.97]'
                              : 'bg-surface-muted text-content-muted cursor-not-allowed'
                          )}
                        >
                          {memorySaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                          添加
                        </button>
                      </div>
                    )}

                    {/* ── 相互矛盾的记忆：服务端本地判出的冲突组，用户在此裁决 ──
                        判据只认槽位/常识互斥(年龄↔学段、城市、身份)，判不出"其实是两回事"，
                        所以三条出路都给：以新为准 / 以另一条为准 / 都保留(不再提示) ── */}
                    {memoryConflicts.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <AlertCircle className="w-3 h-3 text-amber-500 shrink-0" />
                          <p className="text-[11px] font-medium text-content-primary">
                            发现 {memoryConflicts.length} 组相互矛盾的记忆
                          </p>
                        </div>
                        <p className="text-[11px] text-content-muted leading-relaxed">
                          AI 每轮只会看到其中一条（最新的那条）。选中要保留的，或都保留。
                        </p>
                        {memoryConflicts.map((group) => {
                          const members = group.ids
                            .map((id) => memories.find((m) => m.id === id))
                            .filter((m): m is MemoryInfo => !!m)
                          if (members.length < 2) return null
                          const key = group.ids.join('-')
                          const busy = memoryResolving === key
                          return (
                            <div
                              key={key}
                              className="rounded-lg border border-line/50 bg-surface-muted/40 p-2 space-y-1.5"
                            >
                              <p className="text-[10px] text-content-muted">{group.reason}</p>
                              {members.map((m) => (
                                <div key={m.id} className="flex items-start gap-2">
                                  <p
                                    className={cn(
                                      'flex-1 min-w-0 text-xs break-words leading-relaxed',
                                      m.id === group.winnerId
                                        ? 'text-content-primary'
                                        : 'text-content-secondary'
                                    )}
                                  >
                                    {m.content}
                                    {m.id === group.winnerId && (
                                      <span className="ml-1 text-[10px] text-content-muted">（最新）</span>
                                    )}
                                  </p>
                                  <button
                                    onClick={() => handleResolveConflict(group, m.id, 'supersede')}
                                    disabled={busy}
                                    className="shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium bg-surface-subtle/80 text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition-colors disabled:opacity-50"
                                  >
                                    以这条为准
                                  </button>
                                </div>
                              ))}
                              <div className="flex justify-end">
                                <button
                                  onClick={() => handleResolveConflict(group, null, 'keep-both')}
                                  disabled={busy}
                                  className="px-2 py-0.5 rounded-md text-[11px] text-content-muted hover:text-content-primary transition-colors disabled:opacity-50 flex items-center gap-1"
                                >
                                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                  都保留
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* ── 记忆列表(自然展开,由弹窗滚动区统一滚动,
                        内嵌 max-h 小滚动区会把最后一条裁半且形成双层滚动)────────── */}
                    {memories.length === 0 ? (
                      <p className="text-[11px] text-content-muted text-left py-1">
                        暂无记忆。聊天中告诉 AI 你的喜好，它会自动记下来。
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {memories.map((m) => (
                          <li
                            key={m.id}
                            className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-surface-muted/60 border border-line/40"
                          >
                            {memoryEditingId === m.id ? (
                              <div className="flex-1 min-w-0 space-y-1.5">
                                <textarea
                                  value={memoryEditDraft}
                                  onChange={(e) => setMemoryEditDraft(e.target.value)}
                                  rows={2}
                                  maxLength={200}
                                  autoFocus
                                  className={cn(
                                    'w-full text-xs rounded-md border border-line/60 bg-surface px-2 py-1.5',
                                    'text-content-primary placeholder:text-content-muted resize-none',
                                    'focus:outline-none focus:ring-2 focus:ring-line-strong/30 focus:border-line-strong'
                                  )}
                                />
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    onClick={cancelMemoryEdit}
                                    className="px-2 py-1 rounded-md text-[11px] text-content-muted hover:text-content-primary hover:bg-surface-subtle/80 transition-colors"
                                  >
                                    取消
                                  </button>
                                  <button
                                    onClick={() => handleSaveMemoryEdit(m.id)}
                                    disabled={!memoryEditDraft.trim() || memorySavingEdit}
                                    className={cn(
                                      'px-2.5 py-1 rounded-md text-[11px] font-medium transition-all flex items-center gap-1',
                                      memoryEditDraft.trim() && !memorySavingEdit
                                        ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
                                        : 'bg-surface-subtle/80 text-content-muted cursor-not-allowed'
                                    )}
                                  >
                                    {memorySavingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                    保存
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="flex-1 min-w-0 text-left">
                                  <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle/80 text-content-muted shrink-0">
                                      {MEMORY_CATEGORY_LABELS[m.category] ?? '其他'}
                                    </span>
                                    {m.source === 'manual' && (
                                      <span className="text-[10px] text-content-muted shrink-0">手动添加</span>
                                    )}
                                    {m.source === 'imported' && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 shrink-0">
                                        导入自 {m.sourceDetail || '其他 AI'}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-content-secondary break-words leading-relaxed">
                                    {m.content}
                                  </p>
                                </div>
                                <button
                                  onClick={() => startMemoryEdit(m)}
                                  className="shrink-0 p-1 rounded-md text-content-muted hover:text-accent hover:bg-surface-subtle/80 transition-colors"
                                  aria-label="编辑记忆"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleDeleteMemory(m.id)}
                                  disabled={memoryDeleting === m.id}
                                  className="shrink-0 p-1 rounded-md text-content-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                                  aria-label="删除记忆"
                                >
                                  {memoryDeleting === m.id ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* ── 已被取代的记忆：矛盾替换不物理删，留在这里供用户反悔 ── */}
                    {supersededMemories.length > 0 && (
                      <div className="pt-1">
                        <button
                          onClick={() => setSupersededOpen((v) => !v)}
                          className="w-full flex items-center gap-1.5 px-1 py-1 rounded-md text-[11px] text-content-muted hover:text-content-secondary transition-colors"
                        >
                          {supersededOpen ? (
                            <ChevronUp className="w-3 h-3 shrink-0" />
                          ) : (
                            <ChevronDown className="w-3 h-3 shrink-0" />
                          )}
                          已被新记忆取代（{supersededMemories.length}）
                        </button>
                        {supersededOpen && (
                          <ul className="space-y-1.5 mt-1.5">
                            {supersededMemories.map((m) => (
                              <li
                                key={m.id}
                                className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-surface-muted/40 border border-line/30"
                              >
                                <div className="flex-1 min-w-0 text-left">
                                  <p className="text-xs text-content-muted break-words leading-relaxed line-through decoration-line-strong/60">
                                    {m.content}
                                  </p>
                                  <p className="text-[10px] text-content-muted mt-0.5">
                                    不再提供给 AI
                                  </p>
                                </div>
                                <button
                                  onClick={() => handleRestoreMemory(m.id)}
                                  disabled={memoryDeleting === m.id}
                                  className="shrink-0 px-2 py-1 rounded-md text-[11px] text-content-secondary hover:text-content-primary hover:bg-surface-subtle/80 transition-colors flex items-center gap-1 disabled:opacity-50"
                                  aria-label="恢复这条记忆"
                                >
                                  {memoryDeleting === m.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <RotateCcw className="w-3 h-3" />
                                  )}
                                  恢复
                                </button>
                                <button
                                  onClick={() => handleDeleteMemory(m.id)}
                                  disabled={memoryDeleting === m.id}
                                  className="shrink-0 p-1 rounded-md text-content-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                                  aria-label="删除记忆"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* 澄清提问 */}
                {activeSection === 'clarify' && (
                  <div className="space-y-2.5">
                    <MSwitchRow
                      label="澄清提问"
                      help="信息不足时 AI 先以选项卡片向你确认，再正式回答"
                      checked={clarifyEnabled}
                      onChange={handleToggleClarify}
                    />
                    <p className="text-[11px] text-content-muted/80 text-left leading-relaxed">
                      关闭后 AI 直接回答，不再反问。事实、代码、翻译类问题始终直接回答，不会触发确认。
                    </p>
                  </div>
                )}

                {/* 本地文件(仅桌面端) */}
                {activeSection === 'localfiles' && (
                  <div className="space-y-2.5">
                    <MSwitchRow
                      label="允许 AI 操作本地文件"
                      help={
                        inTauri
                          ? '在你授权的工作区文件夹内，AI 可帮你生成/写入文件、删除文件（进回收站）'
                          : '该能力仅在桌面客户端可用'
                      }
                      checked={localFilesEnabled}
                      disabled={!inTauri}
                      onChange={handleToggleLocalFiles}
                    />

                    {inTauri ? (
                      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2">
                        <div className="text-left">
                          <p className="text-xs text-content-secondary">工作区文件夹</p>
                          <p className="text-[11px] text-content-muted">AI 只能在此文件夹内操作；删除会移入回收站，且每次都需你确认。</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <code
                            className="min-w-0 flex-1 truncate rounded-md border border-line/60 bg-surface-muted px-2 py-1 text-[11px] text-content-secondary"
                            title={workspaceDir ?? ''}
                          >
                            {workspaceDir || '尚未选择'}
                          </code>
                          <button
                            type="button"
                            onClick={handlePickWorkspace}
                            disabled={pickingDir}
                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line/60 px-2.5 py-1 text-[11px] text-content-secondary hover:bg-surface-subtle hover:text-content-primary disabled:opacity-40 transition-colors"
                          >
                            {pickingDir ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOpen className="w-3.5 h-3.5" />}
                            选择文件夹
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-[11px] text-content-muted/80 text-left leading-relaxed">
                        当前在浏览器中打开，无法访问本地磁盘。请下载并使用桌面客户端后，在此开启并授权工作区文件夹。
                      </p>
                    )}

                    {inTauri && localFilesEnabled && (
                      <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-3">
                        <div className="text-left min-w-0">
                          <p className="text-xs text-content-secondary">命令始终运行</p>
                          <p className="text-[11px] text-content-muted">
                            AI 执行 PowerShell 命令不再弹确认卡，包括写入、删除、联网命令。仅在完全信任工作区用途时开启。
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={localFilesExecAutoRun}
                          onClick={() => handleToggleExecAutoRun(!localFilesExecAutoRun)}
                          className={cn(
                            'relative w-9 h-5 rounded-full transition-colors shrink-0',
                            localFilesExecAutoRun ? 'bg-amber-500' : 'bg-surface-subtle'
                          )}
                        >
                          <span
                            className={cn(
                              'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white dark:bg-surface transition-transform',
                              localFilesExecAutoRun && 'translate-x-4'
                            )}
                          />
                        </button>
                      </div>
                    )}

                    <p className="text-[11px] text-content-muted/80 text-left leading-relaxed">
                      安全边界：AI 无法访问工作区以外的任何文件，系统目录一律拒绝；删除操作强制确认并走回收站（可还原）。
                    </p>
                  </div>
                )}

                {/* 通用 */}
                {activeSection === 'general' && (
                  <div className="space-y-2.5">
                    {/* Style Settings */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
                    <div className="text-left">
                      <p className="text-xs text-content-secondary">AI 风格</p>
                      <p className="text-[11px] text-content-muted max-md:hidden">选择 AI 回答的语气与详略风格</p>
                    </div>
                    <StylePicker
                      value={conversationStylePreset}
                      onChange={(preset) => {
                        // 立即更新 store + localStorage(轻量、即时)
                        setConversationStylePreset(preset)
                        localStorage.setItem(STYLE_OFFSET_STORAGE_KEY, preset)
                      }}
                      onCommit={persistStylePreset}
                      label="对话风格"
                      className="mt-2.5 hidden md:flex"
                    />
                    {/* 移动端:11 个风格 chip 在 390px 下会挤成三行小胶囊,改成摘要行 + 第三层单选 */}
                    <MSegRow
                      label="对话风格"
                      help="选 AI 回答的语气与详略;选中即写入当前会话"
                      options={STYLE_PRESETS.map((p) => ({ value: p.id, label: p.label, hint: p.tagline }))}
                      value={(conversationStylePreset as string) || 'balanced'}
                      onChange={(v) => {
                        setConversationStylePreset(v)
                        localStorage.setItem(STYLE_OFFSET_STORAGE_KEY, v)
                        persistStylePreset(v)
                      }}
                      className="md:hidden"
                    />
                    </div>

                    {/* 回复长度:篇幅独立于语气可调,长度段在服务端覆盖风格段的详略描述 */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
                    <div className="text-left">
                      <p className="text-xs text-content-secondary">AI 篇幅</p>
                      <p className="text-[11px] text-content-muted max-md:hidden">只规定篇幅，不改变语气与内容准确性</p>
                    </div>
                    <ReplyLengthSlider
                      value={conversationReplyLength}
                      onChange={(level) => {
                        // 立即更新 store + localStorage(轻量、即时)
                        setConversationReplyLength(level)
                        localStorage.setItem(REPLY_LENGTH_STORAGE_KEY, level)
                      }}
                      onCommit={persistReplyLength}
                      label="回复长度"
                      className="mt-2.5 hidden md:flex"
                    />
                    {/* 移动端:四档滑杆的停靠点在 390px 上过密,与对话风格同款改摘要行 + 第三层单选 */}
                    <MSegRow
                      label="回复长度"
                      help="只规定篇幅;选中即写入当前会话"
                      options={REPLY_LENGTH_LEVELS.map((l) => ({ value: l.id, label: l.label, hint: l.tagline }))}
                      value={(conversationReplyLength as string) || 'standard'}
                      onChange={(v) => {
                        setConversationReplyLength(v)
                        localStorage.setItem(REPLY_LENGTH_STORAGE_KEY, v)
                        persistReplyLength(v)
                      }}
                      className="md:hidden"
                    />
                    </div>

                    {/* 外观是一维的: 上面那排「主题」四选一(浅色/深色/跟随系统/格子),
                        下面那排随主题切换 —— 非格子时选配色,格子时选日出/白天/暮色/晚上。
                        明暗走 html.dark,配色走 html[data-pal],格子的光态走
                        html[data-grid-tone]。注意四个光态里**只有晚上是深底**,
                        它也是格子下唯一会写 .dark 的态(下游组件靠 .dark 判明暗) */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
                    <div className="text-left">
                      <p className="text-xs text-content-secondary">外观</p>
                      <p className="text-[11px] text-content-muted max-md:hidden">
                        {themeChoice === 'grid'
                          ? '格子四个光态：日出 / 白天(正午) / 暮色(日落) / 晚上(深夜)'
                          : '月白·桂花金仅深色可用'}
                      </p>
                    </div>
                    <MSegRow
                      label="主题"
                      help="「格子」仅在深色基线上另有四个光态"
                      options={THEME_CHOICES}
                      value={themeChoice}
                      onChange={handleChoiceChange}
                      className="mt-2.5"
                    />
                    {themeChoice === 'grid' ? (
                      /* 主题 = 格子: 下面这排选格子的光态(日出 / 白天 / 暮色 / 晚上)。
                         晚上会顺带切到 .dark —— 它是格子下唯一的深底态。
                         上面那行开关决定这排是"手选"还是"按时间自动":自动时
                         这排仍可点(点了即改回手动),高亮段跟着时间走 */
                      <>
                      <div className="mt-2.5 hidden items-center gap-2 md:flex">
                        <span className="text-[11px] text-content-muted">按时间自动</span>
                        {/* 卡片内开关:span 避免 button 嵌套 */}
                        <span
                          role="switch"
                          aria-checked={gridToneAuto}
                          aria-label="按时间自动选择光态"
                          onClick={() => handleAutoToneToggle(!gridToneAuto)}
                          className={cn(
                            'relative w-8 h-[18px] rounded-full transition-colors shrink-0 ml-auto cursor-pointer',
                            gridToneAuto ? 'bg-accent' : 'bg-surface-subtle'
                          )}
                        >
                          <span
                            className={cn(
                              'absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white dark:bg-surface transition-transform',
                              gridToneAuto && 'translate-x-[14px]'
                            )}
                          />
                        </span>
                      </div>
                      <MSwitchRow
                        label="按时间自动"
                        help="按本地时间在你进入格子前就选好光态"
                        checked={gridToneAuto}
                        onChange={handleAutoToneToggle}
                        className="md:hidden"
                      />
                      <MSegRow
                        label="格子光态"
                        help="四个光态里只有「晚上」是深底;手点任一段即从自动改回手动"
                        options={GRID_TONES}
                        value={gridTone}
                        onChange={handleGridToneChange}
                        className="mt-2"
                      />
                      {gridToneAuto ? (
                        <p className="mt-1.5 text-[11px] text-content-muted">
                          自动 · {GRID_TONES.find((t) => t.value === gridTone)?.label}（点任一时段即改回手动）
                        </p>
                      ) : null}
                      </>
                    ) : (
                      /* 主题 ≠ 格子: 下面这排选配色。每套配色一个色点 + 名称;
                         月白·桂花金仅深色,选中会自动切到深色。
                         两套起步,故用两列网格换行,避免 flex 等分把名称挤断 */
                      <>
                      <div className="mt-2.5 hidden grid-cols-2 gap-2 md:grid">
                        {PALETTES.map((p) => (
                          <button
                            key={p.value}
                            onClick={() => handlePaletteChange(p.value)}
                            aria-pressed={paletteChoice === p.value}
                            className={cn(
                              'flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors',
                              paletteChoice === p.value
                                ? 'border-accent bg-accent-soft/60'
                                : 'border-line/60 hover:bg-surface-muted'
                            )}
                          >
                            <span
                              aria-hidden
                              className="h-3.5 w-3.5 shrink-0 rounded-full border border-line/70"
                              style={{ background: p.swatch }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium text-content-primary">
                                {p.label}
                              </span>
                              <span className="block text-[10px] text-content-muted">{p.hint}</span>
                            </span>
                            {paletteChoice === p.value && (
                              <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                            )}
                          </button>
                        ))}
                      </div>
                      <MPickerRow
                        label="配色"
                        help="每套配色一个色点;月白·桂花金仅深色可用,选中会自动切到深色"
                        options={PALETTES}
                        value={paletteChoice}
                        onPick={handlePaletteChange}
                        className="mt-2.5"
                      />
                      </>
                    )}
                    </div>

                    {/* 背景:关 / 内置壁纸(欢迎页) / 桌面毛玻璃(透出软件外部,仅桌面端) */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0 text-left">
                          {/* 缩略图:一眼看出「壁纸」选项对应哪张图 */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src="/wallpaper/bizhi.jpg"
                            alt=""
                            className="w-9 h-9 rounded-lg object-cover border border-line/60 shrink-0"
                            loading="lazy"
                          />
                          <div className="min-w-0">
                            <p className="text-xs text-content-secondary">背景</p>
                            <p className="text-[11px] text-content-muted max-md:hidden">
                              {backdropMode === 'image'
                                ? '新对话欢迎页显示内置壁纸'
                                : '纯色界面;壁纸仅新对话欢迎页生效'}
                            </p>
                          </div>
                        </div>
                      </div>
                      <MSegRow
                        label="背景"
                        help="壁纸只在新对话欢迎页出现;关闭则为纯色界面"
                        options={BACKDROP_CHOICES}
                        value={backdropMode}
                        onChange={setBackdropMode}
                        className="mt-2"
                      />
                    </div>

                    {/* 聊天行为:开关组(卡内两行,行间细线分隔) */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-1">
                    <MSwitchRow
                      label="思考完毕自动折叠"
                      help="深度思考输出完后自动收起思考框,点击标题可重新展开"
                      checked={autoCollapseReasoning}
                      onChange={setAutoCollapseReasoning}
                    />

                    {/* 通知类:桌面=失焦时完成即通知;手机壳另有一条预约式提醒。
                        按 inShell 露出而不是 inTauri —— 安卓壳同样有通知能力,
                        用桌面专属口径会把手机端这两项整个藏掉。 */}
                    {inShell && (
                    <>
                    <MSwitchRow
                      label="回复完成通知"
                      help="窗口失焦时,AI 回复完成弹系统通知提醒"
                      checked={notifyOnReply}
                      onChange={handleToggleNotify}
                      className="border-t border-line/60"
                    />
                    <MSegRow
                      label="离开后提醒我回来看"
                      help="发消息后过这么久催一次。手机切后台会暂停生成,回来才有结果,所以是「催回来看」而不是「已完成」"
                      options={REMINDER_DELAY_CHOICES}
                      value={reminderDelay}
                      onChange={handleChangeReminderDelay}
                      className="border-t border-line/60"
                    />
                    </>
                    )}

                    {/* AI 设置控制总开关:刻意不在 AI 可控注册表内,AI 无法修改此项;临时模式不渲染(依赖被 403 的 /api/settings/ai-control) */}
                    {!isEphemeral && (
                    <>
                    <MSwitchRow
                      label="AI 设置控制"
                      help="开启后可在对话中让 AI 直接修改主题、侧边栏等设置"
                      checked={aiControlEnabled}
                      onChange={handleToggleAiControl}
                      className="border-t border-line/60"
                    />
                      <p className="text-[11px] text-content-muted/80 text-left leading-relaxed pb-2.5">
                        此开关仅能在此手动更改，AI 无法操作。关闭后 AI 会如实告知功能已关闭，不会尝试修改设置。
                      </p>
                    </>
                    )}
                    </div>
                  </div>
                )}

                {/* 临时会话管理(仅临时模式可达):状态卡 + 清空 + 退出 */}
                {activeSection === 'session' && isEphemeral && (
                  <div className="space-y-2.5">
                    {/* 会话状态卡 */}
                    <div className="rounded-xl border border-accent/20 bg-gradient-to-br from-accent/10 via-accent/5 to-transparent px-4 py-3.5 text-left">
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-lg bg-accent/20 flex items-center justify-center shrink-0">
                          <Timer className="w-5 h-5 text-accent" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-content-primary">临时会话进行中</p>
                          <p className="text-[11px] text-content-muted mt-0.5">
                            {sessionRemaining ? `${sessionRemaining}后自动失效` : '剩余时间计算中…'}
                          </p>
                        </div>
                      </div>
                      <p className="text-[11px] text-content-muted/80 mt-2.5 leading-relaxed">
                        本会话产生的对话与账号主人的正常历史完全隔离，不会写入记忆系统。会话结束后记录保留在隔离区，仅账号主人可查看或清除。
                      </p>
                    </div>

                    {/* 清空本次临时对话(两段式确认,防误触) */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 flex items-center justify-between gap-3">
                      <div className="text-left min-w-0">
                        <p className="text-xs text-content-secondary">清空本次临时对话</p>
                        <p className="text-[11px] text-content-muted">
                          立即删除本会话产生的全部{ephCount == null ? '' : ` ${ephCount} `}条对话（不可恢复）
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirmClear) {
                            handleClearEphemeral()
                          } else {
                            setConfirmClear(true)
                            setTimeout(() => setConfirmClear(false), 3000)
                          }
                        }}
                        disabled={clearing || !ephCount}
                        className={cn(
                          'shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors',
                          confirmClear
                            ? 'bg-red-500 text-white'
                            : 'text-red-500/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30',
                          (clearing || !ephCount) && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        {clearing ? '清空中…' : confirmClear ? '确认清空' : '清空'}
                      </button>
                    </div>

                    {/* 结束临时会话 */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 flex items-center justify-between gap-3">
                      <div className="text-left min-w-0">
                        <p className="text-xs text-content-secondary">结束临时会话</p>
                        <p className="text-[11px] text-content-muted max-md:hidden">退出登录并返回临时聊天登录页</p>
                      </div>
                      <button
                        type="button"
                        onClick={handleEphemeralSignOut}
                        className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-red-500/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        退出
                      </button>
                    </div>
                  </div>
                )}

                {/* 帮助 */}
                {activeSection === 'help' && (
                  <div className="space-y-2.5">
                    <p className="text-xs text-content-secondary text-left leading-relaxed">
                      在下方服务商官网注册并创建 API Key，然后粘贴到「服务商」分类中即可开始使用。
                    </p>
                    <div className="rounded-xl border border-line/60 bg-surface/60 p-3.5">
                      <ul className="text-[11px] space-y-1.5">
                        {providers.map((provider) => {
                          const url = PROVIDER_URL[provider.id]
                          if (!url) return null
                          return (
                            <li key={provider.id} className="flex items-center gap-2">
                              <span className="text-content-secondary shrink-0 min-w-[5rem]">{provider.name}</span>
                              <a href={url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-content-primary hover:underline">
                                {url.replace('https://', '')}
                              </a>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  </div>
                )}

                {/* 手机客户端:仅浏览器 web 出现(桌面壳/安卓壳被 navItemVisible 藏掉) */}
                {activeSection === 'mobileapp' && (
                  <div className="space-y-2.5">
                    <p className="text-xs text-content-secondary text-left leading-relaxed">
                      安卓客户端把本站打包成 App,界面、账号与会话数据与网页完全一致。
                    </p>

                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-content-primary">
                          <Smartphone className="w-4 h-4" />
                        </span>
                        <div className="min-w-0 flex-1 text-left">
                          <p className="truncate text-xs font-medium text-content-primary">aichatt · Android</p>
                          <p className="truncate text-[11px] text-content-muted">
                            {apkManifest?.version
                              ? `v${apkManifest.version}${apkManifest.size ? ` · ${(apkManifest.size / 1048576).toFixed(0)} MB` : ''}`
                              : apkLoading
                                ? '正在获取版本信息…'
                                : '暂未取到版本信息'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={loadApkManifest}
                          disabled={apkLoading}
                          aria-label="刷新版本信息"
                          className="shrink-0 rounded-md p-1.5 text-content-muted hover:text-content-primary hover:bg-surface-subtle/60 transition-colors disabled:opacity-40"
                        >
                          <RefreshCw className={cn('w-3.5 h-3.5', apkLoading && 'animate-spin')} />
                        </button>
                      </div>

                      {apkManifest?.url ? (
                        <a
                          href={apkManifest.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          download
                          className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium bg-accent text-accent-foreground hover:bg-accent-hover active:scale-[0.98] transition-colors"
                        >
                          <Download className="w-4 h-4" />
                          下载 APK
                        </a>
                      ) : (
                        <p className="text-[11px] text-content-muted text-left leading-relaxed">
                          没取到安装包清单(/apk/latest.json),可能发布尚未完成。点右侧刷新按钮重试。
                        </p>
                      )}
                    </div>

                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 text-left">
                      <p className="text-xs text-content-secondary">安装步骤</p>
                      <ol className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-content-muted">
                        <li>1. 建议直接用手机浏览器打开本页下载,省掉传文件这一步。</li>
                        <li>2. 下载完点开安装包;首次会要求允许「安装未知应用」,在弹窗里授予即可。</li>
                        <li>3. 覆盖安装保留登录态与本地设置,无需先卸载旧版。</li>
                        <li>4. 装上后 App 会自己检查新版本,更新不必再回这里下载。</li>
                      </ol>
                    </div>

                    <p className="text-[11px] text-content-muted/80 text-left leading-relaxed">
                      iOS 暂无客户端安装包,可用 Safari 的「添加到主屏幕」获得近似体验。
                    </p>
                  </div>
                )}

                {/* 关于 */}
                {activeSection === 'about' && (
                  <div className="space-y-2.5">
                    {/* App identity */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-4 flex flex-col items-center gap-2">
                      <div className="w-12 h-12 rounded-xl bg-accent flex items-center justify-center">
                        <MessageSquare className="w-6 h-6 text-accent-foreground" />
                      </div>
                      <p className="text-sm font-semibold text-content-primary">aichatt</p>
                      <p className="text-[11px] text-content-muted">AI 多模型对话助手 · v0.1.0</p>
                    </div>

                    {/* Info rows */}
                    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-2.5 divide-y divide-line/40">
                      <div className="flex items-center justify-between gap-3 py-2">
                        <span className="text-xs text-content-secondary shrink-0">版本</span>
                        <span className="text-xs text-content-primary text-right">0.1.0</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 py-2">
                        <span className="text-xs text-content-secondary shrink-0">技术栈</span>
                        <span className="text-xs text-content-primary text-right">Next.js · Prisma · NextAuth</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 py-2">
                        <span className="text-xs text-content-secondary shrink-0">数据存储</span>
                        <span className="text-xs text-content-primary text-right">本地 SQLite / Turso</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 py-2">
                        <span className="text-xs text-content-secondary shrink-0">部署平台</span>
                        <span className="text-xs text-content-primary text-right">Vercel</span>
                      </div>
                    </div>

                    {/* GitHub */}
                    <a
                      href="https://github.com/molinglong"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-line/60 bg-surface/60 text-xs text-content-primary hover:border-line-strong transition-colors"
                    >
                      <GitBranch className="w-4 h-4 text-content-muted shrink-0" />
                      GitHub · molinglong
                      <ExternalLink className="w-3 h-3 text-content-muted ml-auto shrink-0" />
                    </a>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer status bar —— 位于内容列底部(顶部分隔线已移除);手机端无实体 ESC 键,整条隐藏 */}
          <div className="shrink-0 px-4 py-2 items-center gap-2 bg-surface hidden md:flex">
            <kbd className="ml-auto text-[10px] text-content-muted px-1.5 py-0.5 rounded border border-line bg-surface-muted font-mono">ESC</kbd>
          </div>
          </div>
        </div>

          {/* 第三层:移动端推入式单选页(仅有 spec 时挂,盖满整张卡片) */}
          {mobilePicker && (
            <MobilePickerPage spec={mobilePicker} back={mobilePicker.back} shown={pickerShown} onClose={closeMobilePicker} />
          )}
        </MobilePickerCtx.Provider>
      </div>
    </div>
  )
}

// ============================================================================
// PresetModelsManager：管理 ProviderModelOverride 表
// ============================================================================

interface PresetModelsManagerProps {
  providers: ProviderInfo[]
  overrides: import('@/hooks/useProviderModels').ProviderModelOverrideRow[]
  loading: boolean
  error: string | null
  pendingId: string | null
  testingId: string | null
  formOpen: boolean
  form: ProviderModelOverrideForm
  expandedProviders: Set<string>
  onToggleProvider: (providerId: string) => void
  onOpenAddForm: (providerId: string) => void
  onCloseForm: () => void
  onFormChange: (form: ProviderModelOverrideForm) => void
  onSave: () => Promise<void>
  onTest: () => Promise<void>
  onHide: (provider: string, modelId: string, name: string) => Promise<void>
  onUnhide: (provider: string, modelId: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

function PresetModelsManager({
  providers,
  overrides,
  loading,
  error,
  pendingId,
  testingId,
  formOpen,
  form,
  expandedProviders,
  onToggleProvider,
  onOpenAddForm,
  onCloseForm,
  onFormChange,
  onSave,
  onTest,
  onHide,
  onUnhide,
  onDelete,
}: PresetModelsManagerProps) {
  // 工具：查某个 provider 下的隐藏行 + 用户新增行
  const getOverridesForProvider = (providerId: string) =>
    overrides.filter((o) => o.provider === providerId)

  return (
    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Settings2 className="w-3.5 h-3.5 text-content-secondary" />
          <p className="text-[11px] font-medium text-content-secondary">预置模型管理</p>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle/80 text-content-muted font-mono">
            {overrides.length}
          </span>
        </div>
        {loading && <Loader2 className="w-3 h-3 animate-spin text-content-muted" />}
      </div>

      {error && (
        <p className="text-[11px] text-red-500 px-0.5">⚠️ {error}</p>
      )}

      <p className="text-[11px] text-content-muted leading-relaxed max-md:hidden">
        在每个内置厂商下，可以隐藏不需要的预置模型，或添加自定义的模型 ID（自动复用该厂商的 API Key）。
      </p>

      <div className="space-y-1.5">
        {providers.map((p) => {
          const isExpanded = expandedProviders.has(p.id)
          const provOverrides = getOverridesForProvider(p.id)
          const hiddenModelIds = new Set(provOverrides.filter((o) => o.isHidden).map((o) => o.modelId))
          const userAdded = provOverrides.filter((o) => !o.isHidden)
          const visibleBuiltinCount = p.models.filter((mid) => !hiddenModelIds.has(mid)).length

          return (
            <div key={p.id} className="rounded-lg border border-line/40 bg-surface/40 overflow-hidden">
              <div
                role="button"
                tabIndex={0}
                onClick={() => onToggleProvider(p.id)}
                onKeyDown={(e) => e.key === 'Enter' && onToggleProvider(p.id)}
                className="w-full flex items-center justify-between px-2.5 py-2 hover:bg-surface-subtle/40 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <ChevronDown
                    className={cn(
                      'w-3 h-3 text-content-muted shrink-0 transition-transform',
                      !isExpanded && '-rotate-90'
                    )}
                  />
                  <span className="text-xs font-medium text-content-primary truncate">{p.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle/80 text-content-muted font-mono shrink-0">
                    {visibleBuiltinCount}/{p.models.length}
                  </span>
                  {userAdded.length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent font-mono shrink-0">
                      +{userAdded.length}
                    </span>
                  )}
                </div>
                {isExpanded && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenAddForm(p.id)
                    }}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors shrink-0"
                  >
                    <Plus className="w-2.5 h-2.5" />
                    添加模型
                  </button>
                )}
              </div>

              {isExpanded && (
                <div className="border-t border-line/40 px-2.5 py-2 space-y-1.5 bg-surface/30">
                  {/* 内置预置模型 */}
                  <ul className="space-y-1">
                    {p.models.map((modelId) => {
                      const isHidden = hiddenModelIds.has(modelId)
                      const builtinName = modelId // 简化为 id 显示（已有原始模型对象但这里不传）
                      const isPending = pendingId !== null
                      return (
                        <li
                          key={modelId}
                          className={cn(
                            'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors',
                            isHidden
                              ? 'bg-surface-subtle/30 text-content-muted line-through'
                              : 'bg-surface/60 text-content-primary'
                          )}
                        >
                          <span
                            className={cn(
                              'w-1.5 h-1.5 rounded-full shrink-0',
                              isHidden ? 'bg-content-muted/40' : 'bg-emerald-500'
                            )}
                          />
                          <span className="font-mono truncate flex-1">{modelId}</span>
                          {isHidden ? (
                            <button
                              onClick={() => onUnhide(p.id, modelId, builtinName)}
                              disabled={isPending}
                              className="px-1.5 py-0.5 rounded text-[10px] bg-accent/15 text-accent hover:bg-accent/25 transition-colors shrink-0"
                            >
                              恢复
                            </button>
                          ) : (
                            <button
                              onClick={() => onHide(p.id, modelId, builtinName)}
                              disabled={isPending}
                              className="px-1.5 py-0.5 rounded text-[10px] bg-surface-muted text-content-muted hover:text-content-primary transition-colors shrink-0"
                            >
                              隐藏
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>

                  {/* 用户添加的模型 */}
                  {userAdded.length > 0 && (
                    <div className="pt-1 mt-1 border-t border-line/30">
                      <p className="text-[10px] font-medium text-content-muted px-1 mb-1">用户添加</p>
                      <ul className="space-y-1">
                        {userAdded.map((o) => (
                          <li
                            key={o.id}
                            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-accent/5 border border-accent/20 text-[11px]"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                            <span className="font-medium truncate">{o.name}</span>
                            <span className="text-content-muted font-mono truncate flex-1">{o.modelId}</span>
                            {o.supportsVision && <span className="text-[9px] px-1 rounded bg-blue-500/15 text-blue-600">视觉</span>}
                            {o.supportsReasoning && <span className="text-[9px] px-1 rounded bg-purple-500/15 text-purple-600">推理</span>}
                            <button
                              onClick={() => onDelete(o.id)}
                              disabled={pendingId === o.id}
                              className="px-1.5 py-0.5 rounded text-[10px] text-red-500/70 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors shrink-0"
                            >
                              {pendingId === o.id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Trash2 className="w-2.5 h-2.5" />}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* 添加表单：仅在当前 provider 触发时显示 */}
                  {formOpen && form.provider === p.id && (
                    <div className="mt-2 p-2.5 rounded-lg border border-accent/30 bg-accent/5 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                      <p className="text-[11px] font-medium text-accent">添加模型到 {p.name}</p>
                      <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                        <input
                          type="text"
                          value={form.modelId}
                          onChange={(e) => {
                            const newModelId = e.target.value
                            // 智能选择：根据 modelId 关键词自动检测能力
                            // （检测规则与 AI 确认卡片共用 model-capabilities，避免两处漂移）
                            const detected = detectModelCapabilities(newModelId)
                            onFormChange({
                              ...form,
                              modelId: newModelId,
                              supportsVision: form.supportsVision || detected.supportsVision,
                              supportsReasoning: form.supportsReasoning || detected.supportsReasoning,
                              supportsFiles: form.supportsFiles || detected.supportsFiles,
                            })
                          }}
                          placeholder="模型 ID（如 gpt-5）"
                          className="rounded-md border border-line/60 bg-surface px-2 py-1 text-[11px] font-mono text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
                        />
                        <input
                          type="text"
                          value={form.name}
                          onChange={(e) => onFormChange({ ...form, name: e.target.value })}
                          placeholder="显示名（如 GPT-5）"
                          className="rounded-md border border-line/60 bg-surface px-2 py-1 text-[11px] text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-content-muted shrink-0">上下文</span>
                        <input
                          type="number"
                          value={form.contextWindow}
                          onChange={(e) => onFormChange({ ...form, contextWindow: Number(e.target.value) })}
                          className="w-20 rounded-md border border-line/60 bg-surface px-2 py-0.5 text-[11px] text-content-primary focus:outline-none focus:ring-2 focus:ring-accent/30"
                        />
                        <label className="flex items-center gap-1 text-[10px] text-content-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.supportsVision}
                            onChange={(e) => onFormChange({ ...form, supportsVision: e.target.checked })}
                            className="accent-accent"
                          />
                          视觉
                        </label>
                        <label className="flex items-center gap-1 text-[10px] text-content-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.supportsReasoning}
                            onChange={(e) => onFormChange({ ...form, supportsReasoning: e.target.checked })}
                            className="accent-accent"
                          />
                          推理
                        </label>
                        <label className="flex items-center gap-1 text-[10px] text-content-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.supportsFiles}
                            onChange={(e) => onFormChange({ ...form, supportsFiles: e.target.checked })}
                            className="accent-accent"
                          />
                          文件
                        </label>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={onTest}
                          disabled={testingId !== null || !form.modelId || !form.name}
                          className="px-2 py-1 rounded-md text-[10px] font-medium bg-surface-muted text-content-secondary hover:bg-surface-subtle hover:text-content-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                          title="测试模型连通性"
                        >
                          {testingId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                          测试
                        </button>
                        <button
                          onClick={onSave}
                          disabled={pendingId !== null || !form.modelId || !form.name}
                          className="px-2 py-1 rounded-md text-[10px] font-medium bg-accent text-accent-foreground hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {pendingId ? <Loader2 className="w-3 h-3 animate-spin inline" /> : '保存'}
                        </button>
                        <button
                          onClick={onCloseForm}
                          className="px-2 py-1 rounded-md text-[10px] font-medium bg-surface-muted text-content-secondary hover:bg-surface-subtle transition-colors"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============ API 令牌(外部凭证:本地静态页 + ACode 网关/MCP) ============
// 供新标签页(bento)等本地静态页以 Authorization: Bearer 调用待办/快问等 REST API;
// 同一枚令牌也是 ACode 的 aichatt 身份凭证:x-api-key 携带后可调用
// /api/v1/models(拉模型清单)、/api/v1/messages(模型网关)、/api/v1/mcp(记忆读写)。
// 明文仅创建响应中返回一次,库中只存哈希;撤销为软删除(保留审计)。

interface ApiTokenRow {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

function ApiTokensSection() {
  const [tokens, setTokens] = useState<ApiTokenRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tokens')
      if (!res.ok) throw new Error('load failed')
      const data = await res.json()
      setTokens(data.tokens ?? [])
    } catch {
      toast.error('令牌列表加载失败')
      setTokens([])
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const createToken = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '新标签页' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : '生成失败')
      setPlaintext(data.token as string)
      setCopied(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  const revokeToken = async (id: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/tokens?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(typeof d.error === 'string' ? d.error : '撤销失败')
      }
      toast.success('令牌已撤销')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '撤销失败')
    } finally {
      setBusy(false)
    }
  }

  const copyPlaintext = async () => {
    if (!plaintext) return
    try {
      await navigator.clipboard.writeText(plaintext)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时静默,用户可手动选中复制
    }
  }

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  return (
    <div className="space-y-3 text-left">
      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-content-secondary">API 令牌</p>
            <p className="text-[11px] text-content-muted max-md:hidden">供新标签页等本地静态页以 Bearer Token 调用待办/快问 API,无需浏览器登录态</p>
          </div>
          <button
            type="button"
            onClick={createToken}
            disabled={busy}
            className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-foreground disabled:opacity-50 shrink-0"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
            生成令牌
          </button>
        </div>

        {/* 明文一次性展示卡 */}
        {plaintext && (
          <div className="rounded-lg border border-accent/40 bg-accent/5 px-2.5 py-2.5 space-y-2">
            <p className="text-[11px] text-content-secondary font-medium">令牌已生成 — 仅此一次显示,请立即复制保存</p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 min-w-0 truncate text-[11px] font-mono bg-surface-muted/70 rounded px-2 py-1.5 text-content-secondary">{plaintext}</code>
              <button
                type="button"
                onClick={copyPlaintext}
                title="复制"
                className="p-1.5 rounded-md hover:bg-surface-muted/70 text-content-secondary shrink-0"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-accent" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPlaintext(null)}
              className="text-[11px] text-content-muted hover:text-content-secondary"
            >
              我已保存,关闭
            </button>
          </div>
        )}

        {/* 令牌列表 */}
        <div className="space-y-1.5">
          {tokens === null ? (
            <p className="text-[11px] text-content-muted py-1">加载中…</p>
          ) : tokens.length === 0 ? (
            <p className="text-[11px] text-content-muted py-1">还没有令牌,点击上方「生成令牌」创建</p>
          ) : (
            tokens.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-muted/50 px-2.5 py-2">
                <div className="min-w-0">
                  <p className="text-xs text-content-secondary truncate">
                    {t.name}
                    <span className={cn('ml-2 text-[11px]', t.revokedAt ? 'text-content-muted line-through' : 'text-accent')}>
                      {t.revokedAt ? '已撤销' : '有效'}
                    </span>
                  </p>
                  <p className="text-[11px] text-content-muted">
                    创建 {fmtDate(t.createdAt)}
                    {t.lastUsedAt ? ` · 最近使用 ${fmtDate(t.lastUsedAt)}` : ''}
                  </p>
                </div>
                {!t.revokedAt && (
                  <button
                    type="button"
                    onClick={() => revokeToken(t.id)}
                    disabled={busy}
                    title="撤销令牌(外部页将立即失效)"
                    className="p-1.5 rounded-md hover:bg-surface-muted/70 text-content-muted hover:text-red-500 disabled:opacity-50 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
