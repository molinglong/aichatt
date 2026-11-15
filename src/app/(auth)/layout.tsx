/* ── 认证页（登录/注册）共享布局：品牌分栏 ──────────────────
   左栏：品牌叙事区（点阵背景 + 极细大标语 + 药丸 + 缩影卡片），移动端隐藏
   右栏：白底表单区，由 login/register 页面填充 children ── */
import { AuthTrafficBar } from '@/components/AuthTrafficBar'

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="relative flex min-h-screen">
      {/* Tauri 桌面：红绿灯 + 窗口拖动区（Web 端由 .tauri-only 门控隐藏，零渲染） */}
      <AuthTrafficBar />
      {/* ── 左栏：品牌区（移动端隐藏）── */}
      <div className="auth-brand relative hidden w-[55%] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#f0f0f3] to-[#e2e2e7] px-[52px] py-11 dark:from-[#1a1a1d] dark:to-[#232327] lg:flex">
        {/* 点阵背景（纯装饰，整面均匀铺满） */}
        <div aria-hidden className="auth-dot-grid" />

        {/* 顶部 Logo：品牌标记嵌圆徽标；深色模式换反白版图（红点保持原色） */}
        <div className="auth-reveal auth-delay-1 relative z-10 flex items-center gap-[11px]">
          <div className="flex h-[34px] w-[34px] items-center justify-center rounded-full border border-line-strong bg-surface/70">
            <img src="/brand/mark.png" alt="" aria-hidden className="w-[19px] dark:hidden" />
            <img src="/brand/mark-invert.png" alt="" aria-hidden className="hidden w-[19px] dark:block" />
          </div>
          <span className="text-sm font-medium tracking-[0.12em] text-content-primary">
            aichatt
          </span>
        </div>

        {/* 中部标语 + 药丸 */}
        <div className="relative z-10">
          <h1 className="font-ultra auth-reveal auth-delay-2 text-[clamp(34px,4.6vw,52px)] leading-[1.28] tracking-[0.1em] text-content-primary">
            帮你接住日常
            <br />
            也守住学习
          </h1>
          <p className="auth-reveal auth-delay-3 mt-[22px] text-[14.5px] leading-[1.9] tracking-[0.04em] text-content-secondary">
            多模型自由切换，出行、行情、待办、写作，一句问起。
            <br />
            错题、复习、冲刺，一样管住。
          </p>
          <div className="auth-reveal auth-delay-4 mt-[30px] flex flex-wrap gap-2">
            {["多模型接入", "生活与学习", "数据在自己手里"].map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-line-strong/55 bg-surface/55 px-3.5 py-1.5 text-xs tracking-[0.04em] text-content-secondary backdrop-blur-sm transition hover:-translate-y-px hover:bg-surface/85 hover:text-content-primary"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* 底部版权 */}
        <div className="auth-reveal auth-delay-4 relative z-10 text-xs tracking-[0.1em] text-content-muted">
          © {new Date().getFullYear()} aichatt · 个人生活助手
        </div>

        {/* 缩影：CSS 画的对话卡片，暗示产品形态（纯装饰，宽屏才显示避免拥挤） */}
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-[92px] right-11 z-0 hidden w-[292px] flex-col gap-2.5 xl:flex"
        >
          <div className="rotate-[-1.6deg] rounded-2xl border border-line bg-surface/90 p-4 shadow-[0_18px_44px_-14px_rgb(var(--foreground)/0.18)] backdrop-blur-sm">
            <div className="flex justify-end">
              <div className="max-w-[80%] rounded-xl rounded-br-md bg-accent px-3 py-2 text-xs leading-relaxed text-accent-foreground">
                帮我总结这份文档的要点
              </div>
            </div>
            <div className="mt-2.5 flex items-end gap-2">
              <span className="h-5 w-5 shrink-0 rounded-full border border-line bg-surface-subtle" />
              <div className="flex w-[80%] flex-col gap-1.5 rounded-xl rounded-bl-md border border-line bg-surface-muted px-3 py-2.5">
                <i className="h-[7px] w-[88%] rounded bg-line-strong/55" />
                <i className="h-[7px] w-[64%] rounded bg-line-strong/55" />
                <i className="h-[7px] w-[38%] rounded bg-line-strong/55" />
              </div>
            </div>
          </div>
          <div className="ml-auto w-[84%] rotate-[1.4deg] rounded-2xl border border-line bg-surface/90 p-4 opacity-90 shadow-[0_18px_44px_-14px_rgb(var(--foreground)/0.18)] backdrop-blur-sm">
            <div className="flex items-end gap-2">
              <span className="h-5 w-5 shrink-0 rounded-full border border-line bg-surface-subtle" />
              <div className="flex w-[80%] flex-col gap-1.5 rounded-xl rounded-bl-md border border-line bg-surface-muted px-3 py-2.5">
                <i className="h-[7px] w-[76%] rounded bg-line-strong/55" />
                <i className="h-[7px] w-[50%] rounded bg-line-strong/55" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── 右栏：表单区 ── */}
      <div className="flex w-full items-center justify-center bg-surface px-8 py-14 lg:w-[45%] lg:px-10">
        <div className="w-full max-w-[340px]">{children}</div>
      </div>
    </div>
  )
}
