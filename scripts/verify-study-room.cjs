// 学习流内联核验(2026-11-02 改版后口径)
// 独立题面页与学习室头部已撤下:题目写在主页输入框里,起点卡/思路卡/讲解操作/结课卡
// 内联在消息流之下、输入框之上;错题本/回看/收藏改由「学习工具」胶囊的抽屉承载。
// 本脚本只验这条新链路 + 学习模式进出,不再验已删除的学习室布局。
const { chromium, expect } = require('@playwright/test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const base = process.env.STUDY_TEST_BASE || 'http://localhost:3456'
const output = path.resolve('public/preview-study-room-shots')
const question = '直角三角形 ABC 在 B 处为直角，矩形 BDEF 的 E 在 AC 上，AD=4，FC=8。求矩形面积。'
const answer = '### 先找到切入点\n\n观察矩形外的两个直角三角形，它们有两组角分别相等，因此相似。\n\n先不用分别求长和宽，把对应边联系起来。'
const nextTemplate = '继续讲下一步。如果这道题已经讲完，请简短总结关键方法，不必自动出新题。'

function stream(text, id, completed = false) {
  return [
    { type: 'start', messageId: id },
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
    { type: 'finish', finishReason: 'stop', messageMetadata: { studyCompleted: completed } },
  ].map((part) => `data: ${JSON.stringify(part)}\n\n`).join('') + 'data: [DONE]\n\n'
}

async function main() {
  // 断言默认等 20s:dev 下单跳路由(?study=1 换了 searchParams)会触发服务端重编译,
  // 5s 的默认窗口会误判成「点了没反应」(实测 FRAMENAV 在 5~10s 之间才落)。
  expect.configure({ timeout: 20000 })
  const browser = await chromium.launch({ args: ['--mute-audio'] })
  const context = await browser.newContext({ storageState: '.auth/admin.json', viewport: { width: 900, height: 800 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  const requests = []
  const checks = []
  let completeNext = false
  const png = await require('sharp')({ create: { width: 320, height: 180, channels: 3, background: '#f5f5f7' } }).png().toBuffer()
  const imageData = `data:image/png;base64,${png.toString('base64')}`
  page.on('pageerror', (error) => errors.push(error.stack || error.message))
  page.on('requestfailed', (request) => { if (request.resourceType() === 'script') errors.push(`${request.url()}: ${request.failure()?.errorText}`) })
  await page.addInitScript(() => {
    localStorage.setItem('chat:deepThink', 'false')
    // 全新 profile 里侧栏默认展开,而 MobileDrawer 的 Esc 监听在桌面也会挂上 ——
    // 按 Esc 会顺带收起侧栏,内容区重排让「输入框上方内联条」的几何断言偏移。锁死侧栏。
    localStorage.setItem('chat:sidebarOpen', 'false')
    localStorage.removeItem('study:lesson:v1')
  })
  await page.route('**/api/upload', (route) => route.fulfill({
    json: { url: imageData, name: 'study-fixture.png', type: 'image/png', size: png.length },
  }))
  await page.route('**/api/chat', async (route) => {
    const body = route.request().postDataJSON()
    requests.push(body)
    await route.fulfill({
      contentType: 'text/event-stream',
      headers: { 'x-vercel-ai-ui-message-stream': 'v1' },
      body: stream(answer + `\n\n验证回合 ${requests.length}` + (completeNext ? '\n\n本题方法已讲完。\n<!-- study-complete -->' : ''), `study-test-${requests.length}`, completeNext),
    })
    completeNext = false
  })

  const strip = page.locator('[data-study-strip]')
  const composer = page.locator('textarea').last()
  // 胶囊的可及名由 aria-label 给出:「进入学习模式」/「退出学习模式，返回聊天」,
  // 屏内同时只有这一颗,用前缀匹配两者
  const chip = page.getByRole('button', { name: /学习模式/ })
  const toolsChip = page.getByRole('button', { name: '学习工具', exact: true })
  // 欢迎态按钮叫「发送」,会话态叫「发送消息」(ChatInput 两个 variant 各一份)
  const sendBtn = page.getByRole('button', { name: /^(发送|发送消息)$/ })
  const waitReply = async () => {
    const round = requests.length
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: 20000 })
    // 回复全文只在上方气泡渲染一次;取 .first() 是纯防御,不再是给结课卡复读擦屁股
    await expect(page.getByText(`验证回合 ${round}`, { exact: false }).first()).toBeVisible({ timeout: 20000 })
  }
  const shot = async (name) => {
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: path.join(output, name) })
  }
  // 重新进入学习模式并出一道题(每次都是从输入框起步,不再另起题面页)
  const askQuestion = async (text = question) => {
    await page.goto(`${base}/chat?study=1`)
    await expect(chip).toBeVisible({ timeout: 60000 })
    await expect(strip).toHaveCount(0)
    await composer.fill(text)
    await sendBtn.click()
    await expect(strip.getByRole('heading', { name: '这道题，你会到哪一步？' })).toBeVisible({ timeout: 20000 })
  }
  /**
   * 点胶囊并等 URL 落地。胶囊是客户端按钮:dev 冷编译时 SSR 先把按钮画好,
   * hydration 未就绪那一下点下去是空响;导航本身还要等 RSC chunk,实测 20s 都会不够
   * (同一句 toHaveURL 在 3 次跑里分别卡在第 1 步和第 9 步)。重试点击 + 末次放宽到 30s,
   * 真坏了(导航压根不发生)照样红,只是不把 dev 编译延迟算成回归。
   */
  const clickChipTo = async (pattern) => {
    for (let i = 0; i < 3; i += 1) {
      if (pattern.test(page.url())) break
      await chip.click()
      await expect(page).toHaveURL(pattern, { timeout: 10000 }).catch(() => {})
    }
    await expect(page).toHaveURL(pattern, { timeout: 30000 })
  }

  try {
    fs.mkdirSync(output, { recursive: true })

    // ── 1. 欢迎页:胶囊是入口,点下去只把输入框切成讲题态,不出现题面卡 ──────────
    await page.goto(`${base}/chat`)
    await expect(chip).toBeVisible({ timeout: 60000 })
    await expect(toolsChip).toHaveCount(0)
    assert.equal((await composer.getAttribute('placeholder')), '输入问题...')
    await clickChipTo(/\/chat\?study=1$/)
    await expect(toolsChip).toBeVisible()
    assert.equal(await composer.getAttribute('placeholder'), '输入或粘贴题目，也可以只上传题图…')
    await expect(strip).toHaveCount(0)
    assert.equal(requests.length, 0)
    checks.push('capsule toggles study mode, no separate question page, no request before sending')

    // ── 2. 题目走主页输入框:发出后先当「待选题目」收住,一次模型调用都不发 ──────
    await composer.fill(question)
    await sendBtn.click()
    await expect(strip.getByRole('heading', { name: '这道题，你会到哪一步？' })).toBeVisible({ timeout: 20000 })
    assert.equal(requests.length, 0)
    // 题还没进消息流:气泡区是空的,题目只出现在内联条的「当前题目」里
    await expect(page.locator('[data-message-id]')).toHaveCount(0)
    await expect(strip.getByText('当前题目')).toBeVisible()
    await expect(strip.getByText(question, { exact: false })).toBeVisible()
    await shot('inline-approach.png')
    checks.push('question held as draft above the composer, zero model calls before choosing a start')

    // ── 3. 起点选定:合成首条一次发全,服务端契约与旧学习室一致 ─────────────────
    await strip.getByRole('button', { name: /01.*完全不会/ }).click()
    await waitReply()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].studyMode, true)
    assert.equal(requests[0].studyApproach, 'beginner')
    assert.equal(requests[0].maskId, null)
    const first = requests[0].messages.at(-1).parts.map((p) => p.text ?? '').join('')
    assert(first.includes('请帮我理解这道题。'))
    assert(first.includes(question))
    assert(first.includes('学习起点：完全不会'))
    // 气泡只还原题目:内部引导语与本轮指令不外泄
    await expect(page.locator('[data-message-id]').first()).toBeVisible()
    await expect(page.getByText('请帮我理解这道题。', { exact: false })).toHaveCount(0)
    await expect(page.getByText(question, { exact: false })).toBeVisible()
    // 「接着说」等学习流自己的状态行已随学习室一并撤下
    await expect(strip.getByRole('button', { name: '继续，往下讲' })).toBeVisible()
    await expect(strip.getByRole('button', { name: '看完整解法', exact: true })).toBeVisible()
    await shot('inline-running.png')
    checks.push('composed first message keeps server contract, instruction prefix hidden in the bubble')

    // ── 4. 追问与指令:按钮指令不进消息流,手输同样的话照常显示 ─────────────────
    await strip.getByRole('button', { name: '继续，往下讲' }).click()
    await waitReply()
    assert.equal(requests[1].messages.at(-1).metadata.studyAction, 'next')
    assert(requests[1].messages.at(-1).parts.some((p) => p.text === nextTemplate))
    await expect(page.getByText(nextTemplate, { exact: true })).toHaveCount(0)
    await composer.fill(nextTemplate)
    await sendBtn.click()
    await waitReply()
    assert.equal(requests[2].messages.at(-1).metadata?.studyAction, undefined)
    await expect(page.getByText(nextTemplate, { exact: true })).toBeVisible()
    checks.push('button instruction stays invisible, identical manual text renders normally')

    // ── 5. 换起点:只会一点先接思路,不偷发请求;思路进本轮指令 ──────────────────
    await strip.getByRole('button', { name: '换种方式' }).click()
    const beforePartial = requests.length
    await strip.getByRole('button', { name: /02.*只会一点/ }).click()
    assert.equal(requests.length, beforePartial)
    await page.locator('#study-thought').fill('我想先求长和宽，但条件不够。')
    await strip.getByRole('button', { name: '从这里接着讲' }).click()
    await waitReply()
    assert.equal(requests.at(-1).studyApproach, 'partial')
    assert(requests.at(-1).messages.at(-1).parts.some((p) => p.text?.includes('我想先求长和宽')))
    await strip.getByRole('button', { name: '换种方式' }).click()
    await strip.getByRole('button', { name: /02.*只会一点/ }).click()
    await expect(page.locator('#study-thought')).toHaveValue('我想先求长和宽，但条件不够。')
    await strip.getByRole('button', { name: '回到当前讲解' }).click()
    assert.equal(requests.length, beforePartial + 1)
    checks.push('partial collects the approach first, draft survives reopening, back does not re-send')

    // ── 6. 结课:完成标记落到内联条的结课卡,再学一道回到输入框 ──────────────────
    completeNext = true
    await strip.getByRole('button', { name: '看完整解法', exact: true }).click()
    await waitReply()
    // 结课卡(带小结)比 46dvh 承托带高:内容变高必须自动粘底,否则「再学一道」藏在
    // 带子下缘 —— 用户只看见「本题讲完了」,以为整堂课结束就没有入口了。
    // toBeVisible 只看元素有没有尺寸,不看它在不在滚动容器视野里,所以按 rect 量。
    let bandMetrics = null
    const expectRelearnInView = () => expect.poll(async () => {
      bandMetrics = await page.evaluate(() => {
        const band = document.querySelector('[data-study-band]')
        const btn = [...band.querySelectorAll('button')].find((b) => b.textContent.includes('再学一道'))
        const box = band.getBoundingClientRect()
        const r = btn.getBoundingClientRect()
        return { bandTop: Math.round(box.top), bandBottom: Math.round(box.bottom), btnTop: Math.round(r.top), btnBottom: Math.round(r.bottom) }
      })
      return bandMetrics.btnTop >= bandMetrics.bandTop && bandMetrics.btnBottom <= bandMetrics.bandBottom + 1
    }, { timeout: 5000, message: () => `结课卡主操作不在承托带视野内 ${JSON.stringify(bandMetrics)}` }).toBe(true)

    const completed = page.locator('[data-study-complete]')
    await expect(completed.getByRole('heading', { name: '本题讲解完成' })).toBeVisible()
    assert(!(await completed.innerText()).includes('study-complete'))
    // 小结整段复读 finalReply 的 wrapUp 已删:回复气泡悬在消息流里,结课卡本体不该再出现回复内容
    // (变异检查:改动前 wrapUp 把整条回复渲进卡内,用户实测截图 h=833,本断言当时必红)
    assert(!(await completed.innerText()).includes('验证回合'), '结课卡不应整段复读回复内容(回复已在上方气泡)')
    await expect(strip.getByRole('button', { name: '继续，往下讲' })).toHaveCount(0)
    // 自然结课(没人手动滚过)这一路也要自动跟到底 —— 上一版在挂载时量了一次「离底多远」,
    // 内容本就超高时判成不粘底,只有点过小结/回看把视野滚到底之后才恢复
    await expectRelearnInView()
    await shot('inline-complete.png')
    await completed.getByRole('button', { name: '回看讲解' }).click()
    await expect(completed).toHaveCount(0)
    await strip.getByRole('button', { name: '查看本题小结' }).click()
    await expect(completed.getByRole('heading', { name: '本题讲解完成' })).toBeVisible()
    await expectRelearnInView()
    await completed.getByRole('button', { name: '再学一道' }).click()
    await expect(page).toHaveURL(/\/chat\?study=1$/, { timeout: 30000 })
    await expect(strip).toHaveCount(0)
    await expect(page.locator('[data-message-id]')).toHaveCount(0)
    checks.push('completion card, reopen summary, 再学一道 lands back on the bare composer')

    // ── 7. 题图:只传图不写字也能开课,附件随首条一起发出 ────────────────────────
    const beforeImageOnly = requests.length
    await page.goto(`${base}/chat?study=1`)
    await expect(chip).toBeVisible({ timeout: 60000 })
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'study-fixture.png', mimeType: 'image/png', buffer: png })
    await sendBtn.click()
    await expect(strip.getByRole('button', { name: /放大题目图片/ })).toBeVisible()
    assert.equal(requests.length, beforeImageOnly)
    await strip.getByRole('button', { name: /01.*完全不会/ }).click()
    await waitReply()
    assert.equal(requests.at(-1).attachments.length, 1)
    assert(requests.at(-1).messages.at(-1).parts.some((p) => p.text?.includes('题目见附件')))
    checks.push('image-only question: attachment rides the composed first message')

    // ── 8. 学习工具胶囊:抽屉开关,退出学习模式即消失 ────────────────────────────
    await toolsChip.click()
    const drawer = page.getByRole('complementary', { name: '学习工具' })
    await expect(drawer.getByRole('button', { name: '错题本' })).toBeVisible()
    await expect(drawer.getByRole('button', { name: '错题回看' })).toBeVisible()
    await expect(drawer.getByRole('button', { name: '收藏' })).toBeVisible()
    await drawer.getByRole('button', { name: '收藏' }).click()
    await expect(drawer.getByText('待回看')).toHaveCount(0)
    await shot('inline-tools-drawer.png')
    await page.getByRole('button', { name: '关闭抽屉' }).click()
    await expect(drawer).toHaveCount(0)
    checks.push('study tools capsule: notes/review/favorites drawer opens and closes')

    // ── 9. 退出学习模式:回到普通聊天,胶囊与内联条一并撤下 ──────────────────────
    await clickChipTo(/\/chat$/)
    await expect(strip).toHaveCount(0)
    await expect(toolsChip).toHaveCount(0)
    // 软导航落定瞬间旧会话页的学习态输入框与新欢迎页实例短暂共存,裸读会打中卸载中的旧实例
    // (本轮实测:fill/发送/study 标志断言全过,唯独 placeholder 读到讲题文案)。用带重试的断言,
    // 占位符真回不来照样红
    await expect(composer).toHaveAttribute('placeholder', '输入问题...')
    await composer.fill('普通聊天冒烟')
    await sendBtn.click()
    await waitReply()
    assert.equal(requests.at(-1).studyMode, undefined)
    assert.equal(requests.at(-1).studyApproach, undefined)
    checks.push('exit study mode restores ordinary chat, ordinary send has no study flags')

    // ── 10. 手机端几何:内联条压在输入框上方,不撑出横向滚动 ────────────────────
    await page.setViewportSize({ width: 390, height: 844 })
    await askQuestion()
    // 量承托带(data-study-band)而不是内联条本体:带子才是封顶滚动的那一层,
    // 里面的卡片按内容全高渲染,rect 会伸出带子下缘(那是滚动区,不是溢出)
    const metrics = await page.evaluate(() => {
      const band = document.querySelector('[data-study-band]')
      const box = band.getBoundingClientRect()
      const input = [...document.querySelectorAll('textarea')].pop().getBoundingClientRect()
      const first = [...band.querySelectorAll('button')].find((b) => b.textContent.includes('完全不会')).getBoundingClientRect()
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        stripTop: box.top, stripBottom: box.bottom, inputTop: input.top,
        scrollable: band.scrollHeight > band.clientHeight,
        visible: box.height > 0 && box.top >= 0 && box.bottom <= innerHeight,
        // 起点卡第一档(01)要整档落在带子视野里:上一版把带子滚到绝对底部,
        // 01 与「当前题目」被顶出上缘(用户报的「超出屏幕外了」)
        option01Top: first.top, option01Bottom: first.bottom, bandTop: box.top, bandBottom: box.bottom,
        // 空态(还没发消息)封顶 70dvh,消息流起来后退回 46dvh
        cap: band.getBoundingClientRect().height, capRatio: parseFloat(getComputedStyle(band).maxHeight) / innerHeight,
      }
    })
    assert(metrics.overflow <= 1, JSON.stringify(metrics))
    assert(metrics.visible, JSON.stringify(metrics))
    assert(metrics.stripBottom <= metrics.inputTop + 1, JSON.stringify(metrics))
    assert(metrics.option01Top >= metrics.bandTop - 1 && metrics.option01Bottom <= metrics.bandBottom + 1,
      `01 完全不会不在承托带视野内 ${JSON.stringify(metrics)}`)
    // 紧凑化定案(2026-11-02「还要压，紧凑」):空态整张起点卡一次看全,不许还要带内滚
    assert(!metrics.scrollable, `起点卡仍需在承托带内滚动才能看全 ${JSON.stringify(metrics)}`)
    assert(Math.abs(metrics.capRatio - 0.7) < 0.01, `空态封顶应为 70dvh,实测 ${metrics.capRatio.toFixed(3)} ${JSON.stringify(metrics)}`)
    await shot(`inline-mobile-390.png`)
    await strip.getByRole('button', { name: /01.*完全不会/ }).click()
    await waitReply()
    const mobileRunning = await page.evaluate(() => {
      const band = document.querySelector('[data-study-band]')
      const box = band.getBoundingClientRect()
      return { overflow: document.documentElement.scrollWidth - innerWidth, bottom: box.bottom, height: box.height, vh: innerHeight }
    })
    assert(mobileRunning.overflow <= 1, JSON.stringify(mobileRunning))
    assert(mobileRunning.height <= mobileRunning.vh * 0.46 + 1, JSON.stringify(mobileRunning))
    await shot('inline-mobile-running.png')
    checks.push('mobile geometry: strip sits above the composer, capped height, no horizontal overflow')

    assert.deepEqual(errors, [])
    const report = { passed: true, checks, requests: requests.length, errors }
    fs.writeFileSync(path.join(output, 'checks-formal.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    await shot('formal-failure.png').catch(() => {})
    fs.writeFileSync(path.join(output, 'checks-formal.json'), JSON.stringify({ passed: false, checks, error: error.message, errors }, null, 2))
    throw error
  } finally {
    await browser.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
