'use client'

/**
 * 估分报告 · 整页版(design/preview-online-exam.html 方案一 定稿)。
 * 区间总分(客观确定 + 主观自评,待判部分给上限区间)/大题得分条(待判段浅色延展)/
 * 考点丢分 chips/客观题明细/主观题自评仲裁(±,同步自动生成的学校考试记录)/错题流转。
 * AI 阅卷按钮一期置灰(DeepSeek 充值后接入,不卡自评主链路)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import katex from 'katex'
import { ChevronLeft, Sparkles } from 'lucide-react'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@/lib/toast'
import { buildExamAskMessage, type ExamAskCardData } from '@/lib/chat/exam-ask'
import type { AttemptReportPayload, QuestionGrade } from '@/lib/papers/attempt'
import styles from './ExamReport.module.css'

/** 遍历文本节点把 $...$ 渲染成 KaTeX(与 ExamRun 同配方) */
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

function fmtDur(sec: number | null): string {
  if (!sec || sec <= 0) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const KIND_LABEL: Record<string, string> = { choice: '选择题', answer: '主观题' }

export function ExamReportView({ payload }: { payload: AttemptReportPayload }) {
  const { attempt, paper, questions } = payload
  const result = attempt.result
  const router = useRouter()
  const qc = useQueryClient()

  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!contentRef.current) return
    renderTexIn(contentRef.current)
  }, [attempt.result])

  /* 主观题自评(仲裁):本地步进 + 防抖 PATCH,服务端重判后整包刷 */
  const [selfScores, setSelfScores] = useState<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    for (const g of result?.perQuestion ?? []) if (g.verdict === 'pending') map[String(g.number)] = g.score
    return map
  })
  const [savingSelf, setSavingSelf] = useState(false)
  const selfTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selfRef = useRef(selfScores)
  selfRef.current = selfScores

  const persistSelf = useCallback(() => {
    setSavingSelf(true)
    fetchJson<AttemptReportPayload>(`/api/papers/attempts/${attempt.id}/self-score`, {
      method: 'PATCH',
      json: { selfScores: selfRef.current },
    })
      .then((report) => {
        qc.setQueryData(queryKeys.papers.attempt(attempt.id), report)
        qc.invalidateQueries({ queryKey: queryKeys.examRecords.byPaper(paper.slug) })
        qc.invalidateQueries({ queryKey: queryKeys.examRecords.list() })
        setSavingSelf(false)
      })
      .catch(() => {
        setSavingSelf(false)
        toast.error('自评保存失败，请重试')
      })
  }, [attempt.id, paper.slug, qc])

  const stepSelf = useCallback(
    (n: number, max: number, delta: number) => {
      setSelfScores((prev) => {
        const cur = prev[String(n)] ?? 0
        const next = Math.max(0, Math.min(max, cur + delta))
        if (next === cur) return prev
        return { ...prev, [String(n)]: next }
      })
      if (selfTimer.current) clearTimeout(selfTimer.current)
      selfTimer.current = setTimeout(persistSelf, 600)
    },
    [persistSelf]
  )

  /* 「去问AI」:构造带标记的深链消息 → /chat?q= 自动发出(闲鱼自动回报同配方) */
  const askAI = useCallback(
    (data: Omit<ExamAskCardData, 'prompt'> & { prompt: string }) => {
      router.push(`/chat?q=${encodeURIComponent(buildExamAskMessage(data))}`)
    },
    [router]
  )

  const objectiveGrades = useMemo(
    () => (result?.perQuestion ?? []).filter((g) => g.verdict !== 'pending'),
    [result]
  )
  const wrongGrades = useMemo(
    () => objectiveGrades.filter((g) => g.verdict === 'wrong' && g.score < g.max),
    [objectiveGrades]
  )
  const unansweredCount = useMemo(
    () => objectiveGrades.filter((g) => g.verdict === 'unanswered').length,
    [objectiveGrades]
  )
  const unansweredMarks = useMemo(
    () => objectiveGrades.filter((g) => g.verdict === 'unanswered').reduce((a, g) => a + g.max, 0),
    [objectiveGrades]
  )
  const pendingGrades = useMemo(
    () => (result?.perQuestion ?? []).filter((g) => g.verdict === 'pending'),
    [result]
  )
  const qByNumber = useMemo(() => new Map(questions.map((q) => [String(q.number), q])), [questions])

  if (!result) {
    return (
      <div className={styles.page}>
        <div className={styles.scroll}>
          <div className="mx-auto max-w-3xl px-2 text-sm text-content-muted">这份考试还没有判分快照</div>
        </div>
      </div>
    )
  }

  const confirmed = result.objectiveScore + result.selfScore
  const pendingLeft = result.subjectiveMax - result.selfScore
  const upper = result.objectiveScore + result.subjectiveMax
  const objectiveRight = objectiveGrades.filter((g) => g.verdict === 'correct').length
  const weakPending = pendingGrades.filter((g) => g.score <= 0).map((g) => g.number)

  /* 「去问AI」prompt 构造(占位符全部由报告数据填充) */
  const subjectLabel =
    ({ math: '数学', chinese: '语文', physics: '物理', politics: '政治' } as Record<string, string>)[paper.subject] ??
    paper.subject
  const lossSum = result.topicLoss.reduce((a, t) => a + t.loss, 0)
  const gradeAsk = (g: QuestionGrade) => {
    const q = qByNumber.get(String(g.number))
    const my = attempt.answers[String(g.number)]?.trim() || '未作答'
    askAI({
      kind: 'grade',
      no: g.number,
      title: `AI 批改请求 · 第 ${g.number} 题`,
      meta: `主观题 · ${g.max} 分 · 自评 ${selfScores[String(g.number)] ?? 0}/${g.max} · 上下文已附带:题干 / 参考答案 / 我的作答`,
      prompt: `帮我批改一道${subjectLabel}解答题(估分报告自评,需人工仲裁)。\n【题目】${q?.stem ?? ''}\n【参考答案】${q?.answer ?? '无'}\n【我的作答】${my}\n【满分】${g.max} 分\n请按参考答案的评分要点逐条对照我的作答:写对了哪些要点、缺/错哪些、每条给几分;最后单独一行输出:建议得分 X/${g.max}。`,
    })
  }
  const explainAsk = (g: QuestionGrade) => {
    const q = qByNumber.get(String(g.number))
    askAI({
      kind: 'explain',
      no: g.number,
      title: `问AI讲解 · 第 ${g.number} 题`,
      meta: `${q?.multiple ? '多选' : '单选'} · ${g.max} 分 · 你答 ${attempt.answers[String(g.number)] || '—'} → 正确 ${g.expected ?? '—'} · 上下文已附带:题干 / 选项 / 双方答案`,
      prompt: `讲解一道我做错的题。\n【题目】${q?.stem ?? ''}${q?.options.length ? '\n' + q.options.join('\n') : ''}\n【我的答案】${attempt.answers[String(g.number)] || '—'}　【正确答案】${g.expected ?? '—'}\n请讲:①正确解法 ②我错在哪(常见误区) ③一道同类变式(先不给答案)。`,
    })
  }
  const topicsAsk = () => {
    askAI({
      kind: 'topics',
      title: '考点复习请求',
      meta: `${result.topicLoss.length} 个考点 · 共丢 ${lossSum} 分 · 上下文已附带:考点清单`,
      prompt: `我的${subjectLabel}模拟卷丢分考点如下:\n${result.topicLoss.map((t) => `${t.topic}(−${t.loss})`).join('、')}\n请按丢分从多到少,每个考点给:一段最精炼的复习要点 + 一道典型例题(例题答案放在末尾)。`,
    })
  }
  const wrongpackAsk = () => {
    askAI({
      kind: 'wrongpack',
      title: '错因归类请求',
      meta: `客观错题 ${wrongGrades.length} 题 · 上下文已附带:题号 + 考点 + 错误形态`,
      prompt: `这次${subjectLabel}模拟卷我做错 ${wrongGrades.length} 道客观题:\n${wrongGrades.map((g) => `${g.number}(${g.topics[0] ?? '无考点'}${g.note ? ',' + g.note : ''})`).join('、')}\n请归类错因(知识性/审题/计算),按复习性价比排优先级,并说明理由。`,
    })
  }
  const reviewAsk = () => {
    askAI({
      kind: 'review',
      title: '整卷点评请求',
      meta: `总分 ${confirmed}${pendingLeft > 0 ? `~${upper}` : ''}/${paper.totalScore} · ${paper.title}`,
      prompt: `这是一份${subjectLabel}模拟卷(满分 ${paper.totalScore},${paper.durationMin} 分钟)的估分:\n总分 ${confirmed}${pendingLeft > 0 ? `~${upper}` : ''}/${paper.totalScore}(客观确定 ${result.objectiveScore}/${result.objectiveMax} + 主观自评 ${result.selfScore}/${result.subjectiveMax});\n大题得分:${result.sections.map((s) => `${s.name} ${s.got}${s.pending ? `~${s.max}` : ''}/${s.max}`).join('、')};\n丢分考点:${result.topicLoss.map((t) => `${t.topic}(−${t.loss})`).join('、') || '无'}。\n请点评这张卷暴露的薄弱环节,给出未来一周的复习优先级(哪块先补、怎么补)。`,
    })
  }

  return (
    <div className={styles.page}>
      <div className={styles.topbar}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => router.push(`/papers/${paper.slug}`)}
          aria-label="返回卷详情"
        >
          <ChevronLeft />
        </button>
        <div className={styles.title}>估分报告 · {paper.title}</div>
      </div>

      <div className={styles.scroll}>
        <div className={styles.inner} ref={contentRef}>
          {/* 总分区 */}
          <div className={styles.head}>
            <div className={styles.big}>
              <span className={styles.v}>
                {confirmed}
                {pendingLeft > 0 && <i>~{result.objectiveScore + result.subjectiveMax}</i>}
              </span>
              <span className={styles.m}>/ {paper.totalScore} {pendingLeft > 0 ? '估分区间' : '估分'}</span>
            </div>
            <div className={styles.comp}>
              <div>
                客观题已确定 <b>{result.objectiveScore}</b>/{result.objectiveMax} · 主观题自评{' '}
                <b>{result.selfScore}</b>/{result.subjectiveMax}
                {pendingLeft > 0 && <span className={styles.pendingBadge}>待评 {pendingLeft} 分</span>}
              </div>
              <div className={styles.meta}>
                用时 {fmtDur(attempt.durationSec)} / {paper.durationMin}:00 · 交卷 {fmtDate(attempt.submittedAt)} ·
                已记入学校考试(成绩分析在学习台)
                {savingSelf ? ' · 自评保存中…' : ''}
              </div>
            </div>
            <div className={styles.askRow}>
              <button type="button" className={styles.asklnk} onClick={reviewAsk}>
                <Sparkles aria-hidden />
                让AI点评整卷
              </button>
            </div>
          </div>

          {/* 大题得分 · 圆环(实得分实弧,待评段浅色延展到上限) */}
          <div className={styles.card}>
            <div className={styles.secT}>大题得分</div>
            <div className={styles.ringGrid}>
              {result.sections.map((s) => {
                const frac = Math.min(1, s.got / Math.max(1, s.max))
                const C = 2 * Math.PI * 30
                return (
                  <div className={styles.ringCell} key={s.name}>
                    <div className={styles.ringWrap}>
                      <svg className={styles.ringSvg} viewBox="0 0 72 72" aria-hidden="true">
                        <circle cx="36" cy="36" r="30" fill="none" strokeWidth="8" className={styles.ringTrack} />
                        {s.pending && (
                          <circle
                            cx="36" cy="36" r="30" fill="none" strokeWidth="8" strokeLinecap="round"
                            className={styles.ringSoft}
                            strokeDasharray={`${C.toFixed(2)} ${C.toFixed(2)}`}
                            transform="rotate(-90 36 36)"
                          />
                        )}
                        <circle
                          cx="36" cy="36" r="30" fill="none" strokeWidth="8" strokeLinecap="round"
                          className={styles.ringFill}
                          strokeDasharray={`${(C * frac).toFixed(2)} ${C.toFixed(2)}`}
                          transform="rotate(-90 36 36)"
                        />
                      </svg>
                      <div className={styles.ringCenter}>
                        <span className={styles.ringGot + (s.pending ? ' ' + styles.ringPend : '')}>
                          {s.pending ? `${s.got}~${s.max}` : s.got}
                        </span>
                        <span className={styles.ringMax}>{s.pending ? '待评' : `/ ${s.max}`}</span>
                      </div>
                    </div>
                    <div className={styles.ringName} title={s.name}>
                      {s.name}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 考点丢分 */}
          <div className={styles.card}>
            <div className={styles.secT}>
              考点丢分 <span className="hint">喂「针对我复习」+ 冲刺计划</span>
              <button type="button" className={styles.asklnk + ' ml-auto'} onClick={topicsAsk}>
                <Sparkles aria-hidden />
                带考点问AI
              </button>
            </div>
            {result.topicLoss.length > 0 ? (
              <div className={styles.chips}>
                {result.topicLoss.map((t) => (
                  <span className={styles.tchip} key={t.topic}>
                    {t.topic} <span className={styles.n}>×{t.count} · −{t.loss}分</span>
                  </span>
                ))}
              </div>
            ) : (
              <div className={styles.noLoss}>客观题全对,没有考点丢分</div>
            )}
          </div>

          {/* 客观题明细 */}
          <div className={styles.card}>
            <div className={styles.secT}>
              客观题明细 <span className="hint">本地判分 · 确定值</span>
            </div>
            {wrongGrades.map((g) => (
              <div className={styles.orow} key={g.number}>
                <span className={styles.onN}>{g.number}</span>
                <span className={styles.oAns}>
                  你答 <b className={styles.bad}>{attempt.answers[String(g.number)] || '—'}</b> · 正确{' '}
                  <b className={styles.good}>{g.expected ?? '—'}</b>
                  {g.note ? `（${g.note}）` : ''}
                </span>
                <span className={styles.omark + ' ' + styles.no}>−{g.max - g.score}分</span>
                <button type="button" className={styles.asklnk} onClick={() => explainAsk(g)}>
                  <Sparkles aria-hidden />
                  问AI
                </button>
              </div>
            ))}
            {unansweredCount > 0 && (
              <div className={styles.orow + ' ' + styles.mute}>
                <span className={styles.onN}>…</span>
                <span className={styles.oAns}>{unansweredCount} 题未作答,不参与判分</span>
                <span className={styles.omark + ' ' + styles.no}>−{unansweredCount <= 0 ? 0 : unansweredMarks}</span>
              </div>
            )}
            <div className={styles.orow + ' ' + styles.mute}>
              <span className={styles.onN}>…</span>
              <span className={styles.oAns}>其余 {objectiveRight} 题已判,全对</span>
              <span className={styles.omark + ' ' + styles.ok}>{objectiveRight} 对</span>
            </div>
          </div>

          {/* 主观题自评 */}
          {pendingGrades.length > 0 && (
            <div className={styles.card}>
              <div className={styles.secT}>
                主观题自评 <span className="hint">对照答案给分,± 仲裁后记入成绩</span>
              </div>
              {pendingGrades.map((g) => {
                const q = qByNumber.get(String(g.number))
                const myAnswer = attempt.answers[String(g.number)] ?? ''
                return (
                  <div className={styles.rv} key={g.number}>
                    <div className={styles.rvHead}>
                      <span className={styles.qnoBadge}>{g.number}</span>
                      <span className={styles.kindTag}>{KIND_LABEL[q?.kind ?? 'answer'] ?? '主观题'} · {g.max} 分</span>
                      <div className={styles.stp}>
                        <button type="button" onClick={() => stepSelf(g.number, g.max, -1)} aria-label={`第 ${g.number} 题减一分`}>
                          −
                        </button>
                        <b>{selfScores[String(g.number)] ?? 0}</b>
                        <button type="button" onClick={() => stepSelf(g.number, g.max, 1)} aria-label={`第 ${g.number} 题加一分`}>
                          +
                        </button>
                      </div>
                      <span className={styles.rvScore}>
                        {selfScores[String(g.number)] ?? 0}
                        <i>/{g.max}</i>
                      </span>
                      <button type="button" className={styles.askbtn} onClick={() => gradeAsk(g)}>
                        <Sparkles aria-hidden />
                        AI 批改
                      </button>
                    </div>
                    <div className={styles.stem}>
                      {g.number}. {q?.stem ?? ''}
                    </div>
                    {!!q?.images?.length && (
                      <div className={styles.rvImgs}>
                        {q.images.map((src, ii) => (
                          <img key={ii} src={src} alt={`第 ${g.number} 题图 ${ii + 1}`} className={styles.rvImg} />
                        ))}
                      </div>
                    )}
                    <div className={styles.answer + (myAnswer.trim() ? '' : ' ' + styles.empty)}>
                      {myAnswer.trim() ? myAnswer : '未作答 —— 可现在补写要点再自评,也可以直接给 0 分。'}
                    </div>
                    {q?.answer && <div className={styles.aiNote}>参考答案:{q.answer}</div>}
                  </div>
                )
              })}
            </div>
          )}

          {/* 错题流转 */}
          <div className={styles.card}>
            <div className={styles.secT}>
              错题流转 <span className="hint">走复习全家桶 · 重做/变式现成链路</span>
              <button type="button" className={styles.asklnk + ' ml-auto'} onClick={wrongpackAsk}>
                <Sparkles aria-hidden />
                带错题问AI
              </button>
            </div>
            <div className={styles.wflow}>
              {wrongGrades.map((g) => (
                <span className={styles.wq} key={g.number}>
                  {g.number}
                </span>
              ))}
              {wrongGrades.length > 0 && <span className={styles.wsep}>客观错题 {wrongGrades.length} 题</span>}
              {weakPending.length > 0 && <span className={styles.wsep}>主观薄弱 {weakPending.join(' ')}</span>}
              <button type="button" className={styles.reviewBtn} onClick={() => router.push('/study')}>
                带错题去复习 ›
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
