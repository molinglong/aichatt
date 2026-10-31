/**
 * 在途聊天生成注册表(server-only)。
 *
 * 背景:安卓壳切后台时 WryActivity.onPause() 会冻结 WebView 的 JS,SSE 连接随之断开。
 * 如果生成生命周期继续绑定 HTTP 请求(req.signal),上游只会吐出半截就被取消,
 * 回到前台只能看到一条定格在半路的草稿。
 *
 * 这里把「谁在生成」从连接上摘出来:
 *   - 客户端断开 = 没人接收而已,生成继续跑到完成并落库;
 *   - 只有用户显式点「停止」(finalize-draft)或后台兜底超时才 abort 上游。
 *
 * 注册表只存在当前进程内:本项目是单实例部署;进程重启后在途流本来也已丢失,
 * 草稿行由 conversations/[id] 的 10 分钟兜底定格,不需要跨进程恢复。
 * 挂在 globalThis 上避免 Next dev 热重载把不同模块实例的 Map 拆成两份。
 */

export interface ActiveChatRun {
  /** 中止本次生成(用户停止 / 后台超时);reason 会写进 AbortSignal */
  controller: AbortController
  startedAt: number
}

const GLOBAL_KEY = '__aichattActiveChatRuns'

type RunStore = Map<string, Set<ActiveChatRun>>

function getStore(): RunStore {
  const holder = globalThis as typeof globalThis & { [GLOBAL_KEY]?: RunStore }
  if (!holder[GLOBAL_KEY]) holder[GLOBAL_KEY] = new Map()
  return holder[GLOBAL_KEY]
}

/** 注册一次在途生成;同一会话允许多条(多端同时发),停止时一起中止。 */
export function registerActiveChatRun(
  conversationId: string,
  controller: AbortController
): ActiveChatRun {
  const store = getStore()
  const run: ActiveChatRun = { controller, startedAt: Date.now() }
  let runs = store.get(conversationId)
  if (!runs) {
    runs = new Set()
    store.set(conversationId, runs)
  }
  runs.add(run)
  return run
}

/** 生成正常结束/出错后注销;只移除自己那条,不影响同会话的其它在途生成。 */
export function releaseActiveChatRun(conversationId: string, controller: AbortController): void {
  const store = getStore()
  const runs = store.get(conversationId)
  if (!runs) return
  runs.forEach((run) => {
    if (run.controller === controller) runs.delete(run)
  })
  if (runs.size === 0) store.delete(conversationId)
}

/**
 * 显式中止某会话的所有在途生成。
 * 返回是否真的找到并中止了至少一条,供停止接口区分「有活流」与「只剩草稿」。
 */
export function abortActiveChatRuns(conversationId: string, reason: string): boolean {
  const store = getStore()
  const runs = store.get(conversationId)
  if (!runs || runs.size === 0) return false
  let aborted = false
  runs.forEach((run) => {
    if (run.controller.signal.aborted) return
    run.controller.abort(reason)
    aborted = true
  })
  return aborted
}
