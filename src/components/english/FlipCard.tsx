'use client'

/**
 * 快认卡（方案 A「居中沉浸」定稿）——真的是一张卡：
 * 正面词形 + 音标 + 词性/标签，翻面看释义、例句、搭配；卡片后面垫两张纸表示牌堆，
 * 点击卡片或按空格翻面（3D rotateY，时长走 --motion-slow）。
 *
 * 只在「已翻面」后由父组件展示四档评级，卡面本身不塞按钮、不塞进度条。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { asCollocations, asExamples, asSenses, meaningText, type WordQueueItem } from '@/lib/words/types'
import { speakWord } from '@/lib/words/speech'

export function SpeakerIcon({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      aria-label="朗读"
      onClick={onClick}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 5 6 9H3v6h3l5 4z" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      </svg>
    </button>
  )
}

/** 常考短语星标(书里划重点的数字化) */
function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-3 w-3 shrink-0 self-center text-accent" fill="currentColor">
      <path d="M12 3.6l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8z" />
    </svg>
  )
}

/** 义项文本里的英文括注（to carry or move sth.…）降级为浅色小字：纯展示层拆分，不动数据 */
function SenseMeaning({ text }: { text: string }) {
  const notes = text.match(/（[^）]*[A-Za-z][^）]*）/g) ?? []
  const parts = text.split(/（[^）]*[A-Za-z][^）]*）/g)
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {notes[i] && <span className="text-[11.5px] text-content-muted">{notes[i]}</span>}
        </span>
      ))}
    </>
  )
}

function Chips({ item }: { item: WordQueueItem }) {
  const chips = [item.pos, ...item.tags.slice(0, 3)].filter(Boolean) as string[]
  if (!chips.length) return null
  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      {chips.map((c, i) => (
        <span
          key={`${c}-${i}`}
          className="rounded-full border border-line bg-surface-muted px-2.5 py-[2px] text-[11px] text-content-secondary"
        >
          {c}
        </span>
      ))}
    </div>
  )
}

export function FlipCard({
  item,
  flipped,
  onFlip,
  lockedBack = false,
}: {
  item: WordQueueItem
  flipped: boolean
  onFlip: () => void
  /** 学新讲义卡:锁定背面,底注换讲义语境(没有 1-4 评级) */
  lockedBack?: boolean
}) {
  const examples = asExamples(item.examples).slice(0, 2)
  const senses = asSenses(item.senses)
  const hasCoreSense = senses.some((s) => s.core)
  const collocations = asCollocations(item.collocations)
  const corePhrases = collocations.filter((c) => c.core).slice(0, 5)
  const extPhrases = collocations.filter((c) => !c.core)
  const [extOpen, setExtOpen] = useState(false)
  // 义项折叠（2026-11-16 用户点单）：默认只显示常考义（蓝色高亮部分），其余收进折叠条；
  // 没有任何常考标记的词条不折叠（全显示，不能让背面只剩空卡）
  const [sensesOpen, setSensesOpen] = useState(false)
  const coreSenses = hasCoreSense ? senses.filter((s) => s.core) : senses
  const extraSenses = hasCoreSense ? senses.filter((s) => !s.core) : []
  const shownSenses = sensesOpen ? senses : coreSenses
  // 助记：本地状态先吃 item.mnemonic，保存成功后立刻反映到卡面（不必等整队刷新）
  const [mnemonic, setMnemonic] = useState(item.mnemonic ?? '')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const saveMnemonic = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/words/mnemonic', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userWordId: item.id, mnemonic: draft.trim() }),
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || `HTTP ${res.status}`)
      }
      const d = (await res.json()) as { mnemonic: string | null }
      setMnemonic(d.mnemonic ?? '')
      setEditing(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [draft, item.id])

  const ipa = item.phoneticUs || item.phoneticUk
  // 释义里常自带词性前缀（"v. 放弃"），正面已单独显示词性时去掉，避免 "v" + "v. 放弃" 重复
  const meaning = useMemo(() => meaningText(item.trans, item.pos), [item.pos, item.trans])

  // 口音跟音标走:只有英音音标用英音发音人,其余默认美音
  const accent: 'us' | 'uk' = item.phoneticUk && !item.phoneticUs ? 'uk' : 'us'
  const onSpeak = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      speakWord(item.headword, { lang: accent })
    },
    [accent, item.headword],
  )

  // 新卡出现自动朗读一遍（每张卡只播一次，翻回正面不重播；2026-11-17 用户点单：学新讲义卡也自动播）。
  // ref 去重拦 dev StrictMode 双挂载的第二次 effect；浏览器若拦截无手势自动播放，
  // speakWord 内部会静默兜底，不影响翻卡。
  const autoSpokenRef = useRef(false)
  useEffect(() => {
    if (autoSpokenRef.current) return
    autoSpokenRef.current = true
    void speakWord(item.headword, { lang: accent })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  const face =
    'absolute inset-0 flex flex-col rounded-sheet border border-line bg-surface dark:border-line-strong dark:bg-surface-subtle [backface-visibility:hidden] overflow-hidden'

  return (
    <div className="relative mx-auto w-full max-w-[560px]">
      {/* 牌堆：后面垫两张纸，卡才像拿在手上的一张牌 */}
      <div aria-hidden className="absolute inset-x-4 top-3 h-full rounded-sheet border border-line bg-surface-muted opacity-50" />
      <div aria-hidden className="absolute inset-x-2 top-1.5 h-full rounded-sheet border border-line bg-surface-muted opacity-75" />

      <div className="relative [perspective:1400px]">
        <div
          className="relative h-[352px] w-full cursor-pointer select-none [transform-style:preserve-3d] [will-change:transform] md:h-[392px]"
          style={{
            transform: flipped ? 'rotateY(180deg)' : 'none',
            transition: 'transform var(--motion-slow) var(--ease)',
          }}
          onClick={onFlip}
          role="button"
          tabIndex={0}
          aria-label={flipped ? '翻回正面' : '翻面看释义'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onFlip()
          }}
        >
          {/* 正面 */}
          <div className={face}>
            <div className="flex items-center justify-between px-5 pt-4">
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'rounded-full px-2.5 py-[3px] text-[11px] font-medium',
                    item.reps === 0 ? 'bg-accent-soft text-accent' : 'bg-surface-muted text-content-secondary',
                  )}
                >
                  {item.reps === 0 ? '新词' : item.reps < 3 ? '学习中' : '复习'}
                </span>
                {item.isPhrase && (
                  <span className="rounded-full border border-accent/45 px-2.5 py-[3px] text-[11px] font-medium text-accent">
                    短语
                  </span>
                )}
              </div>
              {item.mastery > 0 && (
                <span className="text-[11px] tabular-nums text-content-muted">掌握 {Math.round(item.mastery * 100)}%</span>
              )}
            </div>

            <div className="flex flex-1 flex-col items-center justify-center px-6 pb-4">
              <div
                className={cn(
                  'max-w-full break-words text-center font-bold tracking-[-0.02em]',
                  // 短语比单词长：降字号、放松行距，允许折行成两行
                  item.isPhrase ? 'text-[30px] leading-[1.25] md:text-[38px]' : 'text-[44px] leading-tight md:text-[54px]',
                )}
              >
                {item.headword}
              </div>
              {ipa && (
                <div className="mt-2 flex items-center gap-2 text-[15px] text-content-secondary">
                  <span>{ipa}</span>
                  <SpeakerIcon onClick={onSpeak} />
                </div>
              )}
              <div className="mt-4">
                <Chips item={item} />
              </div>
            </div>

            <div className="pb-4 text-center text-[11.5px] text-content-muted">
              {item.isPhrase ? '短语只考认读，不考拼写 · 点击卡片翻面' : '点击卡片或按空格翻面'}
            </div>
          </div>

          {/* 背面 */}
          <div className={cn(face, '[transform:rotateY(180deg)]')}>
            <div className="flex items-baseline justify-between px-5 pt-4">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'break-words font-bold leading-snug tracking-[-0.01em]',
                      item.isPhrase ? 'text-[18px]' : 'text-[22px]',
                    )}
                  >
                    {item.headword}
                  </span>
                  {item.isPhrase && <span className="shrink-0 text-[11px] text-accent">短语</span>}
                </div>
                {ipa && (
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-content-secondary">
                    <span>{ipa}</span>
                    <SpeakerIcon onClick={onSpeak} />
                  </div>
                )}
              </div>
            </div>

            <div className="mt-3 flex-1 overflow-y-auto px-5">
              {/* pb-3：展开长队列时底部裁切落在空白处，不出现半截字 */}
              <div className="border-t border-line pb-3 pt-3">
                {senses.length > 0 ? (
                  /* 义项逐条分行（同题卡小问拆行规范）：词性对齐行首，英文括注降级浅色小字 */
                  <div className="space-y-1 text-[13px] leading-relaxed text-content-primary">
                    {shownSenses.map((s, i) => (
                      <div key={i} className="flex items-baseline gap-1.5">
                        <span className="w-9 shrink-0 text-[11px] font-medium text-content-muted">{s.pos ?? ''}</span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              s.core &&
                                'rounded-[4px] bg-[rgb(var(--accent)/0.10)] px-0.5 [box-decoration-break:clone] [-webkit-box-decoration-break:clone]',
                            )}
                          >
                            <SenseMeaning text={s.meaning} />
                          </span>
                        </span>
                      </div>
                    ))}
                    {extraSenses.length > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSensesOpen((v) => !v)
                        }}
                        className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-[8px] border border-dashed border-line-strong py-1.5 text-[11.5px] text-content-secondary transition-colors hover:border-accent hover:text-accent"
                      >
                        {sensesOpen ? '收起' : `展开其余 ${extraSenses.length} 个义项`}
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={cn('h-3 w-3 transition-transform', sensesOpen && 'rotate-180')}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="text-[17px] font-semibold leading-snug">
                    {item.pos && <span className="mr-1.5 text-[13px] font-medium text-content-muted">{item.pos}</span>}
                    {meaning || item.definition || '（这个词还没有释义）'}
                  </div>
                )}
                {senses.length === 0 && item.definition && meaning && (
                  <div className="mt-1 text-[12.5px] leading-relaxed text-content-secondary">{item.definition}</div>
                )}
                {(hasCoreSense || corePhrases.length > 0) && (
                  <div className="mt-1.5 text-[10.5px] leading-relaxed text-content-muted">
                    高亮 = 常考义项{corePhrases.length > 0 ? ' · 星标 = 常考短语，扩展只扫不背' : ''}
                  </div>
                )}

                {/* 助记：一句话联想/口诀，短语尤其需要。可现场写，存在字典词条上 */}
                <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium tracking-wide text-content-muted">助记</span>
                    {!editing && (
                      <button
                        type="button"
                        onClick={() => {
                          setDraft(mnemonic)
                          setEditing(true)
                        }}
                        className="text-[11px] text-content-muted transition-colors hover:text-accent"
                      >
                        {mnemonic ? '改写' : '＋ 写一条'}
                      </button>
                    )}
                  </div>

                  {editing ? (
                    <div className="mt-1">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        maxLength={500}
                        rows={2}
                        autoFocus
                        placeholder={item.isPhrase ? '给这个短语写一句联想，如：飞机 take off 起飞，外套 take off 脱下' : '写一句能让你想起它的联想或口诀'}
                        className="w-full resize-none rounded-[8px] border border-line bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent"
                      />
                      <div className="mt-1.5 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void saveMnemonic()}
                          className="rounded-full bg-accent px-3 py-1 text-[11.5px] font-semibold text-accent-foreground disabled:opacity-60"
                        >
                          {saving ? '保存中…' : '保存'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(false)}
                          className="rounded-full border border-line px-3 py-1 text-[11.5px] text-content-secondary"
                        >
                          取消
                        </button>
                        {saveError && <span className="text-[11px] text-danger">{saveError}</span>}
                      </div>
                    </div>
                  ) : mnemonic ? (
                    <div className="mt-1 rounded-[8px] border-l-[3px] border-accent/50 bg-surface-muted px-2.5 py-1.5 text-[12.5px] leading-relaxed text-content-primary">
                      {mnemonic}
                    </div>
                  ) : null}
                </div>

                {collocations.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] font-medium tracking-wide text-content-muted">
                      助记短语{corePhrases.length > 0 ? ` · 核心星标 ${corePhrases.length}` : ` · ${collocations.length}`}
                    </div>
                    <div className="mt-1">
                      {corePhrases.map((c) => (
                        <div key={c.en} className="flex items-baseline gap-1.5 py-[3px]">
                          <StarIcon />
                          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-content-primary">{c.en}</span>
                          {c.zh && <span className="max-w-[46%] shrink-0 truncate text-[11px] text-content-secondary">{c.zh}</span>}
                        </div>
                      ))}
                      {extOpen &&
                        extPhrases.map((c) => (
                          <div key={c.en} className="flex items-baseline gap-1.5 py-[3px]">
                            <span className="h-3 w-3 shrink-0 self-center" />
                            <span className="min-w-0 flex-1 truncate text-[12px] text-content-secondary">{c.en}</span>
                            {c.zh && <span className="max-w-[46%] shrink-0 truncate text-[11px] text-content-secondary">{c.zh}</span>}
                          </div>
                        ))}
                    </div>
                    {extPhrases.length > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setExtOpen((v) => !v)
                        }}
                        className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-[8px] border border-dashed border-line-strong py-1.5 text-[11.5px] text-content-secondary transition-colors hover:border-accent hover:text-accent"
                      >
                        {extOpen ? '收起' : `扩展 ${extPhrases.length} 条（只扫不背）`}
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={cn('h-3 w-3 transition-transform', extOpen && 'rotate-180')}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                    )}
                  </div>
                )}

                {examples.length > 0 && (
                  <ul className="mt-3 space-y-1.5 pb-1">
                    {examples.map((ex, i) => (
                      <li key={i} className="text-[13px] leading-relaxed text-content-secondary">
                        <span className="font-medium text-content-primary">{ex.en}</span>
                        {ex.zh && <span className="ml-1.5">{ex.zh}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="px-5 pb-4 pt-2 text-center text-[11.5px] text-content-muted">
              {lockedBack ? '讲义卡 · 读完用下方按钮继续' : '按 1-4 或点下方按钮评级'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
