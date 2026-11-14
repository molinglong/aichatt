'use client'

/**
 * 组卷等待期动画(方案 B · 题源流水线,design/preview-paper-compose-generating.html 用户挑定):
 * 左列步骤清单(匹配真题→课本拟题→AI 举一反三→排卷配页)逐步点亮,右侧真题池/课本/AI
 * 三通道往卷里进题,格盘按来源颜色逐格点亮 + 「已就位 n/总」计数。
 * 服务端没有进度事件,动画按预计时长等比推进、不造假百分比:走完预计时长后停在
 * 「排卷配页」呼吸态等真实响应;纯真题模式只亮两步,课本 / AI 通道熄灭。
 * 来源分解(约 7:2:1)是示意,真实来源以卷面徽章为准。
 */
import { useEffect, useRef, useState } from 'react'
import { BookOpen, FileText, Layers, Search, Sparkles } from 'lucide-react'
import s from './ComposeGenerating.module.css'

const ICONS = { match: Search, book: BookOpen, ai: Sparkles, bind: Layers } as const

const STEPS_AI = [
  { k: 'match', t: '匹配真题' },
  { k: 'book', t: '课本拟题' },
  { k: 'ai', t: 'AI 举一反三' },
  { k: 'bind', t: '排卷配页' },
] as const
const STEPS_POOL = [
  { k: 'match', t: '匹配真题' },
  { k: 'bind', t: '排卷配页' },
] as const

/** 预计时长(秒)与各步占比——只是动画节奏,不是真实进度承诺 */
const PLAN = { ai: 90, pool: 20 } as const
const SEG: Record<'ai' | 'pool', number[]> = { ai: [0.28, 0.22, 0.32, 0.18], pool: [0.7, 0.3] }
const SRC_VAR = { pool: '--src-pool', tb: '--src-tb', ai: '--src-ai' } as const

/** 来源分解示意:真题优先,课本次之,余量给 AI */
function targets(total: number, mode: 'ai' | 'pool') {
  if (mode === 'pool') return { pool: total, tb: 0, ai: 0 }
  const pool = Math.max(1, Math.round(total * 0.7))
  const tb = Math.max(0, Math.min(total - pool, Math.round(total * 0.18)))
  return { pool, tb, ai: Math.max(0, total - pool - tb) }
}

export default function ComposeGenerating({ mode, total, size = 'card' }: { mode: 'ai' | 'pool'; total: number; size?: 'card' | 'page' }) {
  const steps = mode === 'ai' ? STEPS_AI : STEPS_POOL
  const [step, setStep] = useState(0)
  const [cnt, setCnt] = useState({ pool: 0, tb: 0, ai: 0 })
  const [settled, setSettled] = useState(false)
  const laneRefs = useRef<Record<'pool' | 'tb' | 'ai', HTMLDivElement | null>>({ pool: null, tb: null, ai: null })

  // 步骤与计数推进:rAF 算进度,只有值变化才 setState(避免逐帧重渲染)
  useEffect(() => {
    const segs = SEG[mode]
    const planMs = PLAN[mode] * 1000
    const marks: number[] = []
    let acc = 0
    for (const x of segs) {
      marks.push(acc)
      acc += x
    }
    const tgt = targets(total, mode)
    let raf = 0
    const t0 = performance.now()
    let cur = { step: -1, pool: -1, tb: -1, ai: -1 }
    const frame = (now: number) => {
      const e = now - t0
      const f = Math.min(1, e / planMs)
      let i = 0
      while (i < segs.length - 1 && f >= marks[i + 1]) i++
      const local = Math.max(0, Math.min(1, (f - marks[i]) / segs[i]))
      const c = {
        pool: i >= 1 ? tgt.pool : Math.round(tgt.pool * local),
        tb: i < 1 ? 0 : i === 1 ? Math.round(tgt.tb * local) : tgt.tb,
        ai: i < 2 ? 0 : i === 2 ? Math.round(tgt.ai * local) : tgt.ai,
      }
      if (i !== cur.step) {
        cur.step = i
        setStep(i)
      }
      if (c.pool !== cur.pool || c.tb !== cur.tb || c.ai !== cur.ai) {
        cur = { ...cur, ...c }
        setCnt(c)
      }
      if (f >= 1) {
        // 预计时长走完:停在「排卷配页」呼吸态等真实响应,不再空转
        setSettled(true)
        return
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [mode, total])

  // 飞题小徽章:纯演示性 DOM,直接 appendChild(不进 state,animationend 自删)
  useEffect(() => {
    if (settled) return
    const id = window.setInterval(() => {
      const src: 'pool' | 'tb' | 'ai' = mode === 'pool' ? 'pool' : (['pool', 'tb', 'ai'] as const)[Math.min(step, 2)]
      const lane = laneRefs.current[src]
      if (!lane) return
      const chip = document.createElement('span')
      chip.className = s.mchip
      chip.style.setProperty('--mc', `var(${SRC_VAR[src]})`)
      chip.textContent = '题'
      lane.appendChild(chip)
      chip.addEventListener('animationend', () => chip.remove())
    }, 700)
    return () => window.clearInterval(id)
  }, [mode, step, settled])

  const filled = cnt.pool + cnt.tb + cnt.ai
  const cells = Array.from({ length: Math.max(1, total) }, (_, k) => {
    if (k < cnt.pool) return s.cPool
    if (k < cnt.pool + cnt.tb) return s.cTb
    if (k < cnt.pool + cnt.tb + cnt.ai) return s.cAi
    return ''
  })

  return (
    <div className={`${s.gen} ${size === 'page' ? s.genPage : ''}`}>
      <div className={s.main}>
        <div className={s.steps}>
          {steps.map((stp, k) => {
            const Icon = ICONS[stp.k]
            return (
              <div key={stp.k} className={`${s.stp} ${k < step ? s.done : ''} ${k === step ? s.act : ''}`}>
                <span className={s.ic}>
                  <Icon strokeWidth={1.7} />
                </span>
                {stp.t}
              </div>
            )
          })}
        </div>
        <div className={s.flow}>
          <div className={s.lanes}>
            <div
              ref={(el) => {
                laneRefs.current.pool = el
              }}
              className={`${s.lane} ${step === 0 ? s.hot : ''}`}
            >
              <span className={s.src}>真题池</span>
              <span className={s.lct}>{cnt.pool}</span>
            </div>
            <div
              ref={(el) => {
                laneRefs.current.tb = el
              }}
              className={`${s.lane} ${mode === 'pool' ? s.off : step === 1 ? s.hot : ''}`}
            >
              <span className={s.src}>课本拟题</span>
              <span className={s.lct}>{cnt.tb}</span>
            </div>
            <div
              ref={(el) => {
                laneRefs.current.ai = el
              }}
              className={`${s.lane} ${mode === 'pool' ? s.off : step === 2 ? s.hot : ''}`}
            >
              <span className={s.src}>AI 举一反三</span>
              <span className={s.lct}>{cnt.ai}</span>
            </div>
          </div>
          <div className={s.doc}>
            <div className={s.dhead}>
              <FileText strokeWidth={1.7} />
              组卷<b>{filled}</b>/{total}
            </div>
            <div className={s.grid}>
              {cells.map((cls, k) => (
                <i key={k} className={`${s.cell} ${cls}`} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className={s.foot}>
        <span className={s.legend}>
          {settled ? (
            '题目都就位了,正在排版配页,马上就好…'
          ) : (
            <>
              题目一道道进卷,来源看颜色:
              <i className={`${s.lg} ${s.lgPool}`} />
              真题
              {mode === 'ai' && (
                <>
                  <i className={`${s.lg} ${s.lgTb}`} />
                  课本
                  <i className={`${s.lg} ${s.lgAi}`} />
                  AI
                </>
              )}
            </>
          )}
        </span>
        <span className={s.count}>
          已就位 <b>{filled}</b>/{total} 题
        </span>
      </div>
    </div>
  )
}
