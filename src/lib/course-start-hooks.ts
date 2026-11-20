'use client'

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  isBilibiliInput,
  normalizeCourseUrl,
  patchCourseRecent,
  type CourseRecent,
} from '@/lib/course-recents'

/**
 * 课程启动页共用的两段副作用(日常 B 案 / 监管 C 案都吃):
 * - useCourseMeta:缺标题/封面的最近项问 /api/course/meta 补齐(每项只问一次,失败静默)
 * - useClipboardCourseLink:只在输入框聚焦/窗口回焦时读剪贴板,读不到 B 站链接就不显示
 */

export function useCourseMeta(
  recents: CourseRecent[],
  setRecents: Dispatch<SetStateAction<CourseRecent[]>>,
  preview: boolean
) {
  const asked = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (preview) return
    const targets = recents
      .filter((r) => (!r.title || !r.cover) && !asked.current.has(r.url))
      .slice(0, 3)
    if (!targets.length) return
    targets.forEach((t) => asked.current.add(t.url))
    let alive = true
    void (async () => {
      for (const t of targets) {
        try {
          const res = await fetch(`/api/course/meta?url=${encodeURIComponent(t.url)}`, {
            cache: 'no-store',
          })
          if (!res.ok) continue
          const j = (await res.json()) as { title?: string | null; cover?: string | null }
          if (!alive) return
          if (!j.title && !j.cover) continue
          setRecents((prev) =>
            patchCourseRecent(prev, t.url, {
              title: j.title ?? undefined,
              cover: j.cover ?? undefined,
            })
          )
        } catch {
          /* 离线/限流:保留兜底标签 */
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [recents, preview, setRecents])
}

export function useClipboardCourseLink() {
  const [clip, setClip] = useState('')
  const lastCheck = useRef(0)

  const checkClipboard = useCallback(async () => {
    const now = Date.now()
    if (now - lastCheck.current < 1500) return
    lastCheck.current = now
    try {
      const text = await navigator.clipboard.readText()
      if (text && isBilibiliInput(text)) setClip(normalizeCourseUrl(text))
      else setClip('')
    } catch {
      /* 权限拒绝/不支持:静默 */
    }
  }, [])

  useEffect(() => {
    const onFocus = () => void checkClipboard()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkClipboard])

  const clearClip = useCallback(() => setClip(''), [])

  return { clip, checkClipboard, clearClip }
}