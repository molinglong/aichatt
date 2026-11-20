'use client'

/**
 * 学习台的「英语」入口卡（方案 A 定稿）：
 * 一行数字回答「今天该背多少」，按钮直达 /study/english 工作台。
 * 数据走 GET /api/words/summary（只读、幂等），不触发推进计划。
 * 2026-11-16 学习台 v2「今日聚焦」三格卡:抽 useWordsSummary + EnglishEntryCell(大数字格),
 * 行卡版 EnglishEntryCard 保留可回挂。
 */
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/query/fetcher'
import { cn } from '@/lib/utils'
import type { WordSummary } from '@/lib/words/types'

/** 背词摘要(words/summary 只读);entry 卡与今日格共用同一 queryKey,缓存互通 */
export function useWordsSummary() {
  return useQuery({
    queryKey: ['words', 'summary'],
    queryFn: () => fetchJson<WordSummary>('/api/words/summary'),
    staleTime: 30_000,
    retry: 0,
  })
}

export function EnglishEntryCard() {
  const router = useRouter()
  const { data } = useWordsSummary()

  const empty = data && !data.hasDictionary
  const due = data?.due ?? 0
  const newLeft = Math.max(0, (data?.dailyNew ?? 15) - (data?.todayNewDone ?? 0))
  const listTotal = data?.listTotal ?? 0
  const cursor = data?.cursor ?? 0
  const pct = listTotal > 0 ? Math.min(100, Math.round((cursor / listTotal) * 100)) : 0

  return (
    <div className="mb-5">
      <div className="mb-2 px-0.5 text-[11px] text-content-muted">英语</div>
      <button
        type="button"
        onClick={() => router.push('/study/english')}
        className={cn(
          'group glass-blur flex w-full items-center gap-3.5 rounded-[14px] border px-4 py-3 text-left transition-all duration-150',
          'border-line/60 bg-surface-glass hover:-translate-y-px hover:border-line-strong',
        )}
      >
        <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[12px] bg-accent-soft text-accent">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
            <path d="M8 7.5h7M8 11h5" />
          </svg>
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <b className="truncate text-[14px] font-semibold text-content-primary">
              {empty ? '背单词' : due > 0 ? `到期 ${due} 个词` : newLeft > 0 ? `今天新词 ${newLeft} 个` : '今天的量已完成'}
            </b>
            {!empty && data?.listName && (
              <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10.5px] text-content-secondary">
                {data.listName}
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-2.5 text-[11.5px] text-content-muted">
            {empty ? (
              <span>字典还空着，先导入词单（npm run words:import）</span>
            ) : (
              <>
                <span>今日新词 {Math.min(newLeft, data?.dailyNew ?? 15)}</span>
                <span className="text-line-strong">·</span>
                <span>到期 {due}</span>
                <span className="text-line-strong">·</span>
                <span>已学 {data?.learning ?? 0}</span>
                {listTotal > 0 && (
                  <>
                    <span className="text-line-strong">·</span>
                    <span className="tabular-nums">词单 {pct}%</span>
                  </>
                )}
              </>
            )}
          </span>
        </span>

        {!empty && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 py-[7px] text-[12.5px] font-semibold text-accent-foreground transition-transform duration-150 group-hover:translate-x-0.5">
            {due > 0 || newLeft > 0 ? '继续背' : '查看'}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
          </span>
        )}
      </button>
    </div>
  )
}

/**
 * 「今日聚焦」三格卡里的背词格(2026-11-16 方案A v2):大数字 + 一行细节 + 通栏主按钮(视觉)。
 * 与行卡同数据源;纯展示片段,可点性由父级格子 button 承担(整格点击进 /study/english)。
 */
export function EnglishEntryCell() {
  const { data } = useWordsSummary()

  const empty = !!data && !data.hasDictionary
  const due = data?.due ?? 0
  const newLeft = Math.max(0, (data?.dailyNew ?? 15) - (data?.todayNewDone ?? 0))
  const num = due > 0 ? due : newLeft
  const learned = data?.learning ?? 0
  const listName = data?.listName

  return (
    <>
      <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-content-secondary">
        <span className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[8px] bg-accent-soft text-accent" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <rect x="3" y="5" width="18" height="14" rx="3" />
            <path d="M7 9.5h6" />
            <path d="M7 14.5h10" />
          </svg>
        </span>
        背单词
      </span>
      <span className="text-[30px] font-bold leading-[1.05] tabular-nums text-accent">
        {num}
        <i className="ml-0.5 text-[13px] font-medium not-italic text-content-muted">词</i>
      </span>
      <span className="truncate text-[11.5px] text-content-muted">
        {empty ? '字典还空着,先导入词单' : [listName, `今日新词 ${newLeft}`, `已学 ${learned}`].filter(Boolean).join(' · ')}
      </span>
      <span className="mt-auto inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-accent px-3.5 py-[7px] text-[12.5px] font-semibold text-accent-foreground">
        {empty ? '打开工作台' : due > 0 || newLeft > 0 ? '继续背' : '查看'}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
      </span>
    </>
  )
}
