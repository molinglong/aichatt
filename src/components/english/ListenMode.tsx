'use client'

/**
 * 听音模式（磨耳朵连播，2026-11-17 定稿 = 方案 C：design/preview-audio-mode.html）：
 *   B 骨架（大字无卡框）+ A 式控制面板；桌面（≥640px）默认展开、可收起成底部 dock，
 *   手机固定 dock。今日队列原序连播：每词读 N 遍 → 停顿报中文释义 → 下一个。
 *
 * 硬口径：纯听不记账 —— 不写 UserWord、不推 FSRS、不碰除 TTS 外的任何接口。
 * 发音走有道真人声（speakAwait，失败落浏览器朗读兜底，都失败按超时放行不断节奏）。
 * MediaSession：锁屏继续播、耳机线控/锁屏可切上一词下一词（浏览器 TTS 兜底时锁屏不保播，平台限制）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ListMusic,
  Pause,
  Play,
  Settings2,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { asSenses, meaningText, type WordQueueItem } from '@/lib/words/types'
import { speakAwait } from '@/lib/words/speech'

interface ListenModeProps {
  items: WordQueueItem[]
  listName: string | null
  onClose: () => void
}

/** 口音跟音标走：只有英音音标用英音发音人，其余默认美音（与卡面同规则） */
function accentOf(item: WordQueueItem): 'us' | 'uk' {
  return item.phoneticUk && !item.phoneticUs ? 'uk' : 'us'
}

/** 报读用清洗后的第一义项（「好处；使受益」→「好处」），屏幕显示保持全文 */
function speakMeaningOf(item: WordQueueItem): string {
  const senses = asSenses(item.senses)
  if (senses.length) return senses[0].meaning.replace(/[；;。]+$/, '').trim()
  return meaningText(item.trans, item.pos)
}

const GAP_REPEATE = 420
const GAP_BEFORE_ZH = 1100
const GAP_NEXT = 1400

export function ListenMode({ items, listName, onClose }: ListenModeProps) {
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [finished, setFinished] = useState(false)
  const [reps, setReps] = useState(2)
  const [zhOn, setZhOn] = useState(true)
  const [panelOpen, setPanelOpen] = useState(true) // 桌面面板展开态；手机由响应式规则强制 dock
  const [sheet, setSheet] = useState<'none' | 'set' | 'list'>('none')
  const [status, setStatus] = useState<{ txt: string; busy: boolean }>({ txt: '点播放开始', busy: false })
  const [revealed, setRevealed] = useState(false) // B 式释义：报中文时浮现

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const runRef = useRef(0) // 播放链令牌：暂停/跳词/换设置即作废旧链
  const shadow = useRef({ idx: 0, finished: false })
  const repsRef = useRef(reps)
  const zhRef = useRef(zhOn)

  useEffect(() => {
    repsRef.current = reps
  }, [reps])
  useEffect(() => {
    zhRef.current = zhOn
  }, [zhOn])

  const reviewCount = useMemo(() => items.filter((i) => !i.isNew).length, [items])
  const newCount = items.length - reviewCount

  const gap = useCallback(
    (ms: number, my: number) =>
      new Promise<boolean>((resolve) => {
        window.setTimeout(() => resolve(my === runRef.current), ms)
      }),
    [],
  )

  const stopAudio = useCallback(() => {
    try {
      audioRef.current?.pause()
    } catch {
      /* noop */
    }
    try {
      window.speechSynthesis?.cancel()
    } catch {
      /* noop */
    }
  }, [])

  /* ── MediaSession:锁屏续播 + 线控切词。handler 走 ref,挂载时挂一次 ── */
  const handlersRef = useRef({ toggle: () => {}, prev: () => {}, next: () => {} })
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    try {
      ms.setActionHandler('play', () => handlersRef.current.toggle())
      ms.setActionHandler('pause', () => handlersRef.current.toggle())
      ms.setActionHandler('previoustrack', () => handlersRef.current.prev())
      ms.setActionHandler('nexttrack', () => handlersRef.current.next())
    } catch {
      /* 平台不支持 */
    }
    return () => {
      try {
        ms.setActionHandler('play', null)
        ms.setActionHandler('pause', null)
        ms.setActionHandler('previoustrack', null)
        ms.setActionHandler('nexttrack', null)
      } catch {
        /* noop */
      }
    }
  }, [])

  const setMediaState = useCallback((st: 'playing' | 'paused') => {
    try {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = st
    } catch {
      /* noop */
    }
  }, [])

  /* ── 播放链:从 startIdx 起串行推进,每次 await 后先验令牌 ── */
  const playFrom = useCallback(
    async (startIdx: number) => {
      const my = ++runRef.current
      stopAudio()
      setPlaying(true)
      setFinished(false)
      shadow.current.finished = false
      setMediaState('playing')
      let i = Math.max(0, Math.min(items.length - 1, startIdx))
      for (;;) {
        if (my !== runRef.current) return
        const item = items[i]!
        shadow.current.idx = i
        setIdx(i)
        setRevealed(false)
        try {
          if ('mediaSession' in navigator && 'MediaMetadata' in window) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: item.headword,
              artist: '听音模式',
              album: listName ?? '磨耳朵',
            })
          }
        } catch {
          /* noop */
        }
        for (let r = 1; r <= repsRef.current; r++) {
          if (my !== runRef.current) return
          setStatus({ txt: repsRef.current > 1 ? `正在读 · 第 ${r} 遍` : '正在读', busy: true })
          if (audioRef.current) await speakAwait(audioRef.current, item.headword, { lang: accentOf(item) })
          if (my !== runRef.current) return
          if (r < repsRef.current && !(await gap(GAP_REPEATE, my))) return
        }
        const meaning = speakMeaningOf(item)
        if (zhRef.current && meaning) {
          if (my !== runRef.current) return
          setStatus({ txt: '释义', busy: true })
          if (!(await gap(GAP_BEFORE_ZH, my))) return
          setRevealed(true)
          if (audioRef.current) await speakAwait(audioRef.current, meaning, { lang: 'zh' })
          if (my !== runRef.current) return
        }
        if (i < items.length - 1) {
          setStatus({ txt: '下一个', busy: false })
          if (!(await gap(GAP_NEXT, my))) return
          i++
          continue
        }
        break
      }
      if (my !== runRef.current) return
      shadow.current.finished = true
      setFinished(true)
      setPlaying(false)
      setStatus({ txt: '已播完', busy: false })
      setMediaState('paused')
    },
    [gap, items, listName, setMediaState, stopAudio],
  )

  const pauseAll = useCallback(() => {
    runRef.current++
    stopAudio()
    setPlaying(false)
    setStatus({ txt: '已暂停', busy: false })
    setMediaState('paused')
  }, [setMediaState, stopAudio])

  const togglePlay = useCallback(() => {
    if (shadow.current.finished) void playFrom(0)
    else if (playing) pauseAll()
    else void playFrom(shadow.current.idx)
  }, [pauseAll, playFrom, playing])

  /** 跳词（上一个/下一个/点词列）：播完态往后跳回第 0 个重来 */
  const stepTo = useCallback(
    (target: number) => {
      const next = shadow.current.finished ? 0 : target
      if (next < 0 || next > items.length - 1) {
        pauseAll()
        return
      }
      void playFrom(next)
    },
    [items.length, pauseAll, playFrom],
  )

  const jumpTo = useCallback(
    (i: number) => {
      setSheet('none')
      stepTo(i)
    },
    [stepTo],
  )

  handlersRef.current = {
    toggle: togglePlay,
    prev: () => stepTo(shadow.current.idx - 1),
    next: () => stepTo(shadow.current.idx + 1),
  }

  /* 换设置即时生效：重播当前词（从第 1 遍起） */
  const changeReps = useCallback(
    (n: number) => {
      setReps(n)
      if (playing && !shadow.current.finished) void playFrom(shadow.current.idx)
    },
    [playFrom, playing],
  )
  const toggleZh = useCallback(() => {
    setZhOn((v) => !v)
    if (playing && !shadow.current.finished) void playFrom(shadow.current.idx)
  }, [playFrom, playing])

  /* 卸载/退出:停声 + 作废链 + 归还媒体会话 */
  useEffect(() => {
    return () => {
      runRef.current++
      try {
        audioRef.current?.pause()
      } catch {
        /* noop */
      }
      try {
        window.speechSynthesis?.cancel()
      } catch {
        /* noop */
      }
      try {
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'
      } catch {
        /* noop */
      }
    }
  }, [])

  /* 键盘:空格播放暂停,←/→切词,Esc 退出(工作台的 Esc 处理已让位) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowLeft') stepTo(shadow.current.idx - 1)
      else if (e.key === 'ArrowRight') stepTo(shadow.current.idx + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, stepTo, togglePlay])

  if (!items.length) {
    return (
      <div className="fixed inset-0 z-50 bg-background">
        <div className="mx-auto flex h-full max-w-[520px] flex-col items-center justify-center px-6 text-center">
          <div className="text-[15px] font-semibold">今天没有要听的词</div>
          <div className="mt-1 text-[13px] text-content-secondary">先背词，队列里有词了再来听</div>
          <button
            type="button"
            onClick={onClose}
            className="mt-6 rounded-full border border-line bg-surface px-5 py-2.5 text-[13px] font-semibold text-content-primary"
          >
            返回
          </button>
        </div>
      </div>
    )
  }

  const item = items[Math.min(idx, items.length - 1)]!
  const phonetic = accentOf(item) === 'uk' ? item.phoneticUk : item.phoneticUs
  const displayMeaning = meaningText(item.trans, item.pos)
  const pct = finished ? 100 : Math.round((idx / items.length) * 100)
  const playingIcon = playing ? <Pause size={20} /> : <Play size={20} />

  return (
    <div className="fixed inset-0 z-50 bg-background">
      {/* 常驻音频元素:有道真人声走它,MediaSession 靠它锁屏保播 */}
      <audio ref={audioRef} preload="auto" className="hidden" />

      <div className="mx-auto flex h-full max-w-[520px] flex-col px-[22px]">
        {/* 顶栏 */}
        <div className="flex items-center gap-3 pt-[max(18px,env(safe-area-inset-top))]">
          <button
            type="button"
            onClick={onClose}
            aria-label="退出听音"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
          >
            <ChevronLeft size={17} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold leading-tight text-content-primary">
              {listName || '我的词'} · 听音模式
            </div>
            <div className="mt-0.5 truncate text-[12px] leading-snug text-content-muted">
              今天 {items.length} 个词 · 复习 {reviewCount} · 新词 {newCount}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSheet('list')}
            aria-label="词列"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
          >
            <ListMusic size={16} />
          </button>
        </div>

        {/* 中央:B 骨架 */}
        <div className="flex min-h-0 flex-1 flex-col justify-center">
          <div className="text-center text-[10.5px] uppercase tracking-[0.28em] text-content-muted">Listening · 听音</div>
          <div className="mt-6 select-none text-center text-[clamp(40px,11.5vw,60px)] font-extrabold leading-[1.05] tracking-[-0.02em]">
            {item.headword}
          </div>
          {phonetic && (
            <div className="mt-2.5 text-center text-[14.5px] text-content-secondary" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
              {phonetic}
            </div>
          )}
          <div
            className={cn(
              'mx-auto mt-[22px] min-h-[48px] max-w-[420px] text-center text-[15px] leading-[1.6] text-content-primary transition-[opacity,transform] duration-[320ms]',
              revealed ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
            )}
          >
            {item.pos && <span className="mr-1.5 font-semibold text-content-secondary">{item.pos}</span>}
            {displayMeaning || (item.isPhrase ? '短语 · 听发音即可' : '')}
          </div>
          <div className="mt-[26px] flex items-center justify-center gap-2.5 text-[12px] tabular-nums text-content-muted">
            <button
              type="button"
              onClick={() => setSheet('list')}
              className="underline decoration-dotted underline-offset-[3px] hover:text-content-secondary"
            >
              {finished ? items.length : idx + 1} / {items.length}
            </button>
            <span>·</span>
            <span>{status.txt}</span>
          </div>
          <div className="mx-auto mt-5 h-1 w-full max-w-[340px] overflow-hidden rounded-full bg-surface-subtle">
            <div
              className="h-full rounded-full bg-content-primary"
              style={{ width: `${pct}%`, transition: 'width var(--motion-base) var(--ease)' }}
            />
          </div>
        </div>

        {/* 桌面:A 式控制面板（展开时；手机不渲染） */}
        <div
          className={cn(
            'hidden flex-col items-center pb-[max(26px,env(safe-area-inset-bottom))] sm:flex',
            panelOpen ? 'sm:flex' : 'sm:hidden',
          )}
        >
          <div className="flex items-center gap-[7px] text-[12px] text-content-muted">
            <span className={cn('h-1.5 w-1.5 rounded-full bg-accent', status.busy && 'animate-pulse')} />
            {status.txt}
          </div>
          <div className="mt-3 flex items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={() => stepTo(shadow.current.idx - 1)}
              aria-label="上一个"
              className="inline-flex h-14 min-w-16 items-center justify-center rounded-control border border-line bg-surface text-content-primary transition-colors hover:border-line-strong"
            >
              <SkipBack size={19} />
            </button>
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? '暂停' : '播放'}
              className="inline-flex h-14 min-w-[88px] items-center justify-center rounded-control bg-accent text-accent-foreground transition-colors hover:bg-accent-hover"
            >
              {playingIcon}
            </button>
            <button
              type="button"
              onClick={() => stepTo(shadow.current.idx + 1)}
              aria-label="下一个"
              className="inline-flex h-14 min-w-16 items-center justify-center rounded-control border border-line bg-surface text-content-primary transition-colors hover:border-line-strong"
            >
              <SkipForward size={19} />
            </button>
          </div>
          <div className="mt-3.5 flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={() => setSheet('set')}
              className="inline-flex items-center gap-1.5 text-[12px] text-content-secondary hover:text-content-primary"
            >
              <Settings2 size={13} />
              播放设置
            </button>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="inline-flex items-center gap-1 text-[12px] text-content-secondary hover:text-content-primary"
            >
              <ChevronDown size={13} />
              收起面板
            </button>
          </div>
        </div>

        {/* 底部 dock：手机常驻；桌面收起面板后顶上（含展开按钮） */}
        <div
          className={cn(
            'flex items-center justify-between rounded-[22px] border border-line bg-surface/85 px-3.5 py-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.08)] backdrop-blur-[18px] sm:hidden',
            !panelOpen && 'sm:flex sm:fixed sm:bottom-[max(18px,env(safe-area-inset-bottom))] sm:left-1/2 sm:w-[calc(100%-44px)] sm:max-w-[520px] sm:-translate-x-1/2',
          )}
        >
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              aria-label="展开控制面板"
              className="hidden h-11 w-11 items-center justify-center rounded-full text-content-primary sm:flex"
            >
              <ChevronUp size={18} />
            </button>
            <button
              type="button"
              onClick={() => stepTo(shadow.current.idx - 1)}
              aria-label="上一个"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full text-content-primary"
            >
              <SkipBack size={18} />
            </button>
            <button
              type="button"
              onClick={() => setSheet('list')}
              aria-label="词列"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full text-content-primary sm:hidden"
            >
              <ListMusic size={17} />
            </button>
          </div>
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? '暂停' : '播放'}
            className="inline-flex h-[52px] w-[52px] items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors hover:bg-accent-hover"
          >
            {playingIcon}
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSheet('set')}
              aria-label="播放设置"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full text-content-secondary"
            >
              <Settings2 size={17} />
            </button>
            <button
              type="button"
              onClick={() => stepTo(shadow.current.idx + 1)}
              aria-label="下一个"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full text-content-primary"
            >
              <SkipForward size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* 底部弹层：播放设置 / 词列 */}
      {sheet !== 'none' && (
        <div className="fixed inset-0 z-[60]">
          <div className="absolute inset-0 bg-black/25" onClick={() => setSheet('none')} />
          <div className="absolute bottom-0 left-1/2 w-full max-w-[520px] -translate-x-1/2 rounded-t-3xl border-t border-line bg-surface px-[22px] pb-[max(30px,env(safe-area-inset-bottom))] pt-[18px]">
            <div className="mx-auto mb-3.5 h-1 w-9 rounded-full bg-line-strong" />
            {sheet === 'set' ? (
              <>
                <h4 className="mb-2 text-[14px] font-semibold">播放设置</h4>
                <div className="flex items-center justify-between py-3">
                  <div className="text-[13.5px]">
                    每个词读几遍
                    <small className="block text-[11px] leading-snug text-content-muted">默认 2 遍</small>
                  </div>
                  <div className="flex gap-[3px] rounded-[10px] bg-surface-subtle p-[3px]">
                    {[1, 2, 3].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => changeReps(n)}
                        className={cn(
                          'min-h-7 rounded-lg px-4 py-[5px] text-[12.5px] transition-colors',
                          reps === n
                            ? 'bg-surface font-semibold text-content-primary shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
                            : 'text-content-secondary',
                        )}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between py-3">
                  <div className="text-[13.5px]">
                    报中文释义
                    <small className="block text-[11px] leading-snug text-content-muted">关掉就是纯英语连播</small>
                  </div>
                  <button
                    type="button"
                    onClick={toggleZh}
                    aria-label="报中文释义"
                    className={cn(
                      'relative h-7 w-[46px] rounded-full transition-colors',
                      zhOn ? 'bg-accent' : 'bg-surface-subtle',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-[3px] h-[22px] w-[22px] rounded-full bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left]',
                        zhOn ? 'left-[21px]' : 'left-[3px]',
                      )}
                    />
                  </button>
                </div>
              </>
            ) : (
              <>
                <h4 className="mb-2 text-[14px] font-semibold">今天的词</h4>
                <ul className="max-h-[46vh] overflow-y-auto">
                  {items.map((w, i) => (
                    <li key={`${w.id}-${i}`}>
                      <button
                        type="button"
                        onClick={() => jumpTo(i)}
                        className={cn(
                          'flex w-full items-baseline gap-2.5 rounded-[10px] px-3 py-[11px] text-left text-[14.5px] hover:bg-surface-muted',
                          !finished && i === idx && 'bg-accent-soft font-semibold text-accent',
                        )}
                      >
                        <span className="w-5 shrink-0 text-[10.5px] tabular-nums text-content-muted">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{w.headword}</span>
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-[7px] py-px text-[9.5px]',
                            !finished && i === idx ? 'bg-accent/15' : 'bg-surface-subtle text-content-secondary',
                          )}
                        >
                          {w.isNew ? '新词' : '复习'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
