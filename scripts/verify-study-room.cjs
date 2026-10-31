const { chromium, expect } = require('@playwright/test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const base = process.env.STUDY_TEST_BASE || 'http://localhost:3456'
const output = path.resolve('public/preview-study-room-shots')
const question = '直角三角形 ABC 在 B 处为直角，矩形 BDEF 的 E 在 AC 上，AD=4，FC=8。求矩形面积。'
const answer = '### 先找到切入点\n\n观察矩形外的两个直角三角形，它们有两组角分别相等，因此相似。\n\n先不用分别求长和宽，把对应边联系起来。'

function stream(text, id, completed = false, finishReason = 'stop') {
  return [
    { type: 'start', messageId: id },
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
    { type: 'finish', finishReason, messageMetadata: { studyCompleted: completed && finishReason === 'stop' } },
  ].map((part) => `data: ${JSON.stringify(part)}\n\n`).join('') + 'data: [DONE]\n\n'
}

async function main() {
  const browser = await chromium.launch({ args: ['--mute-audio'] })
  const context = await browser.newContext({ storageState: '.auth/admin.json', viewport: { width: 831, height: 803 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  const requests = []
  const measurements = []
  const checks = []
  let failNext = false
  let completeNext = false
  let finishNext = 'stop'
  let holdNext = false
  let heldRoute = null
  let holdUpload = false
  let uploadRoute = null
  const png = await require('sharp')({ create: { width: 320, height: 180, channels: 3, background: '#f5f5f7' } }).png().toBuffer()
  const imageData = `data:image/png;base64,${png.toString('base64')}`
  page.on('pageerror', (error) => errors.push(error.stack || error.message))
  page.on('requestfailed', (request) => { if (request.resourceType() === 'script') errors.push(`${request.url()}: ${request.failure()?.errorText}`) })
  await page.addInitScript(() => {
    localStorage.setItem('chat:compareMode', 'true')
    localStorage.setItem('chat:deepThink', 'false')
    // 清掉上一轮「续课」快照:否则 /study 会直接恢复旧课,跳过出题首页
    localStorage.removeItem('study:lesson:v1')
  })
  await page.route('**/api/upload', async (route) => {
    if (holdUpload) { uploadRoute = route; return }
    await route.fulfill({ json: { url: imageData, name: 'study-fixture.png', type: 'image/png', size: png.length } })
  })
  await page.route('**/api/chat', async (route) => {
    const body = route.request().postDataJSON()
    requests.push(body)
    if (holdNext) { holdNext = false; heldRoute = route; return }
    if (failNext) { failNext = false; await route.fulfill({ status: 503, json: { error: '上游服务暂时不可用，请重试。' } }); return }
    await route.fulfill({
      contentType: 'text/event-stream',
      headers: { 'x-vercel-ai-ui-message-stream': 'v1' },
      body: stream(answer + `\n\n验证回合 ${requests.length}` + (completeNext ? '\n\n本题方法已讲完。\n<!-- study-complete -->' : ''), `study-test-${requests.length}`, completeNext, finishNext),
    })
    completeNext = false
    finishNext = 'stop'
  })
  const room = page.locator('[data-study-room]')
  const setup = async (text = question) => {
    await page.goto(`${base}/study`)
    await expect(room).toBeVisible({ timeout: 60000 })
    await page.locator('#study-question').fill(text)
    await room.getByRole('button', { name: '选个学习起点' }).click()
    await expect(room.getByRole('heading', { name: '这道题，你会到哪一步？' })).toBeVisible()
  }
  const waitReply = async () => {
    await expect(room.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await expect(room.getByText(`验证回合 ${requests.length}`, { exact: false })).toBeVisible()
  }
  const shot = async (name) => {
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: path.join(output, name) })
  }
  try {
    await setup()
    assert.equal(requests.length, 0)
    await expect(page.locator('[data-study-composer]')).toHaveCount(0)
    await shot('formal-entry-831.png')
    await room.getByRole('button', { name: /01.*完全不会/ }).click()
    await waitReply()
    assert.equal(requests[0].studyMode, true)
    assert.equal(requests[0].studyApproach, 'beginner')
    assert.equal(requests[0].maskId, null)
    assert(requests[0].messages.at(-1).parts.some((part) => part.text?.includes(question)))
    assert.equal(new URL(page.url()).pathname, '/study')
    await expect(room.getByRole('button', { name: '查看原题' })).toBeVisible()
    const top = await page.locator('[data-study-scroll]').evaluate((element) => element.scrollTop)
    await room.getByRole('button', { name: '查看原题' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
    assert.equal(await page.locator('[data-study-scroll]').evaluate((element) => element.scrollTop), top)
    await shot('formal-guided-831.png')
    checks.push('question staging, beginner request, compare isolation, recall scroll restoration')

    const input = page.locator('#study-followup')
    assert.equal(await input.evaluate((element) => element.getBoundingClientRect().height), 44)
    await input.fill('长一点的追问\n'.repeat(20))
    assert((await input.evaluate((element) => element.getBoundingClientRect().height)) <= 144)
    await input.fill('')
    assert.equal(await input.evaluate((element) => element.getBoundingClientRect().height), 44)
    await room.getByRole('button', { name: '继续，往下讲' }).click()
    await waitReply()
    assert.equal(requests.at(-1).studyApproach, 'beginner')
    await room.getByRole('button', { name: '看完整解法', exact: true }).click()
    await waitReply()
    assert(requests.at(-1).messages.at(-1).parts.some((part) => part.text?.includes('完整分步解法')))
    let savedNote
    await page.route('**/api/study/notes', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      savedNote = route.request().postDataJSON()
      await route.fulfill({ json: { id: 'study-note-fixture' } })
    })
    // 存错题入口已从操作栏收进右键菜单(收藏独占操作栏),验证能力仍在
    await room.locator('[data-message-id]').last().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '存为错题' }).click()
    await expect.poll(() => savedNote?.questionText).toBe(question)
    assert(savedNote.analysisText.includes('先找到切入点'))
    checks.push('next/full answer transport, compact input, saving original question with explanation')

    await room.getByRole('button', { name: '换种方式' }).click()
    await expect(page.locator('[data-study-composer]')).toHaveCount(0)
    const countBeforePartial = requests.length
    await room.getByRole('button', { name: /02.*只会一点/ }).click()
    assert.equal(requests.length, countBeforePartial)
    await expect(room.getByRole('button', { name: '从这里接着讲' })).toBeDisabled()
    await page.locator('#study-thought').fill('我想先求长和宽，但条件不够。')
    await room.getByRole('button', { name: '从这里接着讲' }).click()
    await waitReply()
    assert.equal(requests.at(-1).studyApproach, 'partial')
    assert(requests.at(-1).messages.at(-1).parts.some((part) => part.text?.includes('我想先求长和宽')))
    await input.fill('partial 草稿')
    await room.getByRole('button', { name: '换种方式' }).click()
    await room.getByRole('button', { name: /03.*都会了/ }).click()
    await waitReply()
    assert.equal(requests.at(-1).studyApproach, 'review')
    await room.getByRole('button', { name: '展开精简解法' }).click()
    await waitReply()
    assert(requests.at(-1).messages.at(-1).parts.some((part) => part.text?.includes('展开精简解法')))
    await room.getByRole('button', { name: '换种方式' }).click()
    await room.getByRole('button', { name: /02.*只会一点/ }).click()
    await expect(page.locator('#study-thought')).toHaveValue('我想先求长和宽，但条件不够。')
    await room.getByRole('button', { name: '说不清，先给提示' }).click()
    await waitReply()
    await expect(input).toHaveValue('partial 草稿')
    checks.push('partial input and hint, review reveal, approach changes without lost history/drafts')

    await input.fill('<img src=x onerror=alert(1)>')
    await room.getByRole('button', { name: '发送追问' }).click()
    await waitReply()
    await expect(room.locator('img[src="x"]')).toHaveCount(0)
    failNext = true
    await input.fill('触发一次测试错误')
    await room.getByRole('button', { name: '发送追问' }).click()
    await expect(room.getByRole('button', { name: /重试/ }).first()).toBeVisible()
    await room.getByRole('button', { name: /重试/ }).first().click()
    await waitReply()
    holdNext = true
    await input.fill('测试停止')
    await room.getByRole('button', { name: '发送追问' }).click()
    await expect(room.getByRole('button', { name: '停止生成' })).toBeVisible()
    await room.getByRole('button', { name: '停止生成' }).click()
    await expect(room.getByRole('button', { name: '发送追问' })).toBeVisible()
    if (heldRoute) { await heldRoute.abort().catch(() => {}); heldRoute = null }
    await expect(room.getByRole('button', { name: '重新开始讲解' })).toBeVisible()
    await room.getByRole('button', { name: '重新开始讲解' }).click()
    await waitReply()
    await room.getByRole('button', { name: '换种方式' }).click()
    await room.getByRole('button', { name: /01.*完全不会/ }).click()
    await waitReply()
    const beforeCancel = requests.length
    await room.getByRole('button', { name: '换种方式' }).click()
    await room.getByRole('button', { name: /02.*只会一点/ }).click()
    await room.getByRole('button', { name: '返回学习方式选择' }).click()
    await room.getByRole('button', { name: '回到当前讲解' }).click()
    assert.equal(requests.length, beforeCancel)
    await input.fill('取消切换后继续')
    await room.getByRole('button', { name: '发送追问' }).click()
    await waitReply()
    assert.equal(requests.at(-1).studyApproach, 'beginner')
    checks.push('escaped user content, upstream error retry, stop and restart, cancelled approach stays unchanged')

    for (const [width, height] of [[375, 667], [390, 844], [430, 932], [844, 390], [768, 1024], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      await setup()
      await room.getByRole('button', { name: /01.*完全不会/ }).click()
      await waitReply()
      const metrics = await page.evaluate(() => {
        const root = document.querySelector('[data-study-room]')
        const scroll = root.querySelector('[data-study-scroll]')
        const footer = root.querySelector('[data-study-composer]')
        const input = root.querySelector('#study-followup')
        return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth, reading: scroll.clientHeight, footer: footer.getBoundingClientRect().height, input: input.getBoundingClientRect().height,
          bottom: footer.getBoundingClientRect().bottom,
          nested: [...scroll.querySelectorAll('*')].filter((element) => !['TEXTAREA'].includes(element.tagName) && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 2).length }
      })
      assert(metrics.overflow <= 1, JSON.stringify(metrics))
      assert(metrics.footer < 95, JSON.stringify(metrics))
      assert(metrics.reading >= height * .55, JSON.stringify(metrics))
      assert(metrics.bottom <= height + 1, JSON.stringify(metrics))
      assert.equal(metrics.nested, 0)
      assert.equal(metrics.input, 44)
      measurements.push(metrics)
      const blocked = await room.locator('header button').evaluateAll((buttons) => buttons.filter((button) => {
        const r = button.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && !button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      }).map((button) => button.getAttribute('aria-label') || button.textContent))
      assert.deepEqual(blocked, [])
      await room.getByRole('button', { name: '学习工具', exact: true }).click()
      // 学习工具弹层:讲题设置 + 三个备查入口(错题本/今日复习/收藏)
      await expect(page.getByRole('dialog').getByText('讲题设置', { exact: true })).toBeVisible()
      await expect(page.getByRole('dialog').getByRole('button', { name: /^收藏/ })).toBeVisible()
      await page.getByRole('dialog').getByRole('button', { name: /^错题本/ }).click()
      await expect(page.getByRole('button', { name: '关闭抽屉' })).toBeVisible()
      await page.getByRole('button', { name: '关闭抽屉' }).click()
      await shot(`formal-guided-${width}.png`)
    }
    checks.push('responsive single-scroll layout, compact footer, no horizontal overflow')

    await page.setViewportSize({ width: 375, height: 812 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await expect(room.getByRole('button', { name: '发送追问' })).toBeVisible()
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    assert(await input.evaluate((element) => {
      const css = getComputedStyle(element)
      return parseFloat(css.lineHeight) >= parseFloat(css.fontSize) * 1.5 && element.clientHeight >= parseFloat(css.lineHeight) + 20 && element.scrollHeight <= element.clientHeight + 1
    }))
    await shot('formal-large-text.png')
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; document.documentElement.classList.add('dark') })
    await shot('formal-dark.png')
    await page.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.style.setProperty('--keyboard-height', '280px') })
    assert(await page.locator('[data-study-composer]').evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight - 279))
    await page.evaluate(() => document.documentElement.style.setProperty('--keyboard-height', '0px'))
    checks.push('large text, dark theme, simulated soft-keyboard clearance')

    await page.goto(`${base}/study`)
    await expect(room).toBeVisible({ timeout: 60000 })
    await page.locator('#study-question').fill('上传中的题目')
    const chooserPromise = page.waitForEvent('filechooser')
    await room.getByRole('button', { name: '添加附件', exact: true }).click()
    const chooser = await chooserPromise
    await chooser.setFiles([])
    await expect(page.locator('#study-question')).toBeVisible()
    holdUpload = true
    await room.locator('input[type="file"]').setInputFiles({ name: 'study-fixture.png', mimeType: 'image/png', buffer: png })
    await expect(room.getByRole('button', { name: '选个学习起点' })).toBeDisabled()
    await expect.poll(() => !!uploadRoute).toBe(true)
    await uploadRoute.fulfill({ json: { url: imageData, name: 'study-fixture.png', type: 'image/png', size: png.length } })
    uploadRoute = null
    holdUpload = false
    await expect(room.getByRole('button', { name: '选个学习起点' })).toBeEnabled()
    await room.getByRole('button', { name: '移除文件' }).click()
    await expect(page.locator('#study-question')).toBeVisible()
    await expect(room.getByRole('button', { name: '移除文件' })).toHaveCount(0)
    await room.locator('input[type="file"]').setInputFiles({ name: 'study-fixture.png', mimeType: 'image/png', buffer: png })
    await expect(room.getByRole('button', { name: '移除文件' })).toBeVisible()
    await expect(room.getByRole('button', { name: '选个学习起点' })).toBeEnabled()
    await page.locator('#study-question').fill('')
    await room.getByRole('button', { name: '选个学习起点' }).click()
    await expect(room.getByRole('button', { name: /放大题目图片/ })).toBeVisible()
    await room.getByRole('button', { name: /放大题目图片/ }).click()
    await page.keyboard.press('Escape')
    await room.getByRole('button', { name: /01.*完全不会/ }).click()
    await waitReply()
    assert.equal(requests.at(-1).attachments.length, 1)
    assert(requests.at(-1).messages.at(-1).parts.some((part) => part.text?.includes('题目见附件')))
    await room.getByRole('button', { name: '附件与模型设置' }).click()
    await room.locator('input[type="file"]').setInputFiles({ name: 'followup.png', mimeType: 'image/png', buffer: png })
    await expect(room.getByRole('button', { name: '发送追问' })).toBeEnabled()
    await room.getByRole('button', { name: '发送追问' }).click()
    await waitReply()
    assert.equal(requests.at(-1).attachments.length, 1)
    checks.push('upload pending guard, image-only question, lightbox, followup attachments')

    await setup()
    await room.getByRole('button', { name: /01.*完全不会/ }).click()
    await waitReply()
    assert.equal(requests.at(-1).messages.at(-1).metadata.studyAction, 'instruction')
    const nextTemplate = '继续讲下一步。如果这道题已经讲完，请简短总结关键方法，不必自动出新题。'
    await room.getByRole('button', { name: '继续，往下讲' }).click()
    await waitReply()
    assert.equal(requests.at(-1).messages.at(-1).metadata.studyAction, 'next')
    assert(requests.at(-1).messages.at(-1).parts.some((part) => part.text === nextTemplate))
    await expect(room.getByText(nextTemplate, { exact: true })).toHaveCount(0)
    await input.fill(nextTemplate)
    await room.getByRole('button', { name: '发送追问' }).click()
    await waitReply()
    assert.equal(requests.at(-1).messages.at(-1).metadata?.studyAction, undefined)
    await expect(room.getByText(nextTemplate, { exact: true })).toBeVisible()
    completeNext = true
    finishNext = 'length'
    await room.getByRole('button', { name: '继续，往下讲' }).click()
    await waitReply()
    await expect(room.locator('[data-study-complete]')).toHaveCount(0)
    await expect(room.getByRole('button', { name: '继续，往下讲' })).toBeVisible()
    completeNext = true
    await room.getByRole('button', { name: '看完整解法', exact: true }).click()
    const completed = room.locator('[data-study-complete]')
    await expect(completed.getByRole('heading', { name: '本题讲解完成' })).toBeVisible()
    assert.equal(requests.at(-1).messages.at(-1).metadata.studyAction, 'solution')
    await expect(room.getByRole('button', { name: '继续，往下讲' })).toHaveCount(0)
    await expect(room.getByRole('button', { name: '看完整解法', exact: true })).toHaveCount(0)
    assert(!(await completed.innerText()).includes('study-complete'))
    await expect(completed.getByRole('heading', { name: '先找到切入点' })).toBeVisible()
    await expect(input).not.toBeVisible()
    for (const [width, height] of [[375, 667], [844, 390], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      await shot(`formal-completed-${width}.png`)
    }
    await page.setViewportSize({ width: 375, height: 812 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await shot('formal-completed-large-text.png')
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; document.documentElement.classList.add('dark') })
    await shot('formal-completed-dark.png')
    await page.evaluate(() => document.documentElement.classList.remove('dark'))
    await completed.getByRole('button', { name: '回看讲解' }).click()
    await expect(completed).toHaveCount(0)
    await expect(room.getByText(nextTemplate, { exact: true })).toBeVisible()
    await expect(room.getByRole('button', { name: '继续，往下讲' })).toHaveCount(0)
    await input.fill('未发送的追问草稿')
    await room.getByRole('button', { name: '查看本题小结' }).click()
    await expect(completed.getByRole('button', { name: '再学一道' })).toBeDisabled()
    await completed.getByRole('button', { name: '还有疑问' }).click()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('未发送的追问草稿')
    await room.getByRole('button', { name: '发送追问' }).click()
    await waitReply()
    await expect(room.getByRole('button', { name: '继续，往下讲' })).toHaveCount(0)
    await room.getByRole('button', { name: '查看本题小结' }).click()
    const beforeNewLesson = requests.length
    await completed.getByRole('button', { name: '再学一道' }).click()
    await expect(page.locator('#study-question')).toHaveValue('')
    await expect(completed).toHaveCount(0)
    assert.equal(requests.length, beforeNewLesson)
    checks.push('tagged templates hidden, identical manual text visible, truncation not completion, end screen and draft-safe new lesson')

    await setup()
    await room.getByRole('button', { name: /03.*都会了/ }).click()
    await waitReply()
    completeNext = true
    await room.getByRole('button', { name: '展开精简解法' }).click()
    await expect(completed.getByRole('heading', { name: '本题讲解完成' })).toBeVisible()
    checks.push('review solution reaches completion screen')

    await setup()
    await room.getByRole('button', { name: /01.*完全不会/ }).click()
    await waitReply()
    failNext = true
    await room.getByRole('button', { name: '继续，往下讲' }).click()
    await expect(room.getByRole('button', { name: /重试/ }).first()).toBeVisible()
    await expect(completed).toHaveCount(0)
    completeNext = true
    await room.getByRole('button', { name: /重试/ }).first().click()
    await expect(completed.getByRole('heading', { name: '本题讲解完成' })).toBeVisible()
    await setup()
    await room.getByRole('button', { name: /01.*完全不会/ }).click()
    await waitReply()
    holdNext = true
    await room.getByRole('button', { name: '继续，往下讲' }).click()
    await expect(room.getByRole('button', { name: '停止生成' })).toBeVisible()
    await room.getByRole('button', { name: '停止生成' }).click()
    if (heldRoute) { await heldRoute.abort().catch(() => {}); heldRoute = null }
    await expect(completed).toHaveCount(0)
    completeNext = true
    await room.getByRole('button', { name: '继续，往下讲' }).click()
    await expect(completed.getByRole('heading', { name: '本题讲解完成' })).toBeVisible()
    checks.push('next completion, errors and stop do not end lesson, retry and resume can complete')

    await setup()
    holdNext = true
    await room.getByRole('button', { name: /01.*完全不会/ }).click()
    await expect(room.getByRole('button', { name: '停止生成' })).toBeVisible()
    await room.getByRole('button', { name: '停止生成' }).click()
    if (heldRoute) { await heldRoute.abort().catch(() => {}); heldRoute = null }
    await input.fill('首轮停止后，我手动输入的追问')
    await room.getByRole('button', { name: '发送追问' }).click()
    await waitReply()
    await expect(room.getByText('首轮停止后，我手动输入的追问', { exact: true })).toBeVisible()
    await input.fill('完全不会方式保留的草稿')
    await room.getByRole('button', { name: '换种方式' }).click()
    await room.getByRole('button', { name: /03.*都会了/ }).click()
    await waitReply()
    completeNext = true
    await room.getByRole('button', { name: '展开精简解法' }).click()
    await expect(completed.getByRole('button', { name: '再学一道' })).toBeDisabled()
    await completed.getByRole('button', { name: '还有疑问' }).click()
    await room.getByRole('button', { name: '换种方式' }).click()
    await room.getByRole('button', { name: /01.*完全不会/ }).click()
    await waitReply()
    await expect(input).toHaveValue('完全不会方式保留的草稿')
    await input.fill('')
    await room.getByRole('button', { name: '查看本题小结' }).click()
    await expect(completed.getByRole('button', { name: '再学一道' })).toBeEnabled()
    checks.push('manual first visible message after initial abort, other approach drafts protected at completion')

    await page.goto(`${base}/chat`)
    await expect(room).toHaveCount(0)
    await expect(page.locator('textarea').first()).toBeVisible()
    checks.push('ordinary chat remains available')
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(output, 'checks-formal.json'), JSON.stringify({ passed: true, checks, measurements, requests: requests.length, errors }, null, 2))
    console.log(JSON.stringify({ passed: true, checks, measurements, requests: requests.length, errors }, null, 2))
  } catch (error) {
    await shot('formal-failure.png').catch(() => {})
    fs.writeFileSync(path.join(output, 'checks-formal.json'), JSON.stringify({ passed: false, checks, measurements, error: error.message, errors }, null, 2))
    throw error
  } finally {
    await browser.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
