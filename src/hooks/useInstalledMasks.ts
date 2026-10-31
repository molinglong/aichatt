'use client'

/**
 * 面具面板已下载的内置面具。
 * 数据源 GET /api/masks/installed（只返回 id），这里映射回代码里的 BuiltinMask，
 * 供选择器「我的面具」、侧栏菜单与 / 快捷命令复用；与设置页共享同一 query 缓存。
 */
import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys, STALE } from '@/lib/query/keys'
import { getBuiltinMask, type BuiltinMask } from '@/lib/ai/builtin-masks'

export function useInstalledMasks(enabled = true): {
  installedMasks: BuiltinMask[]
  installedIds: string[]
  isLoading: boolean
} {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.masks.installed(),
    queryFn: () => fetchJson<{ maskIds: string[] }>('/api/masks/installed'),
    staleTime: STALE.masks,
    enabled,
  })

  const installedIds = data?.maskIds ?? []
  const installedMasks = installedIds
    .map((id) => getBuiltinMask(id))
    .filter((m): m is BuiltinMask => !!m)

  return { installedMasks, installedIds, isLoading }
}
