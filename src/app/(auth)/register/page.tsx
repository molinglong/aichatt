"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  ErrorBar,
  PasswordInput,
  footerLinkClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from "@/components/auth-controls"

export default function RegisterPage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")

    if (password !== confirmPassword) {
      setError("两次输入的密码不一致")
      return
    }

    if (password.length < 6) {
      setError("密码长度至少为 6 位")
      return
    }

    setLoading(true)

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, code }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "注册失败")
        setLoading(false)
        return
      }

      router.push(`/login?registered=1&email=${encodeURIComponent(email)}`)
    } catch {
      setError("网络错误，请稍后重试")
      setLoading(false)
    }
  }

  return (
    <div>
      <h2 className="font-ultra auth-reveal auth-delay-1 text-[30px] tracking-[0.06em] text-content-primary">
        创建账户
      </h2>
      <p className="auth-reveal auth-delay-2 mb-7 mt-2 text-[13.5px] text-content-secondary">
        注册以开始使用
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <ErrorBar message={error} />}

        <div className="auth-reveal auth-delay-3">
          <label htmlFor="regcode" className={labelClass}>
            注册码
          </label>
          <input
            id="regcode"
            type="text"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="例如：REG-7K2P-9XQM"
            autoCapitalize="characters"
            className={inputClass}
          />
        </div>

        <div className="auth-reveal auth-delay-3">
          <label htmlFor="name" className={labelClass}>
            用户名
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：小明"
            className={inputClass}
          />
        </div>

        <div className="auth-reveal auth-delay-3">
          <label htmlFor="email" className={labelClass}>
            邮箱
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={inputClass}
          />
        </div>

        <div className="auth-reveal auth-delay-4">
          <label htmlFor="password" className={labelClass}>
            密码
          </label>
          <PasswordInput
            id="password"
            placeholder="至少 6 位"
            value={password}
            onChange={setPassword}
          />
        </div>

        <div className="auth-reveal auth-delay-4">
          <label htmlFor="confirmPassword" className={labelClass}>
            确认密码
          </label>
          <PasswordInput
            id="confirmPassword"
            placeholder="再次输入密码"
            value={confirmPassword}
            onChange={setConfirmPassword}
          />
        </div>

        {/* reveal 放在 wrapper 上，避免入场动画 fill 拦截按钮的 hover/active transform */}
        <div className="auth-reveal auth-delay-5">
          <button type="submit" disabled={loading} className={primaryButtonClass}>
            {loading ? (
              <>
                <span className="h-[15px] w-[15px] animate-spin rounded-full border-2 border-accent-foreground/35 border-t-accent-foreground" />
                <span className="ml-2">注册中…</span>
              </>
            ) : (
              "注 册"
            )}
          </button>
        </div>
      </form>

      <p className="auth-reveal auth-delay-5 mt-6 text-center">
        <Link href="/login" className={footerLinkClass}>
          立即登录
        </Link>
      </p>
    </div>
  )
}
