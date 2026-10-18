import { test, expect, type Page } from "@playwright/test"

/**
 * 提示通道降级冒烟(复用 admin 会话)。
 *
 * 起因:dev 重启后旧页面 runtime 引用的 izitoast 动态 chunk 不在磁盘上 →
 * ChunkLoadError。当时的实现有两处放大:失败的 promise 被永久缓存(整个会话 toast 全废),
 * 且 toast 调用不 catch → 未处理 rejection 顶出 Next 全屏错误浮层,把真实报错一起吞掉。
 *
 * 覆盖:
 *  1) 掐掉 izitoast chunk:编辑记忆照样保存成功,回执通过零依赖兜底提示可见,且不出错误浮层
 *  2) 不掐:同一链路走回 iziToast 本体(.iziToast),证明降级没把正常通道带坏
 * 用例自建记忆(MARK),结束兜底清理。
 */

const MARK = "提示降级冒烟"
const RUN = Date.now().toString(36)
const IZI_CHUNK = /\/_next\/static\/chunks\/[^/]*izitoast[^/]*\.js/

async function createMemory(page: Page, content: string): Promise<string> {
  const res = await page.request.post("/api/memories", { data: { content } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { id: string }).id
}

/** 自建条目一律按 MARK 扫出来删,中断残留也能顺带清掉 */
async function cleanupMemories(page: Page): Promise<void> {
  const res = await page.request.get("/api/memories")
  if (!res.ok()) return
  const data = (await res.json()) as { memories: { id: string; content: string }[] }
  for (const m of (data.memories ?? []).filter((m) => m.content.includes(MARK))) {
    await page.request.delete(`/api/memories/${m.id}`)
  }
}

/** 打开设置弹窗的「记忆」板块 */
async function openMemorySection(page: Page): Promise<void> {
  await page.goto("/chat")
  await page.getByRole("button", { name: "设置", exact: true }).first().click()
  // exact 必给:遮罩背后聊天页也有 aria-label="关闭提示",子串匹配会串味
  await expect(page.getByRole("button", { name: "关闭", exact: true }).first()).toBeVisible()
  await page.getByRole("button", { name: "记忆", exact: true }).first().click()
}

/** 把某条记忆的文本改掉并保存,返回保存后的行文本 */
async function editMemory(page: Page, marker: string, nextContent: string): Promise<void> {
  const row = page.locator("li").filter({ hasText: marker }).first()
  await expect(row).toBeVisible()
  await row.getByLabel("编辑记忆").click()
  await row.locator("textarea").fill(nextContent)
  await row.getByRole("button", { name: "保存", exact: true }).click()
}

test("chunk 故障时编辑记忆仍能保存并看到回执", async ({ page }) => {
  await page.route(IZI_CHUNK, (route) => route.abort())

  const marker = `${MARK}-${RUN}-a`
  const id = await createMemory(page, marker)
  try {
    await openMemorySection(page)
    await editMemory(page, marker, `${marker}-已改写`)

    // 兜底提示必须把回执送到位 —— 提示通道自身故障不能把消息也丢掉
    const fallback = page.locator("#aichatt-toast-fallback-top")
    await expect(fallback.getByText("记忆已更新")).toBeVisible()
    // 保存确实生效(列表即时反映新内容),而不是只弹了个提示
    await expect(page.locator("li").filter({ hasText: `${marker}-已改写` }).first()).toBeVisible()
    // 关键回归点:旧实现会在这里顶出 Next 全屏 Unhandled Runtime Error
    await expect(page.locator("nextjs-portal")).toHaveCount(0)
  } finally {
    await page.request.delete(`/api/memories/${id}`)
    await cleanupMemories(page)
  }
})

test("chunk 正常时回执走 iziToast 本体", async ({ page }) => {
  const marker = `${MARK}-${RUN}-b`
  const id = await createMemory(page, marker)
  try {
    await openMemorySection(page)
    await editMemory(page, marker, `${marker}-已改写`)

    const toastEl = page.locator(".iziToast").filter({ hasText: "记忆已更新" }).first()
    await expect(toastEl).toBeVisible()
    await expect(page.locator("#aichatt-toast-fallback-top")).toHaveCount(0)
    await expect(page.locator("nextjs-portal")).toHaveCount(0)
  } finally {
    await page.request.delete(`/api/memories/${id}`)
    await cleanupMemories(page)
  }
})
