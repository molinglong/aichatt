'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, MessagesSquare, FolderTree } from 'lucide-react'
import { usePageNav, type PageNavItem } from '@/hooks/usePageNav'
import { useChatStore } from '@/store/chat-store'
import { useIsTauri } from '@/lib/tauri'
import { cn } from '@/lib/utils'

/**
 * 侧边栏页面导航（T-C：顶栏下沉，页面导航从顶部胶囊搬进侧栏）。
 *
 * 两种形态同一份数据（usePageNav 与移动端 BottomDock 共用）：
 * - list：展开态。首行「聊天」常驻，其余页收进「更多功能」折叠组（默认收起，
 *   当前页落在组内时自动展开，避免当前页找不到高亮）
 * - rail：折叠态 48px 轨道里 5 个图标（C-1：导航常驻轨道，一击可及）
 *
 * 桌面客户端（Tauri）下首行升级为「聊天 | 工作」切换条：首行位置本来就是「聊天」，
 * 右半接上工作模式开关 —— 同一个词只出现一次，高度/字号/图标规格与导航行一致。
 * Web 端不渲染切换条（工作模式是客户端独有概念），首行保持原样的普通导航行。
 */
export function SidebarNav({ variant }: { variant: 'list' | 'rail' }) {
  const { items } = usePageNav()
  const inTauri = useIsTauri()
  const workMode = useChatStore((s) => s.workMode)
  const setWorkMode = useChatStore((s) => s.setWorkMode)
  // 首页「聊天」常驻，其余进折叠组
  const [primaryItem, ...groupItems] = items
  const [moreOpen, setMoreOpen] = useState(false)

  const groupActive = groupItems.some((i) => i.active)

  // 导航进组内页面时自动展开一次；展开后用户仍可手动收起
  useEffect(() => {
    if (groupActive) setMoreOpen(true)
  }, [groupActive])

  if (variant === 'rail') {
    return (
      <div className="flex flex-col items-center gap-1 pt-2">
        {items.map(({ key, label, icon: Icon, active, onClick }) => (
          <button
            key={key}
            onClick={onClick}
            className={cn(
              'p-2 rounded-lg transition-all active:scale-95 touch-manipulation',
              active
                ? 'bg-accent-soft text-content-primary'
                : 'text-content-secondary hover:text-content-primary hover:bg-surface-subtle/60'
            )}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            title={label}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <Icon className="w-4 h-4" />
          </button>
        ))}
      </div>
    )
  }

  const renderListButton = ({
    key,
    label,
    icon: Icon,
    active,
    onClick,
    warm,
  }: PageNavItem) => (
    <button
      key={key}
      onClick={onClick}
      onMouseEnter={warm}
      onFocus={warm}
      className={cn(
        'fl-line w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm text-left transition-colors touch-manipulation',
        active
          ? 'bg-accent-soft text-content-primary font-medium'
          : 'text-content-secondary hover:text-content-primary hover:bg-surface-subtle/60'
      )}
      aria-current={active ? 'page' : undefined}
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <div className="px-1.5 pb-1 flex flex-col gap-px">
      {inTauri && primaryItem ? (
        /* 「聊天 | 工作」视图切换：左半 = 原「聊天」导航行（点击动作/预热不变），
           右半 = 工作模式开关。「工作」只对聊天页生效，故不额外跳路由。 */
        <div role="tablist" aria-label="聊天 / 工作" className="pt-0.5 pb-2">
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-subtle/70">
            <button
              type="button"
              role="tab"
              aria-selected={!workMode}
              onClick={() => {
                // 工作模式中点「聊天」= 收起产物区回到纯聊天（不重置会话）；
                // 其余情况沿用原「聊天」导航动作（统一的新对话重置流程）
                if (workMode) setWorkMode(false)
                else primaryItem.onClick()
              }}
              onMouseEnter={primaryItem.warm}
              onFocus={primaryItem.warm}
              title="聊天模式（收起右侧产物区）"
              className={cn(
                'flex-1 h-7 inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-150 touch-manipulation',
                !workMode
                  ? 'bg-surface text-content-primary shadow-sm'
                  : 'text-content-secondary hover:text-content-primary'
              )}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <MessagesSquare className="w-4 h-4 shrink-0" />
              <span className="truncate">聊天</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={workMode}
              onClick={() => setWorkMode(true)}
              title="工作模式（右侧滑出产物区：预览 / 全部文件）"
              className={cn(
                'flex-1 h-7 inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-150 touch-manipulation',
                workMode
                  ? 'bg-surface text-content-primary shadow-sm'
                  : 'text-content-secondary hover:text-content-primary'
              )}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <FolderTree className="w-4 h-4 shrink-0" />
              <span className="truncate">工作</span>
            </button>
          </div>
        </div>
      ) : (
        primaryItem && renderListButton(primaryItem)
      )}
      {groupItems.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm text-left transition-colors touch-manipulation text-content-secondary hover:text-content-primary hover:bg-surface-subtle/60"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <ChevronDown
              className={cn(
                'w-4 h-4 shrink-0 transition-transform duration-200',
                moreOpen && 'rotate-180'
              )}
            />
            <span className="truncate">更多功能</span>
          </button>
          {moreOpen && groupItems.map(renderListButton)}
        </>
      )}
    </div>
  )
}
