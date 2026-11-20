'use client'

/**
 * 估分报告「去问AI」消息的小卡片渲染:自动发出的深链消息(含完整上下文 prompt)
 * 在聊天里压缩成 题号+类型+上下文摘要 的结构卡,完整 prompt 收进「查看完整上下文」。
 * 与闲鱼自动回报 chip 同思路:正文照发给模型,只是不按普通大泡展示。
 */
import { useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ExamAskCardData } from '@/lib/chat/exam-ask'

export function ExamAskCard({ card }: { card: ExamAskCardData }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="ml-auto max-w-[92%] md:max-w-[88%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2.5 text-accent-foreground">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Sparkles className="w-3 h-3 shrink-0" aria-hidden />
        <b className="text-[12.5px] font-bold leading-tight">{card.title}</b>
        <span className="rounded-full bg-white/20 px-2 py-px text-[9.5px] font-semibold leading-4">
          估分报告
        </span>
      </div>
      <p className="mt-1 text-[10.5px] leading-[1.6] opacity-85 break-words">{card.meta}</p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-[10.5px] font-semibold transition-colors hover:bg-white/25"
      >
        {open ? '收起上下文' : '查看完整上下文'}
        <ChevronDown className={cn('w-2.5 h-2.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="mt-1.5 max-h-56 overflow-y-auto rounded-lg bg-white/10 px-2.5 py-2 text-[10.5px] leading-[1.75] whitespace-pre-wrap break-words">
          {card.prompt}
        </div>
      )}
    </div>
  )
}
