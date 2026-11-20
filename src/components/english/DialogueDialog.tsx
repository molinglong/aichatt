'use client'

/**
 * 今日对话 · 逐句闯关（2026-11-17 用户拍板 design/preview-word-gap.html 方案 C）——
 * AI 把今天的词串成两人日常对话（/api/words/dialogue，产物缓存同 WordPassage 表，
 * 与纸质卷 /papers/words 的「生成对话」同源同 key），App 内逐句挖空填。
 *
 * 交互：一轮一句（who + 挖空句 + 整句中文翻译常显），回车即判；
 * 对 = 绿勾进下一句，错 = 红色给答案再看一眼，看答案 = 没想起（灰）。
 * 全程判分本地跑（lib/words/gap.ts），不接 FSRS——对话没有可程序判分的
 * 词级回忆证据，接了排期「想练就练」就变成打卡任务。
 *
 * 判分白名单：** 内的文中形式 + 对应原形（dialogue 响应 words=抽中原形数组，
 * 用前缀互配把 form 对回 lemma）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { judgeGap, normAnswer, splitBold, type GapWord } from '@/lib/words/gap'

interface DlgLine {
  who: string
  en: string
  zh: string
}

interface DlgData {
  lines: DlgLine[]
  /** 抽中的原形数组（pick）——把 **form** 对回 lemma 用 */
  words: string[]
  cached?: boolean
}

const DEFAULT_COUNT = 5

export function DialogueDialog({ open, words, onClose }: { open: boolean; words: string[]; onClose: () => void }) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<DlgData | null>(null)
  const [error, setError] = useState<string | null>(null)

  /* ── 闯关状态 ── */
  const [idx, setIdx] = useState(0)
  const [text, setText] = useState('')
  /** pending | ok | bad | revealed（revealed = 看答案，没想起） */
  const [status, setStatus] = useState<'pending' | 'ok' | 'bad' | 'revealed'>('pending')
  const [hintOn, setHintOn] = useState(false)
  const [done, setDone] = useState(false)

  const load = useCallback(
    async (forceRefresh = false) => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/words/dialogue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ words, count: DEFAULT_COUNT, refresh: forceRefresh }),
        })
        const d = (await res.json().catch(() => ({}))) as DlgData & { error?: string }
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
        if (!Array.isArray(d.lines) || d.lines.length === 0) throw new Error('对话内容为空，请重新生成')
        setData(d)
        setIdx(0)
        setText('')
        setStatus('pending')
        setHintOn(false)
        setDone(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : '生成失败')
      } finally {
        setLoading(false)
      }
    },
    [words],
  )

  useEffect(() => {
    if (!open) return
    setData(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open])

  const inputRef = useRef<HTMLInputElement>(null)

  /** 当前句的挖空词：**form** 文中形式 + 从 pick 里前缀互配对回的原形 */
  const cur = data?.lines[idx] ?? null
  const curGap: GapWord | null = (() => {
    if (!data || !cur) return null
    const seg = splitBold(cur.en).find((s) => s.bold)
    if (!seg) return null
    const form = seg.text
    const pf = normAnswer(form)
    const w =
      data.words.find((p) => {
        const pp = normAnswer(p)
        return pp && (pf.startsWith(pp) || pp.startsWith(pf))
      }) ?? form
    return { w, form }
  })()

  // 无挖空的衔接句（AI 有时插入没有目标词的过场句）：没有可填的东西，视为已通过，
  // 直接给「下一句」——否则 status 永远 pending，用户会卡死在这一句。
  const passed = status !== 'pending' || !curGap

  const judge = () => {
    if (!curGap || status !== 'pending') return
    const v = judgeGap(text, curGap)
    if (v === 'empty') return
    setStatus(v === 'ok' ? 'ok' : 'bad')
  }

  const next = () => {
    if (!data) return
    if (idx >= data.lines.length - 1) {
      setDone(true)
      return
    }
    setIdx((v) => v + 1)
    setText('')
    setStatus('pending')
    setHintOn(false)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  if (!open) return null

  const progress = data && data.lines.length ? Math.round((Math.min(idx + (passed ? 1 : 0), data.lines.length) / data.lines.length) * 100) : 0

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="overlay-dim absolute inset-0" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="今日对话填空"
        className="relative flex max-h-[88vh] w-full max-w-[640px] flex-col overflow-hidden rounded-t-sheet border border-line bg-surface sm:rounded-panel"
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-[13px]">
          <span className="rounded-full bg-accent-soft px-2 py-[2px] text-[10.5px] font-semibold text-accent">AI 生成</span>
          {data?.cached && (
            <span className="rounded-full bg-surface-muted px-2 py-[2px] text-[10.5px] font-medium text-content-muted">
              复用上次
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-content-primary">今日对话 · 一句一句填</div>
            <div className="truncate text-[11.5px] text-content-muted">
              今天 {words.length} 个词 · AI 抽 {DEFAULT_COUNT} 个串成日常对话
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3.5">
          {loading && (
            <div className="space-y-2.5 py-6">
              <div className="h-4 w-1/2 animate-pulse rounded bg-surface-subtle" />
              <div className="h-3 w-full animate-pulse rounded bg-surface-subtle" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-surface-subtle" />
              <div className="h-3 w-3/5 animate-pulse rounded bg-surface-subtle" />
              <div className="pt-2 text-center text-[11.5px] text-content-muted">正在把今天的词串成一段对话…</div>
            </div>
          )}

          {!loading && error && (
            <div className="py-8 text-center">
              <div className="text-[13px] text-danger">{error}</div>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-4 rounded-full bg-accent px-4 py-2 text-[12.5px] font-semibold text-accent-foreground"
              >
                重试
              </button>
            </div>
          )}

          {!loading && data && (
            <>
              {/* 进度 */}
              <div className="flex items-center gap-3">
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-subtle">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress}%`, transitionDuration: 'var(--motion-base)' }} />
                </div>
                <span className="shrink-0 text-[11.5px] tabular-nums text-content-muted">
                  {Math.min(idx + (passed ? 1 : 0), data.lines.length)} / {data.lines.length}
                </span>
              </div>

              {done ? (
                <div className="py-7 text-center">
                  <div className="text-[15px] font-semibold text-content-primary">对话填完了</div>
                  <div className="mx-auto mt-2 max-w-[380px] text-[12.5px] leading-relaxed text-content-secondary">
                    这些词今天已经在语境里各走过一遍。填错的词明天复习还会再见到。
                  </div>
                </div>
              ) : (
                cur && (
                  <>
                    <div className="mt-3 rounded-sheet border border-line bg-surface-subtle px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                            cur.who === 'B' ? 'bg-accent-soft text-accent' : 'bg-surface-muted text-content-secondary',
                          )}
                        >
                          {cur.who}
                        </span>
                        <span className="text-[11.5px] text-content-muted">{cur.who === 'B' ? '对方' : '同学'}</span>
                      </div>
                      <div className="mt-2 whitespace-pre-wrap text-[16.5px] leading-[1.65] text-content-primary">
                        {splitBold(cur.en).map((seg, i) =>
                          seg.bold ? (
                            <input
                              key={i}
                              ref={inputRef}
                              value={text}
                              onChange={(e) => {
                                setText(e.target.value)
                                if (status === 'bad') setStatus('pending')
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  judge()
                                }
                              }}
                              disabled={status === 'revealed' || status === 'ok'}
                              placeholder={hintOn && curGap ? `${curGap.form[0]}…` : ''}
                              autoCapitalize="off"
                              autoCorrect="off"
                              spellCheck={false}
                              aria-label="填这句话里的目标词"
                              className={cn(
                                'mx-0.5 inline-block min-w-[88px] rounded-[6px] border-b-2 bg-surface-muted px-1.5 pb-0.5 text-center align-baseline outline-none transition-colors placeholder:text-content-muted',
                                status === 'ok' && 'border-emerald-500 bg-emerald-500/10 font-semibold text-emerald-600 dark:text-emerald-400',
                                status === 'bad' && 'border-danger bg-[rgb(var(--danger)/0.08)] font-semibold text-danger',
                                status === 'revealed' && 'border-line-strong font-normal italic text-content-muted',
                                status === 'pending' && 'border-line-strong focus:border-accent',
                              )}
                              style={{ width: `${Math.max(88, seg.text.length * 12 + 28)}px` }}
                            />
                          ) : (
                            <span key={i}>{seg.text}</span>
                          ),
                        )}
                      </div>
                      {cur.zh && <div className="mt-1.5 text-[12.5px] leading-relaxed text-content-muted">{cur.zh}</div>}
                    </div>

                    {/* 反馈区：ok/bad/看答案 才有内容 */}
                    <div
                      aria-live="polite"
                      className={cn(
                        'mt-2 min-h-[18px] text-[12.5px] leading-relaxed',
                        status === 'ok' && 'text-emerald-600 dark:text-emerald-400',
                        status === 'bad' && 'text-danger',
                      )}
                    >
                      {status === 'ok' && '对——这句话就通了。'}
                      {status === 'bad' && curGap && `想岔了——正确是「${curGap.form}」。看一眼句子再走。`}
                      {status === 'revealed' && curGap && `看了答案（没想起）——「${curGap.form}」明天它还会来找你。`}
                    </div>
                  </>
                )
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-5 py-2.5">
          {!done && status === 'pending' && curGap && (
            <button
              type="button"
              onClick={() => setHintOn(true)}
              disabled={hintOn}
              className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-[12px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-50"
            >
              提示
            </button>
          )}
          {!done && status === 'bad' && curGap && (
            <button
              type="button"
              onClick={() => {
                if (!curGap) return
                setText(curGap.form)
                setStatus('revealed')
              }}
              className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-[12px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
            >
              看答案
            </button>
          )}
          {!done && passed && (
            <button
              type="button"
              onClick={next}
              className="shrink-0 rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-accent-foreground"
            >
              {data && idx >= data.lines.length - 1 ? '完成 ✓' : '下一句 →'}
            </button>
          )}
          <span className="min-w-0 flex-1" />
          {done && (
            <button
              type="button"
              onClick={() => void load(true)}
              className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-[12px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
            >
              再来一段
            </button>
          )}
          {!done && status === 'pending' && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(true)}
              className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-[12px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-50"
            >
              换一段
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'shrink-0 rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-accent-foreground',
              !done && passed && 'hidden',
            )}
          >
            {done ? '做完了' : '先不做了'}
          </button>
        </div>
      </div>
    </div>
  )
}
