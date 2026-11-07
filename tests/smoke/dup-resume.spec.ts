import { test, expect, type Page } from "@playwright/test"

// 回归护栏(2026-10-25 实锤):前台恢复补拉会把本页刚生成的回复再追加一遍。
// 原因:本地流消息 id 是 AI SDK 临时 id,与库行永不相等;服务端已下发
// X-Assistant-Message-Id,客户端必须记下它,补拉循环遇到该行即停。
// 表现为同一条回复出现两个气泡(学习模式同样命中),刷新后才消失。

const TEXT = "前台恢复对照回复正文ABC"
const STUDY_TEXT = "前台恢复学习模式对照正文XYZ"
const CONV = "dupresumeconv0001"
const STUDY_CONV = "dupresumestudy0001"
const ASSISTANT_ROW = "dupresume-assistant-row-1"
const STUDY_ASSISTANT_ROW = "dupresumestudy-assistant-row-1"

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

function mockConversation(page: Page, convId: string, assistantId: string, text: string) {
  const assistantRow = {
    id: assistantId, role: "assistant", content: text, reasoning: null, model: "mock",
    metadata: null, attachments: null, streaming: false, createdAt: new Date().toISOString(),
  }
  const userRow = {
    id: `${assistantId}-user`, role: "user", content: "x", reasoning: null, model: null,
    metadata: null, attachments: null, streaming: false,
    createdAt: new Date(Date.now() - 1000).toISOString(),
  }
  return Promise.all([
    page.route("**/api/chat", (route) => route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Conversation-Id": convId,
        "X-Assistant-Message-Id": assistantId,
      },
      body: streamBody(text),
    })),
    page.route(`**/api/conversations/${convId}/messages**`, (route) => {
      const limit = new URL(route.request().url()).searchParams.get("limit")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: limit === "30" ? [assistantRow, userRow] : [] }),
      })
    }),
  ])
}

/** 等回复落屏后模拟"从后台切回":focus 触发 useForegroundResume 的补拉 */
async function assertNoDupAfterResume(page: Page, text: string) {
  const bubbles = page.locator("[data-message-id]", { hasText: text })
  await expect(bubbles).toHaveCount(1, { timeout: 30_000 })
  const before = await bubbles.count()
  // useForegroundResume 的去抖阈值 1500ms,必须等过窗口再触发
  await page.waitForTimeout(1800)
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await page.waitForTimeout(1500)
  expect(await bubbles.count()).toBe(before)
}

test("前台恢复不会重复追加本页刚生成的回复", async ({ page }) => {
  await mockConversation(page, CONV, ASSISTANT_ROW, TEXT)
  await page.goto("/chat")
  await page.getByRole("button", { name: "新对话" }).first().click()
  const input = page.locator("textarea").first()
  await expect(input).toBeVisible({ timeout: 30_000 })
  await input.fill("你好")
  await page.getByRole("button", { name: "发送", exact: true }).first().click()
  await assertNoDupAfterResume(page, TEXT)
})

test("学习模式前台恢复不会重复追加回复", async ({ page }) => {
  await mockConversation(page, STUDY_CONV, STUDY_ASSISTANT_ROW, STUDY_TEXT)
  // 2026-11-02:/study 独立页下线,学习室由 /chat?study=1 承载
  await page.goto("/chat?study=1")
  const question = page.locator("#study-question")
  await expect(question).toBeVisible({ timeout: 30_000 })
  await question.fill("1+1 等于几")
  await page.getByRole("button", { name: /选个学习起点/ }).click()
  await page.getByRole("button", { name: /完全不会/ }).first().click()
  await assertNoDupAfterResume(page, STUDY_TEXT)
})
