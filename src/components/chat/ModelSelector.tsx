'use client'

import { useState, useRef, useEffect, useLayoutEffect, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import {
  Search,
  ChevronDown,
  Star,
  Clock,
  Layers,
  Check,
  Zap,
  Eye,
  CornerDownLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSingleFlight } from '@/hooks/useSingleFlight'
import { useChatStore } from '@/store/chat-store'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { ModelQuickSheet } from './ModelQuickSheet'
import type { ModelDefinition } from '@/lib/ai/types'
import { PROVIDER_DOT, PROVIDER_NAMES } from '@/lib/ai/provider-meta'

export { PROVIDER_DOT, PROVIDER_NAMES }

// 厂商色 hex:命令面板的字母 tile 用 color-mix 调底色,PROVIDER_DOT 的 tailwind 类表达不了
const PROVIDER_COLOR: Record<string, string> = {
  openai: '#10b981',
  anthropic: '#f97316',
  deepseek: '#3b82f6',
  qianwen: '#a855f7',
  wenxin: '#ef4444',
  google: '#0ea5e9',
  mistral: '#f59e0b',
  xai: '#475569',
  groq: '#8b5cf6',
  moonshot: '#6366f1',
  zhipu: '#06b6d4',
  doubao: '#14b8a6',
  custom: '#9ca3af',
}

function formatContext(n: number): string {
  if (n >= 1000000) return '1M'
  return Math.round(n / 1000) + 'K'
}

interface ModelSelectorProps {
  models: ModelDefinition[]
  selectedModel: string
  onModelChange: (modelId: string) => void
  className?: string
  compact?: boolean
  /** 触发按钮追加样式:学习模式讲题模型行需要与旁边的胶囊按钮同款描边 */
  triggerClassName?: string
}

export function ModelSelector({
  models,
  selectedModel,
  onModelChange,
  className,
  compact = false,
  triggerClassName,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  // 方案 C 手机端:≤md 走 iOS 半屏快切(替代桌面 portal 下拉);服务端首帧 false → 桌面下拉
  const isMobile = useIsMobileViewport()
  const [configuredProviders, setConfiguredProviders] = useState<Set<string>>(new Set())
  const [mounted, setMounted] = useState(false)
  // 用 ref 存位置 —— 每次更新不需要重新渲染
  const dropdownPositionRef = useRef({ top: 0, left: 0 })
  // visible 控制 opacity 动画:false=0, true=1
  const [dropdownVisible, setDropdownVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // 「显示旧版」:默认只列出 tier=mainstream 的模型,legacy 需手动展开。
  // 搜索时视为显式意图,自动纳入旧版(否则搜不到曾经用过的旧模型会很困惑)。
  const [showLegacy, setShowLegacy] = useState(false)
  // 键盘导航:↑↓ 在扁平化后的可见行上移动,↵ 选中,Esc 关闭
  const [activeIndex, setActiveIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const dropdownMenuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // ⭐ / 🕐 store 状态(收藏 + 最近持久化在 store + localStorage)
  const favoriteModels = useChatStore((s) => s.favoriteModels)
  const recentModels = useChatStore((s) => s.recentModels)
  const toggleFavoriteModel = useChatStore((s) => s.toggleFavoriteModel)
  const recordModelUsage = useChatStore((s) => s.recordModelUsage)
  const modelSpecialSectionsCollapsed = useChatStore((s) => s.modelSpecialSectionsCollapsed)
  const toggleModelSpecialSection = useChatStore((s) => s.toggleModelSpecialSection)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    // 已配置 Key 的 provider 名单。用 /api/providers/keys-status 而非 /api/keys:
    // 后者返回掩码密钥，临时聊天模式下被 middleware 整体 403，会导致模型列表全空
    fetch('/api/providers/keys-status')
      .then((r) => r.json())
      .then((keys: { provider: string }[]) => {
        setConfiguredProviders(new Set(keys.map((k) => k.provider)))
      })
      .catch(() => {})
  }, [isOpen])

  // 更新下拉菜单位置 —— 用 ref 存,不影响渲染
  useLayoutEffect(() => {
    if (!isOpen || !buttonRef.current) return
    const updatePosition = () => {
      const rect = buttonRef.current!.getBoundingClientRect()
      const dropdownWidth = 352
      const gap = 4
      const margin = 8

      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      // 水平位置:与按钮左缘对齐,边界时贴边
      let left = rect.left
      if (left + dropdownWidth + margin > viewportWidth) {
        left = Math.max(margin, viewportWidth - dropdownWidth - margin)
      }

      // 垂直位置:总是先尝试按钮下方,实测菜单高度后再决定是否翻转
      const desiredTop = rect.bottom + gap
      const actualHeight = dropdownMenuRef.current?.offsetHeight ?? 200
      if (desiredTop + actualHeight + margin > viewportHeight) {
        const topUp = rect.top - actualHeight - gap
        if (topUp >= margin) {
          dropdownPositionRef.current = { top: topUp, left }
          return
        }
      }
      dropdownPositionRef.current = { top: desiredTop, left }
    }
    updatePosition()
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [isOpen, compact])

  // 打开/关闭动画状态机
  useEffect(() => {
    if (isOpen) {
      // 命令面板惯例:每次打开都是干净的过滤状态
      setSearchQuery('')
      setActiveIndex(0)
      // 打开:两帧延迟后设置 visible,确保 opacity 过渡动画正确触发
      let frame2: number | null = null
      const frame1 = requestAnimationFrame(() => {
        frame2 = requestAnimationFrame(() => {
          setDropdownVisible(true)
          // 触屏设备不自动聚焦搜索框:会弹出软键盘顶起弹层;需要筛选时用户自会点击搜索框
          if (!window.matchMedia('(pointer: coarse)').matches) {
            searchInputRef.current?.focus()
          }
        })
      })
      return () => {
        cancelAnimationFrame(frame1)
        if (frame2 !== null) cancelAnimationFrame(frame2)
      }
    } else {
      // 关闭:先淡出,等 transition 结束后再隐藏
      setDropdownVisible(false)
    }
  }, [isOpen])

  // 三段扁平结构:收藏 / 最近 / 全部模型(去重),替代旧版按 provider 分组+折叠
  const { favorites, recent, all } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const isVisible = (m: ModelDefinition) =>
      (configuredProviders.has(m.provider) || m.provider === 'custom' || m.publicPool === true) &&
      (!q ||
        m.name.toLowerCase().includes(q) ||
        (PROVIDER_NAMES[m.provider] || m.provider).toLowerCase().includes(q))

    const favorites = favoriteModels
      .map((id) => models.find((m) => m.id === id))
      .filter((m): m is ModelDefinition => m != null && isVisible(m))
    const favoriteIds = new Set(favorites.map((m) => m.id))
    const recent = recentModels
      .map((id) => models.find((m) => m.id === id))
      .filter((m): m is ModelDefinition => m != null && isVisible(m) && !favoriteIds.has(m.id))
    const recentIds = new Set(recent.map((m) => m.id))

    // 全部模型:额外套旧版规则(显示旧版开关 / 搜索时放开 / 当前选中的例外),
    // 并把上面两段出现过的隐藏,避免视觉重复
    const includeLegacy = showLegacy || q.length > 0
    const all = models.filter(
      (m) =>
        isVisible(m) &&
        (includeLegacy || m.tier !== 'legacy' || m.id === selectedModel) &&
        !favoriteIds.has(m.id) &&
        !recentIds.has(m.id)
    )
    return { favorites, recent, all }
  }, [models, configuredProviders, favoriteModels, recentModels, searchQuery, showLegacy, selectedModel])

  // 收藏/最近手动折叠(持久化在 store);搜索时强制展开 ——
  // 全部模型段排除了这两段条目,折叠态下搜索结果会丢模型
  const searching = searchQuery.trim().length > 0
  const favoritesCollapsed = !searching && modelSpecialSectionsCollapsed.favorites
  const recentCollapsed = !searching && modelSpecialSectionsCollapsed.recent

  // 键盘导航作用域 = 渲染顺序扁平化后的可见行(折叠段跳过)
  const flatRows = useMemo(
    () => [
      ...(favoritesCollapsed ? [] : favorites),
      ...(recentCollapsed ? [] : recent),
      ...all,
    ],
    [favorites, recent, all, favoritesCollapsed, recentCollapsed]
  )

  // 过滤结果变化时把高亮收回第一行,避免 ↵ 选中不可见的行
  useEffect(() => {
    setActiveIndex(0)
  }, [searchQuery, showLegacy])

  // 键盘高亮行滚进可视区
  useEffect(() => {
    if (!isOpen) return
    dropdownMenuRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, isOpen])

  const handleModelChangeDebounced = useSingleFlight((modelId: string) => {
    onModelChange(modelId)
    recordModelUsage(modelId)
    setIsOpen(false)
  }, [onModelChange, recordModelUsage])

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    // 中文输入法组词期间的 ↑↓↵ 是选字,不是导航
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (flatRows.length) setActiveIndex((i) => (i + 1) % flatRows.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (flatRows.length) setActiveIndex((i) => (i - 1 + flatRows.length) % flatRows.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const m = flatRows[activeIndex]
      if (m) handleModelChangeDebounced(m.id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setIsOpen(false)
    }
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownMenuRef.current &&
        !dropdownMenuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const selected = useMemo(
    () => models.find((m) => m.id === selectedModel),
    [models, selectedModel]
  )

  // 三段的行偏移:键盘高亮与 hover 都落在同一套扁平下标上(折叠段不占行)
  const favOffset = 0
  const recentOffset = favoritesCollapsed ? 0 : favorites.length
  const allOffset = recentOffset + (recentCollapsed ? 0 : recent.length)

  const toggleSpecialSection = (section: 'favorites' | 'recent') => {
    toggleModelSpecialSection(section)
    // 折叠/展开改变了可见行集合,高亮收回第一行避免 ↵ 落到错位行
    setActiveIndex(0)
  }

  const renderSection = (
    key: string,
    label: string,
    icon: React.ReactNode,
    iconClassName: string,
    items: ModelDefinition[],
    offset: number,
    collapsed = false,
    onToggleCollapsed?: () => void
  ) => {
    if (items.length === 0) return null
    const headerCls =
      'flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-content-muted'
    return (
      <div key={key}>
        {onToggleCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={cn(headerCls, 'w-full hover:text-content-secondary transition-colors')}
          >
            <ChevronDown
              className={cn('w-3 h-3 shrink-0 transition-transform duration-200', collapsed && '-rotate-90')}
            />
            <span className={cn('inline-flex items-center justify-center w-3.5 h-3.5', iconClassName)}>
              {icon}
            </span>
            <span className="flex-1 text-left">{label}</span>
            <span className="font-normal normal-case tracking-normal">{items.length}</span>
          </button>
        ) : (
          <div className={headerCls}>
            <span className={cn('inline-flex items-center justify-center w-3.5 h-3.5', iconClassName)}>
              {icon}
            </span>
            <span className="flex-1">{label}</span>
            <span className="font-normal normal-case tracking-normal">{items.length}</span>
          </div>
        )}
        {!collapsed &&
          items.map((model, i) => (
            <ModelRow
              key={model.id}
              model={model}
              isSelected={model.id === selectedModel}
              isActive={activeIndex === offset + i}
              isFavorite={favoriteModels.includes(model.id)}
              onSelect={handleModelChangeDebounced}
              onToggleFavorite={toggleFavoriteModel}
              onHover={() => setActiveIndex(offset + i)}
            />
          ))}
      </div>
    )
  }

  return (
    <div className={cn('relative', className)}>
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          compact
            // 触屏 ≥44px 触控目标;桌面端保持 28px 紧凑
            ? 'flex items-center gap-1.5 h-7 min-h-[44px] sm:min-h-0 px-2.5 rounded-full text-[11px] font-medium bg-surface-muted hover:bg-surface-subtle text-content-secondary'
            : 'flex items-center gap-1.5 min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-surface-subtle text-content-secondary',
          'transition-colors',
          triggerClassName
        )}
      >
        {selected && (
          <span
            className={cn('w-1.5 h-1.5 rounded-full shrink-0', PROVIDER_DOT[selected.provider] ?? 'bg-content-muted')}
          />
        )}
        <span className={cn(compact ? 'max-w-[100px]' : 'max-w-[160px]', 'truncate')}>
          {selected?.name || selectedModel}
        </span>
        <ChevronDown className="w-3 h-3 text-content-muted shrink-0" />
      </button>

      {/* 方案 C 手机端:≤md 走 iOS 半屏快切(记录 usage 由 sheet 负责,此处传原始回调不重复计) */}
      {isMobile && (
        <ModelQuickSheet
          open={isOpen}
          onClose={() => setIsOpen(false)}
          models={models}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
        />
      )}

      {isOpen && !isMobile && mounted && createPortal(
        <div
          ref={dropdownMenuRef}
          className={cn(
            'fixed z-[9999]',
            'w-[352px] max-h-[380px]',
            'flex flex-col',
            'bg-surface-muted rounded-2xl border border-line/60 shadow-lg',
            'overflow-hidden',
            // 仅过渡 opacity(纯 CSS transition,不依赖 tailwindcss-animate 插件)
            'transition-opacity duration-200 ease-out'
          )}
          style={{
            top: `${dropdownPositionRef.current.top}px`,
            left: `${dropdownPositionRef.current.left}px`,
            opacity: dropdownVisible ? 1 : 0,
          }}
          onKeyDown={handleMenuKeyDown}
        >
          {/* 搜索框 */}
          <div className="px-2 py-1.5 border-b border-line/60 shrink-0">
            <div className="relative flex items-center">
              <Search className="absolute left-2.5 w-3.5 h-3.5 text-content-muted pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索模型..."
                className={cn(
                  'w-full h-7 pl-8 pr-2 rounded-lg text-xs',
                  'bg-surface-subtle text-content-primary placeholder:text-content-muted',
                  'border border-transparent focus:border-accent/40 focus:outline-none',
                  'transition-colors'
                )}
              />
            </div>
          </div>

          {/* 模型列表(可滚动区域):收藏 / 最近 / 全部模型 三段扁平 */}
          <div className="flex-1 overflow-y-auto py-1">
            {renderSection(
              '__favorites',
              '收藏',
              <Star className="w-3 h-3" fill="currentColor" />,
              'text-yellow-500',
              favorites,
              favOffset,
              favoritesCollapsed,
              () => toggleSpecialSection('favorites')
            )}
            {renderSection(
              '__recent',
              '最近',
              <Clock className="w-3 h-3" />,
              'text-content-muted',
              recent,
              recentOffset,
              recentCollapsed,
              () => toggleSpecialSection('recent')
            )}
            {renderSection(
              '__all',
              '全部模型',
              <Layers className="w-3 h-3" />,
              'text-content-muted',
              all,
              allOffset
            )}
            {favorites.length + recent.length + all.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-content-muted">
                {searchQuery.trim() ? '没有匹配的模型' : '请先在设置中配置 API Key'}
              </div>
            )}
          </div>

          {/* 状态栏:总数 / 旧版开关 / 已配置厂商数 */}
          <div className="flex items-center justify-between px-3 py-1.5 border-t border-line/60 shrink-0 text-[10px] text-content-muted">
            <span>{flatRows.length} 个模型</span>
            <button
              type="button"
              onClick={() => setShowLegacy((v) => !v)}
              className={cn(
                'px-1.5 py-0.5 rounded transition-colors',
                showLegacy
                  ? 'bg-accent-soft text-content-primary'
                  : 'text-content-muted hover:text-content-secondary'
              )}
            >
              {showLegacy ? '已含旧版' : '显示旧版'}
            </button>
            <span>{configuredProviders.size} 家已配置</span>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

/** 模型行:厂商 tile + 双行信息; memo 避免下拉内其他项重渲 */
interface ModelRowProps {
  model: ModelDefinition
  isSelected: boolean
  isActive: boolean
  isFavorite: boolean
  onSelect: (modelId: string) => void
  onToggleFavorite: (modelId: string) => void
  onHover: () => void
}
const ModelRow = memo(function ModelRow({
  model,
  isSelected,
  isActive,
  isFavorite,
  onSelect,
  onToggleFavorite,
  onHover,
}: ModelRowProps) {
  // 星标按钮事件:阻止冒泡,避免触发外层 onClick(选中)
  const handleToggleFavorite = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    onToggleFavorite(model.id)
  }
  const providerColor = PROVIDER_COLOR[model.provider] ?? '#9ca3af'

  return (
    <button
      type="button"
      data-active={isActive || undefined}
      onMouseEnter={onHover}
      onClick={() => onSelect(model.id)}
      className={cn(
        'w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors',
        'min-h-[44px] sm:min-h-[40px] touch-manipulation',
        isActive && !isSelected && 'bg-surface-subtle',
        isSelected
          ? 'bg-accent-soft text-content-primary'
          : 'text-content-secondary'
      )}
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <span
        className="flex items-center justify-center w-[22px] h-[22px] rounded-md text-[10.5px] font-bold shrink-0"
        style={{
          background: `color-mix(in srgb, ${providerColor} 14%, transparent)`,
          color: providerColor,
        }}
      >
        {model.name.charAt(0).toUpperCase()}
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className={cn('text-xs truncate', isSelected && 'font-medium')}>{model.name}</span>
        <span className="flex items-center gap-1 text-[10px] text-content-muted">
          <span className="truncate">
            {PROVIDER_NAMES[model.provider] || model.provider} · {formatContext(model.contextWindow)} 上下文
            {model.tier === 'legacy' && ' · 旧版'}
          </span>
          {model.publicPool && (
            <span className="inline-flex items-center h-[14px] px-1 rounded bg-accent-soft text-content-secondary text-[9px] leading-none shrink-0">
              公共额度
            </span>
          )}
          {model.supportsReasoning && (
            <span className="inline-flex items-center justify-center w-[14px] h-[14px] rounded bg-accent-soft text-content-secondary shrink-0">
              <Zap className="w-2 h-2" />
            </span>
          )}
          {model.supportsVision && (
            <span className="inline-flex items-center justify-center w-[14px] h-[14px] rounded bg-surface-muted text-content-muted shrink-0">
              <Eye className="w-2 h-2" />
            </span>
          )}
        </span>
      </span>
      <span className="flex items-center gap-1 shrink-0">
        {/* ⭐ 星标按钮:点击切换收藏,不选中模型 */}
        <span
          role="button"
          tabIndex={-1}
          aria-label={isFavorite ? '取消收藏' : '收藏'}
          onClick={handleToggleFavorite}
          className={cn(
            'inline-flex items-center justify-center w-4 h-4 rounded transition-all duration-150',
            'hover:bg-surface-muted cursor-pointer',
            isFavorite
              ? 'text-yellow-500 opacity-100'
              : 'text-content-muted opacity-50 hover:opacity-90'
          )}
        >
          <Star
            className="w-3 h-3"
            fill={isFavorite ? 'currentColor' : 'none'}
            strokeWidth={isFavorite ? 0 : 2}
          />
        </span>
        {isSelected ? (
          <Check className="w-3.5 h-3.5 text-content-secondary" />
        ) : (
          isActive && <CornerDownLeft className="w-3 h-3 text-content-muted" />
        )}
      </span>
    </button>
  )
})
