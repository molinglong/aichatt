'use client'

import { usePageNav } from '@/hooks/usePageNav'
import { useUiStyle } from '@/hooks/useUiStyle'

/**
 * Google 2020 移动端底部导航(M2 bottom nav)。
 *
 * 设计出处: public/preview-material3.html 的 .m-nav —— 白底 + 顶部 1px 发丝线,
 * 等分「图标 + 文字」(弹性布局按项数自适应),选中蓝、无胶囊底。仅在 data-style="google" 且聊天欢迎页
 * 挂载(与预览稿 data-scene 门控一致);bigsur / classic 不渲染,导航主力仍是
 * 抽屉(BottomDock 已随方案 C 撤下,本组件是 google 样式的专属分支)。
 */
export function GoogleMobileNav() {
  const uiStyle = useUiStyle()
  const { items, isEphemeral } = usePageNav()
  if (uiStyle !== 'google' || isEphemeral) return null
  return (
    <nav
      aria-label="页面导航"
      className="md:hidden shrink-0 border-t border-line bg-surface"
    >
      {/* 弹性等分(同 BottomDock):项数变化不依赖 grid-cols-5,2026-11-01 学习项撤出后 4 项不残留空列 */}
      <div className="flex items-stretch px-1 pt-1 pb-[max(var(--sab),0.375rem)]">
        {items.map(({ key, shortLabel, icon: Icon, active, onClick }) => (
          <button
            key={key}
            onClick={onClick}
            aria-label={shortLabel}
            aria-current={active ? 'page' : undefined}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 transition-colors ${
              active ? 'text-accent' : 'text-content-secondary active:bg-surface-subtle'
            }`}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.2 : 1.8} />
            <span className={`text-[10.5px] leading-none ${active ? 'font-medium' : ''}`}>
              {shortLabel}
            </span>
          </button>
        ))}
      </div>
    </nav>
  )
}
