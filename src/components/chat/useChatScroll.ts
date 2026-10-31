'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { registerListAnchoring, registerListFollowing } from './chat-list-bridge'

type Anchor = {
  node: HTMLElement
  messageId: string | null
  block: number
  top: number
  scrollTop: number
}
const BLOCKS = '.rich-md p, .rich-md li, .rich-md pre, .rich-md blockquote, .rich-md h1, .rich-md h2, .rich-md h3, .rich-md h4, .rich-md table'

/** One writer for passive layout changes. Explicit navigation may still scroll the list. */
export function createChatScrollController(
  el: HTMLElement,
  following: { current: boolean },
  onFollowing: (value: boolean) => void,
) {
  let destroyed = false
  let raf = 0
  let captureRaf = 0
  let layoutPending = false
  let anchor: Anchor | null = null
  let direction = 0
  let intentUntil = 0
  let lastTop = el.scrollTop
  let pointer: { y: number; scrollbar: boolean } | null = null
  let touchY: number | null = null
  const priorOverflowAnchor = el.style.overflowAnchor
  el.style.overflowAnchor = 'none'

  const bottomDistance = () => el.scrollHeight - el.clientHeight - el.scrollTop
  const capture = () => {
    if (following.current || destroyed || !el.clientHeight) { anchor = null; return }
    const box = el.getBoundingClientRect()
    const messages = el.querySelectorAll<HTMLElement>('[data-message-id]')
    for (const message of Array.from(messages)) {
      const r = message.getBoundingClientRect()
      if (r.bottom <= box.top + 1 || r.top >= box.bottom) continue
      const blocks = Array.from(message.querySelectorAll<HTMLElement>(BLOCKS))
      const block = blocks.findIndex(n => {
        const b = n.getBoundingClientRect()
        return b.height > 0 && b.bottom > box.top + 1 && b.top < box.bottom
      })
      const node = blocks[block] ?? message
      anchor = { node, block, messageId: message.dataset.messageId ?? null,
        top: node.getBoundingClientRect().top - box.top, scrollTop: el.scrollTop }
      return
    }
    anchor = null
  }
  const captureSoon = () => {
    if (captureRaf || destroyed) return
    captureRaf = requestAnimationFrame(() => {
      captureRaf = 0
      if (!layoutPending) capture()
    })
  }
  const setFollowing = (value: boolean) => {
    if (following.current === value) return
    following.current = value
    onFollowing(value)
  }
  const detach = () => {
    setFollowing(false)
    // Capture before the default wheel/keyboard action, then refresh after its scroll event.
    if (!anchor) capture()
  }
  const flush = () => {
    raf = 0
    layoutPending = false
    if (destroyed || !el.isConnected || !el.clientHeight) return
    if (following.current) {
      if (Math.abs(bottomDistance()) > 1) el.scrollTop = el.scrollHeight
      anchor = null
    } else if (anchor) {
      let node = anchor.node
      if (!node.isConnected && anchor.messageId) {
        const message = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
          .find(n => n.dataset.messageId === anchor?.messageId)
        node = message?.querySelectorAll<HTMLElement>(BLOCKS)[anchor.block] ?? message ?? node
      }
      if (node.isConnected && el.contains(node)) {
        // Subtract user scrolling from the observed movement; compensate layout only.
        const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top
        const drift = top - anchor.top + el.scrollTop - anchor.scrollTop
        if (Math.abs(drift) > 1) el.scrollTop += drift
      }
      capture()
    }
    lastTop = el.scrollTop
  }
  const schedule = () => {
    if (destroyed) return
    layoutPending = true
    if (!raf) raf = requestAnimationFrame(flush)
  }
  const resume = () => {
    direction = 0
    intentUntil = 0
    anchor = null
    setFollowing(true)
    schedule()
  }
  // Scrollable descendants own their gestures, including contained overscroll at an edge.
  const nestedOwns = (target: EventTarget | null, delta: number) => {
    let node = target instanceof Element ? target : null
    while (node && node !== el) {
      if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
        const style = getComputedStyle(node)
        if (/auto|scroll/.test(style.overflowY)) {
          const canScroll = delta < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1
          if (canScroll || /contain|none/.test(style.overscrollBehaviorY)) return true
        }
      }
      node = node.parentElement
    }
    return false
  }
  const intent = (delta: number) => {
    direction = Math.sign(delta)
    intentUntil = performance.now() + 500
    if (delta < 0) detach()
    // A downward gesture at bottom is explicit consent even if no scroll event follows.
    else if (delta > 0 && bottomDistance() <= 2) resume()
  }
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    if (!nestedOwns(event.target, event.deltaY)) intent(event.deltaY)
  }
  const onScroll = () => {
    const top = el.scrollTop
    // Shrinkage cannot increase top; flush records its own compensation before
    // scroll events run. A pending RO must not discard real downward consent.
    if (!following.current && direction > 0 && performance.now() < intentUntil &&
        top > lastTop + 0.5 && bottomDistance() <= 2) resume()
    lastTop = top
    if (!following.current) captureSoon()
  }
  const onKey = (event: KeyboardEvent) => {
    const target = event.target
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
    if (target instanceof Element && target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return
    if (target instanceof Node && target !== document.body && target !== document.documentElement && !el.contains(target)) return
    const up = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)
    const down = ['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey)
    if (!up && !down) return
    if (!nestedOwns(target, up ? -1 : 1)) intent(up ? -1 : 1)
  }
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || event.button > 1) return
    const r = el.getBoundingClientRect()
    const scrollbar = event.clientX >= r.right - Math.max(14, el.offsetWidth - el.clientWidth)
    pointer = { y: event.clientY, scrollbar }
    if (scrollbar || event.button === 1) detach()
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!pointer || !event.buttons) return
    const delta = event.clientY - pointer.y
    if (pointer.scrollbar && delta) intent(delta)
    else if (Math.abs(delta) > 3 && !nestedOwns(event.target, -delta)) detach()
    pointer.y = event.clientY
  }
  const onPointerUp = () => {
    if (pointer?.scrollbar && direction > 0 && bottomDistance() <= 2) resume()
    pointer = null
  }
  const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null }
  const onTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY
    if (touchY !== null && y !== undefined) {
      const delta = touchY - y
      if (delta && !nestedOwns(event.target, delta)) intent(delta)
    }
    touchY = y ?? null
  }
  const onTouchEnd = () => { touchY = null }
  const ro = new ResizeObserver(schedule)
  ro.observe(el)
  const content = el.firstElementChild
  if (content) ro.observe(content)
  el.addEventListener('wheel', onWheel, { passive: true, capture: true })
  el.addEventListener('scroll', onScroll, { passive: true })
  el.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true })
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerup', onPointerUp, { passive: true })
  window.addEventListener('pointercancel', onPointerUp, { passive: true })
  el.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
  el.addEventListener('touchmove', onTouchMove, { passive: true, capture: true })
  el.addEventListener('touchend', onTouchEnd, { passive: true })
  window.addEventListener('keydown', onKey)
  schedule()
  return {
    resume,
    detach,
    destroy() {
      destroyed = true
      ro.disconnect()
      cancelAnimationFrame(raf)
      cancelAnimationFrame(captureRaf)
      el.removeEventListener('wheel', onWheel, { capture: true })
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      el.removeEventListener('touchstart', onTouchStart, { capture: true })
      el.removeEventListener('touchmove', onTouchMove, { capture: true })
      el.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('keydown', onKey)
      el.style.overflowAnchor = priorOverflowAnchor
    },
  }
}

export function useChatScroll(el: HTMLDivElement | null) {
  const following = useRef(true)
  const controller = useRef<ReturnType<typeof createChatScrollController> | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  useEffect(() => {
    registerListFollowing(() => following.current)
    return () => registerListFollowing(() => true)
  }, [])
  useEffect(() => {
    if (!el) return
    const current = createChatScrollController(el, following, value => setShowScrollToBottom(!value))
    controller.current = current
    registerListAnchoring(true)
    return () => {
      current.destroy()
      controller.current = null
      registerListAnchoring(false)
    }
  }, [el])
  const handleScrollToBottom = useCallback(() => {
    following.current = true
    setShowScrollToBottom(false)
    controller.current?.resume()
  }, [])
  const detachScroll = useCallback(() => controller.current?.detach(), [])
  return { showScrollToBottom, handleScrollToBottom, detachScroll }
}
