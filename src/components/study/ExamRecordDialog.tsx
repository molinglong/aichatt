'use client'

/**
 * 「记一次学校考试」弹窗(2026-11-16:原方案D 就地展开卡改弹窗,表单本体未动):
 * ExamRecordForm 原样搬入,壳与 StudyPanelDialog/TodayTasksDialog 同配方——
 * 桌面居中磨砂遮罩 + ESC(表单卡自带圆角边框,壳不再叠一层卡 chrome),点遮罩关闭;
 * 移动端全屏 + useBackToClose 返回键收口。深度链 ?recordExam=slug 由父组件开弹窗带 initialSlug。
 */
import { useEffect } from 'react'
import { cn } from '@/lib/utils'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useBackToClose } from '@/hooks/useBackToClose'
import { ExamRecordForm } from './ExamRecordForm'
import type { LibraryPaperItem } from './StudyHome'

export function ExamRecordDialog({
  open,
  onClose,
  papers,
  papersError,
  onRetryPapers,
  initialSlug,
  onDone,
}: {
  open: boolean
  onClose: () => void
  papers: LibraryPaperItem[]
  /** 卷库接口失败:表单内提示「加载失败·重试」,而不是误导成「没有匹配的卷子」 */
  papersError?: boolean
  onRetryPapers?: () => void
  initialSlug?: string | null
  onDone: () => void
}) {
  const isMobile = useIsMobileViewport()
  useBackToClose(open, onClose)

  // 桌面 Esc 关闭(移动端由返回键哨兵收口)
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
      aria-label="记一次学校考试"
      className={cn(
        'fixed inset-0 z-[200]',
        isMobile ? 'flex flex-col bg-surface' : 'flex items-start justify-center pt-[8vh] px-4',
      )}
    >
      {/* 桌面磨砂遮罩,点击空白关闭(与 StudyPanelDialog 同配方) */}
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
          'relative z-10 min-h-0',
          isMobile
            ? 'h-full w-full overflow-y-auto px-3'
            : 'max-h-[86vh] w-full max-w-[780px] overflow-y-auto',
        )}
        style={isMobile ? { paddingTop: 'max(12px, calc(var(--m-chrome-top, 0px) + 12px))', paddingBottom: 16 } : undefined}
      >
        <ExamRecordForm
          papers={papers}
          papersError={papersError}
          onRetryPapers={onRetryPapers}
          initialSlug={initialSlug}
          onDone={onDone}
          onClose={onClose}
        />
      </div>
    </div>
  )
}
