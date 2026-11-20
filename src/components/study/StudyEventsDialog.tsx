'use client'

/**
 * 学习记录弹层（便利贴风 · 2026-11-18 挑稿 design/preview-study-events.html 弹层 1）：
 * - 手动补一条 = 一句话（2-160 字）+ 标签六选一（可不选，后台不打标）+ 今天/昨天归属
 * - 时间线按归属日分组：便利贴日戳（和纸胶带）+ 流水行，悬停出 ×，点了立即删
 * - 数据与 AI 聊天快记（record_study_event 工具）共用 StudyEvent 表，REST 走 /api/study/events
 * - 骨架复用 StudyPanelDialog 配方：桌面磨砂遮罩玻璃卡 + ESC、移动全屏 + useBackToClose 返回键收口
 * - 底部统计：本周/本月条数 + 连续记 N 天（纯前端聚合 30 天窗口）
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useBackToClose } from '@/hooks/useBackToClose'
import { fetchJson } from '@/lib/query/fetcher'
import { toast } from '@/lib/toast'
import {
  EVENT_TAG_VALUES,
  EVENT_TAG_LABELS,
  localEventISO,
  type EventTag,
  type StudyEventToolRow,
} from '@/lib/ai/study-event-tool'
import s from './StudyEventsDialog.module.css'

/** 最近 30 天学习记录（学习台贴纸与本弹层共用同一 query key，改动后 invalidate 即同步） */
export function useStudyEventsRecent(enabled = true) {
  return useQuery({
    queryKey: ['study', 'events-recent'],
    queryFn: async () => {
      const from = new Date()
      from.setDate(from.getDate() - 29)
      return fetchJson<StudyEventToolRow[]>(
        `/api/study/events?from=${localEventISO(from)}&to=${localEventISO(new Date())}`
      )
    },
    enabled,
    staleTime: 30_000,
  })
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/** 日戳文案:今天/昨天,再往前回退「M月D日 周X」 */
function dayStampLabel(iso: string, todayIso: string, yesterdayIso: string): string {
  if (iso === todayIso) return '今天'
  if (iso === yesterdayIso) return '昨天'
  const d = new Date(`${iso}T00:00:00`)
  return `${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日 周${WEEKDAY[d.getDay()]}`
}

export function StudyEventsDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  /** 新增/删除后回调(父组件 invalidate 共享 query,贴纸同步刷新) */
  onChanged: () => void
}) {
  const isMobile = useIsMobileViewport()
  // 移动端系统返回 / 安卓手势:先收浮层,不退出 /study(与错题本浮层同口径)
  useBackToClose(open, onClose)
  const { data: rows, isPending } = useStudyEventsRecent(open)

  const [text, setText] = useState('')
  const [tag, setTag] = useState<EventTag | null>(null)
  const [day, setDay] = useState<'today' | 'yesterday'>('today')
  const [saving, setSaving] = useState(false)

  // 桌面 Esc 关闭(移动端无键盘,由返回键哨兵收口)
  useEffect(() => {
    if (!open || isMobile) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isMobile, onClose])

  const todayIso = localEventISO(new Date())
  const yesterdayIso = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return localEventISO(d)
  }, [])

  // 归属日分组(API 已按 eventDate 倒序 + 组内 createdAt 正序,顺序摊开即成组)
  const groups = useMemo(() => {
    const out: Array<{ date: string; items: StudyEventToolRow[] }> = []
    for (const r of rows ?? []) {
      const last = out[out.length - 1]
      if (last && last.date === r.eventDate) last.items.push(r)
      else out.push({ date: r.eventDate, items: [r] })
    }
    return out
  }, [rows])

  // 本周(近 7 天含今天)/本月(30 天窗口即取到的全部)/连续记 N 天(今天没记则从昨天起算)
  const { weekCount, monthCount, keepDays } = useMemo(() => {
    const arr = rows ?? []
    const boundary = new Date()
    boundary.setDate(boundary.getDate() - 6)
    const week = arr.filter((r) => r.eventDate >= localEventISO(boundary) && r.eventDate <= todayIso).length
    const dates = new Set(arr.map((r) => r.eventDate))
    const cursor = new Date()
    if (!dates.has(todayIso)) cursor.setDate(cursor.getDate() - 1)
    let keep = 0
    while (dates.has(localEventISO(cursor))) {
      keep += 1
      cursor.setDate(cursor.getDate() - 1)
    }
    return { weekCount: week, monthCount: arr.length, keepDays: keep }
  }, [rows, todayIso])

  const submit = async () => {
    const t = text.trim()
    if (t.length < 2) {
      toast.error('先写一句话（至少 2 个字）', { title: '学习记录' })
      return
    }
    setSaving(true)
    try {
      await fetchJson('/api/study/events', {
        json: {
          text: t,
          ...(tag ? { tag } : {}),
          date: day === 'yesterday' ? yesterdayIso : todayIso,
        },
      })
      setText('')
      setTag(null)
      setDay('today')
      toast.success('已记下一笔', { title: '学习记录' })
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '存入失败，请重试', { title: '学习记录' })
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    try {
      await fetchJson(`/api/study/events/${id}`, { method: 'DELETE' })
      toast.success('已删除', { title: '学习记录' })
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败', { title: '学习记录' })
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="学习记录"
      className={cn(
        'fixed inset-0 z-[200]',
        isMobile ? 'flex flex-col bg-surface' : 'flex items-start justify-center pt-[12vh] px-4'
      )}
    >
      {!isMobile && (
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="absolute inset-0 bg-black/20 backdrop-blur-[12px] saturate-150 dark:bg-white/15 dark:saturate-150"
        />
      )}
      <div
        className={cn(
          'relative z-10 flex flex-col overflow-hidden',
          isMobile
            ? 'h-full w-full bg-surface'
            : 'h-[68vh] w-full max-w-[520px] rounded-xl border border-line/60 bg-surface-glass glass-blur shadow-2xl enter-pop'
        )}
      >
        {/* 头部:和纸胶带贴标题 + 关闭;移动端页头吃安全区 */}
        <div
          className={cn('flex flex-none items-center gap-3 px-5', s.head)}
          style={isMobile ? { paddingTop: 'max(14px, calc(var(--m-chrome-top, 0px) + 14px))' } : undefined}
        >
          <span className={s.tapeTitle}>学习记录</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* 记一笔:便利贴纸卡(一句话 + 标签六选一 + 今天/昨天) */}
        <div className={cn('flex-none px-5 pb-1 pt-1.5', s.body)}>
          <div className={s.composer}>
            <input
              className={s.compInput}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit()
              }}
              maxLength={160}
              placeholder="今天学了什么？一句话记下来…"
              aria-label="一句话记录"
            />
            <div className={s.tagRow}>
              {EVENT_TAG_VALUES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTag((v) => (v === t ? null : t))}
                  className={cn(s.tagBtn, s[`tag_${t}`], tag === t && s.tagBtnOn)}
                >
                  {EVENT_TAG_LABELS[t]}
                </button>
              ))}
            </div>
            <div className={s.compFoot}>
              <div className={s.dateSeg}>
                <button
                  type="button"
                  className={cn(s.segBtn, day === 'today' && s.segBtnOn)}
                  onClick={() => setDay('today')}
                >
                  今天
                </button>
                <button
                  type="button"
                  className={cn(s.segBtn, day === 'yesterday' && s.segBtnOn)}
                  onClick={() => setDay('yesterday')}
                >
                  昨天
                </button>
              </div>
              <button
                type="button"
                className={s.sendBtn}
                onClick={() => void submit()}
                disabled={saving || text.trim().length < 2}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                记一笔
              </button>
            </div>
          </div>
        </div>

        {/* 时间线:日分组 + 流水行 */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-2">
          {isPending ? (
            <div className="flex h-24 items-center justify-center text-[13px] text-content-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
            </div>
          ) : groups.length === 0 ? (
            <div className="flex h-24 flex-col items-center justify-center gap-1 text-[13px] text-content-muted">
              <span>还没有记录</span>
              <span className="text-[12px]">在聊天里说「记一下今天背了单词」也能存进来</span>
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.date} className="mt-4 first:mt-1.5">
                <div className="flex items-center">
                  <span className={s.dayStamp}>
                    {dayStampLabel(g.date, todayIso, yesterdayIso)}
                    <i>{g.items.length} 条</i>
                  </span>
                  <span className={cn('ml-3 h-px flex-1', s.dashLine)} />
                </div>
                <div className="mt-1">
                  {g.items.map((r) => (
                    <div key={r.id} className={s.evRow}>
                      <span className={s.evText}>{r.text}</span>
                      {r.tag && (
                        <span className={cn(s.tagBtn, s[`tag_${r.tag}`], 'flex-none')}>
                          {EVENT_TAG_LABELS[r.tag as EventTag] ?? r.tag}
                        </span>
                      )}
                      <span className={s.evTime}>
                        {new Date(r.createdAt).getHours().toString().padStart(2, '0')}
                        :
                        {new Date(r.createdAt).getMinutes().toString().padStart(2, '0')}
                      </span>
                      <button
                        type="button"
                        className={s.evDel}
                        onClick={() => void remove(r.id)}
                        aria-label="删除这条记录"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 底部统计 */}
        <div className="flex flex-none items-center gap-2 border-t border-line/60 px-5 py-2.5 text-[11.5px] text-content-muted tabular-nums">
          <span>
            本周 <b className="font-semibold text-content-secondary">{weekCount}</b> 条
          </span>
          <span aria-hidden>·</span>
          <span>
            本月 <b className="font-semibold text-content-secondary">{monthCount}</b> 条
          </span>
          {keepDays >= 2 && (
            <>
              <span aria-hidden>·</span>
              <span>连续记 {keepDays} 天</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
