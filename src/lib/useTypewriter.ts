'use client'

import { useSyncExternalStore, useRef, useEffect, useMemo, useCallback } from 'react'

/**
 * Per-instance external store: render only derives immutable text boundaries;
 * effects/RAF commit progress. String snapshots remain stable between reveals,
 * including interrupted React renders and StrictMode effect replays.
 */
interface TextState {
  fullText: string
  /** UTF-16 offsets after each complete reveal unit (normally one grapheme). */
  ends: number[]
}

interface StoreEntry extends TextState {
  revealedLength: number
  /** Fractional position in graphemes, not UTF-16 code units. */
  revealedPos: number
  rate: number
  rateCap: number
  lastTs: number
  listeners: Set<() => void>
  rafId: number | null
  alive: boolean
  enabled?: boolean
  draining?: boolean
}

const stores = new WeakMap<object, StoreEntry>()

// Normal input tracks a 140ms backlog. Large bursts get up to 500ms of
// smoothing budget, not a fixed characters/second ceiling. This is a feedback
// time constant, not a promise to reveal an entire burst in 500ms: the backlog
// decays over several budgets. A 6000-grapheme burst should drain within 3s.
const LATENCY_MS = 140
const BURST_EXTRA_MS = 360
const RATE_MIN = 12
const TAU_MS = 80
// A throttled/background RAF must not spend seconds of accumulated credit.
const MAX_DT_MS = 48

// Structural type keeps this usable with TS libs predating Intl.Segmenter.
type GraphemeSegmenter = { segment(text: string): Iterable<{ index: number; segment: string }> }
const Segmenter = (Intl as typeof Intl & {
  Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => GraphemeSegmenter
}).Segmenter
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null

/**
 * Without Segmenter, split only between known independent base characters.
 * Everything uncertain (marks, ZWJ, flags, Indic conjuncts, Jamo, etc.) stays
 * grouped with its neighbours. This deliberately over-groups rare scripts,
 * rather than pretending Array.from/code-point slicing is grapheme-safe.
 */
function independentBase(char: string): boolean {
  return /^[\x20-\x7e\t\r\n\u3400-\u9fff\u3041-\u3096\u30a1-\u30fa\uac00-\ud7a3]$/.test(char)
}

function segmentEnds(text: string, complete: boolean): number[] {
  const ends: number[] = []
  if (segmenter) {
    for (const part of Array.from(segmenter.segment(text))) ends.push(part.index + part.segment.length)
  } else {
    let offset = 0
    let previous = ''
    for (const char of Array.from(text)) {
      if (offset && independentBase(previous) && independentBase(char) && !(previous === '\r' && char === '\n')) {
        ends.push(offset)
      }
      offset += char.length
      previous = char
    }
    if (offset) ends.push(offset)
  }
  // Transport chunks can split a surrogate pair. Keep the incomplete suffix
  // queued without spinning RAF. Once upstream finishes, preserve even malformed
  // source text verbatim (as disabled/history does), rather than draining forever.
  if (!complete && /[\ud800-\udbff]$/.test(text)) ends.pop()
  return ends
}

function textState(fullText: string, previous: TextState, complete: boolean): TextState {
  if (fullText === previous.fullText) {
    let ends = previous.ends
    if (/[\ud800-\udbff]$/.test(fullText)) {
      const included = ends[ends.length - 1] === fullText.length
      if (complete !== included) ends = complete ? ends.concat(fullText.length) : ends.slice(0, -1)
    }
    return { fullText, ends }
  }
  if (!fullText.startsWith(previous.fullText)) return { fullText, ends: segmentEnds(fullText, complete) }
  // Re-segment the last cluster: a chunk may extend it with a combining mark,
  // skin tone, ZWJ sequence or the second regional indicator of a flag.
  const stableCount = Math.max(0, previous.ends.length - 1)
  const start = stableCount ? previous.ends[stableCount - 1] : 0
  return {
    fullText,
    ends: previous.ends.slice(0, stableCount).concat(segmentEnds(fullText.slice(start), complete).map(end => start + end)),
  }
}

/** Number of boundaries at/before a UTF-16 offset. */
function boundaryCount(ends: number[], offset: number): number {
  let lo = 0
  let hi = ends.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ends[mid] <= offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

function retainedLength(visible: string, previous: TextState, next: TextState): number {
  let length = Math.min(visible.length, next.fullText.length)
  if (!next.fullText.startsWith(visible)) {
    length = 0
    while (length < visible.length && length < next.fullText.length && visible[length] === next.fullText[length]) length++
  }
  // Keep only a prefix that is a complete unit in BOTH versions. Never reveal
  // unseen common text, or preserve half a glyph when its combining mark changes.
  for (;;) {
    const before = previous.ends[boundaryCount(previous.ends, length) - 1] ?? 0
    const after = next.ends[boundaryCount(next.ends, length) - 1] ?? 0
    const safe = Math.min(before, after)
    if (safe === length) return safe
    length = safe
  }
}

function getStore(token: object): StoreEntry {
  let entry = stores.get(token)
  if (!entry) {
    entry = {
      fullText: '', ends: [], revealedLength: 0, revealedPos: 0,
      rate: RATE_MIN, rateCap: 240, lastTs: 0,
      listeners: new Set(), rafId: null, alive: false,
    }
    stores.set(token, entry)
  }
  return entry
}

function snapshot(entry: StoreEntry): string {
  return entry.fullText.slice(0, entry.revealedLength)
}

function notifyChanged(entry: StoreEntry, before: string) {
  if (snapshot(entry) !== before) entry.listeners.forEach(listener => listener())
}

function tick(entry: StoreEntry, now: number) {
  entry.rafId = null
  const target = entry.ends.length
  if (!entry.alive || entry.revealedPos >= target) {
    entry.alive = false
    return
  }

  const before = snapshot(entry)
  const dtMs = Math.min(MAX_DT_MS, Math.max(0, now - entry.lastTs))
  entry.lastTs = now
  const gap = target - entry.revealedPos
  const budget = LATENCY_MS + Math.min(BURST_EXTRA_MS, Math.sqrt(Math.max(0, gap - 48)) * 5)
  // Bound extreme upstream bursts as well: a 6000-character snapshot must not
  // suddenly paint hundreds of characters per frame as its latency budget shrinks.
  const desired = Math.min(entry.rateCap, 2400, Math.max(RATE_MIN, gap * 1000 / budget))
  const alpha = 1 - Math.exp(-dtMs / TAU_MS)
  // Exact integral of the exponential velocity ramp for this frame. Unlike
  // applying the final velocity to the whole frame, this avoids a first-frame
  // jump and behaves consistently at 30/60/120Hz.
  const distance = (desired * dtMs + (entry.rate - desired) * TAU_MS * alpha) / 1000
  entry.rate += (desired - entry.rate) * alpha
  entry.revealedPos = Math.min(target, entry.revealedPos + Math.max(0, distance))
  entry.revealedLength = entry.ends[Math.floor(entry.revealedPos) - 1] ?? 0

  // Schedule before notifying: a synchronous subscriber commit may stop or
  // replace this chain. Never resurrect it after that commit returns.
  entry.alive = entry.revealedPos < target
  if (entry.alive) entry.rafId = requestAnimationFrame(t => tick(entry, t))
  notifyChanged(entry, before)
}

function kick(entry: StoreEntry) {
  if (entry.alive || entry.revealedPos >= entry.ends.length) return
  entry.alive = true
  entry.lastTs = performance.now()
  entry.rafId = requestAnimationFrame(t => tick(entry, t))
}

function stop(entry: StoreEntry) {
  entry.alive = false
  if (entry.rafId !== null) cancelAnimationFrame(entry.rafId)
  entry.rafId = null
}

function getServerSnapshot(): string {
  return ''
}

/** maxRate, when explicitly supplied, remains a hard graphemes/second cap. */
export function useTypewriter(fullText: string, enabled: boolean, maxRate?: number, drainOnDisable = false): {
  displayText: string
  isTyping: boolean
} {
  const tokenRef = useRef<object | null>(null)
  if (tokenRef.current === null) tokenRef.current = {}
  const token = tokenRef.current
  const entry = getStore(token)
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener) }
  }, [entry])
  const getSnapshot = useCallback(() => snapshot(entry), [entry])
  const displayText = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  // Pure, immutable derivation only; aborted renders cannot mutate the store.
  const next = useMemo(() => textState(fullText, entry, !enabled), [fullText, enabled, entry])

  useEffect(() => {
    const before = snapshot(entry)
    const appendOnly = fullText.startsWith(entry.fullText)
    const changed = fullText !== entry.fullText || next.ends !== entry.ends
    const wasTyping = entry.enabled || (entry.draining && entry.revealedLength < entry.fullText.length)
    entry.draining = Boolean(!enabled && drainOnDisable && wasTyping && appendOnly && entry.revealedLength < fullText.length)
    entry.enabled = enabled
    entry.rateCap = maxRate !== undefined && Number.isFinite(maxRate) && maxRate > 0 ? maxRate : 240
    entry.rate = Math.min(entry.rate, entry.rateCap)

    if (changed) {
      const retained = retainedLength(before, entry, next)
      const count = boundaryCount(next.ends, retained)
      const fraction = appendOnly && retained === entry.revealedLength ? entry.revealedPos % 1 : 0
      if (!appendOnly) {
        stop(entry)
        entry.rate = Math.min(RATE_MIN, entry.rateCap)
      }
      entry.fullText = fullText
      entry.ends = next.ends
      entry.revealedLength = retained
      entry.revealedPos = Math.min(next.ends.length, count + fraction)
    }
    if (enabled || entry.draining) {
      kick(entry)
    } else {
      entry.revealedLength = fullText.length
      entry.revealedPos = entry.ends.length
      entry.rate = Math.min(RATE_MIN, entry.rateCap)
      stop(entry)
    }
    // Hidden appends do not notify; multiple incoming commits share one RAF.
    notifyChanged(entry, before)
  }, [fullText, enabled, entry, next, maxRate, drainOnDisable])

  useEffect(() => () => stop(entry), [entry])

  const appendOnly = fullText.startsWith(entry.fullText)
  const draining = drainOnDisable && appendOnly &&
    (entry.enabled || (entry.draining && entry.revealedLength < entry.fullText.length))
  const visibleLength = retainedLength(displayText, entry, next)
  const visibleText = displayText.slice(0, visibleLength)
  const isTyping = Boolean((enabled || draining) && visibleText.length < fullText.length)
  // History/default-disabled is complete on its first render, while the ending
  // streaming frame keeps its queued tail. Revisions retain their safe prefix
  // even before the effect commits, instead of flashing empty/new full text.
  return { displayText: isTyping ? visibleText : fullText, isTyping }
}
