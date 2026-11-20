'use client'

/**
 * 划词翻译（全站可用）
 *
 * 选中英文/中文 → 选区旁冒一个「译」小按钮 → 点开小卡：
 *   · 单个英文词：先查本地字典（命中显示音标/词性/释义/助记，零 token）
 *   · 没命中或整句：交给 AI 翻译
 *   · 都能「加入我的词」和「复制」
 *
 * 只在正文上生效：输入框、文本域、可编辑区域里的选区一律忽略；
 * 滚动、点空白、Esc、选区消失都会关掉，不挡别的手势。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { pruneForPrint } from '@/lib/words/sheet'

interface DictEntry {
  headword: string
  pos: string | null
  trans: string | null
  mnemonic: string | null
  phoneticUs: string | null
  phoneticUk: string | null
  isPhrase: boolean
}

interface Result {
  from: 'dict' | 'ai'
  translation: string
  entry?: DictEntry
}

interface Anchor {
  x: number
  y: number
  text: string
}

const MAX_LEN = 200

export function SelectionTranslator() {
  const [pill, setPill] = useState<Anchor | null>(null)
  const [panel, setPanel] = useState<Anchor | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastTextRef = useRef('')

  const closeAll = useCallback(() => {
    setPill(null)
    setPanel(null)
    setResult(null)
    setError(null)
    setAdded(false)
  }, [])

  /** 读当前选区：排除输入框/可编辑区，限制长度，取尾部坐标 */
  const readSelection = useCallback((): Anchor | null => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (!text || text.length > MAX_LEN) return null

    const node = sel.anchorNode
    const el = node instanceof HTMLElement ? node : node?.parentElement
    if (el?.closest('input, textarea, [contenteditable="true"], .ws-noprint, .no-selection-translate')) return null

    const rect = sel.getRangeAt(0).getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) return null
    return {
      x: Math.min(Math.max(rect.left + rect.width / 2, 60), window.innerWidth - 60),
      y: Math.min(rect.bottom, window.innerHeight - 40),
      text,
    }
  }, [])

  const translate = useCallback(async (text: string) => {
    setLoading(true)
    setError(null)
    setResult(null)
    setAdded(false)
    try {
      const res = await fetch('/api/words/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const d = (await res.json().catch(() => ({}))) as Result & { error?: string }
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setResult(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : '翻译失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const addToWords = useCallback(async () => {
    if (!panel) return
    try {
      const res = await fetch('/api/words/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headword: panel.text, trans: result?.translation ?? '' }),
      })
      const d = (await res.json().catch(() => ({}))) as { existed?: boolean; error?: string }
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setAdded(true)
      toast.success(d.existed ? '已经在你的词库里了' : '已加入我的词')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加入失败')
    }
  }, [panel, result])

  // 选区动作：鼠标松开 / 手指抬起
  useEffect(() => {
    const onUp = () => {
      // 让浏览器先结算选区
      window.setTimeout(() => {
        const a = readSelection()
        if (!a) return
        if (rootRef.current?.contains(document.activeElement)) return
        setPill(a)
        setPanel(null)
      }, 10)
    }
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchend', onUp)
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchend', onUp)
    }
  }, [readSelection])

  // 点空白 / 滚动 / Esc 关掉
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return
      closeAll()
    }
    const onScroll = () => closeAll()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [closeAll])

  const openPanel = () => {
    if (!pill) return
    lastTextRef.current = pill.text
    setPanel(pill)
    setPill(null)
    void translate(pill.text)
  }

  const entry = result?.entry
  const ipa = entry?.phoneticUs || entry?.phoneticUk

  return (
    <div ref={rootRef} className="no-selection-translate pointer-events-none fixed inset-0 z-[60]">
      {/* 选区旁的小按钮 */}
      {pill && (
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={openPanel}
          style={{ left: pill.x, top: pill.y + 6 }}
          className="pointer-events-auto absolute flex h-8 -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-surface px-3 text-[12px] font-semibold text-content-primary shadow-[0_6px_20px_rgb(0_0_0/0.16)]"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5h9M8 5v14M4 19h8M15 9h5M17 9v10M14 19h6" />
          </svg>
          译
        </button>
      )}

      {/* 结果小卡 */}
      {panel && (
        <div
          style={{
            left: Math.min(Math.max(panel.x - 150, 12), typeof window !== 'undefined' ? window.innerWidth - 312 : 12),
            top: panel.y + 44,
          }}
          className="pointer-events-auto absolute w-[300px] overflow-hidden rounded-[14px] border border-line bg-surface shadow-[0_16px_48px_rgb(0_0_0/0.18)]"
        >
          <div className="flex items-start gap-2 border-b border-line px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-content-primary">{panel.text}</div>
              {ipa && <div className="truncate text-[11px] text-content-muted">{ipa}</div>}
            </div>
            <button
              type="button"
              onClick={closeAll}
              aria-label="关闭"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-content-muted hover:text-content-primary"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="max-h-[220px] overflow-y-auto px-3 py-2.5">
            {loading && <div className="py-1 text-[12.5px] text-content-muted">翻译中…</div>}
            {!loading && error && <div className="text-[12.5px] text-danger">{error}</div>}
            {!loading && result && (
              <>
                <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-content-primary">
                  {entry?.pos && <span className="mr-1 text-[11.5px] italic text-content-muted">{entry.pos}.</span>}
                  {/* 本地词条释义常 200+ 字，卡片里只留够用的一眼；全文在背词卡里看 */}
                  {result.from === 'dict' ? pruneForPrint(result.translation, 60) : result.translation}
                </div>
                {entry?.mnemonic && (
                  <div className="mt-1.5 rounded-[6px] bg-surface-muted px-2 py-1 text-[11.5px] leading-relaxed text-content-secondary">
                    助记 {entry.mnemonic}
                  </div>
                )}
                {result.from === 'dict' && (
                  <div className="mt-1.5 text-[10.5px] text-content-muted">本地词典命中</div>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5 border-t border-line px-2.5 py-2">
            <button
              type="button"
              disabled={added || loading}
              onClick={() => void addToWords()}
              className={cn(
                'rounded-full px-3 py-1 text-[11.5px] font-semibold transition-colors',
                added ? 'bg-surface-muted text-content-muted' : 'bg-accent text-accent-foreground disabled:opacity-50',
              )}
            >
              {added ? '已加入' : '加入我的词'}
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(result?.translation ?? '')
                toast.success('已复制')
              }}
              className="rounded-full border border-line px-3 py-1 text-[11.5px] text-content-secondary hover:text-content-primary"
            >
              复制
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
