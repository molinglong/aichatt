'use client'

/**
 * 打印足迹卡 —— 拟卷 tab 顶部常驻卡(design/preview-print-center.html 方案A,2026-11-18 挑稿定案)。
 *
 * 左「今日打印」大数字(今晚测验判据同源:客户端本地零点 since 以来全部 kind 次数,
 * 拟卷次数单列一行),右最近打印最多四行(kind 徽标 + 名称 + 次数/时间 + 打开 ↗)。
 * 数据 GET /api/study/print-event?since=...(今日口径与今晚测验一致)。
 * 「今日 N 次」只对今天的行标注(次数来自今日窗口聚合,历史行只给日期+时间,不编数);
 * word-sheet → 背词卷页;passage 无独立页(在背词工作区弹窗内),不给打开入口。
 */
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'

interface PrintEventRow {
  id: string
  kind: string
  targetId: string
  createdAt: string
  title: string | null
}

interface PrintSummary {
  today: { all: number; composed: number }
  todayCounts: Record<string, number>
  recent: PrintEventRow[]
}

/** kind → 徽标文案 + 打开入口(无入口的 kind 不给「打开」) */
const KIND_META: Record<string, { label: string; href?: (targetId: string) => string }> = {
  composed: { label: '拟卷', href: (id) => `/papers/composed/${id}` },
  'word-sheet': { label: '背词卷', href: () => '/papers/words' },
  passage: { label: '短文' },
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 今天/昨天/周X(与 EveningQuiz 的 zh-CN 时间口径一致,时区跟随客户端) */
function relDayLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startToday - startThat) / 86_400_000)
  if (diffDays <= 0) return '今天'
  if (diffDays === 1) return '昨天'
  return WEEKDAY[d.getDay()]
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

function PrintRow({ ev, todayCounts }: { ev: PrintEventRow; todayCounts: Record<string, number> }) {
  const meta = KIND_META[ev.kind]
  const isToday = relDayLabel(ev.createdAt) === '今天'
  const count = todayCounts[`${ev.kind}:${ev.targetId}`]
  const metaText =
    isToday && count ? `今日 ${count} 次 · ${hhmm(ev.createdAt)}` : `${relDayLabel(ev.createdAt)} ${hhmm(ev.createdAt)}`
  const cls =
    'group flex min-h-[36px] items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-subtle'
  const inner = (
    <>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${
          ev.kind === 'composed' ? 'bg-accent-soft text-accent' : 'bg-surface-subtle text-content-secondary'
        }`}
      >
        {meta?.label ?? ev.kind}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-content-primary">
        {ev.title ?? meta?.label ?? ev.kind}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-content-muted">{metaText}</span>
      {meta?.href && (
        <span className="shrink-0 text-[11.5px] text-content-secondary transition-colors group-hover:text-content-primary">
          打开 ↗
        </span>
      )}
    </>
  )
  return meta?.href ? (
    <Link href={meta.href(ev.targetId)} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  )
}

export function PrintFootprintCard() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.study.printSummary(),
    queryFn: () => {
      const since = new Date()
      since.setHours(0, 0, 0, 0)
      return fetchJson<PrintSummary>(`/api/study/print-event?since=${since.getTime()}`)
    },
  })
  const recent = (data?.recent ?? []).slice(0, 4)

  return (
    <div className="glass-blur mb-3 rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3">
      <div className="flex gap-4 max-md:flex-col">
        {/* 左:今日数字 + 今晚测验判据(同源口径,只报数不承诺结果——回执会剔除已测过的卷) */}
        <div className="flex shrink-0 flex-col justify-center border-line pr-4 max-md:flex-row max-md:items-baseline max-md:gap-3 max-md:border-b max-md:pb-2.5 max-md:pr-0 md:border-r">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[30px] font-bold leading-none tracking-tight text-content-primary tabular-nums">
              {data ? data.today.all : '–'}
            </span>
            <span className="text-[11px] text-content-secondary">今日打印 · 份</span>
          </div>
          <p className="mt-1.5 text-[10.5px] whitespace-nowrap text-content-muted max-md:mt-0">
            今晚测验判据 · 今日拟卷 {data?.today.composed ?? 0} 份
          </p>
        </div>
        {/* 右:最近打印(空态收成一行提示,不占高度) */}
        <div className="min-w-0 flex-1 md:self-center">
          {isLoading ? (
            <p className="text-[11.5px] text-content-muted">加载中…</p>
          ) : recent.length === 0 ? (
            <p className="text-[11.5px] text-content-muted">还没有打印记录 · 打印拟卷或背词卷后会出现在这里</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {recent.map((ev) => (
                <PrintRow key={ev.id} ev={ev} todayCounts={data?.todayCounts ?? {}} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
