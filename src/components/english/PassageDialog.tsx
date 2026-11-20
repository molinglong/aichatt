'use client'

/**
 * AI 小短文弹层 —— 把「今天要背的词」串成一篇容易读的英文短文。
 * 目的：背完单词立刻在上下文里再见一次，所以难度压低、句子短、场景日常。
 *
 * 正文里的目标词由模型用 **双星号** 标出，这里渲染成高亮；
 * 中文译文可折叠；生成不满意可以点「重新生成」再要一版。
 *
 * 2026-11-17 读后默写（用户拍板 design/preview-word-gap.html 方案 B）：
 *   读完点「开始默写」，目标词收起成题单逐空填——判分本地跑（lib/words/gap.ts，
 *   form + 原形双白名单），看答案 = 没想起，全程不接 FSRS（语境用法不是词级
 *   最小回忆单元，白名单误判的噪音不进排期）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { PaperBrandSeal } from '@/components/papers/PaperBrandSeal'
import { dedupeGapWords, judgeGap, type GapWord } from '@/lib/words/gap'
import { PRINT_BASE_CSS, printPageCss } from '@/lib/print/print-css'

interface Passage {
  title: string
  titleZh: string
  body: string
  translation: string
  words: Array<{ w?: string; form?: string }>
  targetWords: string[]
  reviewWords?: string[]
  previewWords?: string[]
  /** true = 命中缓存（同一组词已生成过，没花 token） */
  cached?: boolean
}

/** 把 **word** 渲染成高亮 */
function Highlighted({ text, printMode }: { text: string; printMode?: boolean }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <mark
            key={i}
            className={
              printMode ? 'pp-w' : 'rounded-[3px] bg-accent-soft px-0.5 font-semibold text-accent'
            }
          >
            {p.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

/** 打印专用样式：整页只留这张短文（portal 策略,body > *:not(副本) 全藏），A4 页边距 16/15mm */
const PRINT_CSS = `
@media screen { .passage-print { display: none; } }
@media print {
  /* 公共底座(@page/html,body 解锁/dev 浮标隐藏)收敛在 @/lib/print/print-css */
  ${printPageCss('16mm 15mm')}
  ${PRINT_BASE_CSS}
  body > *:not(.passage-print) { display: none !important; }
  .passage-print {
    display: block !important;
    position: relative; /* 品牌钤印定位锚 */
    padding-top: 14mm; /* 钤印落在页首 padding 区,避免横穿卷头底线 */
    color: #000;
    font-family: "Songti SC", "SimSun", "Noto Serif SC", -apple-system, "Microsoft YaHei", serif;
  }
  .passage-print mark { background: transparent; }
  .passage-print .pp-w { background: #ececec; font-weight: 700; padding: 0 2px; border-radius: 2px; }
  /* 右上角钤印位让行:标题/副题长也不许钻到印下面 */
  .pp-head { border-bottom: 1.5px solid #000; padding-bottom: 6px; margin-bottom: 7mm; padding-right: 84px; }
  .pp-title { font-size: 15pt; font-weight: 700; letter-spacing: .01em; }
  .pp-sub { font-size: 9pt; color: #000; margin-top: 3px; }
  .pp-body { font-size: 11.5pt; line-height: 1.95; }
  .pp-w { background: #ececec; font-weight: 700; padding: 0 2px; border-radius: 2px; }
  .pp-zh { margin-top: 7mm; border-top: 1px solid #dcdcdc; padding-top: 4mm; font-size: 9.5pt; line-height: 1.85; color: #000; }
  .pp-h { font-size: 8.5pt; color: #000; margin-bottom: 2mm; }
  .pp-foot { margin-top: 8mm; border-top: 1px solid #dcdcdc; padding-top: 3px;
    display: flex; align-items: flex-end; justify-content: space-between; gap: 6mm;
    font-size: 7.5pt; color: #000; }
  .pp-foot span:first-child { flex: 1; min-width: 0; line-height: 1.5; }
  .pp-foot span:last-child { flex: none; white-space: nowrap; }
}
`

/** 译文里模型常把 ** 也带出来，展示时一律去掉 */
const plain = (s: string) => s.replace(/\*\*/g, '')

/** 默写单空状态：text 保留输入便于重判；revealed = 看答案（没想起） */
interface GapState {
  text: string
  status: 'pending' | 'ok' | 'bad' | 'revealed'
  hint: 0 | 1 | 2
}

export function PassageDialog({
  open,
  words,
  transMap,
  onClose,
}: {
  open: boolean
  words: string[]
  /** headword → 中文释义首段（默写提示第二级用；掺进来的词没有就不给中文档） */
  transMap?: Record<string, string>
  onClose: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<Passage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showZh, setShowZh] = useState(true)
  // 掺词开关（默认关：学新词的短文只围绕今天的新词，想要复习/预习味再手动掺）：
  // 复习=今天到期但已学过的词；预习=计划里还没学的词
  const [withReview, setWithReview] = useState(false)
  const [withPreview, setWithPreview] = useState(false)
  const REVIEW_COUNT = 4
  const PREVIEW_COUNT = 3
  // 打印用的副本走 portal 挂到 body：打印时把整个 App 藏掉，只留这一页
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  /* ── 读后默写：quizOn 切读/默两态；判分纯本地，不接排期 ── */
  const [quizOn, setQuizOn] = useState(false)
  const [gapStates, setGapStates] = useState<Record<number, GapState>>({})
  const gapItems = useMemo(
    () => (data ? dedupeGapWords(data.words.filter((x): x is GapWord => !!x.w && !!x.form)) : []),
    [data],
  )

  const setGap = (i: number, patch: (st: GapState) => GapState) =>
    setGapStates((s) => ({ ...s, [i]: patch(s[i] ?? { text: '', status: 'pending', hint: 0 }) }))

  const judgeOne = (i: number) =>
    setGap(i, (st) => {
      if (st.status === 'revealed') return st
      const v = judgeGap(st.text, gapItems[i])
      if (v === 'empty') return st
      return { ...st, status: v === 'ok' ? 'ok' : 'bad' }
    })

  const revealAll = () =>
    gapItems.forEach((item, i) =>
      setGap(i, (st) =>
        st.status === 'ok'
          ? st
          : { ...st, text: item.form, status: 'revealed' },
      ),
    )

  const gapDone = gapItems.length > 0 && gapItems.every((_, i) => (gapStates[i]?.status ?? 'pending') !== 'pending')

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/words/passage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          words,
          reviewCount: withReview ? REVIEW_COUNT : 0,
          previewCount: withPreview ? PREVIEW_COUNT : 0,
          refresh: forceRefresh,
        }),
      })
      const d = (await res.json().catch(() => ({}))) as Passage & { error?: string }
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setData(d)
      // 新短文 = 回读态重来（重新生成/换掺词都会走到这）
      setQuizOn(false)
      setGapStates({})
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败')
    } finally {
      setLoading(false)
    }
  }, [withPreview, withReview, words])

  // 打开即生成；换了掺词开关也重新生成
  useEffect(() => {
    if (!open) return
    setData(null)
    setShowZh(true)
    setQuizOn(false)
    setGapStates({})
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, withReview, withPreview])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="overlay-dim absolute inset-0" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="AI 小短文"
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
            <div className="truncate text-[14px] font-semibold text-content-primary">
              {data?.titleZh || '用今天背的词读一篇小短文'}
            </div>
            <div className="truncate text-[11.5px] text-content-muted">
              今天 {words.length} 个词 · 读完再回去背一遍更牢
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
              <div className="h-4 w-2/3 animate-pulse rounded bg-surface-subtle" />
              <div className="h-3 w-full animate-pulse rounded bg-surface-subtle" />
              <div className="h-3 w-11/12 animate-pulse rounded bg-surface-subtle" />
              <div className="h-3 w-full animate-pulse rounded bg-surface-subtle" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-surface-subtle" />
              <div className="pt-2 text-center text-[11.5px] text-content-muted">正在用今天的词写一篇短文…</div>
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
              <h3 className="text-[17px] font-bold leading-snug text-content-primary">{data.title}</h3>

              {/* 读/默切换行：默写题单就来自这篇正文的目标词 */}
              {gapItems.length > 0 && (
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="min-w-0 text-[11.5px] leading-snug text-content-muted">
                    {quizOn ? '第二遍：不看原文，凭记忆填 · 回车即判' : '读完连蒙带猜一遍，再凭记忆默写一遍更牢'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setQuizOn((v) => !v)}
                    className="shrink-0 rounded-full border border-accent/50 bg-accent-soft px-3.5 py-1.5 text-[12px] font-semibold text-accent transition-colors hover:border-accent"
                  >
                    {quizOn ? '← 回去再读一遍' : '开始默写 →'}
                  </button>
                </div>
              )}

              {quizOn ? (
                /* 默写题单：原形去重，每空回车/失焦即判；看答案 = 没想起（灰） */
                <div className="mt-2.5 grid grid-cols-1 gap-2 md:grid-cols-2">
                  {gapItems.map((item, i) => {
                    const st = gapStates[i] ?? { text: '', status: 'pending' as const, hint: 0 as const }
                    const ansText =
                      st.status === 'bad'
                        ? `答案 ${item.form}`
                        : st.status === 'revealed'
                          ? '没想起'
                          : st.hint >= 2
                            ? transMap?.[item.w] ?? ''
                            : ''
                    return (
                      <div
                        key={item.w}
                        className={cn(
                          'flex min-w-0 items-center gap-2.5 rounded-[12px] border px-3 py-2',
                          st.status === 'ok' && 'border-emerald-500/60 bg-emerald-500/[0.06]',
                          st.status === 'bad' && 'border-danger/60 bg-[rgb(var(--danger)/0.06)]',
                          st.status !== 'ok' && st.status !== 'bad' && 'border-line bg-surface-subtle',
                        )}
                      >
                        <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-content-muted">{i + 1}</span>
                        <input
                          value={st.text}
                          onChange={(e) =>
                            setGap(i, (s) => ({
                              ...s,
                              text: e.target.value,
                              status: s.status === 'ok' || s.status === 'revealed' ? s.status : 'pending',
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              judgeOne(i)
                            }
                          }}
                          onBlur={() => judgeOne(i)}
                          disabled={st.status === 'revealed'}
                          placeholder={st.hint >= 1 ? `${item.form[0]}…` : ''}
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          aria-label={`默写 ${item.w}`}
                          className="min-w-0 flex-1 border-b border-line-strong bg-transparent pb-0.5 text-center text-[16px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent disabled:text-content-muted"
                        />
                        <button
                          type="button"
                          onClick={() => setGap(i, (s) => ({ ...s, hint: Math.min(2, s.hint + 1) as 0 | 1 | 2 }))}
                          disabled={st.hint >= 2 || st.status === 'revealed'}
                          title={st.hint === 0 ? '首字母提示' : '中文释义'}
                          aria-label={st.hint === 0 ? '首字母提示' : '中文释义'}
                          className="h-7 w-7 shrink-0 rounded-full border border-line text-[11px] text-content-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                        >
                          {st.hint === 0 ? '?' : '中'}
                        </button>
                        <span className="w-[76px] shrink-0 truncate text-right text-[11px] leading-tight text-content-muted">
                          {ansText}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="mt-1.5 whitespace-pre-wrap text-[15px] leading-[1.7] text-content-primary">
                  <Highlighted text={data.body} />
                </div>
              )}

              {!quizOn && data.translation && (
                <div className="mt-4 border-t border-line pt-3">
                  <button
                    type="button"
                    onClick={() => setShowZh((v) => !v)}
                    className="flex items-center gap-1 text-[11.5px] text-content-muted transition-colors hover:text-content-secondary"
                  >
                    {showZh ? '收起译文' : '看中文译文'}
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      className={cn('h-3 w-3 transition-transform', showZh && 'rotate-180')}
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  {showZh && (
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-content-secondary">
                      {plain(data.translation)}
                    </p>
                  )}
                </div>
              )}

              {!quizOn && (data.reviewWords?.length || data.previewWords?.length) && (
                <div className="mt-3 space-y-1 text-[11px] leading-relaxed text-content-muted">
                  {data.reviewWords?.length ? <div>顺手复习：{data.reviewWords.join(' · ')}</div> : null}
                  {data.previewWords?.length ? <div>明天预习：{data.previewWords.join(' · ')}</div> : null}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-5 py-2.5">
          {!quizOn && (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setWithReview((v) => !v)}
                title="加几个今天到期、已经学过的词（顺手复核）"
                className={cn(
                  'rounded-full border px-2.5 py-[3px] text-[11px] font-medium transition-colors',
                  withReview
                    ? 'border-accent/50 bg-accent-soft text-accent'
                    : 'border-line text-content-muted hover:text-content-secondary',
                )}
              >
                复习 {withReview ? REVIEW_COUNT : 0}
              </button>
              <button
                type="button"
                onClick={() => setWithPreview((v) => !v)}
                title="加几个明天才学的词（提前眼熟）"
                className={cn(
                  'rounded-full border px-2.5 py-[3px] text-[11px] font-medium transition-colors',
                  withPreview
                    ? 'border-accent/50 bg-accent-soft text-accent'
                    : 'border-line text-content-muted hover:text-content-secondary',
                )}
              >
                预习 {withPreview ? PREVIEW_COUNT : 0}
              </button>
            </div>
          )}
          {quizOn && (
            <>
              <button
                type="button"
                onClick={revealAll}
                className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-[12px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
              >
                看答案
              </button>
              <span className="min-w-0 flex-1" />
            </>
          )}
          {!quizOn && (
            <>
              <button
                type="button"
                disabled={loading || !data}
                onClick={() => window.print()}
                className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-[12px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-50"
              >
                打印
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => void load(true)}
                className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-[12px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-50"
              >
                重新生成
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-accent-foreground"
          >
            {quizOn ? (gapDone ? '做完了' : '先不做了') : '看完了'}
          </button>
        </div>
      </div>

      {/* 打印副本：挂在 body 上，打印时只留它（屏幕上看不到） */}
      {mounted &&
        data &&
        createPortal(
          <>
            <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
            <div className="passage-print">
              {/* 品牌钤印(与拟卷卷面同款):屏下隐藏,打印时随纸面转纯黑 */}
              <PaperBrandSeal />
              <div className="pp-head">
                <div className="pp-title">{data.title}</div>
                <div className="pp-sub">
                  {data.titleZh ? `${data.titleZh} · ` : ''}
                  今天 {words.length} 个词 · {new Date().toLocaleDateString('zh-CN')}
                </div>
              </div>
              <div className="pp-body">
                <Highlighted text={data.body} printMode />
              </div>
              {data.translation && (
                <div className="pp-zh">
                  <div className="pp-h">中文译文</div>
                  {plain(data.translation)}
                </div>
              )}
              <div className="pp-foot">
                <span>今天用到的词：{words.join(' · ')}</span>
                <span>aichatt · 背词卷</span>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}
