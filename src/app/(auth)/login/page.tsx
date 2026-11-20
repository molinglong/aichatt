"use client"

import { useEffect, useRef, useState } from "react"
import { signIn } from "next-auth/react"
import Link from "next/link"
import {
  ErrorBar,
  PasswordInput,
  footerLinkClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from "@/components/auth-controls"

/* 次级描边按钮:与主按钮同骨架(高度/圆角/hover 抬升),白底描边不占 accent */
const secondaryButtonClass =
  "flex h-11 w-full items-center justify-center gap-2 rounded-[10px] border border-line-strong bg-surface text-sm font-medium text-content-primary transition hover:-translate-y-px hover:bg-surface-muted hover:border-content-muted active:scale-[0.98] disabled:pointer-events-none disabled:opacity-55"

/* 或线:表单与 home 快捷入口之间 */
function Divider() {
  return (
    <div className="my-5 flex items-center gap-3.5" aria-hidden>
      <span className="h-px flex-1 bg-line" />
      <span className="text-[11.5px] text-content-muted">或</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

function HomeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 10.5L12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M10 21v-6h4v6" />
    </svg>
  )
}

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [justRegistered, setJustRegistered] = useState(false)
  const [loading, setLoading] = useState(false)
  const homeStarted = useRef(false)

  // home 授权回调会带 home_code 回到这里，自动完成一次 NextAuth 登录。
  useEffect(() => {
    if (homeStarted.current) return

    const params = new URLSearchParams(window.location.search)
    const code = params.get("home_code")
    const homeError = params.get("home_error")

    // 注册成功跳回(A4):渲染一次性成功条并预填注册邮箱,然后清掉参数防刷新复现
    if (params.get("registered") === "1") {
      setJustRegistered(true)
      const regEmail = params.get("email")
      if (regEmail && !email) setEmail(regEmail)
      const cleaned = new URLSearchParams(window.location.search)
      cleaned.delete("registered")
      cleaned.delete("email")
      const qs = cleaned.toString()
      window.history.replaceState(null, "", "/login" + (qs ? `?${qs}` : ""))
      return
    }

    if (homeError) {
      homeStarted.current = true
      setError(
        homeError === "no_email"
          ? "home 账号没有邮箱，无法对应 aichatt 用户"
          : homeError === "email_unverified"
            ? "邮箱还没有验证，请先到 home 完成验证"
            : "统一登录已过期，请重试"
      )
      window.history.replaceState(null, "", "/login")
      return
    }

    if (!code) return
    homeStarted.current = true

    const requested = params.get("next") || "/chat"
    const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/chat"

    // 先清掉 URL 里的一次性 code：避免并发挂载重复提交，也不把它留在历史记录里。
    window.history.replaceState(null, "", "/login")
    setLoading(true)

    signIn("home", { code, redirect: false }).then((res) => {
      if (res?.error) {
        setLoading(false)
        setError("这个邮箱还没有 aichatt 账号，请先注册")
        window.history.replaceState(null, "", "/login")
        return
      }
      window.location.replace(next)
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)

    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    })

    if (res?.error) {
      setLoading(false)
      setError("邮箱或密码错误")
      return
    }

    // 硬导航而非 router.push:未登录时落地页(/study)的 RSC 请求会被 middleware 307 回 /login,
    // 这条脏跳转进 Next 14 router cache 后软导航会复用,表现为首点无反应、需点第二次。
    // 用 replace 不用 assign:assign 会把 /login 留在历史栈里,之后任何一次「返回」
    // (安卓壳返回键 = WebView goBack、手机手势返回、浏览器后退)都会掉回登录页。
    window.location.replace("/study")
  }

  return (
    <div>
      <h2 className="font-ultra auth-reveal auth-delay-1 text-[30px] tracking-[0.06em] text-content-primary">
        欢迎回来
      </h2>
      <p className="auth-reveal auth-delay-2 mb-7 mt-2 text-[13.5px] text-content-secondary">
        登录以继续，也可以用 home 账号快捷进入
      </p>

      {justRegistered && !error && (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-[10px] border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-[13px] text-content-primary"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 flex-none text-emerald-600 dark:text-emerald-400">
            <circle cx="12" cy="12" r="8.5" />
            <path d="m8.5 12.2 2.4 2.4 4.8-5" />
          </svg>
          <span>注册成功，账号已建好——直接登录即可开始使用。</span>
        </div>
      )}

      {error && <ErrorBar message={error} />}

      <form onSubmit={handleSubmit} className="auth-reveal auth-delay-3 mt-5 flex flex-col gap-4">
        <div>
          <label htmlFor="email" className={labelClass}>
            邮箱或用户名
          </label>
          <input
            id="email"
            type="text"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com 或用户名"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="password" className={labelClass}>
            密码
          </label>
          <PasswordInput
            id="password"
            placeholder="••••••••"
            value={password}
            onChange={setPassword}
          />
        </div>

        {/* reveal 放在 wrapper 上，避免入场动画 fill 拦截按钮的 hover/active transform */}
        <div className="auth-reveal auth-delay-5">
          <button type="submit" disabled={loading} className={primaryButtonClass}>
            {loading ? (
              <>
                <span className="h-[15px] w-[15px] animate-spin rounded-full border-2 border-accent-foreground/35 border-t-accent-foreground" />
                <span className="ml-2">登录中…</span>
              </>
            ) : (
              "登 录"
            )}
          </button>
        </div>
      </form>

      <Divider />

      <div className="auth-reveal auth-delay-5">
        <button
          type="button"
          disabled={loading}
          onClick={() => window.location.assign("/api/auth/home/start")}
          className={secondaryButtonClass}
        >
          <HomeIcon />
          使用 home 账号登录
        </button>
      </div>

      <p className="auth-reveal auth-delay-5 mt-6 flex items-center justify-center gap-2">
        <Link href="/register" className={footerLinkClass}>
          立即注册
        </Link>
        <Link href="/login/ephemeral" className={footerLinkClass}>
          临时聊天
        </Link>
      </p>
    </div>
  )
}
