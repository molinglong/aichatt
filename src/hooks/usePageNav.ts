'use client'

import { MessageSquare, Sparkles, Scale, PenLine, BookOpen } from 'lucide-react'
import { useRouter, usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { prefetchTabData, type TabKey } from '@/lib/query/prefetchTab'
import { useStartNewChat } from '@/hooks/useStartNewChat'

/**
 * 页面导航（聊天 / 学习 / 生图 / 观点探索 / 写作画布）单一数据源。
 * （2026-11-15 定位改版:「学习模式」降叫「学习」,顺序与功能不动。）
 *
 * 三处消费：移动端 BottomDock、侧边栏导航（T-C 顶栏下沉后新增）。
 * （原桌面顶栏中部胶囊已随 T-C 下线，导航进侧栏。）
 *
 * 语义统一：
 * - 「聊天」= 统一的重置流程（useStartNewChat），不是 router.push('/chat')
 * - 其余 = router.push + 点击前数据预热（prefetchTabData），与旧 TopBar 同策略
 * - 临时聊天模式（访客密码登录）只有聊天页可用，过滤到只剩「聊天」
 */
export type PageNavKey = TabKey | 'study'

export interface PageNavItem {
  key: PageNavKey
  /** 完整名（侧边栏导航用） */
  label: string
  /** 短名（移动端 Dock 横向空间受限用） */
  shortLabel: string
  icon: typeof MessageSquare
  active: boolean
  onClick: () => void
  /** hover / focus 预热（桌面端鼠标进入即备好数据） */
  warm: () => void
}

export function usePageNav(opts?: {
  /** 浮层内导航注入（移动抽屉）：浮层里点导航必须走它的 replace 流程，
   *  否则抽屉关 → armPop 的 back() 会在途取消导航（详见 useBackToClose） */
  navigate?: (href: string) => void
}): { items: PageNavItem[]; isEphemeral: boolean } {
  const { data: session } = useSession()
  const isEphemeral = session?.ephemeral === true
  const router = useRouter()
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const startNewChat = useStartNewChat()
  const injectedNavigate = opts?.navigate

  // 导航出口：桌面（无注入）保持 router.push；浮层内交给注入的 replace 流程
  const go = useCallback(
    (path: string) => {
      if (injectedNavigate) injectedNavigate(path)
      else router.push(path)
    },
    [injectedNavigate, router]
  )

  // 导航过渡状态：点击立刻设上，导航完成（pathname 更新）清掉
  const [pendingTab, setPendingTab] = useState<PageNavKey | null>(null)
  useEffect(() => {
    setPendingTab(null)
  }, [pathname])

  // 预编译路由 — 让 Next.js 在背景里把目标路由的 RSC chunk / page chunk 下好
  useEffect(() => {
    router.prefetch('/chat')
    router.prefetch('/images')
    router.prefetch('/explore')
    router.prefetch('/write')
  }, [router])

  // 「聊天」：非 /chat 时给高亮过渡反馈；已在 /chat 时 nonce 重置本身立即生效
  const handleChat = useCallback(() => {
    if (pathname !== '/chat') setPendingTab('chat')
    startNewChat(injectedNavigate ? { navigate: injectedNavigate } : undefined)
  }, [pathname, startNewChat, injectedNavigate])

  const handleGo = useCallback(
    (key: PageNavKey, path: string, warm?: TabKey) => {
      if (pathname?.startsWith(path)) return
      // 在导航之前预热 — 点按瞬间就开始拉数据
      if (warm) prefetchTabData(queryClient, warm)
      setPendingTab(key)
      go(path)
    },
    [pathname, queryClient, go]
  )

  const isImagesPage = pathname?.startsWith('/images')
  const isExplorePage = pathname?.startsWith('/explore')
  const isStudyPage = pathname?.startsWith('/study')
  const isWritePage = pathname?.startsWith('/write')

  const items: PageNavItem[] = [
    {
      key: 'chat',
      label: '聊天',
      shortLabel: '聊天',
      icon: MessageSquare,
      // 聊天兜底：非其他四页即聊天（/chat 新对话页 + /chat/c/[id] 会话页）
      active:
        (!isImagesPage && !isExplorePage && !isStudyPage && !isWritePage) ||
        pendingTab === 'chat',
      onClick: handleChat,
      warm: () => prefetchTabData(queryClient, 'chat'),
    },
    {
      key: 'study',
      label: '学习',
      shortLabel: '学习',
      icon: BookOpen,
      active: Boolean(isStudyPage),
      onClick: () => handleGo('study', '/study'),
      warm: () => {},
    },
    {
      key: 'images',
      label: '生图',
      shortLabel: '生图',
      icon: Sparkles,
      active: Boolean(isImagesPage) || pendingTab === 'images',
      onClick: () => handleGo('images', '/images', 'images'),
      warm: () => prefetchTabData(queryClient, 'images'),
    },
    {
      key: 'explore',
      label: '观点探索',
      shortLabel: '探索',
      icon: Scale,
      active: Boolean(isExplorePage) || pendingTab === 'explore',
      onClick: () => handleGo('explore', '/explore', 'explore'),
      warm: () => prefetchTabData(queryClient, 'explore'),
    },
    {
      key: 'write',
      label: '写作画布',
      shortLabel: '写作',
      icon: PenLine,
      active: Boolean(isWritePage) || pendingTab === 'write',
      onClick: () => handleGo('write', '/write'),
      warm: () => {},
    },
  ]

  return { items: isEphemeral ? items.filter((i) => i.key === 'chat') : items, isEphemeral }
}
