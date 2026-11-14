import { prisma } from '@/lib/db'

/**
 * 公共资源口径:管理员(role=admin)名下的试卷库/题库/课本库为全站公共资产。
 * 读路径(检索/抽题/组卷池/阅读器)按「自己 + 库主人」合并归属,新账号开箱即有题库;
 * 写路径(改/删/录入/拉黑)仍按原 userId 归属校验——公共资产对非主人只读。
 */

const OWNER_TTL = 60_000
let ownerCache: { ids: string[]; at: number } | null = null

/** 库主人 = 全部管理员。60s 进程内缓存,免得每个读查询都查一遍 user 表 */
async function libraryOwnerIds(): Promise<string[]> {
  const now = Date.now()
  if (ownerCache && now - ownerCache.at < OWNER_TTL) return ownerCache.ids
  const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } })
  const ids = admins.map((a) => a.id)
  ownerCache = { ids, at: now }
  return ids
}

/**
 * 读路径归属合并:自己 + 库主人(去重)。用于 Prisma where 的 userId 过滤:
 *   where: { userId: { in: await libraryScopes(userId) } }
 * 无管理员时退化为 [userId],与私有口径等价。
 */
export async function libraryScopes(userId: string): Promise<string[]> {
  const owners = await libraryOwnerIds()
  const others = owners.filter((id) => id !== userId)
  return others.length ? [userId, ...others] : [userId]
}
