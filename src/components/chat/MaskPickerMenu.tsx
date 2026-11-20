'use client'

import { useEffect, useRef, useState } from 'react'
import { Search, ChevronDown, Settings as SettingsIcon, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { BUILTIN_MASKS } from '@/lib/ai/builtin-masks'
import { BUILTIN_GAMES } from '@/lib/ai/builtin-games'
import { isMaskRestricted } from '@/lib/ai/focus-restrict'
import { bumpFocusIntercept, useFocusLock } from '@/lib/focus-lock-store'
import type { MaskDTO } from '@/lib/ai/mask-types'
import { SheetRow } from '@/components/ui/MobileSheet'

interface MaskPickerMenuProps {
  /** 当前生效面具 id(菜单项高亮);空表示未使用面具 */
  activeMaskId?: string | null
  /** 自定义面具列表(「我的面具」分组);未加载/为空时隐藏分组 */
  userMasks?: MaskDTO[]
  /** 从面具面板下载的内置面具，与自定义面具一起进「我的面具」分组 */
  installedMasks?: readonly MaskRow[]
  /** 选择某个面具 */
  onSelect: (maskId: string) => void
  /** 打开面具管理(设置页 masks 分区) */
  onManage: () => void
  /** 清除面具(不使用) */
  onClear: () => void
  /**
   * menu = 桌面/锚定弹层，保持原菜单样式；
   * sheet = 底部面板内，行与分组切到统一版（14px 行、11px 分组、选中整行浅底、无分隔线）
   */
  variant?: 'menu' | 'sheet'
}

/** 折叠分区:我的面具(自定义 + 面具面板已下载) / 精选 / 游戏；面具库与新增面具已迁入设置→面具面板 */
type GroupKey = 'mine' | 'curated' | 'game'

interface MaskRow {
  id: string
  avatar: string
  name: string
  description: string
}

/** 单个面具菜单项:三个分组共用 */
function MaskItem({
  mask,
  active,
  onSelect,
  variant,
  restricted,
}: {
  mask: MaskRow
  active: boolean
  onSelect: (id: string) => void
  variant: 'menu' | 'sheet'
  restricted?: boolean
}) {
  const pick = () => {
    if (restricted) {
      bumpFocusIntercept()
      toast.warning(`监管模式锁定中 ·「${mask.name}」不可用，到点自动恢复`, { title: '监管模式' })
      return
    }
    onSelect(mask.id)
  }
  const shield = (
    <Shield className="w-3 h-3 shrink-0 text-amber-500/80" aria-label="监管模式锁定中不可用" />
  )
  if (variant === 'sheet') {
    return (
      <SheetRow
        title={mask.name}
        subtitle={mask.description}
        selected={active}
        onClick={pick}
        lead={
          <span className="text-[18px] leading-none" aria-hidden>
            {mask.avatar}
          </span>
        }
        trailing={restricted ? shield : undefined}
        className={cn(restricted && 'opacity-40')}
      />
    )
  }
  return (
    <button
      onClick={pick}
      role="menuitem"
      aria-disabled={restricted || undefined}
      className={cn(
        'w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors',
        active ? 'bg-surface-muted' : 'hover:bg-surface-subtle',
        restricted && 'opacity-40 cursor-not-allowed hover:bg-transparent'
      )}
    >
      <span className="text-base leading-5 shrink-0" aria-hidden>{mask.avatar}</span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-content-primary">{mask.name}</span>
        <span className="block text-[11px] text-content-muted truncate">{mask.description}</span>
      </span>
      {restricted && <span className="self-center shrink-0">{shield}</span>}
    </button>
  )
}

/**
 * 面具选择菜单主体:搜索 + 可折叠分组(我的面具/精选/游戏)。
 *
 * menu 变体:只渲染菜单内容本身,定位与盒高夹取由调用方包裹 —— 调用方容器需为
 * `flex flex-col overflow-hidden` 且给出 maxHeight(见 useMaskMenuMaxHeight),
 * 内部据此把列表窗压成 盒高 − 80(搜索 41 + 钉底 37 + 边框 2),钉底不随列表滚走。
 *
 * sheet 变体:给 MobileSheet 用(外层容器需 flex flex-col)。搜索固定、列表自滚,
 * 「管理面具 / 不使用面具」降级成列表末尾的普通行,不再有钉底双钮。
 */
export function MaskPickerMenu({
  activeMaskId,
  userMasks,
  installedMasks,
  onSelect,
  onManage,
  onClear,
  variant = 'menu',
}: MaskPickerMenuProps) {
  const [query, setQuery] = useState('')
  // 监管模式锁定中:受限面具(游戏/闲聊向)置灰拦截,见 focus-restrict.ts 清单
  const { locked: focusLocked } = useFocusLock()
  // 用户折叠意图;搜索期间强制展开(否则折叠组里的命中看不见),不回写此状态
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({
    mine: false,
    curated: false,
    game: false,
  })
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const isSheet = variant === 'sheet'

  // 触屏设备不自动聚焦:会弹出软键盘顶起弹层(与 ModelSelector 同一策略)
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) searchRef.current?.focus()
  }, [])

  const q = query.trim().toLowerCase()

  const groups: { key: GroupKey; label: string; rows: readonly MaskRow[] }[] = []
  // 已下载面具若已升入精选（策展调整），不再重复出现在「我的面具」
  const curatedIds = new Set(BUILTIN_MASKS.map((m) => m.id))
  const mineRows = [...(userMasks ?? []), ...(installedMasks ?? []).filter((m) => !curatedIds.has(m.id))]
  if (mineRows.length > 0) {
    groups.push({ key: 'mine', label: '我的面具', rows: mineRows })
  }
  groups.push({ key: 'curated', label: '精选', rows: BUILTIN_MASKS })
  if (BUILTIN_GAMES.length > 0) {
    groups.push({ key: 'game', label: '游戏', rows: BUILTIN_GAMES })
  }

  const hitsOf = (rows: readonly MaskRow[]) =>
    q
      ? rows.filter(
          (m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)
        )
      : rows
  const totalHits = groups.reduce((n, g) => n + hitsOf(g.rows).length, 0)

  return (
    <>
      {isSheet ? (
        <div className="shrink-0 px-4 pb-1 pt-1">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-content-muted" aria-hidden />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                if (listRef.current) listRef.current.scrollTop = 0
              }}
              placeholder="搜索面具"
              className="h-9 w-full rounded-xl border border-transparent bg-surface-muted pl-9 pr-3 text-[14px]
                text-content-primary placeholder:text-content-muted focus:border-accent/40
                focus:outline-none transition-colors"
            />
          </div>
        </div>
      ) : (
        <div className="shrink-0 px-2 py-1.5 border-b border-line/60">
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 w-3.5 h-3.5 text-content-muted pointer-events-none" aria-hidden />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                // 列表窗随查询重排,回到顶部避免停在旧滚动位(与预览页 apply() 同策略)
                if (listRef.current) listRef.current.scrollTop = 0
              }}
              placeholder="搜索面具..."
              className="w-full h-7 pl-8 pr-2 rounded-lg text-xs bg-surface-subtle text-content-primary
                placeholder:text-content-muted border border-transparent focus:border-accent/40
                focus:outline-none transition-colors"
            />
          </div>
        </div>
      )}

      <div
        ref={listRef}
        className={cn(
          'min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          isSheet ? 'flex-auto pb-1' : 'flex-auto py-1.5'
        )}
      >
        {groups.map((g) => {
          const hits = hitsOf(g.rows)
          if (q && hits.length === 0) return null
          const isCollapsed = q ? false : collapsed[g.key]
          return (
            <div key={g.key}>
              <button
                type="button"
                role="menuitem"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}
                className={cn(
                  'w-full flex items-center transition-colors',
                  isSheet
                    ? 'gap-1.5 px-4 pb-1.5 pt-3.5 text-[11px] font-semibold tracking-[0.08em] text-content-muted active:text-content-secondary'
                    : 'gap-1.5 px-2 py-1 text-[11px] font-semibold tracking-wide text-content-muted hover:text-content-secondary',
                  focusLocked && g.key === 'game' && 'text-amber-600 dark:text-amber-400'
                )}
              >
                {focusLocked && g.key === 'game' && (
                  <Shield className="w-3 h-3 shrink-0" aria-label="监管模式锁定中不可用" />
                )}
                <ChevronDown
                  className={cn('w-3 h-3 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
                  aria-hidden
                />
                <span className="flex-1 text-left">{g.label}</span>
                <span className="text-[10px] font-normal">
                  {q ? `${hits.length}/${g.rows.length}` : g.rows.length}
                </span>
              </button>
              {!isCollapsed &&
                hits.map((m) => (
                  <MaskItem
                    key={m.id}
                    mask={m}
                    active={m.id === activeMaskId}
                    onSelect={onSelect}
                    variant={variant}
                    restricted={focusLocked && isMaskRestricted(m)}
                  />
                ))}
            </div>
          )
        })}
        {q && totalHits === 0 && (
          <div className="px-3 py-4 text-center text-xs text-content-muted">无匹配面具</div>
        )}
        {isSheet && (
          <>
            <SheetRow
              title="管理面具"
              lead={<SettingsIcon aria-hidden />}
              onClick={onManage}
            />
            <SheetRow title="不使用面具" subtitle="回到默认人格" onClick={onClear} />
          </>
        )}
      </div>

      {!isSheet && (
        <div className="shrink-0 flex gap-1 px-1.5 py-1 border-t border-line">
          <button
            onClick={onManage}
            role="menuitem"
            title="新增 / 编辑 / 删除"
            className="flex-1 min-w-0 h-7 flex items-center justify-center gap-1.5 rounded-lg text-[11.5px]
              text-content-muted hover:bg-surface-subtle hover:text-content-secondary transition-colors whitespace-nowrap"
          >
            <SettingsIcon className="w-3.5 h-3.5 shrink-0" aria-hidden />
            <span>管理面具</span>
          </button>
          <button
            onClick={onClear}
            role="menuitem"
            className="flex-1 min-w-0 h-7 flex items-center justify-center gap-1.5 rounded-lg text-[11.5px]
              text-content-muted hover:bg-surface-subtle hover:text-content-secondary transition-colors whitespace-nowrap"
          >
            <span className="text-sm leading-none" aria-hidden>✕</span>
            <span>不使用面具</span>
          </button>
        </div>
      )}
    </>
  )
}
