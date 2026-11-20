'use client'

/**
 * 在线做题 · 方案A 卷面仿真答题(design/preview-online-exam.html 挑稿定稿)。
 *
 * 结构:悬浮考试条(倒计时/已答/答题卡/交卷)+ 四体仿真卷面(794px A4,窄视口 transform 等比缩放)
 * + 纸面交互层(选项点字母圈选/填空点横线就地输入/解答题下作答区)+ 答题卡浮层 + 交卷确认弹层。
 *
 * 纪律:
 * - 纸面恒白黑字(--paper/--paper-ink 本地常量),深色模式不反色;chrome 层走全局 token;
 * - 作答防抖 800ms PATCH 存进度(断点续考);交卷前离开页面用 keepalive fetch 兜底一拍;
 * - 题目载荷服务端已剥答案,本组件零答案数据;KaTeX 渲染一次(题目静态,避免 React 重写
 *   手改的文本节点——与 [slug]/page.tsx 的 renderTexIn 同配方);
 * - 倒计时按 startedAt+durationMin 本地推算,到点自动交卷(一次)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import { Clock, LayoutGrid, X } from 'lucide-react'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@/lib/toast'
import type { AttemptQuestion, AttemptRunPayload } from '@/lib/papers/attempt'
import styles from '../../app/(app)/papers/exam/[id]/ExamRun.module.css'

/** 遍历文本节点把 $...$ / $$...$$ 渲染成 KaTeX(与 papers/[slug]/page.tsx 同配方) */
function renderTexIn(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const t = node as Text
    if (t.nodeValue && t.nodeValue.includes('$')) targets.push(t)
  }
  for (const t of targets) {
    const value = t.nodeValue ?? ''
    const re = /\$\$([^$\n]+?)\$\$|\$([^$\n]+?)\$/g
    const frag = document.createDocumentFragment()
    let last = 0
    let m: RegExpExecArray | null
    let changed = false
    while ((m = re.exec(value))) {
      if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)))
      const display = !!m[1]
      const span = document.createElement('span')
      span.innerHTML = katex.renderToString((m[1] ?? m[2]) ?? '', { throwOnError: false, displayMode: display })
      frag.appendChild(span)
      last = m.index + m[0].length
      changed = true
    }
    if (changed) {
      if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)))
      t.parentNode?.replaceChild(frag, t)
    }
  }
}

/** 选项「A. xxx」拆字母与内容 */
function splitOption(opt: string): { letter: string; content: string } | null {
  const m = opt.match(/^\s*([A-Za-z])[.、．]\s*([\s\S]*)$/)
  if (!m) return null
  return { letter: m[1].toUpperCase(), content: m[2] }
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function ExamRun({ payload }: { payload: AttemptRunPayload }) {
  const { attempt, paper, questions } = payload
  const qc = useQueryClient()
  const [answers, setAnswers] = useState<Record<string, string>>(attempt.answers)
  const [acOpen, setAcOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [saveState, setSaveState] = useState<'saving' | 'saved' | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [scale, setScale] = useState(1)
  const [tick, setTick] = useState(() => Date.now())

  const sheetRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<HTMLDivElement>(null)
  const fitInnerRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const submitOnce = useRef(false)
  const answersRef = useRef(answers)
  answersRef.current = answers

  const deadline = useMemo(() => Date.parse(attempt.startedAt) + paper.durationMin * 60_000, [attempt.startedAt, paper.durationMin])
  const remainingSec = Math.max(0, (deadline - tick) / 1000)
  const urgent = remainingSec < 5 * 60

  const answeredCount = useMemo(
    () => Object.values(answers).filter((v) => typeof v === 'string' && v.trim()).length,
    [answers]
  )

  /* 倒计时走秒 */
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  /* KaTeX 一次性渲染(题目静态) */
  useEffect(() => {
    if (!sheetRef.current) return
    renderTexIn(sheetRef.current)
    document.fonts?.ready.then(() => renderTexIn(sheetRef.current!)).catch(() => {})
  }, [])

  /* 卷面等比缩放:容器宽度/794,观察 sheet 高度变化(作答区展开/收起)同步 fit 高度 */
  useEffect(() => {
    const fit = fitRef.current
    const inner = fitInnerRef.current
    const sheet = sheetRef.current
    if (!fit || !inner || !sheet) return
    const apply = () => {
      const w = fit.clientWidth
      if (w <= 0) return
      const s = Math.min(1, w / 794)
      setScale(s)
      inner.style.transform = `scale(${s})`
      fit.style.height = `${sheet.offsetHeight * s}px`
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(sheet)
    ro.observe(fit)
    document.fonts?.ready.then(apply).catch(() => {})
    return () => ro.disconnect()
  }, [])

  /* 作答防抖保存(断点续考) */
  const persist = useCallback(
    (list: Record<string, string>, keepalive = false) => {
      const body = JSON.stringify({ answers: list })
      if (keepalive) {
        void fetch(`/api/papers/attempts/${attempt.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {})
        return
      }
      setSaveState('saving')
      fetchJson<{ ok: boolean }>(`/api/papers/attempts/${attempt.id}`, { method: 'PATCH', json: { answers: list } })
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState(null))
    },
    [attempt.id]
  )
  useEffect(() => {
    if (!dirtyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      dirtyRef.current = false
      persist(answersRef.current)
    }, 800)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [answers, persist])
  useEffect(() => {
    const flush = () => {
      if (!dirtyRef.current) return
      dirtyRef.current = false
      persist(answersRef.current, true)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [persist])

  /* 交卷(幂等;到点自动) */
  const doSubmit = useCallback(
    async (auto = false) => {
      if (submitOnce.current) return
      submitOnce.current = true
      setSubmitting(true)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      dirtyRef.current = false
      try {
        await fetchJson<unknown>(`/api/papers/attempts/${attempt.id}`, {
          method: 'PATCH',
          json: { answers: answersRef.current },
        })
      } catch {
        /* 交卷以服务端存档为准,保存失败不阻塞判分 */
      }
      try {
        const report = await fetchJson<unknown>(`/api/papers/attempts/${attempt.id}/submit`, { method: 'POST' })
        qc.setQueryData(queryKeys.papers.attempt(attempt.id), report)
        qc.invalidateQueries({ queryKey: queryKeys.papers.attemptEntry(paper.slug) })
        qc.invalidateQueries({ queryKey: queryKeys.examRecords.byPaper(paper.slug) })
        qc.invalidateQueries({ queryKey: queryKeys.examRecords.list() })
      } catch (e) {
        submitOnce.current = false
        setSubmitting(false)
        setConfirmOpen(false)
        if (!auto) throw e
      }
    },
    [attempt.id, paper.slug, qc]
  )
  useEffect(() => {
    if (remainingSec <= 0) void doSubmit(true)
  }, [remainingSec, doSubmit])

  /* 选项点选:单选替换,多选切换(字母序输出) */
  const pickOption = useCallback((q: AttemptQuestion, letter: string) => {
    setAnswers((prev) => {
      const cur = prev[String(q.number)] ?? ''
      const picked = cur.split('')
      if (q.multiple) {
        const i = picked.indexOf(letter)
        if (i >= 0) picked.splice(i, 1)
        else picked.push(letter)
      } else {
        return { ...prev, [String(q.number)]: letter }
      }
      const next = Array.from(new Set(picked)).sort().join('')
      const copy = { ...prev }
      if (next) copy[String(q.number)] = next
      else delete copy[String(q.number)]
      return copy
    })
    dirtyRef.current = true
  }, [])
  const setBlank = useCallback((n: number, v: string) => {
    setAnswers((prev) => {
      const copy = { ...prev }
      if (v.trim()) copy[String(n)] = v
      else delete copy[String(n)]
      return copy
    })
    dirtyRef.current = true
  }, [])

  const jumpTo = useCallback((n: number) => {
    setAcOpen(false)
    const el = document.querySelector(`[data-qno="${n}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  /* 答题卡分组(按大题首现顺序) */
  const acSections = useMemo(() => {
    const out: Array<{ name: string; numbers: number[]; total: number }> = []
    const byName = new Map<string, { name: string; numbers: number[]; total: number }>()
    for (const q of questions) {
      const name = q.section ?? '(未分组)'
      let s = byName.get(name)
      if (!s) {
        s = { name, numbers: [], total: 0 }
        byName.set(name, s)
        out.push(s)
      }
      s.numbers.push(q.number)
      s.total += q.score
    }
    return out
  }, [questions])

  const sectionMeta = useMemo(() => {
    const map = new Map<string, { count: number; total: number }>()
    for (const q of questions) {
      const name = q.section ?? '(未分组)'
      const m = map.get(name) ?? { count: 0, total: 0 }
      m.count += 1
      m.total += q.score
      map.set(name, m)
    }
    return map
  }, [questions])

  const submitError = () => toast.error('交卷失败，请重试')

  return (
    <div className={styles.wrap}>
      {/* 悬浮考试条 */}
      <div className={styles.fbar}>
        <div className={styles.fbarTitle}>
          {paper.title} <span className={styles.mode}>· 考试模式{saveState === 'saving' ? ' · 保存中…' : saveState === 'saved' ? ' · 已保存' : ''}</span>
        </div>
        <div className={`${styles.fclock} ${urgent ? styles.urgent : ''}`}>
          <Clock />
          <b>{fmtClock(remainingSec)}</b>
        </div>
        <div className={styles.fprog}>
          已答 <b>{answeredCount}</b>/{questions.length}
        </div>
        <button type="button" className={styles.fbtn} onClick={() => setAcOpen((v) => !v)} aria-expanded={acOpen}>
          <LayoutGrid />
          答题卡
        </button>
        <button type="button" className={styles.submitBtn} onClick={() => setConfirmOpen(true)} disabled={submitting}>
          {submitting ? '交卷中…' : '交卷'}
        </button>
      </div>

      {/* 答题卡浮层 */}
      {acOpen && (
        <div className={styles.acard}>
          <div className={styles.acHead}>
            <span className={styles.t}>答题卡</span>
            <span className={styles.s}>
              已答 <b>{answeredCount}</b>/{questions.length}
            </span>
            <button type="button" className={styles.acX} onClick={() => setAcOpen(false)} aria-label="收起答题卡">
              <X />
            </button>
          </div>
          <div className={styles.acBody}>
            {acSections.map((s) => (
              <div key={s.name}>
                <div className={styles.acSec}>{s.name}</div>
                <div className={styles.acGrid}>
                  {s.numbers.map((n) => {
                    const done = !!answers[String(n)]?.trim()
                    return (
                      <button
                        key={n}
                        type="button"
                        className={`${styles.asq} ${done ? styles.done : ''}`}
                        onClick={() => jumpTo(n)}
                      >
                        {n}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className={styles.acTip}>点题号跳到对应题 · 未答题交卷不判分</div>
          <div className={styles.acFoot}>
            <span className={styles.sum}>
              未答 <b>{questions.length - answeredCount}</b> 题
            </span>
            <button type="button" className={styles.submitBtn} onClick={() => setConfirmOpen(true)} disabled={submitting}>
              交卷
            </button>
          </div>
        </div>
      )}

      {/* 卷面 */}
      <div className={styles.scroll}>
        <div className={styles.fit} ref={fitRef}>
          <div className={styles.fitInner} ref={fitInnerRef}>
            <div className={styles.sheet} ref={sheetRef}>
              <div className={styles.paperHead}>
                <div className={styles.secretTag}>绝密★启用前</div>
                <div className={styles.examTag}>
                  {paper.subject === 'math' ? '数学' : paper.subject} · 在线做题 · 全部题目与答案出自原卷
                </div>
                <div className={styles.paperTitle}>{paper.title}</div>
                <div className={styles.paperMeta}>
                  <span>满分 {paper.totalScore} 分</span>
                  <span>考试时间 {paper.durationMin} 分钟</span>
                </div>
              </div>
              {questions.map((q, i) => {
                const prev = i > 0 ? questions[i - 1] : null
                const secName = q.section ?? '(未分组)'
                const picked = answers[String(q.number)] ?? ''
                const pickedSet = new Set(picked.split(''))
                const isBlank = q.kind !== 'choice' && !!q.section && q.section.includes('填空')
                const collapsedQ = !!collapsed[String(q.number)]
                return (
                  <div key={q.id} data-qno={q.number}>
                    {(prev?.section ?? null) !== q.section && (
                      <div className={styles.sectionHead}>
                        {secName}
                        <span className={styles.sn}>
                          （本大题共 {sectionMeta.get(secName)?.count ?? 0} 小题，共{' '}
                          {sectionMeta.get(secName)?.total ?? 0} 分）
                        </span>
                      </div>
                    )}
                    <div className={styles.q}>
                      <div className={styles.qText}>
                        <span className={styles.qNo}>{q.number}.</span>
                        {q.stem}
                        {!q.kind.startsWith('choice') && <span className={styles.scoreTag}>（{q.score}分）</span>}
                        {isBlank && (
                          <>
                            {' '}
                            <input
                              className={styles.blankInput}
                              value={picked}
                              onChange={(e) => setBlank(q.number, e.target.value)}
                              aria-label={`第 ${q.number} 题答案`}
                            />
                          </>
                        )}
                      </div>
                      {q.images.length > 0 && (
                        <div className={styles.qImgs}>
                          {q.images.map((src, ii) => (
                            // 题图 URL 来自服务端 PaperQuestion.images(/exam-papers/<slug>/…),与原卷页同源
                            <img key={ii} src={src} alt={`第 ${q.number} 题图 ${ii + 1}`} className={styles.qImg} />
                          ))}
                        </div>
                      )}
                      {q.kind === 'choice' && (
                        <div className={styles.opts}>
                          {q.options.map((opt, oi) => {
                            const sp = splitOption(opt)
                            const letter = sp?.letter ?? String.fromCharCode(65 + oi)
                            const content = sp?.content ?? opt
                            const on = pickedSet.has(letter)
                            return (
                              <div
                                key={oi}
                                className={`${styles.popt} ${on ? styles.on : ''}`}
                                onClick={() => pickOption(q, letter)}
                                role="button"
                                aria-pressed={on}
                              >
                                <span className={styles.pl}>{letter}</span>
                                <span>{content}</span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {!isBlank && q.kind !== 'choice' && (
                        <div className={`${styles.answerArea} ${collapsedQ ? styles.collapsed : ''}`}>
                          <div className={styles.answerAreaHead}>
                            作答区 · {q.score} 分
                            <button
                              type="button"
                              onClick={() => setCollapsed((prev2) => ({ ...prev2, [String(q.number)]: !collapsedQ }))}
                            >
                              {collapsedQ ? '展开' : '收起'}
                            </button>
                          </div>
                          <textarea
                            className={styles.answerAreaTa}
                            value={picked}
                            onChange={(e) => setBlank(q.number, e.target.value)}
                            placeholder="在此书写解答过程…"
                            aria-label={`第 ${q.number} 题作答区`}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 交卷确认 */}
      {confirmOpen && (
        <div className={styles.veil} onClick={() => !submitting && setConfirmOpen(false)}>
          <div className={styles.dlg} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className={styles.dlgHead}>
              <div>
                <div className={styles.dlgTitle}>交卷确认</div>
                <div className={styles.dlgSub}>{paper.title} · 考试模式</div>
              </div>
              <button type="button" className={styles.acX} onClick={() => setConfirmOpen(false)} aria-label="关闭">
                <X />
              </button>
            </div>
            <div className={styles.dlgBody}>
              <div className={styles.subStats}>
                <div className={styles.ss}>
                  <b>{answeredCount}</b>
                  <span>已答</span>
                </div>
                <div className={styles.ss + ' ' + styles.warn}>
                  <b>{questions.length - answeredCount}</b>
                  <span>未答</span>
                </div>
                <div className={styles.ss}>
                  <b>{fmtClock(remainingSec)}</b>
                  <span>剩余时间</span>
                </div>
              </div>
              <div className={styles.warnLine}>
                {questions.length - answeredCount > 0
                  ? `还有 ${questions.length - answeredCount} 题未作答,未答题不参与判分;到时将自动停笔并按已答内容出分。`
                  : '全部答完,交卷后立即出客观题估分,主观题可回报告页自评。'}
              </div>
            </div>
            <div className={styles.dlgFoot}>
              <button type="button" className={styles.ghostBtn} onClick={() => setConfirmOpen(false)} disabled={submitting}>
                继续作答
              </button>
            <button type="button" className={styles.submitBtn} onClick={() => void doSubmit().catch(submitError)} disabled={submitting}>
              {submitting ? '判分中…' : '确认交卷'}
            </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
