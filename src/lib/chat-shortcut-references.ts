import { MAX_REFERENCE_CHARS, type ConversationReference } from './chat-shortcuts'

export interface ConversationChoice {
  id: string
  title: string
  model: string
  mode: string
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isChoice(value: unknown): value is ConversationChoice {
  return isObject(value) && typeof value.id === 'string' && !!value.id.trim() &&
    typeof value.title === 'string' && !!value.title.trim() &&
    typeof value.model === 'string' && typeof value.mode === 'string'
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('操作已取消', 'AbortError')
}

function rethrowAbort(error: unknown, signal?: AbortSignal): void {
  checkAbort(signal)
  if (isObject(error) && error.name === 'AbortError') throw error
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  checkAbort(signal)
  let response: Response
  try {
    response = await fetch(url, { method: 'GET', signal })
  } catch (error) {
    rethrowAbort(error, signal)
    throw new Error('无法连接会话服务，请检查网络后重试')
  }
  checkAbort(signal)
  if (!response.ok) {
    if (response.status === 401) throw new Error('登录已失效，请重新登录后再试')
    if (response.status === 403) throw new Error('没有权限读取此会话')
    if (response.status === 404) throw new Error('会话不存在或已被删除')
    throw new Error(`读取会话失败（HTTP ${response.status}），请稍后重试`)
  }
  try {
    const data: unknown = await response.json()
    checkAbort(signal)
    return data
  } catch (error) {
    rethrowAbort(error, signal)
    throw new Error('会话服务返回的 JSON 无效，请稍后重试')
  }
}

export async function searchShortcutConversations(query: string, signal?: AbortSignal): Promise<{ items: ConversationChoice[]; hasMore: boolean }> {
  const params = new URLSearchParams({ limit: '20', type: 'title', q: query })
  const data = await fetchJson(`/api/conversations?${params}`, signal)
  if (!isObject(data) || !Array.isArray(data.items) || data.items.length > 20 ||
      typeof data.total !== 'number' || !Number.isSafeInteger(data.total) || data.total < data.items.length ||
      typeof data.hasMore !== 'boolean' || data.hasMore !== (data.total > data.items.length) ||
      !data.items.every(isChoice)) {
    throw new Error('会话搜索响应格式无效，请稍后重试')
  }
  return {
    items: data.items.map(({ id, title, model, mode }) => ({ id, title, model, mode })),
    hasMore: data.hasMore,
  }
}

interface ReferenceMessage {
  id: string
  role: string
  content: string
  model: string | null
  groupId: string | null
  streaming: boolean
}

function isMessage(value: unknown): value is ReferenceMessage {
  return isObject(value) && typeof value.id === 'string' && !!value.id.trim() &&
    typeof value.role === 'string' && typeof value.content === 'string' &&
    (value.model === null || typeof value.model === 'string') &&
    (value.groupId === null || typeof value.groupId === 'string') &&
    typeof value.streaming === 'boolean'
}

export async function loadConversationReference(choice: ConversationChoice, signal?: AbortSignal): Promise<ConversationReference> {
  checkAbort(signal)
  if (!isChoice(choice)) throw new Error('会话信息无效，请重新选择')
  const seenIds = new Set<string>()
  const seenCursors = new Set<string>()
  const pieces: string[] = []
  let cursor: string | null = null
  let used = 0
  let truncated = false

  // The API delivers newest first. Keep the newest readable window within the budget,
  // then reverse message blocks (never lines within a block) for the final transcript.
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: '100' })
    if (cursor !== null) params.set('cursor', cursor)
    const data = await fetchJson(`/api/conversations/${encodeURIComponent(choice.id)}/messages?${params}`, signal)
    if (!isObject(data) || !Array.isArray(data.messages) || data.messages.length > 100 ||
        !(data.nextCursor === null || (typeof data.nextCursor === 'string' && !!data.nextCursor.trim())) ||
        !data.messages.every(isMessage)) {
      throw new Error('会话消息响应格式无效，请稍后重试')
    }
    const messages: ReferenceMessage[] = data.messages
    let newIds = 0
    let budgetReached = false
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (seenIds.has(message.id)) continue
      seenIds.add(message.id)
      newIds++
      if (message.streaming || !message.content.trim() || !['user', 'assistant'].includes(message.role)) continue
      if (message.role === 'assistant' && choice.mode !== 'compare' && message.groupId && message.model !== choice.model) continue
      const label = message.role === 'user' ? '用户：\n' : `AI（模型：${JSON.stringify(message.model || '未知')}）：\n`
      const remaining = MAX_REFERENCE_CHARS - used - (pieces.length ? 2 : 0)
      if (remaining <= label.length) {
        truncated = true
        budgetReached = true
        break
      }
      let content = message.content.slice(0, remaining - label.length)
      if (content.length < message.content.length && /[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1)
      if (!content.trim()) {
        truncated = true
        budgetReached = true
        break
      }
      const piece = label + content
      used += piece.length + (pieces.length ? 2 : 0)
      pieces.push(piece)
      if (content.length < message.content.length || used === MAX_REFERENCE_CHARS) {
        truncated = content.length < message.content.length || i < messages.length - 1 || data.nextCursor !== null
        budgetReached = true
        break
      }
    }
    if (budgetReached || data.nextCursor === null) break
    cursor = data.nextCursor as string
    if (seenCursors.has(cursor) || newIds === 0 || page === 9) {
      truncated = true
      break
    }
    seenCursors.add(cursor)
  }
  checkAbort(signal)
  if (!pieces.length) throw new Error('此会话没有可引用的已完成文本消息（不含附件和隐藏推理）')
  return { id: choice.id, title: choice.title, text: pieces.reverse().join('\n\n'), truncated, messageCount: pieces.length }
}
