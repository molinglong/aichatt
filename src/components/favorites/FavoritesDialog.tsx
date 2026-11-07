'use client'

import { useEffect } from 'react'
import { Star, X } from 'lucide-react'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useBackToClose } from '@/hooks/useBackToClose'
import { cn } from '@/lib/utils'
import { FavoriteList } from '@/components/study/FavoriteList'

/**
 * 收藏浮层（主界面入口）。
 *
 * 收藏列表此前只在学习室抽屉里,主界面收藏完没有地方看;这个浮层把
 * FavoriteList 原样搬到桌面居中弹窗 / 手机全屏（骨架与 SearchDialog 同款）:
 * 桌面磨砂遮罩 + max-w-lg 卡片,手机整页全屏随 WebView 视口。
 * 浮层返回键收口走 useBackToClose 哨兵（与搜索弹层同一机制);
 * 「回到原对话」必须走同一 hook 的 navigate —— 本浮层压了哨兵条目,
 * 裸 router.push 会被浮层关闭收尾的 back() 抢先取消（真机「点历史对话
 * 没反应」同款事故）,navigate 立旗标 + replace 原地改写哨兵才安全。
 */
export function FavoritesDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const isMobile = useIsMobileViewport()
  const { navigate } = useBackToClose(open, onClose)

  // ESC 关闭(桌面)
  useEffect(() => {
    if (!open || isMobile) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, isMobile, onClose])

  if (!open) return null

  return (
    <div
      className={cn(
        'fixed inset-0 z-[200]',
        isMobile
          ? 'flex flex-col bg-surface'
          : 'flex items-start justify-center pt-[12vh] px-4'
      )}
      onClick={isMobile ? undefined : onClose}
    >
      {/* Backdrop — 与搜索弹层同一主题感知磨砂遮罩(仅桌面浮层) */}
      {!isMobile && (
        <div className="absolute inset-0 bg-black/20 backdrop-blur-[12px] saturate-150 dark:bg-white/15 dark:saturate-150" />
      )}

      <div
        className={cn(
          'relative overflow-hidden',
          isMobile
            ? 'flex h-full min-h-0 w-full flex-col bg-surface'
            : 'flex h-[70vh] w-full max-w-lg flex-col rounded-xl border border-line/60 bg-surface-glass glass-blur shadow-2xl'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 — 手机端页头吃全局 --m-chrome-top 基线,与搜索弹层同款 */}
        <div
          className={cn(
            'flex shrink-0 items-center gap-2 border-b border-line/50',
            isMobile
              ? 'pl-5 pr-[var(--m-chrome-inset)] pt-[var(--m-chrome-top)] pb-2'
              : 'px-3.5 py-3'
          )}
        >
          <Star className={cn('shrink-0 text-accent', isMobile ? 'w-[18px] h-[18px]' : 'w-4 h-4')} />
          <span className={cn('flex-1 font-medium text-content-primary', isMobile ? 'text-[16px]' : 'text-sm')}>
            收藏
          </span>
          <button
            onClick={onClose}
            className={cn(
              'hover:bg-surface-subtle transition-colors touch-manipulation',
              isMobile
                ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full active:bg-surface-subtle/70'
                : 'p-1 rounded-md'
            )}
            aria-label="关闭收藏"
          >
            <X className={cn('text-content-muted', isMobile ? 'w-[18px] h-[18px]' : 'w-3.5 h-3.5')} />
          </button>
        </div>

        <div className="min-h-0 flex-1">
          <FavoriteList
            onBeforeNavigate={onClose}
            navigateToConversation={(id) => navigate(`/chat/c/${id}`)}
          />
        </div>
      </div>
    </div>
  )
}
