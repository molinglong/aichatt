/**
 * 监管模式锁定期禁用清单 —— 方案: design/focus-lock-restrict-plan.md §3.2 (R1)。
 *
 * 清单即常量:放行某项 = 从对应数组删一行;新增游戏走 kind:'game' 自动兜住,
 * 无需登记 id。自定义面具(user: 前缀)无法自动分类,一律放行。
 */

/** 锁定期禁用的内置面具 id(游戏 + 闲聊向 + 辩论) */
export const RESTRICTED_MASK_IDS: readonly string[] = [
  'life-sim', // 都市人生模拟器(kind:'game' 游戏)
  'empathizer', // 共情倾听者
  'shuangwen-writer', // 爽文写作家
  'angst-writer', // 虐文/致郁文写作家
  'lyric-analyst', // 歌词分析者
  'opponent', // 反方辩手(辩论)
]

/** 锁定期禁用的搜索平台档(纯娱乐站;B站/知乎等学习常用档保留) */
export const RESTRICTED_PLATFORM_IDS: readonly string[] = ['douyin', 'miyoushe']

/**
 * 面具是否锁定期受限。id 清单为主,kind:'game' 兜底(未来新游戏面具
 * 即使忘了登记 id 也会被拦)。kind 字段调用方不一定有(前端 MaskRow 无),可省。
 */
export function isMaskRestricted(mask: { id?: string | null; kind?: string | null } | null | undefined): boolean {
  if (!mask?.id) return false
  if (mask.kind === 'game') return true
  return RESTRICTED_MASK_IDS.includes(mask.id)
}

/** 搜索平台档是否锁定期受限 */
export function isPlatformRestricted(platformId: string | null | undefined): boolean {
  if (!platformId) return false
  return RESTRICTED_PLATFORM_IDS.includes(platformId)
}
