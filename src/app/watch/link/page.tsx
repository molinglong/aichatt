"use client"

import { useState } from "react"
import Link from "next/link"

export default function WatchLinkPage() {
  const [code, setCode] = useState("")
  const [state, setState] = useState<"idle" | "busy" | "ok" | "error">("idle")
  const [message, setMessage] = useState("")
  const [needLogin, setNeedLogin] = useState(false)

  async function submit() {
    if (code.length !== 6 || state === "busy") return
    setState("busy")
    setMessage("")
    setNeedLogin(false)

    try {
      const res = await fetch("/api/watch/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (res.ok) {
        setState("ok")
        setMessage("授权成功，手表会自动登录并返回主屏")
      } else {
        setState("error")
        setMessage(data.error || "授权失败，请重试")
        setNeedLogin(res.status === 401)
      }
    } catch {
      setState("error")
      setMessage("网络异常，请重试")
    }
  }

  return (
    <main className="min-h-screen bg-white px-6 py-16 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
        <div>
          <h1 className="text-lg font-medium">手表登录</h1>
          <p className="mt-2 text-sm leading-6 text-neutral-500 dark:text-neutral-400">
            在手表上打开 aichatt，输入屏幕上显示的 6 位授权码。授权后手表会自动登录，无需再手动填写 Token。
          </p>
        </div>

        <input
          value={code}
          onChange={(event) =>
            setCode(
              event.target.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "")
                .slice(0, 6)
            )
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") submit()
          }}
          placeholder="ABC123"
          maxLength={6}
          autoFocus
          inputMode="text"
          autoCapitalize="characters"
          className="w-full rounded-2xl border border-neutral-200 bg-transparent px-4 py-4 text-center font-mono text-3xl tracking-[0.35em] uppercase outline-none transition-colors focus:border-neutral-400 dark:border-neutral-800 dark:focus:border-neutral-600"
        />

        <button
          type="button"
          onClick={submit}
          disabled={code.length !== 6 || state === "busy"}
          className="w-full rounded-2xl bg-neutral-900 py-3.5 text-sm font-medium text-white transition-opacity disabled:opacity-35 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {state === "busy" ? "授权中…" : state === "ok" ? "已授权" : "授权登录"}
        </button>

        {message ? (
          <p
            className={
              state === "ok"
                ? "text-sm text-emerald-600 dark:text-emerald-400"
                : "text-sm text-red-500 dark:text-red-400"
            }
          >
            {message}
          </p>
        ) : null}

        {needLogin ? (
          <Link href="/login" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
            先去登录 aichatt →
          </Link>
        ) : null}

        <p className="text-xs leading-5 text-neutral-400 dark:text-neutral-500">
          授权码 5 分钟内有效。手表端也可在设置里改用已有 Token 登录。
        </p>
      </div>
    </main>
  )
}
