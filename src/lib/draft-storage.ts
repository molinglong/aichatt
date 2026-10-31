/**
 * 草稿本地存储 (SSR-safe)
 *
 * 设计要点:
 *  - localStorage 单 key 存储整个 Record,避免散 key 命名空间污染
 *  - 写入失败(QuotaExceededError、私密浏览模式)时静默降级,不抛错到 UI
 *  - 写入加 500ms 防抖,避免输入时频繁 IO
 *  - 读取走同步 API,便于组件挂载时一次性恢复
 */

import type { ConversationReference } from './chat-shortcuts'

const STORAGE_KEY = 'chat:drafts:v1'
const SAVE_DEBOUNCE_MS = 500

export interface DraftEntry {
  /** 输入文本 */
  text: string
  /** 最近保存时间戳(ms) */
  savedAt: number
  /** 用户主动选取的会话正文快照，与正文一起恢复，避免标签丢失。 */
  references?: ConversationReference[]
}

export type DraftsMap = Record<string, DraftEntry>

/** 读取全部草稿(SSR 期间返回空对象) */
export function loadDrafts(): DraftsMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed as DraftsMap
    }
    return {}
  } catch {
    return {}
  }
}

/** 读取某个会话的草稿 */
export function getDraft(convKey: string): DraftEntry | null {
  const all = loadDrafts()
  return all[convKey] ?? null
}

/** 写入某个会话的草稿(覆盖) */
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingWrites: DraftsMap | null = null

export function setDraft(convKey: string, entry: DraftEntry | null): void {
  if (typeof window === 'undefined') return
  const current = loadDrafts()
  if (entry === null) {
    delete current[convKey]
  } else {
    current[convKey] = entry
  }
  pendingWrites = current
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    flushDrafts()
  }, SAVE_DEBOUNCE_MS)
}

/** 立即冲刷待写入数据(供「发送前」清空草稿使用) */
export function flushDrafts(): void {
  if (typeof window === 'undefined') return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!pendingWrites) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingWrites))
  } catch {
    // QuotaExceeded 或私密模式 → 静默降级,功能照常工作
  }
  pendingWrites = null
}

/** 清空某个会话的草稿 */
export function clearDraft(convKey: string): void {
  setDraft(convKey, null)
  // 立即生效,避免与「发送后跳转」竞态
  flushDrafts()
}

/** 草稿 key 命名:__new__ 用于未发送时的占位 */
export const DRAFT_NEW_KEY = '__new__'

export function draftKeyFor(conversationId: string | null | undefined): string {
  return conversationId ?? DRAFT_NEW_KEY
}
