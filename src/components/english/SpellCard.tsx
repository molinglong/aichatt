'use client'

/**
 * 拼写卡 —— 中文释义 → 敲英文。
 * 判分规则（与后端 deriveSpellRating 对齐）：
 *   首次拼对 → 按用时给 认识/秒答；拼错则清空输入、必须整词重打，
 *   重打正确后**按「忘记」结算**（错过的词不能靠第二次蒙对变结实）。
 *
 * 学新小测模式（design/preview-word-learn-flow.html A+Alan 案，2026-11-15 挑中）：
 *   practice=false 且传了 onFirstFail：首次拼错 → 显示「回讲解重学」，点击后由
 *   工作台记「忘记」并切回讲解卡，重学后再拼只算练习（onPractice 收尾，不再提交排期）。
 *   发音按钮 = 提示：点了之后即使拼对，后端也按「忘记」结算（Alan 式独立回忆判定，
 *   第一次无提示的回忆才是 FSRS 的输入）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { meaningText, spellSenses, type WordQueueItem } from '@/lib/words/types'
import { speakWord } from '@/lib/words/speech'
import { SpeakerIcon } from './FlipCard'

/** 判定口径（2026-11-17 放宽）：小写后只保留字母数字参与比对。
 *  输入法/复制把标点（】'等）、汉字等噪音带进输入框不再误判；
 *  词组空格也不再强制（give up ≡ giveup）——拼写核的是字母序列本身。 */
function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 首个错位下标（用于「第 N 个字母错了」） */
function firstDiff(a: string, b: string) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n
}

export function SpellCard({
  item,
  onResult,
  onFirstFail,
  onPractice,
  practice = false,
  badgeLabel,
}: {
  item: WordQueueItem
  /** graded 轮：onResult(firstTry, elapsedMs, hintUsed)——提交排期 */
  onResult: (firstTry: boolean, elapsedMs: number, hintUsed: boolean) => void
  /** 学新小测：首次拼错后「回讲解重学」按钮的回调（工作台记忘记并切讲解）；不传 = 复习卡现款行为 */
  onFirstFail?: () => void
  /** 重学后的再拼：拼对收尾，不再提交排期 */
  onPractice?: () => void
  practice?: boolean
  badgeLabel?: string
}) {
  const [value, setValue] = useState('')
  const [attempts, setAttempts] = useState(0)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'bad'; text: string; sub?: string; at?: number } | null>(null)
  const [failedFirst, setFailedFirst] = useState(false)
  const [hintUsed, setHintUsed] = useState(false)
  const startRef = useRef(Date.now())
  const inputRef = useRef<HTMLInputElement>(null)
  const lockedRef = useRef(false)

  const answer = item.headword || item.lemma
  // 提示释义（design/preview-spell-meaning.html B 案，2026-11-16）：打印单同款压缩，
  // 保留 ①②③ 编号、只留前三个有实义的义项；压不出段时回退原释义/definition
  const senses = useMemo(() => spellSenses(item.trans, 3), [item.trans])
  const hint = useMemo(() => {
    const n = answer.replace(/\s/g, '').length
    const first = answer[0] ?? ''
    return `首字母 ${first} · ${n} 个字母${answer.includes(' ') ? ' · 含空格' : ''}`
  }, [answer])

  // 口音跟音标走:只有英音音标用英音发音人,其余默认美音
  const accent: 'us' | 'uk' = item.phoneticUk && !item.phoneticUs ? 'uk' : 'us'
  const onSpeak = useCallback(() => {
    setHintUsed(true)
    speakWord(answer, { lang: accent })
  }, [accent, answer])

  // 新卡出现自动朗读一遍（每张卡只播一次，重学重试的练习卡是新实例会再播）。
  // 注意不占「提示」：听到读音当作记忆辅助，点右上发音按钮才算用提示（拼对也按忘记结算）。
  // ref 去重拦 dev StrictMode 双挂载；浏览器拦截无手势自动播放时 speakWord 内部静默兜底，不影响拼卡。
  const autoSpokenRef = useRef(false)
  useEffect(() => {
    startRef.current = Date.now()
    inputRef.current?.focus()
    if (!autoSpokenRef.current) {
      autoSpokenRef.current = true
      speakWord(answer, { lang: accent })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (lockedRef.current) return
    const typed = normalize(value)
    if (!typed) return

    if (typed === normalize(answer)) {
      lockedRef.current = true
      const elapsed = Date.now() - startRef.current
      const firstTry = attempts === 0
      if (practice) {
        // 重学后的再拼：只算练习，不给排期
        setFeedback({ kind: 'ok', text: '重学通过', sub: '这次不算排期，明天小测见' })
        window.setTimeout(() => onPractice?.(), 500)
        return
      }
      setFeedback({
        kind: 'ok',
        text: firstTry ? (hintUsed ? '拼对了（用了发音提示）' : '拼对了') : '重打正确',
        sub: firstTry
          ? hintUsed
            ? '提示后不算独立回忆——本次按「忘记」结算，明天还会见到它'
            : ''
          : '本次按「忘记」结算，明天还会见到它',
      })
      // 给一眼正反馈的时间，再进下一张
      window.setTimeout(() => onResult(firstTry, elapsed, hintUsed), firstTry ? 420 : 700)
      return
    }

    const at = firstDiff(typed, normalize(answer))
    // 报错回显原输入（保留标点等噪音），一眼看出多打了什么；超长截断
    const showTyped = value.trim().slice(0, 60)
    const isFirstFail = attempts === 0 && !!onFirstFail && !practice
    setAttempts((n) => n + 1)
    if (isFirstFail) {
      // 学新小测：首错不重打——看清正确拼写后回讲解重学（工作台记忘记）
      setFailedFirst(true)
      setFeedback({ kind: 'bad', text: `第 ${at + 1} 个字母错了`, sub: `你写 ${showTyped}，正确是 ${answer}`, at })
      return
    }
    setFeedback({
      kind: 'bad',
      text: `第 ${at + 1} 个字母错了`,
      sub: `你写 ${showTyped}，正确是 ${answer}`,
      at,
    })
    setValue('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  return (
    <div className="relative mx-auto w-full max-w-[560px]">
      <div aria-hidden className="absolute inset-x-4 top-3 h-full rounded-sheet border border-line bg-surface-muted opacity-50" />
      <div aria-hidden className="absolute inset-x-2 top-1.5 h-full rounded-sheet border border-line bg-surface-muted opacity-75" />

      <form
        onSubmit={submit}
        className="relative flex min-h-[300px] flex-col rounded-sheet border border-line bg-surface px-6 pb-6 pt-5 dark:border-line-strong dark:bg-surface-subtle md:min-h-[330px]"
      >
        <div className="flex items-center justify-between">
          <span className="rounded-full bg-surface-muted px-2.5 py-[3px] text-[11px] text-content-secondary">
            {badgeLabel ? `${badgeLabel} · ${attempts > 0 ? '再拼一次' : '拼写'}` : attempts > 0 ? '再拼一次' : '拼写'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSpeak}
              aria-label="朗读发音（会计入提示）"
              title="朗读发音（点了算用提示）"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-line text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 5 6 9H3v6h3l5 4z" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
              </svg>
            </button>
            {item.mastery > 0 && (
              <span className="text-[11px] tabular-nums text-content-muted">掌握 {Math.round(item.mastery * 100)}%</span>
            )}
          </div>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center py-4 text-center">
          <div className="text-[12px] text-content-muted">{hint}</div>
          <div className="mt-2 text-[25px] font-bold leading-[1.4] tracking-[-0.01em]">
            {senses.length > 0
              ? senses.join('　')
              : meaningText(item.trans, item.pos) || item.definition || '（缺释义）'}
          </div>
        </div>

        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            disabled={failedFirst}
            placeholder={failedFirst ? '拼错了——先回讲解重学' : '输入英文，回车检查'}
            className={cn(
              'h-12 min-w-0 flex-1 rounded-full border bg-surface px-3.5 text-[18px] tracking-[0.01em] text-content-primary outline-none transition-colors placeholder:text-content-muted disabled:opacity-60 dark:bg-surface-muted',
              feedback?.kind === 'bad' ? 'border-danger' : 'border-line-strong focus:border-accent',
            )}
          />
          {failedFirst && onFirstFail ? (
            <button
              type="button"
              onClick={() => onFirstFail()}
              className="h-12 shrink-0 rounded-full border border-line-strong px-4 text-[13px] font-semibold text-content-primary transition-colors hover:border-accent"
            >
              回讲解重学
            </button>
          ) : (
            <button
              type="submit"
              className="h-12 w-[72px] shrink-0 rounded-full bg-accent text-[14px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 md:w-[84px]"
            >
              检查
            </button>
          )}
        </div>

        <div className="mt-3 min-h-[46px]">
          {feedback?.kind === 'ok' && (
            <div className="rounded-control border border-accent/40 bg-accent-soft px-3 py-2 text-[13px] font-medium text-accent">
              {feedback.text}
              {feedback.sub && <span className="ml-2 font-normal">{feedback.sub}</span>}
            </div>
          )}
          {feedback?.kind === 'bad' && (
            <div className="rounded-control border border-danger/50 bg-[rgb(var(--danger)/0.08)] px-3 py-2 text-[13px] text-danger">
              <span className="font-semibold">{feedback.text}</span>
              <span className="ml-2">{feedback.sub}</span>
              {!failedFirst && <div className="mt-0.5 text-[11.5px] opacity-80">已清空，请整词重打一遍</div>}
            </div>
          )}
          {!feedback && (
            <div className="px-1 text-[11.5px] leading-relaxed text-content-muted">
              {practice
                ? '重学练习：拼对就进下一个，不再计排期。'
                : '拼错不计「认识」。第一次就拼对，才按用时算认识/秒答；点发音算用提示。'}
            </div>
          )}
        </div>
      </form>
    </div>
  )
}
