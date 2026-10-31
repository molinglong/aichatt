import { test, expect, type Page } from "@playwright/test"

// 手机端长按分工回归（2026-10-21 定案）：
// - 消息文本/代码块：触屏不再拦截，交还浏览器原生文本菜单（复制/全选/搜索）。
// - 会话条目：原生对 Link 没有可用菜单，保留自定义菜单，但时序改成「抬手后装配」
//   （安卓长按先派 contextmenu、手指仍压屏，旧实现会被抬手合成的 click/mousedown 秒关）。
// 布局保持桌面尺寸（复用既有「新对话/发送」选择器），触屏判定由 CDP 强制 pointer=coarse 生效。
// evaluate 回调会被序列化到页面执行，模块作用域的函数引不进来，故事件构造就地写。

const SENT_1 = "甲句是不该被复制的第一句。"
const SENT_2 = "乙句是长按后应当选中的第二句。"

const streamBody = (text: string) =>
  [
    { type: "start" },
    { type: "text-start", id: "seg-1" },
    { type: "text-delta", id: "seg-1", delta: text },
    { type: "text-end", id: "seg-1" },
    { type: "finish" },
  ]
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("") + "data: [DONE]\n\n"

/** 造一条含两句话的助手回复 */
async function seedReply(page: Page) {
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: streamBody(`${SENT_1}${SENT_2}`),
    })
  )
  await page.goto("/chat")
  await page.getByRole("button", { name: "新对话" }).first().click()
  const input = page.locator("textarea").first()
  await expect(input).toBeVisible({ timeout: 30_000 })
  await input.fill("给我两句话")
  await page.getByRole("button", { name: "发送" }).click()
  await expect(page.getByText(SENT_2).first()).toBeVisible({ timeout: 30_000 })
}

/** 造一条带围栏代码块的助手回复（后注册的 route 优先接管 beforeEach 的纯文本 mock） */
async function seedCodeReply(page: Page) {
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: streamBody("```js\nconst answer = 42\n```"),
    })
  )
  await page.goto("/chat")
  await page.getByRole("button", { name: "新对话" }).first().click()
  const input = page.locator("textarea").first()
  await expect(input).toBeVisible({ timeout: 30_000 })
  await input.fill("给我一段代码")
  await page.getByRole("button", { name: "发送" }).click()
  await expect(page.locator("pre").filter({ hasText: "const answer = 42" })).toBeVisible({ timeout: 30_000 })
}

/** 强制主指针为触屏（matchMedia('(pointer: coarse)') 的判定源） */
async function emulateCoarsePointer(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "pointer", value: "coarse" },
      { name: "any-pointer", value: "coarse" },
    ],
  })
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true })
  expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(true)
}

const lastBubble = (page: Page) => page.locator("[data-message-id]").last()
const conversationRow = (page: Page) => page.locator('a[href^="/chat/c/"]').first()
// 页面里另有常驻的 role="menu"(推理档面板等),只用全局右键菜单的稳定标识
const menu = (page: Page) => page.locator('[data-context-menu]')
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true })

/** 复刻安卓壳 evaluateJavascript 派发的应用动作事件（长按菜单里的自定义按钮） */
async function dispatchNativeMenuAction(
  page: Page,
  action: "quote" | "study" | "edit" | "regenerate",
  messageId: string,
  selection = ""
) {
  await page.evaluate(
    ({ action, messageId, selection }) => {
      window.dispatchEvent(
        new CustomEvent("aichatt:longpress-action", {
          detail: { action, messageId, selection },
        })
      )
    },
    { action, messageId, selection }
  )
}

/**
 * 复刻安卓长按会话条目的事件时序：contextmenu（手指仍压屏）→ touchend。
 * 两个观测点都等两帧：zustand 落 state 到菜单 DOM 之间隔着 React 渲染。
 */
async function runConversationLongPress(page: Page, conversationId?: string) {
  return page.evaluate(async (id) => {
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const selector = id ? `a[href="/chat/c/${id}"]` : 'a[href^="/chat/c/"]'
    const row = document.querySelector(selector) as HTMLElement | null
    if (!row) throw new Error("侧栏没有会话条目")
    const r = row.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const prevented = !row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y })
    )
    await nextFrame()
    const menuAtContextMenu = !!document.querySelector('[data-context-menu]')
    row.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true }))
    await nextFrame()
    return { prevented, menuAtContextMenu, menuAtTouchEnd: !!document.querySelector('[data-context-menu]') }
  }, conversationId)
}

test.beforeEach(async ({ page }) => {
  await seedReply(page)
})

test("手机长按消息文本交还系统原生菜单", async ({ page }) => {
  await emulateCoarsePointer(page)
  const notPrevented = await lastBubble(page).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.top + 20),
      })
    )
  })
  // dispatchEvent 返回 true = React 层没有 preventDefault，浏览器原生菜单才会弹
  expect(notPrevented, "触屏长按仍被拦截的话，系统原生菜单不会出现").toBe(true)
  await page.waitForTimeout(100)
  await expect(menu(page), "手机端不应再弹自定义菜单").toHaveCount(0)
})

test("手机长按代码块也交还系统原生菜单", async ({ page }) => {
  await seedCodeReply(page)
  await emulateCoarsePointer(page)
  const notPrevented = await page
    .locator("pre")
    .filter({ hasText: "const answer = 42" })
    .evaluate((el) => {
      const r = el.getBoundingClientRect()
      return el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(r.left + r.width / 2),
          clientY: Math.round(r.top + 20),
        })
      )
    })
  expect(notPrevented, "代码块触屏长按仍被拦截的话，系统原生复制菜单不会出现").toBe(true)
  await page.waitForTimeout(100)
  await expect(menu(page), "手机端不应再弹自定义菜单").toHaveCount(0)
})

test("手机长按会话条目：当下不弹，抬手后才弹", async ({ page }) => {
  await emulateCoarsePointer(page)
  const { prevented, menuAtContextMenu, menuAtTouchEnd } = await runConversationLongPress(page)
  expect(prevented, "会话条目必须吞掉系统链接菜单，否则会弹出打开/复制链接").toBe(true)
  expect(menuAtContextMenu, "contextmenu 当下就弹会压在手指底下").toBe(false)
  expect(menuAtTouchEnd, "抬手后必须弹，否则长按没有任何菜单").toBe(true)
  // 手机端会话管理动作仍完整保留
  await expect(menuItem(page, "重命名")).toBeVisible()
  await expect(menuItem(page, "分支此对话")).toBeVisible()
  await expect(menuItem(page, "推送到线上（这一条）")).toBeVisible()
  await page.screenshot({ path: "test-results/mobile-longpress-conversation-menu.png" })
})

test("会话菜单刚弹时的惯性微滚不得关掉菜单", async ({ page }) => {
  await emulateCoarsePointer(page)
  await runConversationLongPress(page)
  await expect(menu(page)).toBeVisible()
  const nudge = () =>
    conversationRow(page).evaluate((el) => el.dispatchEvent(new Event("scroll", { bubbles: true })))
  await nudge()
  await expect(menu(page)).toBeVisible()
  // 宽限期过后的滚动才该收菜单
  await page.waitForTimeout(400)
  await nudge()
  await expect(menu(page)).toHaveCount(0)
})

test("手机长按会话条目触发一次轻震（菜单弹出）", async ({ page }) => {
  await emulateCoarsePointer(page)
  // 桩掉 navigator.vibrate:Web 侧触感走这条降级通路(APK 内走 haptics 插件)
  await page.evaluate(() => {
    const w = window as unknown as { __vibes: unknown[] }
    w.__vibes = []
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: (ms: number | number[]) => {
        w.__vibes.push(ms)
        return true
      },
    })
  })
  await runConversationLongPress(page)
  const vibes = await page.evaluate(() => (window as unknown as { __vibes: unknown[] }).__vibes)
  expect(vibes, "菜单弹出瞬间应恰好一次 8ms 轻震").toEqual([8])
})

test("会话菜单可标记为已读，蓝点随即消失", async ({ page }) => {
  // 只操作时间戳正常的会话:列表首行可能是历史遗留的未来时间戳(时钟偏差导致),
  // 「标记为已读」写的是当前时间,永远追不上未来时间戳,蓝点必然清不掉。
  const convId = await page.evaluate(async () => {
    const res = await fetch("/api/conversations?limit=20&offset=0")
    const data = (await res.json()) as { items?: Array<{ id: string; updatedAt: string }> }
    const now = Date.now()
    return data.items?.find((c) => new Date(c.updatedAt).getTime() <= now)?.id ?? null
  })
  expect(convId, "侧栏前 20 条里应至少有一条时间戳正常的会话").not.toBeNull()
  const targetId = convId!
  const row = page.locator(`a[href="/chat/c/${targetId}"]`).first()
  await expect(row, "被测会话应出现在侧栏").toBeVisible()
  // 造未读:把该会话的已读时间回拨到 1，再整页重载让 store 从 localStorage 读回
  await page.evaluate((id) => {
    localStorage.setItem("chat:lastReadAt", JSON.stringify({ [id]: 1 }))
  }, targetId)
  await page.goto("/chat")
  const dot = row.locator('[aria-label="未读"]')
  await expect(dot, "未读蓝点应先出现，否则测不到清除效果").toBeVisible()

  await emulateCoarsePointer(page)
  await runConversationLongPress(page, targetId)
  await expect(menuItem(page, "标记为已读")).toBeVisible()
  await page.screenshot({ path: "test-results/mobile-longpress-mark-read.png" })
  await menuItem(page, "标记为已读").click()
  await expect(dot, "标记已读后蓝点必须消失").toHaveCount(0)
})

// ── 安卓原生菜单追加的应用动作（壳里按 data-* 能力标记决定显隐）──────────

test("长按菜单桥：能力标记按消息角色落到 DOM", async ({ page }) => {
  const user = page.locator('[data-message-id][data-message-role="user"]').first()
  const assistant = page.locator('[data-message-id][data-message-role="assistant"]').last()
  await expect(user, "用户消息应允许编辑/存错题本").toHaveAttribute("data-can-edit", "1")
  await expect(user).toHaveAttribute("data-can-study", "1")
  await expect(assistant, "最后一条 AI 消息应允许重新生成").toHaveAttribute("data-can-regenerate", "1")
  await expect(assistant).toHaveAttribute("data-can-study", "1")
  await expect(assistant, "AI 消息不应出现编辑入口").not.toHaveAttribute("data-can-edit", "1")
})

test("长按菜单桥：引用回复引用的是选中文字", async ({ page }) => {
  const messageId = await lastBubble(page).getAttribute("data-message-id")
  await dispatchNativeMenuAction(page, "quote", messageId!, SENT_2)
  const banner = page.getByRole("status").filter({ hasText: "回复 AI" }).first()
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(SENT_2)
})

test("长按菜单桥：编辑命中长按的用户消息", async ({ page }) => {
  const userBubble = page.locator('[data-message-id][data-message-role="user"]').first()
  const messageId = await userBubble.getAttribute("data-message-id")
  await dispatchNativeMenuAction(page, "edit", messageId!)
  await expect(page.getByText("编辑消息")).toBeVisible()
})

test("长按菜单桥：存错题本落到对应消息", async ({ page }) => {
  const captured: { value: { sourceMessageId?: string; questionText?: string } | null } = {
    value: null,
  }
  await page.route("**/api/study/notes", async (route) => {
    captured.value = route.request().postDataJSON()
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
  })
  const userBubble = page.locator('[data-message-id][data-message-role="user"]').first()
  const messageId = await userBubble.getAttribute("data-message-id")
  await dispatchNativeMenuAction(page, "study", messageId!)
  await expect(page.getByText("已存入错题本").first()).toBeVisible()
  expect(captured.value?.sourceMessageId).toBe(messageId)
  expect(captured.value?.questionText).toContain("给我两句话")
})

test("桌面右键消息仍当下即弹", async ({ page }) => {
  await lastBubble(page).evaluate((el) => {
    const r = el.getBoundingClientRect()
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.top + 20),
      })
    )
  })
  await expect(menu(page)).toBeVisible()
  await expect(menuItem(page, "复制")).toBeVisible()
})

// ── 手机抽屉历史行:长按 = 重命名 / 标记为未读 / 删除(2026-10-28) ────────

/** 切到手机视口并打开全屏抽屉 */
async function openDrawer(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "打开侧边栏" }).first().click()
  const drawer = page.locator('aside[aria-label="导航抽屉"]')
  await expect(drawer).toBeVisible()
  await expect(page.locator("[data-conversation-row]").first()).toBeVisible({ timeout: 20_000 })
  return drawer
}

const drawerRows = (page: Page) => page.locator("[data-conversation-row]")

/**
 * 复刻手指长按：touchstart → 保持 600ms → touchend。
 * 返回按下期间是否已弹菜单（必须 false：手指还压屏时弹会被抬手合成事件秒关）
 * 与抬手后是否弹（必须 true）。
 */
async function longPressDrawerRow(row: ReturnType<Page["locator"]>) {
  return row.evaluate(async (el) => {
    const r = el.getBoundingClientRect()
    const touch = new Touch({
      identifier: 1,
      target: el,
      clientX: Math.round(r.left + 40),
      clientY: Math.round(r.top + r.height / 2),
    })
    el.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      })
    )
    await new Promise((res) => setTimeout(res, 600))
    const during = !!document.querySelector("[data-context-menu]")
    el.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [touch],
      })
    )
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    return { during, after: !!document.querySelector("[data-context-menu]") }
  })
}

test("抽屉历史行长按：抬手后才弹手机尺寸菜单", async ({ page }) => {
  await emulateCoarsePointer(page)
  await openDrawer(page)
  const { during, after } = await longPressDrawerRow(drawerRows(page).first())
  expect(during, "手指还压屏时不能弹菜单").toBe(false)
  expect(after, "抬手后必须弹菜单").toBe(true)
  await expect(menu(page)).toHaveAttribute("data-context-menu-size", "comfortable")
  await expect(menuItem(page, "重命名")).toBeVisible()
  await expect(menuItem(page, "删除")).toBeVisible()
  await page.screenshot({ path: "test-results/mobile-drawer-longpress-menu.png" })
})

test("抽屉长按标记为未读：行内蓝点复现", async ({ page }) => {
  // 清掉历史已读表，避免上一轮残留把这项藏起来
  await page.evaluate(() => localStorage.removeItem("chat:lastReadAt"))
  await page.reload()
  await emulateCoarsePointer(page)
  await openDrawer(page)
  const rows = drawerRows(page)
  const count = await rows.count()
  expect(count, "抽屉里至少要有两条会话，取最后一条(非当前会话)").toBeGreaterThan(1)
  const row = rows.nth(count - 1)
  await row.scrollIntoViewIfNeeded()
  await expect(row.locator('[aria-label="未读"]')).toHaveCount(0)
  await longPressDrawerRow(row)
  await expect(menuItem(page, "标记为未读")).toBeVisible()
  await menuItem(page, "标记为未读").click()
  await expect(menu(page)).toHaveCount(0)
  await expect(row.locator('[aria-label="未读"]'), "标记未读后行内应出现蓝点").toBeVisible()
})

test("抽屉长按改名：内联输入提交后列表即时更新", async ({ page }) => {
  await emulateCoarsePointer(page)
  let patchedTitle = ""
  await page.route("**/api/conversations/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue()
    patchedTitle = (route.request().postDataJSON() as { title?: string }).title ?? ""
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
  })
  await openDrawer(page)
  const row = drawerRows(page).first()
  await longPressDrawerRow(row)
  await menuItem(page, "重命名").click()
  const input = page.getByPlaceholder("对话标题")
  await expect(input).toBeVisible()
  const nextTitle = `抽屉改名-${Date.now()}`
  await input.fill(nextTitle)
  await input.press("Enter")
  await expect(input).toHaveCount(0)
  await expect(row).toContainText(nextTitle)
  expect(patchedTitle).toBe(nextTitle)
})

test("抽屉长按删除：确认后行立即消失", async ({ page }) => {
  await emulateCoarsePointer(page)
  await page.route("**/api/conversations/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue()
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
  })
  await openDrawer(page)
  const rows = drawerRows(page)
  const count = await rows.count()
  expect(count).toBeGreaterThan(1)
  const row = rows.nth(count - 1)
  await row.scrollIntoViewIfNeeded()
  const id = await row.getAttribute("data-conversation-row")
  expect(id).toBeTruthy()
  await longPressDrawerRow(row)
  await page.screenshot({ path: "test-results/mobile-drawer-longpress-menu-bottom.png" })
  await menuItem(page, "删除").click()
  const dialog = page.locator('[role="alertdialog"]')
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "删除" }).click()
  await expect(page.locator(`[data-conversation-row="${id}"]`)).toHaveCount(0)
})

test("桌面不出抽屉（长按只在手机抽屉生效）", async ({ page }) => {
  // DOM 里常驻(受 md:hidden 控制),断言可见性而不是存在性
  await expect(page.locator('aside[aria-label="导航抽屉"]')).toBeHidden()
})
