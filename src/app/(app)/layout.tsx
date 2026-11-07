import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { TopBar } from '@/components/TopBar'
import { TopFade } from '@/components/TopFade'
import { SettingsModal } from '@/components/SettingsModal'
import { ContextMenuHost } from '@/components/ui/ContextMenu'
import { ConfirmDialogHost } from '@/components/ui/ConfirmDialog'
import { MobileFloatButtons } from '@/components/mobile/MobileFloatButtons'
import { UpdateBanner } from '@/components/mobile/UpdateBanner'
import { MobileDrawer } from '@/components/mobile/MobileDrawer'

/**
 * 各主 tab(chat/images/explore/write)共享的 shell layout。
 * (2026-11-02:/study 独立页下线,学习室内嵌进 chat 的两个页面)
 *
 * 此前每个 tab 各持有一份一模一样的独立 layout,导致跨 tab 导航时
 * Next.js 视为"不同 layout 之间的跳转"——整棵 Sidebar/TopBar 子树
 * 被卸载重建:侧边栏逐条淡入动画每次重播、会话/面具/模型等 6+ 个
 * 接口每次重发、auth() 每次重跑,体感"每切一次卡一下"。
 *
 * 放进同一个 route group(route group 不改变 URL)后,tab 间导航
 * 只替换 children,shell 与其中所有客户端状态完整保留。
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()

  if (!session?.user) {
    redirect('/login')
  }

  // 安全区让位从 app-frame 下移到 <main>(2026-10-07 灰条修复):让位带此前由 frame 的
  // pt-[var(--sat)] 呈现,露出的是 frame 自己的 bg-surface-muted 灰(#F5F5F7/#262628)——
  // 状态栏灰条即它。移到 main 后,让位带由 app-shell-column(bg-surface 白)呈现,
  // 顶部与页面同色。仅 ≤md 让位:md:p-1.5 本就盖过 sat,桌面端零变化。
  // 内容列 relative:承接桌面端浮动工具簇(TopBar ≥md 分支)
  return (
    <div className="app-frame h-screen bg-surface-muted p-0 md:p-1.5 overflow-hidden">
      {/* app-shell 加 relative isolate: 收拢层叠上下文。
          底色用 muted 不用 surface: shell 只在浮动侧栏的四周缝隙露出来,取灰不取白,
          否则侧栏外圈是一圈白板 */}
      <div className="app-shell relative isolate h-full flex overflow-hidden rounded-none md:rounded-xl shadow-2xl border border-line bg-surface-muted">
        {/* 壁纸层(主题 = 壁纸时可见): 无状态,显隐全由 html[data-wallpaper="on"] 驱动。
            照片一层 + 中间柔光一层。柔光默认 display:none —— 只在对话页出现
            (欢迎页曾经也有,会在屏幕正中印出一个白圆,已按用户要求去掉)。
            CSS 在 globals.css 的「主题: 壁纸」段。z-0 低于内容列(z-1)与侧栏(z-50) */}
        <div className="sky-wallpaper" aria-hidden>
          <div className="sky-wallpaper-photo" />
          <div className="sky-wallpaper-veil" />
        </div>
        <Sidebar />
        <div className="app-shell-column relative flex flex-col flex-1 min-w-0 bg-surface">
          <TopBar />
          {/* 上沿渐隐:内容滚上去时不再被硬切,而是渐隐着「冲出去」(浮簇本身无底板)。
              仅滚动后显形,静置/短会话不出现,故不吃留白 —— 见 TopFade.tsx */}
          <TopFade />
          {/* 方案 C 手机端(≤md):悬浮圆钮(返回/抽屉/设置)+ 全屏大字导航抽屉。
              BottomDock 已随方案 C 撤下,导航统一走抽屉(组件保留可随时回挂) */}
          <MobileFloatButtons />
          {/* 应用内自更新横幅(仅安卓壳渲染;启动静默检查,有新版才浮出) */}
          <UpdateBanner />
          {/* 深渊微光 · 流星层: 深色画布 z:-1 层带(纸面之上/内容之下),样式全在 globals.css;
              浅色模式下无样式注入,空 div 不可见 */}
          <div className="abyss-sky" aria-hidden>
            <i />
            <i />
            <i />
          </div>
          {/* max-md:pt-[var(--sat)]:手机端让位带在 main 内,背景随内容列(白/壁纸);
              桌面 md 档由 app-frame 的 p-1.5 承担,此处不生效 */}
          <main className="app-main flex-1 overflow-hidden max-md:pt-[var(--sat)]">
            {children}
          </main>
        </div>
        <MobileDrawer />
      </div>
      <SettingsModal />
      {/* 全局右键菜单宿主(单例):消息气泡 / 代码块 / 会话列表等场景通过 contextMenuStore 弹出 */}
      <ContextMenuHost />
      {/* 通道③ 确认框宿主(单例):confirmDialog() 的 Promise 在此落地,须与 SettingsModal 同级 */}
      <ConfirmDialogHost />
    </div>
  )
}
