'use client'

/**
 * PDF 录题 · 编辑抽屉(挑稿方案B「单题焦点审」收编形态):
 * 左侧原图区域放大对照(题区定位命中才显示),右侧题干/选项/答案/考点/题型分值全字段可改。
 * 骨架与 ReviewStatsDialog 同配方:桌面居中磨砂遮罩玻璃卡 + ESC/点外关,移动端全屏 + 返回键收口。
 */
import { useEffect, useState } from 'react'
import { X, Sparkles, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useBackToClose } from '@/hooks/useBackToClose'
import type { ImportCandidate } from '@/lib/papers/pdf-import'

const FIELD_LABEL = 'mb-1.5 block text-[11px] font-semibold tracking-wide text-content-secondary'
const INPUT =
  'w-full rounded-[9px] border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-content-primary outline-none transition-colors focus:border-accent tabular-nums'

export function PdfImportEditDrawer({
  open,
  candidate,
  regionImage,
  solving,
  onClose,
  onSave,
  onAiSolve,
}: {
  open: boolean
  candidate: ImportCandidate | null
  /** 该题在页图上的裁剪原图(dataURL);null = 定位失败/扫描版 */
  regionImage: string | null
  solving: boolean
  onClose: () => void
  /** 保存:把表单态整包交回父层(父层负责落库与关抽屉) */
  onSave: (next: Partial<ImportCandidate>) => void
  onAiSolve: () => void
}) {
  const isMobile = useIsMobileViewport()
  useBackToClose(open, onClose)

  const [stem, setStem] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [answer, setAnswer] = useState('')
  const [topic, setTopic] = useState('')
  const [kind, setKind] = useState<'choice' | 'answer'>('choice')
  const [score, setScore] = useState('')

  useEffect(() => {
    if (!candidate) return
    setStem(candidate.stem)
    setOptions(candidate.options.length ? [...candidate.options] : [''])
    setAnswer(candidate.answer)
    setTopic(candidate.topic)
    setKind(candidate.kind)
    setScore(candidate.score ? String(candidate.score) : '')
  }, [candidate?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || isMobile) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isMobile, onClose])

  if (!open || !candidate) return null

  const isChoice = kind === 'choice'
  const srcChip = !answer
    ? { cls: 'bg-[rgb(var(--danger)/0.1)] text-[rgb(var(--danger))]', text: '缺答案' }
    : candidate.answerSource === 'ai'
      ? { cls: 'border border-dashed border-line-strong text-content-secondary', text: 'AI 参考' }
      : { cls: 'bg-accent-soft text-accent', text: '卷面抽到' }

  const buildSave = (): Partial<ImportCandidate> => ({
    stem: stem.trim(),
    options: isChoice ? options.map((o) => o.trim()).filter(Boolean) : [],
    answer: answer.trim(),
    topic: topic.trim(),
    kind,
    score: Math.max(0, Math.round(Number(score) || 0)),
    // 手改答案后来源视为卷面(用户确认过的口径);AI 解走专用按钮改 answerSource
    answerSource: answer.trim() ? (candidate.answerSource === 'ai' ? 'ai' : 'paper') : '',
  })

  return (
    <div
      className={cn(
        'fixed inset-0 z-[200]',
        isMobile ? 'flex flex-col bg-surface' : 'flex items-start justify-center px-4 pt-[6vh]'
      )}
    >
      {!isMobile && (
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="absolute inset-0 bg-black/20 backdrop-blur-[12px] saturate-150 dark:bg-white/15 dark:saturate-150"
        />
      )}

      <div
        className={cn(
          'relative flex min-h-0 flex-col overflow-hidden',
          isMobile
            ? 'h-full w-full bg-surface'
            : 'max-h-[88vh] w-full max-w-[880px] rounded-xl border border-line/60 bg-surface-glass glass-blur shadow-2xl enter-pop'
        )}
      >
        {/* 头:题号 + 状态 + 关闭 */}
        <div className="flex min-h-[52px] shrink-0 items-center gap-2.5 border-b border-line/60 px-4 py-2.5">
          <span className="rounded-[7px] bg-accent-soft px-2 py-0.5 text-[12px] font-bold tabular-nums text-accent">
            {candidate.number > 0 ? `第 ${candidate.number} 题` : '未编号'}
          </span>
          <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-content-muted tabular-nums">
            第 {candidate.page} 页
          </span>
          <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-semibold', srcChip.cls)}>{srcChip.text}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ml-auto rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row">
          {/* 左:原图区域放大 */}
          <div className="shrink-0 border-b border-line/60 bg-surface-muted p-3 md:w-[46%] md:border-b-0 md:border-r">
            {regionImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={regionImage} alt={`第 ${candidate.page} 页原图区域`} className="mx-auto max-h-[240px] w-auto max-w-full rounded-lg border border-line bg-white md:max-h-none" />
            ) : (
              <div className="flex h-[120px] items-center justify-center rounded-lg border border-dashed border-line-strong text-[11.5px] text-content-muted md:h-[200px]">
                {solving ? '解析中…' : '无原图定位(扫描页或题干未匹配到文字层)'}
              </div>
            )}
          </div>

          {/* 右:全字段编辑 */}
          <div className="min-w-0 flex-1 p-4">
            <label className={FIELD_LABEL}>题干</label>
            <textarea value={stem} onChange={(e) => setStem(e.target.value)} rows={3} className={cn(INPUT, 'resize-y leading-relaxed')} />

            {isChoice && (
              <>
                <div className="mt-3 flex items-center justify-between">
                  <span className={FIELD_LABEL}>选项</span>
                  <button
                    type="button"
                    onClick={() => setOptions((o) => [...o, ''])}
                    className="text-[11px] font-medium text-accent hover:opacity-80"
                  >
                    + 加一个
                  </button>
                </div>
                <div className="space-y-1.5">
                  {options.map((o, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="flex h-[21px] w-[21px] shrink-0 items-center justify-center rounded-full border border-line-strong text-[10.5px] tabular-nums text-content-secondary">
                        {String.fromCharCode(65 + i)}
                      </span>
                      <input
                        value={o}
                        onChange={(e) => setOptions((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))}
                        className={INPUT}
                      />
                      {options.length > 2 && (
                        <button
                          type="button"
                          aria-label="删除该选项"
                          onClick={() => setOptions((arr) => arr.filter((_, j) => j !== i))}
                          className="shrink-0 rounded p-1 text-content-muted hover:bg-surface-subtle hover:text-content-primary"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="mt-3 flex items-center justify-between">
              <span className={cn(FIELD_LABEL, 'mb-0')}>答案</span>
              <button
                type="button"
                onClick={onAiSolve}
                disabled={solving}
                className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[10.5px] font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
              >
                <Sparkles className={cn('h-3 w-3', solving && 'animate-pulse')} />
                {solving ? '解题中…' : 'AI 解'}
              </button>
            </div>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={2}
              placeholder="缺答案的题不能入库,手填或点 AI 解"
              className={cn(INPUT, 'mt-1.5 resize-y leading-relaxed')}
            />

            <div className="mt-3">
              <label className={FIELD_LABEL}>考点</label>
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="2~8 字考点短语" className={INPUT} />
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              <div>
                <label className={FIELD_LABEL}>题型</label>
                <select value={kind} onChange={(e) => setKind(e.target.value === 'choice' ? 'choice' : 'answer')} className={INPUT}>
                  <option value="choice">选择</option>
                  <option value="answer">解答/填空</option>
                </select>
              </div>
              <div>
                <label className={FIELD_LABEL}>分值</label>
                <input value={score} onChange={(e) => setScore(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" className={INPUT} />
              </div>
              <div>
                <label className={FIELD_LABEL}>大题</label>
                <input value={candidate.section} disabled className={cn(INPUT, 'opacity-60')} />
              </div>
            </div>
          </div>
        </div>

        {/* 底:保存 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-line/60 px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-content-muted">
            改完保存即回列表;AI 解的答案入库时标「AI 参考」来源
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-line px-3.5 py-1.5 text-[12px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(buildSave())}
            className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
          >
            <Check className="h-3.5 w-3.5" />
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
