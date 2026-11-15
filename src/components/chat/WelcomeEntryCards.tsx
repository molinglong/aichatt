'use client'

/**
 * 欢迎页能力入口卡(定位改版:日常生活助手,2026-11-15):
 * 签名图+日期行下的一排露出面。出行/闲鱼走 /chat?q= 问句深链
 * (复用 ChatPanel 现成的 autoSend 跳转桥),其余四张直跳功能页。
 * 临时聊天(访客密码)与导航口径一致,只留聊天,整块不渲染。
 */
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { BookOpen, Fish, PenLine, Route, Scale, Sparkles } from 'lucide-react'

/** 问句深链预设:发出前 AI 端有 ask_clarification 接住,不用模板占位 */
const TRIP_PROMPT = '帮我规划一次出行。'
const FISH_PROMPT = '看看我的闲鱼监控和最近行情。'

interface Entry {
  key: string
  label: string
  desc: string
  icon: typeof Route
  /** 问句深链卡:进对话并自动发送 */
  prompt?: string
  /** 功能页直跳 */
  href?: string
}

const ENTRIES: Entry[] = [
  { key: 'trip', label: '出行', desc: '火车票 · 行程规划', icon: Route, prompt: TRIP_PROMPT },
  { key: 'fish', label: '闲鱼', desc: '行情 · 实时监控', icon: Fish, prompt: FISH_PROMPT },
  { key: 'study', label: '学习', desc: '复习 · 拟卷 · 错题', icon: BookOpen, href: '/study' },
  { key: 'write', label: '写作', desc: '文档 · 画布', icon: PenLine, href: '/write' },
  { key: 'images', label: '生图', desc: '文生图 · 重绘', icon: Sparkles, href: '/images' },
  { key: 'explore', label: '探索', desc: '观点对辩', icon: Scale, href: '/explore' },
]

export function WelcomeEntryCards() {
  const router = useRouter()
  const { data: session } = useSession()

  if (session?.ephemeral === true) return null

  const go = (entry: Entry) => {
    if (entry.prompt) router.push(`/chat?q=${encodeURIComponent(entry.prompt)}`)
    else if (entry.href) router.push(entry.href)
  }

  return (
    <div className="mx-auto mt-5 grid max-w-[500px] grid-cols-2 gap-2.5 text-center max-md:max-w-[340px] md:grid-cols-3">
      {ENTRIES.map((entry) => {
        const Icon = entry.icon
        return (
          <button
            key={entry.key}
            type="button"
            onClick={() => go(entry)}
            className="flex flex-col items-center gap-1 rounded-[14px] border border-line bg-surface py-3 transition hover:border-accent/55 hover:shadow-[0_4px_14px_rgb(var(--foreground)/0.08)]"
          >
            <Icon className="h-[18px] w-[18px] text-accent/90" strokeWidth={1.7} aria-hidden />
            <span className="text-[12.5px] font-semibold leading-none text-content-primary">{entry.label}</span>
            <span className="text-[10.5px] leading-none text-content-muted">{entry.desc}</span>
            {entry.prompt && (
              <span className="mt-0.5 rounded-full border border-dashed border-line-strong px-1.5 py-px text-[9px] leading-tight text-content-muted">
                问句深链
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
