'use client'

/**
 * 背词卷的屏幕工具条（打印时整条隐藏）：
 * 词源分段（新词/复习/混合）/ 词单 / 起止词号 / 版式 / 助记开关 / 打印。
 * 智能选词（2026-11-16 方案 A 定案）：新词·按计划时词单/词号框换成
 * 「按计划 · 今日新词 N」徽章 + 手动选段出口；复习态词源是到期词集，
 * 词单/词号不适用，整块换成到期徽章；混合态（2026-11-18）换成
 * 「按计划 · 复习 N + 新词 M」徽章——词源是到期词集+计划新词，同样不适用词单/词号。
 * 一切状态都在 URL 上（可收藏、可分享、刷新不丢），改参数即 router.replace。
 */
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { SHEET_MODE_META, type SheetMode } from '@/lib/words/sheet'

export interface SheetListOption {
  slug: string
  name: string
  wordCount: number
}

export function WordSheetToolbar({
  lists,
  source,
  smartCount,
  mixInfo,
  dueCount,
  mode,
  from,
  to,
  showMnemonic,
  showColls,
  includePassage,
  passageState,
  showShuffle,
  shuffled,
  includeDialogue,
  dialogueHint,
  dialogueState,
  baseWords,
}: {
  lists: SheetListOption[]
  /** 词源：new=新词卷（默认）| review=今日复习卷 | mix=今日任务混合卷（2026-11-18） */
  source: 'new' | 'review' | 'mix'
  /** 非 null = 新词按计划自动选取（智能态：词单/词号框换成徽章 + 手动选段出口） */
  smartCount: number | null
  /** 混合态两节词数与计划可用性；非混合态恒 null（词源是到期词集+计划新词，徽章替代词单/词号） */
  mixInfo: { review: number; fresh: number; hasPlan: boolean } | null
  /** 今日到期词数（复习角标/徽章；已按每日复习配额截断，= 卷面实际印的词数） */
  dueCount: number
  mode: SheetMode
  from: number
  to: number
  showMnemonic: boolean
  /** 印搭配短语（col=1 默认开）：词库 collocations 考点搭配，仅 A/D 生效 */
  showColls: boolean
  /** 是否把 AI 短文附在这张纸后面 */
  includePassage: boolean
  /** ready=缓存里已有这篇；missing=还没生成过 */
  passageState: 'ready' | 'missing'
  /** B/D 默写类版式才出「打乱词序」（A 对照单、C 折叠单要保持词表顺序） */
  showShuffle: boolean
  shuffled: boolean
  /** 是否附「今日对话」挖空页 */
  includeDialogue: boolean
  dialogueHint: 'none' | 'first' | 'zh'
  /** ready=缓存里已有这篇对话；missing=还没生成过 */
  dialogueState: 'ready' | 'missing'
  /** 当前这页的词（生成短文/对话时作基础词） */
  baseWords: string[]
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [dlgGenerating, setDlgGenerating] = useState(false)
  const [dlgError, setDlgError] = useState<string | null>(null)
  // ⚙ 选项面板开关（低频设置收进来，主条保单行——两行悬浮是反人类的根源）
  const [optsOpen, setOptsOpen] = useState(false)
  const optsRef = useRef<HTMLDivElement | null>(null)

  // 滚动边缘(2026-11-18 用户口径):静止时条融进纸面,词表从条下滑过才浮出细灰框。
  // 只有锁定期皮肤用它(html[data-fl-locked] 门),普通肤色下页签本就常驻描边。
  const barRef = useRef<HTMLDivElement | null>(null)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const scroller = barRef.current?.closest('.ws-scroll') as HTMLElement | null
    if (!scroller) return
    const onScroll = () => setScrolled(scroller.scrollTop > 2)
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])

  // 点面板/⚙ 按钮之外关闭 + Esc 关闭。
  // 用 document pointerdown + contains 判断而不是 fixed 遮罩：
  // 卡片有 backdrop-blur，blur 祖先会让 fixed 遮罩定位退化（踩过的坑）。
  useEffect(() => {
    if (!optsOpen) return
    const onDown = (e: PointerEvent) => {
      if (optsRef.current && !optsRef.current.contains(e.target as Node)) setOptsOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOptsOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [optsOpen])

  /**
   * 纸上要附短文但还没生成过：现场生成一篇（落缓存），再刷新这一页。
   * 掺词必须 0/0：/papers/words 查缓存按「只围绕这批词」的 key（与 App 弹层默认同口径），
   * 这里掺了复习/预习词 key 就对不上——生成成功也永远挂不到这张卷子后面，
   * 表现就是「点了没反应」（2026-11-16 修，根因即此）；失败原先也静默，一并补错误显示。
   */
  const generatePassage = async (force = false) => {
    setGenerating(true)
    setGenError(null)
    try {
      const res = await fetch('/api/words/passage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ words: baseWords, reviewCount: 0, previewCount: 0, refresh: force }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        setGenError(data?.error ?? `生成失败（HTTP ${res.status}）`)
        return
      }
      router.refresh()
    } catch {
      setGenError('网络异常，生成失败')
    } finally {
      setGenerating(false)
    }
  }

  /**
   * 附对话但还没生成过：随机抽 5 个词让 AI 写一段日常对话（落缓存），再带 seed 刷新。
   * seed 必须回填 URL（dseed=…）：/papers/words 按「同一份词表 + 同一 seed」抽出同一批词
   * 算同一个缓存 key，少了 dseed 页面抽的词对不上，永远读不到刚生成的那篇。
   */
  const generateDialogue = async () => {
    if (baseWords.length < 3) {
      setDlgError('至少需要 3 个词才能串成对话')
      return
    }
    setDlgGenerating(true)
    setDlgError(null)
    try {
      const seed = Date.now()
      const res = await fetch('/api/words/dialogue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ words: baseWords, seed, count: 5 }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        setDlgError(data?.error ?? `生成失败（HTTP ${res.status}）`)
        return
      }
      update({ dseed: String(seed) })
    } catch {
      setDlgError('网络异常，生成失败')
    } finally {
      setDlgGenerating(false)
    }
  }

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString())
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k)
        else next.set(k, v)
      }
      router.replace(`/papers/words?${next.toString()}`)
    },
    [params, router],
  )

  // 悬浮圆条 + ⚙ 收纳（2026-11-17 定案）：主条只留高频操作保单行，
  // 低频设置（助记/打乱/附短文/附对话）进 ⚙ 面板——两行悬浮挡词表是反人类的根源。
  return (
    <div className="ws-noprint sticky top-0 z-20 px-4 pt-3.5">
      <div ref={barRef} data-ws-scrolled={scrolled ? '' : undefined} className="fl-ws-bar mx-auto flex max-w-[900px] flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface/95 px-3 py-2.5 text-[12.5px] shadow-[0_1px_3px_rgb(0_0_0/0.18)] backdrop-blur">
        <button
          type="button"
          onClick={() => router.push('/study')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-muted hover:text-content-primary"
          aria-label="返回"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>

        {/* 词源分段（2026-11-16 方案 A 定案；2026-11-18 加第三段「混合」）：全条第一个决策，
            新词/复习/混合一键直达。切回新词/混合时清掉显式 list/from/to——
            新词让服务端重新走「按计划」智能默认，混合压根不适用词单/词号。 */}
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => update({ src: null, from: null, to: null })}
            className={cn(
              'h-8 rounded-l-lg border px-2.5 text-[12px] transition-colors',
              source === 'new'
                ? 'border-accent bg-accent-soft font-semibold text-accent'
                : 'border-line bg-surface text-content-secondary hover:border-line-strong',
            )}
          >
            新词
          </button>
          <button
            type="button"
            onClick={() => update({ src: 'review' })}
            className={cn(
              'h-8 border border-l-0 px-2.5 text-[12px] transition-colors',
              source === 'review'
                ? 'border-accent bg-accent-soft font-semibold text-accent'
                : 'border-line bg-surface text-content-secondary hover:border-line-strong',
            )}
          >
            复习
            {dueCount > 0 && (
              <span className="ml-1 text-[10.5px] font-normal tabular-nums opacity-80">{dueCount}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => update({ src: 'mix', from: null, to: null })}
            title="今日任务：复习在前、新词在后，一张纸覆盖今天全部（需背词计划）"
            className={cn(
              'h-8 rounded-r-lg border border-l-0 px-2.5 text-[12px] transition-colors',
              source === 'mix'
                ? 'border-accent bg-accent-soft font-semibold text-accent'
                : 'border-line bg-surface text-content-secondary hover:border-line-strong',
            )}
          >
            混合
          </button>
        </div>

        {source === 'review' ? (
          // 复习态：词源是到期词集，词单/词号不适用
          <span className="inline-flex h-8 items-center rounded-lg bg-accent-soft px-2.5 text-[12px] text-accent">
            今日到期&nbsp;<b className="font-semibold tabular-nums">{dueCount}</b>&nbsp;词
          </span>
        ) : source === 'mix' ? (
          // 混合态：词源是到期词集+计划新词，词单/词号不适用；没挂计划给出口提示
          mixInfo?.hasPlan ? (
            <span className="inline-flex h-8 items-center gap-2 rounded-lg bg-surface-muted px-2.5 text-[12px] text-content-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              <span>
                按计划 ·{' '}
                <b className="font-semibold tabular-nums text-content-primary">
                  复习 {mixInfo.review} + 新词 {mixInfo.fresh}
                </b>
              </span>
            </span>
          ) : (
            <span className="inline-flex h-8 items-center rounded-lg bg-surface-muted px-2.5 text-[12px] text-content-secondary">
              混合需挂背词计划（学习台里建一个）
            </span>
          )
        ) : smartCount != null ? (
          // 智能态：不用填任何数字；「手动选段」是唯一出口，点了就回到词单+词号手动模式
          <>
            <span className="inline-flex h-8 items-center gap-2 rounded-lg bg-surface-muted px-2.5 text-[12px] text-content-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              <span>
                按计划 · <b className="font-semibold tabular-nums text-content-primary">今日新词 {smartCount}</b>
              </span>
            </span>
            <button
              type="button"
              onClick={() => update({ from: '1', to: '15' })}
              title="退出智能态，回到词单 + 起止词号手动选取"
              className="inline-flex h-8 items-center rounded-lg border border-line bg-surface px-2.5 text-[12px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
            >
              手动选段
            </button>
          </>
        ) : (
          <>
            <select
              value={params.get('list') ?? lists[0]?.slug ?? ''}
              onChange={(e) => update({ list: e.target.value, from: '1', to: '15' })}
              className="h-8 min-w-0 max-w-[220px] rounded-lg border border-line bg-surface px-2 text-[12.5px] text-content-primary outline-none focus:border-accent"
              aria-label="词单"
            >
              {lists.map((l) => (
                <option key={l.slug} value={l.slug}>
                  {l.name}（{l.wordCount}）
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1">
              <span className="text-content-muted">第</span>
              <input
                type="number"
                min={1}
                value={from}
                onChange={(e) => update({ from: String(Math.max(1, Number(e.target.value) || 1)) })}
                className="w-12 bg-transparent text-center tabular-nums text-content-primary outline-none"
                aria-label="起始词号"
              />
              <span className="text-content-muted">–</span>
              <input
                type="number"
                min={1}
                value={to}
                onChange={(e) => update({ to: String(Math.max(1, Number(e.target.value) || 1)) })}
                className="w-12 bg-transparent text-center tabular-nums text-content-primary outline-none"
                aria-label="结束词号"
              />
              <span className="text-content-muted">词</span>
            </div>
          </>
        )}

        {/* 版式（2026-11-18 用户口径）：四个并列钮收成下拉选项框——版式是低频切换，
            条上只露当前值省一截；选项文案/顺序同原钮（A 对照单 / B 默写纸 / C 折叠单 / D 英译中） */}
        <select
          value={mode}
          onChange={(e) => update({ mode: e.target.value })}
          title={SHEET_MODE_META[mode].desc}
          aria-label="版式"
          className="h-8 max-w-[220px] min-w-0 rounded-lg border border-line bg-surface px-2 text-[12px] text-content-primary outline-none focus:border-accent"
        >
          {(Object.keys(SHEET_MODE_META) as SheetMode[]).map((m) => (
            <option key={m} value={m}>
              {m} {SHEET_MODE_META[m].label}
            </option>
          ))}
        </select>

        <div className="relative shrink-0" ref={optsRef}>
          <button
            type="button"
            onClick={() => setOptsOpen((v) => !v)}
            aria-label="打印选项"
            aria-expanded={optsOpen}
            title="助记 / 打乱 / 短文 / 对话"
            className={cn(
              'relative flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
              optsOpen
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line bg-surface text-content-secondary hover:border-line-strong hover:text-content-primary',
            )}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {(includePassage || includeDialogue) && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            )}
          </button>

          {optsOpen && (
            <div className="absolute right-0 top-full z-30 mt-2 w-[300px] rounded-xl border border-line bg-surface p-3 shadow-[0_8px_28px_rgb(0_0_0/0.16)]">
              <div className="mb-1.5 text-[11px] font-semibold text-content-muted">词表</div>
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 text-content-secondary">
                  <input
                    type="checkbox"
                    checked={showMnemonic}
                    onChange={(e) => update({ mn: e.target.checked ? '1' : '0' })}
                    className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                  />
                  印助记
                </label>
                {(mode === 'A' || mode === 'D') && (
                  <label
                    className="flex items-center gap-1.5 text-content-secondary"
                    title="印词库里的考点搭配短语（核心搭配优先，每词 2 条）；每页词数会降为 20"
                  >
                    <input
                      type="checkbox"
                      checked={showColls}
                      onChange={(e) => update({ col: e.target.checked ? '1' : '0' })}
                      className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                    />
                    印搭配短语
                  </label>
                )}
                {showShuffle && (
                  <label className="flex items-center gap-1.5 text-content-secondary" title="防止「背位置不背词」：每次打印重新洗牌，序号跟着重排">
                    <input
                      type="checkbox"
                      checked={shuffled}
                      onChange={(e) => update({ sh: e.target.checked ? '1' : null })}
                      className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                    />
                    打乱词序
                  </label>
                )}
              </div>

              <div className="mb-1.5 mt-3 text-[11px] font-semibold text-content-muted">附卷内容</div>
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 text-content-secondary">
                  <input
                    type="checkbox"
                    checked={includePassage}
                    onChange={(e) => update({ psg: e.target.checked ? '1' : '0' })}
                    className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                  />
                  附 AI 短文
                </label>
                {includePassage && passageState === 'missing' && (
                  <div className="pl-5">
                    <button
                      type="button"
                      disabled={generating}
                      onClick={() => void generatePassage()}
                      className="inline-flex h-7 items-center rounded-lg border border-accent/50 bg-accent-soft px-2.5 text-[12px] font-semibold text-accent disabled:opacity-60"
                    >
                      {generating ? '生成中…' : '生成短文'}
                    </button>
                    {genError && <div className="mt-1 text-[11.5px] text-danger">{genError}</div>}
                  </div>
                )}
                {includePassage && passageState === 'ready' && (
                  <div className="flex items-center gap-2 pl-5">
                    <span className="text-[11.5px] text-content-muted">短文已在后页</span>
                    <button
                      type="button"
                      disabled={generating}
                      onClick={() => void generatePassage(true)}
                      title="对现在的短文不满意（比如太难、写跑题）就换一篇，会覆盖原来那篇"
                      className="inline-flex h-7 items-center rounded-lg border border-line px-2.5 text-[12px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-60"
                    >
                      {generating ? '生成中…' : '重新生成'}
                    </button>
                  </div>
                )}

                <label className="flex items-center gap-1.5 text-content-secondary" title="随机抽几个词串成日常对话，目标词挖空让你填，答案单独一页">
                  <input
                    type="checkbox"
                    checked={includeDialogue}
                    onChange={(e) => update({ dlg: e.target.checked ? '1' : null })}
                    className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                  />
                  附对话填空
                </label>
                {includeDialogue && (
                  <div className="space-y-2 pl-5">
                    <select
                      value={dialogueHint}
                      onChange={(e) => update({ dhl: e.target.value === 'first' ? null : e.target.value })}
                      className="h-7 w-full rounded-lg border border-line bg-surface px-1.5 text-[12px] text-content-primary outline-none focus:border-accent"
                      aria-label="挖空提示"
                    >
                      <option value="none">提示：纯空</option>
                      <option value="first">提示：首字母</option>
                      <option value="zh">提示：中文</option>
                    </select>
                    {dialogueState === 'missing' && (
                      <div>
                        <button
                          type="button"
                          disabled={dlgGenerating}
                          onClick={() => void generateDialogue()}
                          className="inline-flex h-7 items-center rounded-lg border border-accent/50 bg-accent-soft px-2.5 text-[12px] font-semibold text-accent disabled:opacity-60"
                        >
                          {dlgGenerating ? '生成中…' : '生成对话'}
                        </button>
                        {dlgError && <div className="mt-1 text-[11.5px] text-danger">{dlgError}</div>}
                      </div>
                    )}
                    {dialogueState === 'ready' && (
                      <div className="text-[11.5px] text-content-muted">对话与答案已附末页</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => window.print()}
          className="fl-ws-print ml-auto inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-4 text-[12.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9V2h12v7" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <path d="M6 14h12v8H6z" />
          </svg>
          打印
        </button>
      </div>
    </div>
  )
}
