'use client'

/**
 * 学习会话数据 + 流式消费 hook(v2 独立管线):
 * - load:GET /api/study/[id](会话 + 讲义卡步)
 * - post(action):POST /api/study/[id]/stream,SSE 增量更新本地流式卡
 * - 远端流式兜底:检测到 streaming 步(跨端/刷新)自动 1.5s 轮询补拉
 * - complete:手动结课(幂等)
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface StudyRef {
  doc: string
  chapter: string | null
  section: string | null
  heading: string
  content: string
}

export interface StudySessionView {
  id: string
  question: string
  images: string[]
  startLevel: string
  status: 'explaining' | 'completed'
  modelId: string
  summary: string | null
  createdAt: string
  updatedAt: string
}

export interface StudyStepView {
  id: string
  idx: number
  action: string | null
  followupText: string | null
  content: string
  reasoning: string | null
  refs: StudyRef[] | null
  selfRating: 'good' | 'again' | null
  streaming: boolean
}

export type StudyAction = 'start' | 'continue' | 'easier' | 'solution' | 'followup' | 'quiz'

export interface StudyPostOpts {
  text?: string
  /** 随本动作一并记录的上一步自评(讲义卡「懂了/没懂」) */
  rate?: { idx: number; rating: 'good' | 'again' }
}

export function useStudySession(sessionId: string | null) {
  const [session, setSession] = useState<StudySessionView | null>(null)
  const [steps, setSteps] = useState<StudyStepView[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [archivedNoteId, setArchivedNoteId] = useState<string | null>(null)
  const busyRef = useRef(false)

  const apply = useCallback((d: { session: StudySessionView; steps: StudyStepView[]; archivedNoteId?: string | null }) => {
    // 本地流式进行中禁止覆盖:迟到的 GET/轮询会把流式占位卡打回服务器快照(内容竞态)
    if (busyRef.current) return
    setSession(d.session)
    setSteps(d.steps)
    if (d.archivedNoteId !== undefined) setArchivedNoteId(d.archivedNoteId)
  }, [])

  const load = useCallback(
    async (id?: string | null) => {
      const target = id ?? sessionId
      if (!target) return
      setLoading(true)
      setLoadError(null)
      try {
        const res = await fetch(`/api/study/${target}`)
        if (res.status === 404) {
          setLoadError('not_found')
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        apply(await res.json())
      } catch {
        setLoadError('网络错误,加载失败')
      } finally {
        setLoading(false)
      }
    },
    [sessionId, apply]
  )

  // 初载 + 会话切换
  useEffect(() => {
    if (sessionId) void load(sessionId)
    else {
      setSession(null)
      setSteps([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 远端流式兜底:非本地触发的 streaming 步(刷新/跨端)轮询补拉,到稳态即停
  useEffect(() => {
    if (!sessionId || busy) return
    if (!steps.some((s) => s.streaming)) return
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/study/${sessionId}`)
        if (!res.ok) return
        const d = (await res.json()) as { session: StudySessionView; steps: StudyStepView[] }
        setSession(d.session)
        setSteps(d.steps)
      } catch {
        /* 下一轮再试 */
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [sessionId, steps, busy])

  const postTo = useCallback(
    async (targetId: string, action: StudyAction, opts?: StudyPostOpts) => {
      if (!targetId || busyRef.current) return
      busyRef.current = true
      setBusy(true)
      setStreamError(null)
      const tempId = `streaming-${Date.now()}`
      setSteps((prev) => [
        ...prev.map((s) => (opts?.rate && s.idx === opts.rate.idx ? { ...s, selfRating: opts.rate.rating } : s)),
        {
          id: tempId,
          idx: prev.length,
          action,
          followupText: opts?.text ?? null,
          content: '',
          reasoning: null,
          refs: null,
          selfRating: null,
          streaming: true,
        },
      ])
      let live = ''
      try {
        const res = await fetch(`/api/study/${targetId}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, text: opts?.text, rate: opts?.rate }),
        })
        if (!res.ok || !res.body) {
          const e = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(e.error || `HTTP ${res.status}`)
        }
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let sep: number
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            if (!raw.startsWith('data: ')) continue
            const evt = JSON.parse(raw.slice(6)) as {
              type: string
              text?: string
              refs?: StudyRef[]
              stepId?: string
              completed?: boolean
              message?: string
            }
            if (evt.type === 'delta') {
              live += evt.text ?? ''
              setSteps((prev) => prev.map((s) => (s.id === tempId ? { ...s, content: live } : s)))
            } else if (evt.type === 'refs') {
              setSteps((prev) => prev.map((s) => (s.id === tempId ? { ...s, refs: evt.refs ?? null } : s)))
            } else if (evt.type === 'thinking') {
              setSteps((prev) =>
                prev.map((s) => (s.id === tempId ? { ...s, reasoning: (s.reasoning ?? '') + (evt.text ?? '') } : s))
              )
            } else if (evt.type === 'done') {
              setSteps((prev) =>
                prev.map((s) =>
                  s.id === tempId ? { ...s, id: evt.stepId ?? s.id, content: s.content || live, streaming: false } : s
                )
              )
              if (evt.completed) setSession((prev) => (prev ? { ...prev, status: 'completed' } : prev))
            } else if (evt.type === 'error') {
              setStreamError(evt.message ?? '生成失败')
              setSteps((prev) => prev.map((s) => (s.id === tempId ? { ...s, streaming: false } : s)))
            }
          }
        }
      } catch (err) {
        setStreamError(err instanceof Error ? err.message : '生成失败')
        setSteps((prev) => prev.map((s) => (s.id === tempId ? { ...s, streaming: false } : s)))
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [sessionId]
  )

  const post = useCallback(
    (action: StudyAction, opts?: StudyPostOpts) => {
      if (!sessionId) return
      return postTo(sessionId, action, opts)
    },
    [sessionId, postTo]
  )

  const complete = useCallback(async () => {
    if (!sessionId) return
    await fetch(`/api/study/${sessionId}/complete`, { method: 'POST' }).catch(() => {})
    await load(sessionId)
  }, [sessionId, load])

  return {
    session,
    steps,
    loading,
    loadError,
    busy,
    streamError,
    archivedNoteId,
    setArchivedNoteId,
    reload: load,
    post,
    postTo,
    complete,
    setSteps,
  }
}
