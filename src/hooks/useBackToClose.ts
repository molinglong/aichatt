'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

/**
 * 让系统/浏览器「返回」先关浮层，而不是整页 goBack。
 *
 * 背景：设置、抽屉这类浮层不开新路由，因此不产生任何历史条目。在 Tauri 安卓壳里
 * 返回键由 Tauri 的 Android AppPlugin 默认处理成「WebView 能 goBack 就 goBack，
 * 否则交还系统」，于是浮层开着时按返回可能跳回上一个页面，或直接退到桌面。
 * 手机浏览器的手势返回同样需要浮层的历史记录。
 *
 * 做法：浮层「这一组」打开时压入一条同 URL 的哨兵历史条目，返回键先弹掉它，
 * 我们在 popstate 里关掉最上层那一个。
 *
 * 为什么一组一条、而不是每个浮层各一条（实测踩过的坑）：浮层交接时旧浮层不是即时
 * 卸载的 —— 抽屉有 450ms 滑出动画，它真正卸载时新浮层的 effect 早跑完了，
 * 「按实例各压一条」会留下两条哨兵：[空][哨兵A(抽屉)][哨兵B(设置)]，返回关掉设置后
 * 停在哨兵A 上，用户下一次按返回是「空响一声」哪也去不了
 * （tmp-check-back-stack.cjs 的 D1/D3 就是把这条量出来的）。
 * 共一条哨兵后，交接只是组成员变化，历史深度不动。
 *
 * 浮层内导航必须走 navigate()（真机事故，2026-10-07）：历史行点击原来是
 * close()+router.push()，抽屉一关就 armPop，其 back() 抢在 Next 的 RSC 导航写入
 * 历史之前弹掉哨兵，popstate 把在途导航一并取消 —— 表现为「点历史对话没反应」
 * （探针实测：back() 在 39ms 触发，此后全程无 pushState）。
 * navigate() 立 navigatingAway 旗标让 armPop 跳过 back()，并用 replace 原地改写
 * 哨兵条目，落点历史栈与桌面端 push 后一致（返回键从目标页直接回上一层，
 * 不会撞上哨兵空响）。
 */

const SENTINEL = 'aichattOverlayBackToken'

// 在架浮层的 id，底→顶。顶层 = 返回键该关的那一个。
const open: number[] = []
// id → 关闭回调（popstate 时只调最上层那个）。回调返回 false = 这次返回已被浮层
// 内部消化(弹掉自己的一层内部页,浮层仍开着),监听器要重新入组+恢复原哨兵。
const closers = new Map<number, () => void | false>()
let seq = 0

// 全局一个 popstate 监听：按实例各挂各的会出现「一次返回关掉两层」。
let listenerInstalled = false

// 「浮层里正在跳走」：路由 replace 接管了哨兵条目，armPop 收尾时不许再 back()。
let navigatingAway = false

// 内层返回后恢复刚弹出的哨兵。forward 是异步的，期间不许补写/回收历史条目。
let sentinelToken: number | null = null
let restoringSentinel: number | null = null
let restoreTimer: ReturnType<typeof setTimeout> | null = null
let pendingNavigation: (() => void) | null = null

function finishSentinelRestore() {
  restoringSentinel = null
  if (restoreTimer !== null) clearTimeout(restoreTimer)
  restoreTimer = null
  if (pendingNavigation) {
    const navigate = pendingNavigation
    pendingNavigation = null
    navigate()
  } else if (open.length === 0) {
    // 恢复途中点了关闭：现在才能安全收掉刚恢复的哨兵。
    armPop()
  }
}

const currentToken = (): number | null => {
  const t = (typeof history !== 'undefined' ? (history.state as Record<string, unknown> | null) : null)?.[SENTINEL]
  return typeof t === 'number' ? t : null
}

// 只追加我们的标记，其余字段原样带上：整体替换 state 会让 Next App Router 认不出
// 这条记录，表现为整页重载（聊天状态全丢）。
const writeSentinel = (id: number, push: boolean) => {
  const state = { ...(history.state || {}), [SENTINEL]: id }
  if (push) history.pushState(state, '')
  else history.replaceState(state, '')
  sentinelToken = id
}

const installListener = () => {
  if (listenerInstalled || typeof window === 'undefined') return
  listenerInstalled = true
  window.addEventListener('popstate', () => {
    const token = currentToken()
    if (restoringSentinel !== null) {
      // forward 的回执不是又按了一次返回；只认正在恢复的那条历史记录。
      if (token !== restoringSentinel) return
      finishSentinelRestore()
      return
    }
    // 哨兵还挂在当前条目上 = 这次 popstate 弹的是别的东西（页面导航等），不归我们管。
    if (token !== null) return
    const id = open[open.length - 1]
    if (id === undefined) return
    open.pop()
    const fn = closers.get(id)
    closers.delete(id)
    const handled = fn?.()
    if (handled === false && fn) {
      open.push(id)
      closers.set(id, fn)
    }
    if (open.length > 0 && sentinelToken !== null) {
      // 不在 popstate 内 pushState：遍历后没有新的用户激活，Chromium 会把相关历史
      // 标成可跳过，WebView 系统返回可能直接退到桌面，JS history.back 测试却照常通过。
      // 恢复刚弹掉的原哨兵，保留它的可返回资格；内层页/下层浮层共用同一条。
      restoringSentinel = sentinelToken
      // 外部导航可能删掉 forward 目标而不发回执，不能让全局恢复锁永久悬挂。
      // 超时只解除锁/完成待处理操作，绝不重新 push 以免再次制造可跳过记录。
      restoreTimer = setTimeout(finishSentinelRestore, 1000)
      history.forward()
    }
  })
}

// 「组已空、待弹掉自己那条哨兵」。必须延后到下一个宏任务：history.back() 是异步的，
// 而同 tick 里可能又开了新浮层，立即弹会把人家的条目弹掉。
let popArmed = false
function armPop() {
  popArmed = true
  setTimeout(() => {
    if (!popArmed) return
    popArmed = false
    // forward 尚未落到目标记录，不能回收当前的主页记录；恢复回执会重新收尾。
    if (restoringSentinel !== null) return
    // 正在跳走：条目已由路由 replace 接管，back() 会连在途导航一起取消。
    // 旗标先于 open.length 判断消费 —— 浮层交接时它同样已失效，
    // 留着会在下一次合法收尾时误吞一次 back()（返回键空响）。
    if (navigatingAway) {
      navigatingAway = false
      return
    }
    // 交接：又有浮层进组了 → 这条哨兵归它们，不收。
    if (open.length > 0) return
    if (currentToken() !== null) history.back()
  }, 0)
}

/**
 * close 返回 false = 这次返回被浮层内部消化(弹掉自己的一层内部页),浮层保持
 * 注册并恢复原哨兵;返回 undefined/void = 浮层真的关了,按原语义出组。
 */
export function useBackToClose(openNow: boolean, close: () => void | false) {
  const closeRef = useRef(close)
  closeRef.current = close
  const router = useRouter()

  // 浮层内导航统一出口：先立旗标 → 再关浮层（随后的 armPop 只清旗不 back()）→
  // replace 原地改写哨兵条目。桌面端无此 hook，仍走自己的 router.push，行为不变。
  const navigate = useCallback(
    (url: string) => {
      // 只有组里有哨兵才会触发 armPop 收尾；没有就别立旗，防旗标滞留到下个浮层
      if (open.length > 0) navigatingAway = true
      closeRef.current()
      if (restoringSentinel !== null) {
        // 等原哨兵恢复后再 replace，避免把底下的主页改写，或被 forward 抢走导航。
        pendingNavigation = () => {
          router.replace(url)
          if (open.length === 0) armPop()
        }
      } else {
        router.replace(url)
      }
    },
    [router]
  )

  useEffect(() => {
    if (!openNow || typeof window === 'undefined') return

    installListener()
    const id = ++seq
    const wasEmpty = open.length === 0
    open.push(id)
    closers.set(id, () => closeRef.current())

    // 恢复期间新浮层直接入组；此时 push 会删掉正在 forward 的目标记录。
    if (restoringSentinel === null) {
      if (wasEmpty) {
        // 组从零起：正常压一条；残留哨兵则接管，不再叠一条。
        writeSentinel(id, currentToken() === null)
      } else if (currentToken() === null) {
        // 组里已有浮层却查不到哨兵（被别的导航顶掉了）→ 兜底补一条
        writeSentinel(id, true)
      }
    }

    return () => {
      const i = open.lastIndexOf(id)
      if (i >= 0) open.splice(i, 1)
      closers.delete(id)
      // 组清空了才收哨兵；还有浮层就留着给它们用（交接不留残条目靠的就是这条）
      if (open.length === 0) armPop()
    }
  }, [openNow])

  return { navigate }
}
