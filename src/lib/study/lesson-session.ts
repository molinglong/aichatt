/**
 * 学习模式「续课」本地快照
 *
 * /study 是单页学习室:题目、附件、学习起点、追问草稿都只活在组件 state 里,
 * 页面一刷新组件重挂就是开新课。这里把整堂课的快照落 localStorage,配合 URL 上的
 * 会话 id 从服务端回拉已入库的讲解,实现「刷新接着上同一道题」。
 *
 * 设计要点:
 *  - 单 key 单快照:同一时刻只学一道题,不做多课堆叠(避免旧课残渣顶掉新课)
 *  - 写入 300ms 防抖,localStorage 不可用(私密浏览/配额)时静默降级
 *  - 模块内缓存一份,让页面(读会话 id)与学习室(读阶段)看到同一份数据
 *  - 结构损坏或版本不符时整体丢弃,回落到空白课
 */

import type { Attachment } from '@/lib/attachment-types'

const STORAGE_KEY = 'study:lesson:v1'
const SAVE_DEBOUNCE_MS = 300

export type StudyApproach = 'beginner' | 'partial' | 'review'

export interface StudyLessonSnapshot {
  /** 已入库的会话 id;首条消息返回前为 null */
  conversationId: string | null
  /** 原题正文(用户粘贴的那段,不含发送时拼的引导语) */
  question: string
  attachments: Attachment[]
  /** 是否已提交题目进入「选学习起点」阶段 */
  questionReady: boolean
  approach: StudyApproach | null
  thought: string
  choosing: boolean
  collectingThought: boolean
  drafts: Record<StudyApproach, string>
  savedAt: number
}

function blank(): StudyLessonSnapshot {
  return {
    conversationId: null,
    question: '',
    attachments: [],
    questionReady: false,
    approach: null,
    thought: '',
    choosing: true,
    collectingThought: false,
    drafts: { beginner: '', partial: '', review: '' },
    savedAt: 0,
  }
}

let cache: StudyLessonSnapshot | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let flushBound = false

/** 立即落盘(绕过防抖);页面卸载时兜底,避免最后 300ms 的输入丢失 */
function writeNow(snapshot: StudyLessonSnapshot): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // 配额/私密模式 → 静默降级,本次会话内存里仍然可用
  }
}

function bindFlush(): void {
  if (flushBound || typeof window === 'undefined') return
  flushBound = true
  const flush = () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (cache) writeNow(cache)
  }
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
}

/** 空白课快照:快照不属于当前会话(从历史打开旧课)时用来重置界面状态 */
export function blankStudyLesson(): StudyLessonSnapshot {
  return blank()
}

/** 读取续课快照(SSR 期间返回空白课,不写缓存) */
export function loadStudyLesson(): StudyLessonSnapshot {
  if (typeof window === 'undefined') return blank()
  if (cache) return cache
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StudyLessonSnapshot>
      if (parsed && typeof parsed === 'object') {
        const base = blank()
        cache = {
          ...base,
          ...parsed,
          attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
          drafts: { ...base.drafts, ...(parsed.drafts ?? {}) },
        }
        return cache
      }
    }
  } catch {
    // 损坏 JSON / 存储不可用 → 当作没有续课
  }
  cache = blank()
  return cache
}

/** 合并写入快照字段(防抖落盘) */
export function patchStudyLesson(patch: Partial<StudyLessonSnapshot>): void {
  if (typeof window === 'undefined') return
  bindFlush()
  const next = { ...loadStudyLesson(), ...patch, savedAt: Date.now() }
  cache = next
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeNow(next)
  }, SAVE_DEBOUNCE_MS)
}

/** 清空续课(开新课/会话已失效/用户显式重开) */
export function clearStudyLesson(): void {
  cache = blank()
  if (typeof window === 'undefined') return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略:清不掉也不影响本次内存态
  }
}
