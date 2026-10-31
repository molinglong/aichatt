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

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [showLegacy, setShowLegacy] = useState(false)
  const homeStarted = useRef(false)
  // 第 3 波开关：默认关闭；确认迁移完成后再设为 1，只保留 home 登录。
  const homeOnly = process.env.NEXT_PUBLIC_HOME_ONLY === "1"

  // home 授权回调会带 home_code 回到这里，自动完成一次 NextAuth 登录。
  useEffect(() => {
    // 应急入口：即使开启 homeOnly，也允许 /login?legacy=1 使用原账号密码。
    if (new URLSearchParams(window.location.search).get("legacy") === "1") {
      setShowLegacy(true)
    }

    if (homeStarted.current) return

    const params = new URLSearchParams(window.location.search)
    const code = params.get("home_code")
    const homeError = params.get("home_error")

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

    // 硬导航而非 router.push:未登录时 /chat 的 RSC 请求会被 middleware 307 回 /login,
    // 这条脏跳转进 Next 14 router cache 后软导航会复用,表现为首点无反应、需点第二次。
    // 用 replace 不用 assign:assign 会把 /login 留在历史栈里,之后任何一次「返回」
    // (安卓壳返回键 = WebView goBack、手机手势返回、浏览器后退)都会掉回登录页。
    window.location.replace("/chat")
  }

  return (
    <div>
      <h2 className="font-ultra auth-reveal auth-delay-1 text-[30px] tracking-[0.06em] text-content-primary">
        欢迎回来
      </h2>
      <p className="auth-reveal auth-delay-2 mb-7 mt-2 text-[13.5px] text-content-secondary">
        用 home 账号登录，aichatt 与 plan 共用同一身份
      </p>

      {error && <ErrorBar message={error} />}

      <div className="auth-reveal auth-delay-3 mt-5 flex flex-col gap-3">
        <button
          type="button"
          disabled={loading}
          onClick={() => window.location.assign("/api/auth/home/start")}
          className={primaryButtonClass}
        >
          {loading ? (
            <>
              <span className="h-[15px] w-[15px] animate-spin rounded-full border-2 border-accent-foreground/35 border-t-accent-foreground" />
              <span className="ml-2">正在登录…</span>
            </>
          ) : (
            "使用 home 账号登录"
          )}
        </button>

        {(!homeOnly || showLegacy) && (
          <button
            type="button"
            onClick={() => setShowLegacy((value) => !value)}
            className={`${footerLinkClass} self-center`}
          >
            {showLegacy ? "收起原账号登录" : "使用原账号密码登录"}
          </button>
        )}
      </div>

      {showLegacy && (
        <>
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <div className="auth-reveal auth-delay-3">
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

        <div className="auth-reveal auth-delay-4">
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

      <p className="auth-reveal auth-delay-5 mt-6 flex items-center justify-center gap-2">
        <Link href="/register" className={footerLinkClass}>
          立即注册
        </Link>
        <Link href="/login/ephemeral" className={footerLinkClass}>
          临时聊天
        </Link>
      </p>
        </>
      )}
    </div>
  )
}
