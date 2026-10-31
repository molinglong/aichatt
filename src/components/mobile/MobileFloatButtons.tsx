'use client'

import { useState } from 'react'
import { Menu, ArrowLeft, Settings as SettingsIcon, RotateCw } from 'lucide-react'
import { useRouter, usePathname } from 'next/navigation'
import { useChatStore } from '@/store/chat-store'
import { cn } from '@/lib/utils'

/**
 * 方案 C 手机端悬浮圆钮(≤md):深色半透明玻璃圆钮悬浮在壁纸上,
 * 取代原移动端顶栏带(汉堡/标题/设置)与 BottomDock 的导航职责。
 *
 * - 欢迎页/功能页:左 = ☰ 抽屉,右 = ⚙ 设置
 * - 会话页(/chat/c/*):左 = ← 返回欢迎页,左二 = ☰ 抽屉,右 = ⚙ 设置
 * - 设计稿参数:40px 圆、浅色页 = 白 72% 玻璃 + 墨 8% 描边 + 墨图标(2026-10-07 换色定案),
 *   暗色回落 rgb(28 28 30/.36) + 白图标;
 * - z-30:压过页面内容与 TopFade(z-10),低于全屏抽屉(z-50)与设置弹窗(z-100)
 */
export function MobileFloatButtons() {
  const router = useRouter()
  const pathname = usePathname()
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const setSettingsOpen = useChatStore((s) => s.setSettingsOpen)

  const isConversation = !!pathname?.startsWith('/chat/c/')
  const [reloading, setReloading] = useState(false)
  if (pathname?.startsWith('/study')) return null

  // 2026-10-28:去掉顶栏圆钮的圆底/描边/阴影,只保留图标本体(命中区仍 40px)。
  const btnBase =
    'flex items-center justify-center w-10 h-10 text-content-primary ' +
    'dark:text-white ' +
    'transition-transform duration-150 ' +
    'active:scale-90 touch-manipulation'
  const btnStyle: React.CSSProperties = {
    WebkitTapHighlightColor: 'transparent',
  }

  return (
    // fixed(不是 absolute):基线要按视口顶算,才能与抽屉头部(fixed inset-0)落在同一条线,
    // 不吃 main 的 max-md:pt-[var(--sat)] 与 shell 1px 边框,免得安全区被算两遍。
    <div
      className="mobile-float-buttons md:hidden pointer-events-none fixed inset-x-0 z-30"
      style={{ top: 'var(--m-chrome-top)' }}
    >
      <div className="relative h-10">
        {/* 左:会话页 = ← 返回 + ☰ 抽屉,并成一个胶囊;其余页只有一颗 ☰,
            胶囊宽度就是 40px,圆角下看起来仍是一个圆。底色只在壁纸主题下画 */}
        <div className="m-float-pill absolute left-[var(--m-chrome-inset)] top-0 flex items-center gap-[var(--m-chrome-gap)] rounded-full">
          <button
            onClick={() => (isConversation ? router.push('/chat') : toggleSidebar())}
            className={cn(btnBase, 'pointer-events-auto')}
            aria-label={isConversation ? '返回' : '打开侧边栏'}
            style={btnStyle}
          >
            {isConversation ? <ArrowLeft className="w-[18px] h-[18px]" /> : <Menu className="w-[18px] h-[18px]" />}
          </button>
          {isConversation && (
            <button
              onClick={toggleSidebar}
              className={cn(btnBase, 'pointer-events-auto')}
              aria-label="打开侧边栏"
              style={btnStyle}
            >
              <Menu className="w-[18px] h-[18px]" />
            </button>
          )}
        </div>
        {/* 右:刷新 + 设置 —— 两颗并成一个胶囊。容器不设定位宽度,按钮仍是原来那 40px:
            胶囊右边缘对齐原来的设置钮右边缘,刷新钮靠 gap 顶在它左边,
            所以与合并前的横向位置逐像素一致。胶囊底色只在壁纸主题下画(globals.css ⑥) */}
        <div className="m-float-pill absolute right-[var(--m-chrome-inset)] top-0 flex items-center gap-[var(--m-chrome-gap)] rounded-full">
          <button
            onClick={() => {
              if (reloading) return
              setReloading(true)
              window.location.reload()
            }}
            className={cn(btnBase, 'pointer-events-auto')}
            aria-label="刷新页面"
            style={btnStyle}
          >
            <RotateCw className={cn('w-[18px] h-[18px]', reloading && 'animate-spin')} />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className={cn(btnBase, 'pointer-events-auto')}
            aria-label="设置"
            style={btnStyle}
          >
            <SettingsIcon className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
    </div>
  )
}
