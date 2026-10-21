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

/**
 * 复刻安卓长按会话条目的事件时序：contextmenu（手指仍压屏）→ touchend。
 * 两个观测点都等两帧：zustand 落 state 到菜单 DOM 之间隔着 React 渲染。
 */
async function runConversationLongPress(page: Page) {
  return page.evaluate(async () => {
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const row = document.querySelector('a[href^="/chat/c/"]') as HTMLElement | null
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
  })
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
