import { create, type StateCreator, type StoreApi, type UseBoundStore } from 'zustand'
import type { ReactNode } from 'react'
import { haptic } from '@/lib/haptics'

/**
 * 右键菜单项数据模型 —— 场景方只声明数据,渲染/定位/翻转/关闭
 * 全部由全局单例 <ContextMenuHost />(src/components/ui/ContextMenu.tsx)接管。
 *
 * 用法:
 *   const { openContextMenu } = useContextMenuStore.getState()
 *   openContextMenu({ x: e.clientX, y: e.clientY }, items)
 * (e 为 onContextMenu 事件,场景方自行 e.preventDefault())
 */
export interface ContextMenuItem {
  id: string
  label: string
  /** lucide 图标元素,约定尺寸 w-3.5 h-3.5 */
  icon?: ReactNode
  /** 危险操作(删除类):hover 红色 */
  danger?: boolean
  disabled?: boolean
  /** 条件裁剪:false 的项不渲染(配合 filter(Boolean) 使用) */
  hidden?: boolean
  /** 该项之前渲染一条分组分隔线 */
  dividerBefore?: boolean
  /** 二级子菜单(展开后渲染;叶子项才需要 onSelect) */
  submenu?: ContextMenuItem[]
  onSelect?: () => void
}

/**
 * 菜单尺寸档:
 * - compact(默认):桌面右键/代码块等,12px 紧凑行
 * - comfortable:手机端手指操作(抽屉历史行长按),14px 文本、40px 行高、圆角 2xl,
 *   危险项常驻红色(触屏没有 hover,不能靠 hover 才变红)
 */
export type ContextMenuSize = 'compact' | 'comfortable'

interface ContextMenuState {
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
  /** 菜单顶部说明行(如代码块的语言名),可选 */
  header?: string
  size: ContextMenuSize
  openContextMenu: (
    pos: { x: number; y: number },
    items: ContextMenuItem[],
    header?: string,
    opts?: { size?: ContextMenuSize }
  ) => void
  closeContextMenu: () => void
}

type ContextMenuStoreHook = UseBoundStore<StoreApi<ContextMenuState>>

const storeInitializer: StateCreator<ContextMenuState> = (set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  header: undefined,
  size: 'compact',
  openContextMenu: (pos, items, header, opts) => {
    // 触感:菜单弹出瞬间一次轻震。这里仍在手势调用栈内(click/touchend),
    // 满足 Web Vibration API 的用户激活要求;桌面指针下 haptic 内部直接跳过
    haptic('light')
    set({ open: true, x: pos.x, y: pos.y, items, header, size: opts?.size ?? 'compact' })
  },
  closeContextMenu: () => set({ open: false, items: [], header: undefined }),
})

/** 防止 Next.js dev 模式 HMR 重新执行 create() 破坏单例(与 chat-store 同一模式) */
const globalForStore = globalThis as unknown as { __contextMenuStore?: ContextMenuStoreHook }

const created: ContextMenuStoreHook = (globalForStore.__contextMenuStore
  ?? (create<ContextMenuState>(storeInitializer) as ContextMenuStoreHook))

export const useContextMenuStore = created

if (typeof window !== 'undefined' && !globalForStore.__contextMenuStore) {
  globalForStore.__contextMenuStore = created
}
