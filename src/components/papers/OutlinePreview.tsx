'use client'

/**
 * 全屏结构工作台 · 右栏仿真卷面预览（纯结构 + 试装真题）。
 * 输入=大纲行 + dry-run 试装结果 + 学科;渲染四体仿真卷面(与卷面页同视觉口径):
 * FangSong 卷头 / 黑体大题说明 / 宋体正文 / 密封线示意;题干=试装真题,缺口=点线占位。
 * 纯函数组件:不碰 AI/真题池/打印,试装数据由父级 dry-run 查询带入。
 * 相邻同名大题合并为一个真卷式说明(小题数/分值跨行累计)。
 */
import { slotHintsFor, type SlotHint } from '@/lib/papers/slot-hints'
import { SUBJECT_LABELS } from '@/lib/study/subject-labels'

export interface PreviewSlotRow {
  section: string
  kind: 'choice' | 'answer'
  score: number
  count: number
}
export interface DrySlot {
  section: string | null
  kind: string
  score: number
  q: { number: number; stem: string; options: string[]; topics: string[]; paperTitle: string } | null
}

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

export default function OutlinePreview({
  rows,
  subject,
  picks,
  loading,
  paperTitle,
}: {
  rows: PreviewSlotRow[]
  subject: string
  picks: DrySlot[]
  loading?: boolean
  paperTitle?: string
}) {
  const subjectLabel = SUBJECT_LABELS[subject as keyof typeof SUBJECT_LABELS] ?? subject
  const totalScore = rows.reduce((a, r) => a + r.score * r.count, 0)
  const totalCount = rows.reduce((a, r) => a + r.count, 0)
  // dry-run 槽位与 rows 前 12 行一一对应;预取每行试装题在扁平数组中的起始偏移
  const defs = rows.slice(0, 12)
  const offsets: number[] = []
  let acc = 0
  for (const d of defs) {
    offsets.push(acc)
    acc += d.count
  }
  // 相邻同名大题归组(组 = 一个真卷式大题说明)
  const groups: Array<{ title: string; items: Array<{ row: PreviewSlotRow; ordinal: number; pickIdx: number; hint?: SlotHint; qno: number }> }> = []
  rows.forEach((r, i) => {
    const hints = slotHintsFor(subject, r.section, r.kind, r.score)
    const seq = hints.length === 1 ? Array.from({ length: r.count }, () => hints[0]) : hints.slice(0, r.count)
    const defIdx = Math.min(i, 11)
    const group = groups[groups.length - 1]
    if (group && r.section && group.title === r.section) {
      group.title = r.section
      for (let k = 0; k < r.count; k++) {
        group.items.push({ row: r, ordinal: k, pickIdx: offsets[defIdx] + k, hint: seq[k], qno: 0 })
      }
    } else {
      const g = { title: r.section, items: [] as typeof group.items }
      for (let k = 0; k < r.count; k++) {
        g.items.push({ row: r, ordinal: k, pickIdx: offsets[defIdx] + k, hint: seq[k], qno: 0 })
      }
      groups.push(g)
    }
  })

  // 全局连续题号
  let qnoAbs = 0
  for (const g of groups) for (const it of g.items) it.qno = ++qnoAbs

  return (
    <div
      className="relative rounded border border-line bg-surface py-4 pl-9 pr-5 font-[SimSun,'宋体',serif] text-content-primary"
      style={{ minHeight: '100%' }}
    >
      <div
        aria-hidden
        className="absolute bottom-3 left-2 top-3 border-l border-dashed border-line-strong pl-1 text-[9px] leading-none tracking-[3px] text-content-muted"
        style={{ writingMode: 'vertical-rl' }}
      >
        密……封……线……内……不……要……答……题……
      </div>
      <div className="mb-3 text-center">
        <div className="font-['FangSong','STFangsong','仿宋',serif] text-[17px] font-bold tracking-[2px]">
          {paperTitle?.trim() || `${subjectLabel}练测卷`}
        </div>
        <div className="mt-1 font-['FangSong','STFangsong','仿宋',serif] text-[11px] text-content-secondary">
          （共 {totalCount} 题，满分 {totalScore} 分）
          {loading && <span className="ml-1 text-content-muted">试装更新中…</span>}
        </div>
      </div>
      {groups.map((g, gi) => {
        const runCount = g.items.length
        const runScoreSum = g.items.reduce((a, x) => a + x.row.score, 0)
        const firstScore = g.items[0].row.score
        const allSameScore = g.items.every((x) => x.row.score === firstScore)
        const detail = allSameScore && runCount > 1 ? `每小题 ${firstScore} 分，共 ${runScoreSum} 分` : `共 ${runScoreSum} 分`
        const secTitle = g.title || `${CN_NUM[gi] ?? gi + 1}、${g.items[0].row.kind === 'choice' ? '单项选择题' : '非选择题'}`
        return (
          <div key={gi} className="mb-3">
            <div className="mb-1.5 font-['SimHei','黑体',sans-serif] text-[12.5px]">
              {secTitle}（共 {runCount} 小题，{detail}）
            </div>
            {g.items.map((item, ii) => {
              const pick = picks[item.pickIdx]?.q ?? null
              return (
                <div key={ii}>
                  {pick ? (
                    <>
                      <div className="py-0.5 pl-2.5 text-[12px] leading-[1.9]">
                        {item.qno}. {pick.stem}
                        <span className="ml-1 text-[10.5px] text-content-muted">（{item.row.score}分）</span>
                      </div>
                      {pick.options.map((o, oi) => (
                        <div key={oi} className="pl-6 text-[12px] leading-[1.8]">
                          {o}
                        </div>
                      ))}
                      <div className="pb-1 pl-2.5 text-[10px] leading-relaxed text-content-muted">
                        试装 · {pick.paperTitle}
                        {item.hint ? ` · 常考 ${item.hint.label}` : ''}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="py-0.5 pl-2.5 text-[12px] leading-[1.9]">
                        {item.qno}. <span className="text-content-muted">（该档真题不足——点线占位）</span>
                        <span className="ml-1 text-[10.5px] text-content-muted">（{item.row.score}分）</span>
                      </div>
                      {item.hint && <div className="pb-1 pl-2.5 text-[10px] text-content-muted">常考 · {item.hint.label}</div>}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
      <div className="mt-2 text-right font-['SimHei','黑体',sans-serif] text-[11px] text-content-secondary">
        共 {totalCount} 题 · 满分 {totalScore} 分
      </div>
    </div>
  )
}
