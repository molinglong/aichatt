import type { PlanItem, PlanMemo, ReviewResult, ScheduleResponse } from "./types"

/**
 * 今日计划客户端 API(cookie session 直连)。
 * 原 plan 应用 src/lib/api.ts 的并入版:去掉离线缓存/flush 通道,双端直连 Postgres。
 */

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(typeof data?.error === "string" ? data.error : `请求失败（${res.status}）`)
  }
  return res.json() as Promise<T>
}

export interface CreateItemInput {
  title: string
  note?: string
  kind?: PlanItem["kind"]
  priority?: PlanItem["priority"]
  estimateMin?: number
  energy?: PlanItem["energy"]
  plannedDate?: string
  startMin?: number
  endMin?: number
}

export interface PlanMemoInput {
  id?: string
  title?: string
  content?: string
  pinned?: boolean
}

export const planApi = {
  list(date: string) {
    return request<{ items: PlanItem[] }>(`/api/plan/items?date=${encodeURIComponent(date)}`)
  },

  create(input: CreateItemInput) {
    return request<PlanItem>("/api/plan/items", {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  /** 更新;restore=true 时 patch 里带删除前快照,原样放回 */
  update(id: string, patch: Record<string, unknown>) {
    return request<PlanItem>(`/api/plan/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  },

  remove(id: string) {
    return request<{ ok: true }>(`/api/plan/items/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  },

  schedule(date: string, mode: "all" | "one", id?: string) {
    return request<ScheduleResponse>("/api/plan/schedule-day", {
      method: "POST",
      body: JSON.stringify({ date, mode, id }),
    })
  },

  review(date: string) {
    return request<ReviewResult>(`/api/plan/review?date=${encodeURIComponent(date)}`)
  },

  memos() {
    return request<{ memos: PlanMemo[] }>("/api/plan/memos")
  },

  memoCreate(input: PlanMemoInput & { content: string }) {
    return request<PlanMemo>("/api/plan/memos", {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  memoUpdate(id: string, patch: PlanMemoInput) {
    return request<PlanMemo>("/api/plan/memos", {
      method: "PATCH",
      body: JSON.stringify({ id, ...patch }),
    })
  },

  memoRemove(id: string) {
    return request<{ ok: true }>(`/api/plan/memos?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  },
}
