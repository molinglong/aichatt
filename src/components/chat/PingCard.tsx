'use client'

/**
 * 主对话 Ping 卡:管家主动消息的卡片渲染(metadata.kind==='ping')。
 * 数据源:消息 content(纯文本摘要,同时是管家接话的上下文)+ metadata 的
 * source/icon/actions(按钮 = 跳转到对应模式/页面)。
 */
import { cn } from '@/lib/utils'

export interface PingPayload {
  source?: string
  icon?: string
  unread?: boolean
  actions?: Array<{ label: string; href: string }>
}

export function PingCard({ content, payload }: { content: string; payload: PingPayload }) {
  const text = content.replace(/^\[[^\]]+\]\s*/, '')
  return (
    <div
      className={cn(
        'w-full max-w-[560px] overflow-hidden rounded-[14px] border bg-surface',
        payload.unread ? 'border-[rgba(0,122,255,.4)] shadow-[0_0_0_3px_var(--accent-soft)]' : 'border-line'
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-line bg-surface-muted px-4 py-2.5">
        <span className="text-[15px]" aria-hidden>
          {payload.icon ?? '🔔'}
        </span>
        <span className="text-xs font-semibold text-content-primary">{payload.source ?? '管家提醒'}</span>
      </div>
      <div className="px-4 py-3 text-[13.5px] leading-relaxed text-content-secondary">{text}</div>
      {payload.actions && payload.actions.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3.5 pb-3">
          {payload.actions.map((a, i) => (
            <a
              key={i}
              href={a.href}
              className={cn(
                'rounded-full px-4 py-1.5 text-[12.5px] font-semibold transition-opacity hover:opacity-85',
                i === 0 ? 'bg-accent text-accent-foreground' : 'border border-line bg-surface text-content-secondary'
              )}
            >
              {a.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
