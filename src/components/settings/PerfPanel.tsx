'use client'

import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { cn } from '@/lib/utils'

/**
 * 设置 → 性能体检:桌面小鸡同源的 CPU/内存/GPU 记录 + 回看。
 *
 * 数据链路(全在桌面 Tauri,Web 端无数据源,导航不露此分区):
 *   Rust perf.rs 后台线程 10s 一笔 → ~8640 笔 ≈ 24h 环形缓冲(重启清零);
 *   perf_history 全量取回,前端按档位切片/抽稀画线;
 *   过热记录来自宠物页红蛋破壳时 perf_log_event 记账(与动画同源,非阈值推算)。
 * 当前值走 perf_probe 3s 轮询(与宠物页交错采样安全:read_cpu 按真实间隔求差)。
 * 导出 = 前端把 points+events 序列化成 JSON 下载留档。
 */

type HistPoint = { ts: number; cpu: number; mem: number; gpu: number | null }
type HistEvent = { start: number; dur: number; kind: string }
type PerfHistory = { points: HistPoint[]; events: HistEvent[] }
type NowSample = { cpu: number; mem: number; gpu: number | null }

const METRICS = [
  { id: 'cpu', label: 'CPU', color: '#e8a23c' },
  { id: 'mem', label: '内存', color: '#5b8db8' },
  { id: 'gpu', label: 'GPU', color: '#8fb96e' },
] as const
type MetricId = (typeof METRICS)[number]['id']

const RANGES: { secs: number; label: string }[] = [
  { secs: 600, label: '10 分' },
  { secs: 3600, label: '1 时' },
  { secs: 21600, label: '6 时' },
  { secs: 86400, label: '24 时' },
]

// 图表几何:viewBox 660×170,左留轴标签、下留时刻
const CHART_W = 660
const CHART_H = 170
const PL = 38
const PR = 10
const PT = 12
const PB = 20
const PLOT_W = CHART_W - PL - PR
const PLOT_H = CHART_H - PT - PB

/** 抽稀步长:每条线最多 ~300 点,SVG 负担可控且蜡笔滤镜下视觉无差 */
const MAX_PTS = 300

function yOf(v: number): number {
  return PT + (1 - Math.min(100, Math.max(0, v)) / 100) * PLOT_H
}

function fmtClock(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtDur(dur: number): string {
  return dur < 120 ? `~${dur}s` : `~${Math.round(dur / 60)}m`
}

export function PerfPanel() {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const [hist, setHist] = useState<PerfHistory | null>(null)
  const [now, setNow] = useState<NowSample | null>(null)
  const [range, setRange] = useState(3600)
  const [hidden, setHidden] = useState<Set<MetricId>>(new Set())

  useEffect(() => {
    if (!isTauri) return
    let alive = true
    const pullHist = () =>
      invoke<PerfHistory>('perf_history')
        .then((h) => {
          if (alive) setHist(h)
        })
        .catch(() => {})
    const pullNow = () =>
      invoke<NowSample>('perf_probe')
        .then((p) => {
          if (alive) setNow(p)
        })
        .catch(() => {})
    pullHist()
    pullNow()
    const t1 = window.setInterval(pullHist, 30_000)
    const t2 = window.setInterval(pullNow, 3000)
    return () => {
      alive = false
      window.clearInterval(t1)
      window.clearInterval(t2)
    }
  }, [isTauri])

  const hasGpu = !!(now?.gpu != null || hist?.points.some((p) => p.gpu != null))

  // 档位切片 + 抽稀 + 峰值(一行 useMemo 算齐)
  const view = useMemo(() => {
    const points = hist?.points ?? []
    const nowSec = Math.floor(Date.now() / 1000)
    const from = Math.max(points[0]?.ts ?? nowSec - range, nowSec - range)
    const slice = points.filter((p) => p.ts >= from)
    const stride = Math.max(1, Math.ceil(slice.length / MAX_PTS))
    const sampled = slice.filter((_, i) => i % stride === 0 || i === slice.length - 1)
    const span = Math.max(60, nowSec - from)
    const xOf = (ts: number) => PL + ((ts - from) / span) * PLOT_W
    const peaks: Record<MetricId, number> = { cpu: 0, mem: 0, gpu: 0 }
    for (const p of slice) {
      peaks.cpu = Math.max(peaks.cpu, p.cpu)
      peaks.mem = Math.max(peaks.mem, p.mem)
      peaks.gpu = Math.max(peaks.gpu, p.gpu ?? 0)
    }
    // 过热带:事件与档位区间的交集,太窄也保 3px 可见
    const bands = (hist?.events ?? [])
      .filter((e) => e.start + e.dur >= from && e.start <= nowSec)
      .map((e) => {
        const x1 = xOf(Math.max(e.start, from))
        const x2 = xOf(Math.min(e.start + e.dur, nowSec))
        return { ...e, x: x1, w: Math.max(3, x2 - x1) }
      })
    const events = (hist?.events ?? [])
      .filter((e) => e.start >= from)
      .sort((a, b) => b.start - a.start)
    return { sampled, xOf, peaks, bands, events, span, from, nowSec, empty: slice.length === 0 }
  }, [hist, range])

  const visible = METRICS.filter((m) => (m.id === 'gpu' ? hasGpu : true) && !hidden.has(m.id))

  const exportJson = () => {
    if (!hist) return
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...hist }, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    a.href = url
    a.download = `perf-history-${stamp}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const toggleMetric = (id: MetricId) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (visible.length > 1) next.add(id) // 至少留一条线
      return next
    })

  if (!isTauri) {
    return (
      <div className="rounded-xl border border-dashed border-line/70 px-4 py-8 text-center text-sm text-content-muted">
        性能体检仅桌面端可用 —— 采样由桌面 App 的 Rust 侧完成。
      </div>
    )
  }

  const nowCards: { id: MetricId; label: string; v: number | null; peak: number }[] = [
    { id: 'cpu', label: 'CPU', v: now?.cpu ?? null, peak: view.peaks.cpu },
    { id: 'mem', label: '内存', v: now?.mem ?? null, peak: view.peaks.mem },
    { id: 'gpu', label: 'GPU', v: hasGpu ? now?.gpu ?? null : null, peak: view.peaks.gpu },
  ]

  return (
    <div className="space-y-3">
      {/* 纸条卡:小吉报告卡同款语言 —— 暖纸底、虚线框、微歪斜、右上「体检」印章 */}
      <div className="relative rotate-[-0.3deg] rounded-[6px_18px_8px_16px] border border-[#e2d9c4] bg-[#fffdf6] px-4 pb-4 pt-4 shadow-[2px_3px_0_rgba(138,131,117,0.12)] dark:border-[#3d3d44] dark:bg-[#2f2f35] dark:shadow-[2px_3px_0_rgba(0,0,0,0.25)]">
        {/* 「体检」印章 */}
        <div
          aria-hidden
          className="absolute right-3 top-3 flex h-11 w-11 rotate-12 items-center justify-center rounded-full border-2 border-[#e05a4a] text-[13px] font-bold tracking-[2px] text-[#e05a4a] opacity-75"
        >
          体检
        </div>

        {/* 头:标题 + 记录中 chip(pr 让位印章;窄容器里标题/chip 不换行,副题截断) */}
        <div className="mb-4 flex items-center gap-2 pr-12">
          <h3 className="whitespace-nowrap text-base font-bold text-[#4a4234] dark:text-[#e8e5de]">
            <span aria-hidden className="mr-1">📏</span>性能体检
          </h3>
          <span className="min-w-0 truncate text-xs text-[#8a8271] dark:text-[#9a958b]">与小吉同一采样 · CPU / 内存 / GPU</span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-[#d8c89a] bg-[#f2ead3] px-3 py-1 text-xs font-semibold text-[#8a6d2f] dark:border-[#55482e] dark:bg-[#3a3428] dark:text-[#d3b56a]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#8fb96e]" />
            记录中 · 24h 环形缓冲
          </span>
        </div>

        {/* 当前值三卡(虚线 + 微歪斜,rotation 按 index 错开) */}
        <div className="mb-3 grid grid-cols-3 gap-2.5">
          {nowCards
            .filter((c) => c.id !== 'gpu' || hasGpu)
            .map((c, i) => (
              <div
                key={c.id}
                className={cn(
                  'rounded-xl border border-dashed border-[#d8c89a] bg-[#faf3df] px-3 py-2.5 dark:border-[#4a4232] dark:bg-[#35322a]',
                  ['rotate-[0.3deg]', 'rotate-[-0.3deg]', 'rotate-[0.22deg]'][i]
                )}
              >
                <div className="flex items-center gap-1.5 text-xs text-[#8a8271] dark:text-[#9a958b]">
                  <span className="h-2 w-2 rounded-full" style={{ background: METRICS.find((m) => m.id === c.id)!.color }} />
                  {c.label}
                </div>
                <div className="mt-0.5 text-2xl font-bold tabular-nums text-[#4a4234] dark:text-[#e8e5de]">
                  {c.v != null ? Math.round(c.v) : '--'}
                  <span className="ml-0.5 text-xs font-semibold text-[#8a8271] dark:text-[#9a958b]">%</span>
                </div>
                <div className="mt-0.5 text-[11px] text-[#8a8271] dark:text-[#9a958b]">
                  范围峰值 <b className="tabular-nums font-bold">{Math.round(c.peak)}%</b>
                </div>
              </div>
            ))}
        </div>

        {/* 图表卡 */}
        <div className="mb-3 rounded-xl border border-dashed border-[#d8c89a] bg-[#fdf6e3] px-2 pb-1 pt-2 dark:border-[#4a4232] dark:bg-[#26262b]">
          {/* 档位 + 图例 */}
          <div className="flex flex-wrap items-center gap-1.5 px-1">
            {RANGES.map((r) => (
              <button
                key={r.secs}
                type="button"
                onClick={() => setRange(r.secs)}
                aria-pressed={range === r.secs}
                className={cn(
                  'h-8 rounded-full px-3 text-xs font-semibold transition-colors max-md:h-11',
                  range === r.secs
                    ? 'bg-[#4a4234] text-[#fffdf6] dark:bg-[#e8e5de] dark:text-[#2f2f35]'
                    : 'border border-dashed border-[#d8c89a] text-[#8a8271] hover:text-[#4a4234] dark:border-[#4a4232] dark:text-[#9a958b] dark:hover:text-[#e8e5de]'
                )}
              >
                {r.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1">
              {METRICS.filter((m) => m.id !== 'gpu' || hasGpu).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleMetric(m.id)}
                  aria-pressed={!hidden.has(m.id)}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-xs font-semibold transition-opacity max-md:h-11',
                    hidden.has(m.id) && 'opacity-35'
                  )}
                  style={{ color: m.color }}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* SVG 图:过热带 → 网格 → 三线(蜡笔滤镜) */}
          <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="mt-1 w-full" role="img" aria-label="性能历史曲线">
            <defs>
              <filter id="perfCrayon" x="-5%" y="-5%" width="110%" height="110%">
                <feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves="2" seed="7" result="n" />
                <feDisplacementMap in="SourceGraphic" in2="n" scale="1.6" xChannelSelector="R" yChannelSelector="G" />
              </filter>
            </defs>
            {/* 过热带(红蛋时刻) */}
            {view.bands.map((b, i) => (
              <rect
                key={`b${i}`}
                x={b.x}
                y={PT}
                width={b.w}
                height={PLOT_H}
                rx={2}
                fill="#e05a4a"
                className="fill-[#e05a4a]/[0.12] dark:fill-[#e05a4a]/[0.22]"
              />
            ))}
            {/* 网格 + 轴标 */}
            {[0, 50, 100].map((v) => (
              <g key={v}>
                <line
                  x1={PL}
                  x2={CHART_W - PR}
                  y1={yOf(v)}
                  y2={yOf(v)}
                  className="stroke-[#e2d9c4] dark:stroke-[#3d3d44]"
                  strokeDasharray={v === 0 ? undefined : '3 4'}
                />
                <text x={PL - 6} y={yOf(v) + 3} textAnchor="end" fontSize="10" className="fill-[#8a8271] dark:fill-[#9a958b]">
                  {v}
                </text>
              </g>
            ))}
            {/* 时刻轴:起/中/末 */}
            {[view.from, view.from + view.span / 2, view.nowSec].map((ts, i) => (
              <text
                key={`t${i}`}
                x={i === 0 ? PL : i === 1 ? PL + PLOT_W / 2 : CHART_W - PR}
                y={CHART_H - 5}
                textAnchor={i === 0 ? 'start' : i === 1 ? 'middle' : 'end'}
                fontSize="10"
                className="fill-[#8a8271] dark:fill-[#9a958b]"
              >
                {fmtClock(ts)}
              </text>
            ))}
            {view.empty ? (
              <text x={PL + PLOT_W / 2} y={PT + PLOT_H / 2} textAnchor="middle" fontSize="12" className="fill-[#8a8271] dark:fill-[#9a958b]">
                记录中 · 每 10 秒一笔,攒满 24 小时自动滚动
              </text>
            ) : (
              <g filter="url(#perfCrayon)">
                {visible.map((m) => (
                  <polyline
                    key={m.id}
                    fill="none"
                    stroke={m.color}
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={view.sampled.map((p) => `${view.xOf(p.ts).toFixed(1)},${yOf((p[m.id] as number | null) ?? 0).toFixed(1)}`).join(' ')}
                  />
                ))}
              </g>
            )}
          </svg>
        </div>

        {/* 过热记录 */}
        <div className="mb-3">
          <p className="mb-2 text-[13px] font-bold text-[#4a4234] dark:text-[#e8e5de]">
            过热记录 <span className="text-xs font-semibold text-[#8a8271] dark:text-[#9a958b]">(≥95% 持续 3s,小吉缩红蛋的时刻)</span>
          </p>
          {view.events.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-[#d8c89a] px-3 py-2.5 text-center text-xs text-[#8a8271] dark:border-[#4a4232] dark:text-[#9a958b]">
              {hist ? '还没有 —— 小吉一直很凉快' : '正在载入历史…'}
            </div>
          ) : (
            <div className="space-y-1.5">
              {view.events.slice(0, 8).map((e, i) => (
                <div
                  key={`${e.start}-${i}`}
                  className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-[#e2d9c4] bg-[#fdf6e3] px-3 py-2 text-[13px] dark:border-[#3d3d44] dark:bg-[#26262b]"
                >
                  {/* 蛋形点 */}
                  <span aria-hidden className="h-4 w-3.5 shrink-0 rounded-[50%_50%_50%_50%/60%_60%_40%_40%] bg-[#e05a4a]" />
                  <b className="tabular-nums text-[#4a4234] dark:text-[#e8e5de]">{fmtClock(e.start)}</b>
                  <span className="text-[#8a8271] dark:text-[#9a958b]">
                    <b className="text-[#4a4234] dark:text-[#e8e5de]">{e.kind} 100%</b> 过热,小吉缩了红蛋
                  </span>
                  <span className="ml-auto text-xs tabular-nums text-[#8a8271] dark:text-[#9a958b]">持续 {fmtDur(e.dur)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 脚注 + 导出 */}
        <div className="flex flex-wrap items-center gap-3 border-t border-dashed border-[#e2d9c4] pt-3 dark:border-[#3d3d44]">
          <p className="text-xs text-[#8a8271] dark:text-[#9a958b]">
            采样 <b className="text-[#4a4234] dark:text-[#e8e5de]">10s</b> 一笔 · 缓冲{' '}
            <b className="tabular-nums text-[#4a4234] dark:text-[#e8e5de]">8,640</b> 笔 ≈ 24 小时 · 重启清零
          </p>
          <button
            type="button"
            onClick={exportJson}
            disabled={!hist}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-[8px_12px_8px_12px] border-[1.5px] border-[#b09c62] px-4 text-[13px] font-semibold text-[#8a6d2f] transition-colors hover:bg-[#8a6d2f] hover:text-white disabled:opacity-40 max-md:h-11 dark:border-[#8a6d2f]/60 dark:text-[#d3b56a] dark:hover:bg-[#8a6d2f] dark:hover:text-white"
          >
            <Download className="h-3.5 w-3.5" />
            导出 JSON
          </button>
        </div>
      </div>
    </div>
  )
}
