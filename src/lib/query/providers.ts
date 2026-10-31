import { queryKeys, STALE } from '@/lib/query/keys'
import { fetchJson } from '@/lib/query/fetcher'
import type { ModelDefinition } from '@/lib/ai/types'

/**
 * ── 已配置 Key 的 provider 名单(仅标识,零密钥信息) ────────
 * 用它回答「哪些服务商的模型真的能跑」。不用 /api/keys:后者返回掩码密钥,
 * 临时聊天模式下被 middleware 整体 403(见 app/api/providers/keys-status)。
 */
export const providerKeysStatusQuery = {
  queryKey: [...queryKeys.providers(), 'keys-status'] as const,
  queryFn: async (): Promise<Set<string>> => {
    const rows = await fetchJson<Array<{ provider?: string }>>('/api/providers/keys-status')
    return new Set(
      (Array.isArray(rows) ? rows : []).map((r) => r.provider ?? '').filter(Boolean)
    )
  },
  staleTime: STALE.providers,
}

/**
 * 模型「开箱可用」判定 —— 与 ModelSelector 的下拉口径一致:
 * 已配置 Key 的 provider / 自定义模型 / 公共池门面(服务端出钱,全员可见)。
 */
export const isModelAvailable = (
  model: Pick<ModelDefinition, 'provider' | 'publicPool'>,
  configuredProviders: Set<string>
) =>
  model.provider === 'custom' ||
  model.publicPool === true ||
  configuredProviders.has(model.provider)

/**
 * ── /api/providers 模型列表的唯一 queryFn ─────────────────
 * 历史上 TopBar 预热(prefetchTab)、/chat、/study、/write、/chat/c/[id]
 * 各自手写映射,字段清单漂移 —— publicPool 透传缺失导致「标准」模型的
 * 首跑默认选不中。收敛到这一份:模型级扩展字段经展开透传自动携带,
 * 以后给 ModelDefinition 加字段只改 /api/providers 即可,调用点零改动。
 */
export const providersModelsQuery = {
  queryKey: queryKeys.providers(),
  queryFn: async (): Promise<ModelDefinition[]> => {
    const payload = await fetchJson<
      | Array<{ id?: string; effectiveModels: Array<Omit<ModelDefinition, 'provider'> & { provider?: string }> }>
      | { providers: Array<{ id?: string; effectiveModels: Array<Omit<ModelDefinition, 'provider'> & { provider?: string }> }> }
    >('/api/providers')
    const list = Array.isArray(payload) ? payload : payload.providers ?? []
    return list.flatMap((p) =>
      (p.effectiveModels ?? []).map((m) => ({
        ...m,
        provider: p.id ?? m.provider ?? '',
      }))
    )
  },
  staleTime: STALE.providers,
}
