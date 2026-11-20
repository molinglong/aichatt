'use client'

/**
 * 学习页「错题回看 / 错题本 / 收藏」浮层(原右侧抽屉改弹窗 · 方案 C 宽版)。
 *
 * 骨架复用主界面收藏浮层(FavoritesDialog):桌面居中磨砂遮罩 + 玻璃卡、ESC 关闭、
 * 移动端全屏 + useBackToClose 返回键收口;桌面宽度取 C 案 680px,让公式/长解析/
 * 复习选项有更舒展的横向空间。三个内容组件(NoteList/ReviewCard/FavoriteList)原样搬入,
 * 仅以 wide prop 开启 C 案的「筛选单行 + 行内边距舒展」(默认关闭,不影响其它调用点)。
 */
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useBackToClose } from '@/hooks/useBackToClose'
import { NoteList } from '@/components/study/NoteList'
import { FavoriteList } from '@/components/study/FavoriteList'
import { ReviewCard } from '@/components/study/ReviewCard'

export type StudyPanelTab = 'review' | 'notes' | 'favorites'

/** 复习卡「重新学/举一反三」回传的最小错题字段(与 ReviewCard / study page 同口径) */
type ReviewNote = { id: string; title: string; content: string; imageUrl?: string | null }

const CHIP = 'px-2.5 py-1 rounded-full text-xs bg-surface-subtle/60 border border-line/60 text-content-secondary'

const TABS: Array<[StudyPanelTab, string]> = [
  ['review', '错题回看'],
  ['notes', '错题本'],
  ['favorites', '收藏'],
]

export function StudyPanelDialog({
  open,
  onClose,
  tab,
  onTab,
  dueCount,
  weakCount,
  favoriteCount,
  onChanged,
  onRestudy,
  onDrill,
  initialMode,
  topicFilter,
  onClearTopic,
}: {
  open: boolean
  onClose: () => void
  tab: StudyPanelTab
  onTab: (tab: StudyPanelTab) => void
  dueCount: number
  weakCount: number
  favoriteCount: number
  onChanged: () => void
  onRestudy: (note: ReviewNote) => void
  onDrill: (note: ReviewNote) => void
  /** 错题回看初始模式(学习台「重做练习」入口深链);翻卡/重做卡内自动回落 */
  initialMode?: 'flip' | 'redo'
  /** 考点专项过滤(统计弹层「专项 ›」带入) */
  topicFilter?: string | null
  onClearTopic?: () => void
}) {
  const isMobile = useIsMobileViewport()
  // 移动端系统返回 / 安卓手势:先收浮层,不退出 /study(与收藏浮层同口径)
  const { navigate } = useBackToClose(open, onClose)

  // 桌面 Esc 关闭(移动端无键盘,由返回键哨兵收口)
  useEffect(() => {
    if (!open || isMobile) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isMobile, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="错题回看 / 错题本 / 收藏"
      className={cn(
        'fixed inset-0 z-[200]',
        isMobile ? 'flex flex-col bg-surface' : 'flex items-start justify-center pt-[12vh] px-4'
      )}
    >
      {/* 桌面:磨砂遮罩,点击空白关闭(与收藏浮层同配方);遮罩不设 z,面板 z-10 显式压住,
          防止内容点击被遮罩截胡(练它按钮吞点击的根因) */}
      {!isMobile && (
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="absolute inset-0 bg-black/20 backdrop-blur-[12px] saturate-150 dark:bg-white/15 dark:saturate-150"
        />
      )}

      <div
        className={cn(
          'relative z-10 flex flex-col overflow-hidden',
          isMobile
            ? 'h-full w-full bg-surface'
            : 'h-[70vh] w-full max-w-[680px] rounded-xl border border-line/60 bg-surface-glass glass-blur shadow-2xl enter-pop'
        )}
      >
        {/* 头部:三 tab + 关闭;移动端页头吃 --m-chrome-top 安全区 */}
        <div
          className="flex flex-none items-center gap-1 border-b border-line px-3"
          style={
            isMobile
              ? { paddingTop: 'max(12px, calc(var(--m-chrome-top, 0px) + 12px))', paddingBottom: 12 }
              : { paddingTop: 8, paddingBottom: 8 }
          }
        >
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onTab(key)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs transition-colors',
                tab === key
                  ? 'bg-surface-subtle font-medium text-content-primary'
                  : 'text-content-muted hover:text-content-primary'
              )}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* 计数 chips */}
        <div className="flex flex-none flex-wrap gap-2 px-4 py-3">
          {tab === 'favorites' ? (
            <span className={CHIP}>
              已收藏 <b>{favoriteCount}</b>
            </span>
          ) : (
            <>
              <span className={CHIP}>
                待回看 <b>{dueCount}</b>
              </span>
              <span className={CHIP}>
                薄弱考点 <b>{weakCount}</b>
              </span>
            </>
          )}
        </div>

        {/* 内容:三个列表组件原样搬入,wide 开启 C 案舒展排版 */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'notes' ? (
            <NoteList wide onChanged={onChanged} />
          ) : tab === 'review' ? (
            <ReviewCard
              key={`${initialMode ?? 'flip'}:${topicFilter ?? ''}`}
              mode={initialMode ?? 'flip'}
              topicFilter={topicFilter}
              onClearTopic={onClearTopic}
              onChanged={onChanged}
              onRestudy={onRestudy}
              onDrill={onDrill}
            />
          ) : (
            <FavoriteList
              wide
              onChanged={onChanged}
              onBeforeNavigate={onClose}
              navigateToConversation={isMobile ? navigate : undefined}
            />
          )}
        </div>
      </div>
    </div>
  )
}