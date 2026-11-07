'use client'

import { usePageNav } from '@/hooks/usePageNav'
import { cn } from '@/lib/utils'

/**
 * 移动端底部 Dock(<768px):页面导航从顶栏中部胶囊下沉至此。
 *
 * 设计要点:
 * - 仅移动端渲染(md:hidden),桌面端导航走侧边栏(T-C 顶栏下沉后由 SidebarNav 接管)
 * - 流内元素((app) layout 主列里 main 的兄弟),非 fixed —— 天然避开层叠上下文坑;
 *   软键盘弹起时被 visual viewport 裁掉,无需处理
 * - 各项带文字标签,语义零歧义(替代原先移动端 3 个纯图标胶囊 + 极窄屏折叠菜单)
 * - 导航数据源 = usePageNav(与侧栏导航同一份):点击立即高亮 + 数据预热,零分叉
 * - pb 让出 Home Indicator 安全区(浏览器内 --sab 为 0)
 * - 临时聊天模式(访客密码登录)只有聊天页可用,Dock 整体隐藏
 */
export function BottomDock() {
  const { items, isEphemeral } = usePageNav()

  // 临时聊天模式:仅聊天页可用,无页面可切,Dock 整体隐藏
  if (isEphemeral) return null

  return (
    <nav
      aria-label="页面导航"
      className="md:hidden shrink-0 px-3 pt-1 pb-[max(var(--sab),0.375rem)]"
    >
      <div className="flex items-stretch gap-0.5 p-1 rounded-2xl border border-line/60 bg-surface-glass glass-blur shadow-lg">
        {items.map(({ key, shortLabel, icon: Icon, active, onClick }) => (
          <button
            key={key}
            onClick={onClick}
            aria-label={shortLabel}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-xl transition-all duration-150 active:scale-95 touch-manipulation',
              active
                ? 'bg-accent-soft text-accent'
                : 'text-content-secondary hover:text-content-primary'
            )}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <Icon className="w-5 h-5" />
            <span className="text-[10px] leading-none font-medium">{shortLabel}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
