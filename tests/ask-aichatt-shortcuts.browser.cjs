const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');

const ROOT = path.join(process.cwd(), 'browser-extension');
const PORT = 4190;
const BASE = `http://127.0.0.1:${PORT}/panel.html`;
const passed = [];
const ok = (name) => { passed.push(name); console.log('PASS', name); };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

const conversations = Array.from({ length: 4 }, (_, i) => ({
  id: `conv-${i + 1}`,
  title: i === 0 ? '快捷入口测试资料' : `快捷入口测试资料${i + 1}`,
  model: 'vision-1',
  mode: 'chat',
}));
const sentinelFor = (id) => `REFERENCE_BODY_${id.replace(/-/g, '_').toUpperCase()}_739`;

(async () => {
  const server = http.createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, BASE).pathname);
      const file = path.join(ROOT, pathname === '/' ? 'panel.html' : pathname);
      if (!file.startsWith(ROOT)) throw new Error('bad path');
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => {
      const store = {
        settings: {
          server: 'https://chat.yuban.icu', token: 'test-token',
          user: { name: 'Tester', email: 'tester@example.com' },
          authMode: 'account', model: '', autoPause: true, hideDanmaku: true, deepThink: true,
        },
        aichattDeviceId: 'test-device',
      };
      const get = async (key) => (typeof key === 'string' ? (key in store ? { [key]: store[key] } : {}) : {});
      const set = async (obj) => { Object.assign(store, obj); };
      const remove = async (key) => { delete store[key]; };
      window.__stubStore = store;
      window.__subtitleMode = 'ok';
      window.__subtitleCalls = 0;
      const runtimeListeners = [];
      window.__dispatchRuntimeMessage = (message) => {
        let response;
        for (const listener of runtimeListeners) {
          listener(message, {}, (value) => { response = value; });
        }
        return response;
      };
      window.chrome = {
        runtime: {
          id: 'test-extension',
          onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
          sendMessage: () => Promise.resolve({}),
        },
        storage: { local: { get, set, remove }, session: { get, set, remove } },
        tabs: {
          query: async () => [{ id: 1 }],
          sendMessage: async (_tabId, message) => {
            if (message?.type === 'aichatt:get-context') {
              return { ok: true, title: '测试视频', url: 'https://www.bilibili.com/video/BV1TEST', hasVideo: true, currentTime: 0, duration: 600 };
            }
            if (message?.type === 'aichatt:extract-subtitles') {
              window.__subtitleCalls += 1;
              if (window.__subtitleMode === 'none') {
                return { ok: false, error: '这个视频没有可提取的 AI/CC 字幕（硬字幕需要 Whisper）' };
              }
              if (window.__subtitleMode === 'empty-url-once' && window.__subtitleCalls === 1) {
                return {
                  ok: false,
                  error: '字幕条目已返回但地址为空（B 站接口偶发异常），正在重试',
                  retryable: true,
                };
              }
              const wrong =
                window.__subtitleMode === 'wrong' ||
                (window.__subtitleMode === 'wrong-once' && window.__subtitleCalls === 1);
              const items = wrong
                ? [{ from: 0, to: 3, content: '诺贝尔奖不仅提供几百万的奖金，科学界对此有很多讨论。' }]
                : Array.from({ length: 90 }, (_, i) => ({
                    from: i * 6,
                    to: i * 6 + 5,
                    content: `第${i}段字幕，用于验证长视频分段总结流程，包含足够长度让分块逻辑实际生效。`,
                  }));
              return {
                ok: true,
                title: '测试视频',
                url: 'https://www.bilibili.com/video/BV1TEST',
                lan: 'ai-zh',
                lanDoc: '中文',
                duration: 540,
                items,
              };
            }
            throw new Error('not mocked');
          },
        },
      };
    });

    const payloads = [];
    const quickCalls = [];
    let mode = 'ok';
    let releaseHold;
    await context.route('https://chat.yuban.icu/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname;
      if (pathname === '/api/extension/login') return route.fulfill({ json: { user: { name: 'Tester', email: 'tester@example.com' } } });
      if (pathname === '/api/quick-chat' && request.method() === 'POST') {
        const body = JSON.parse(request.postData() || '{}');
        const content = body.messages?.[0]?.content || '';
        quickCalls.push(content);
        const text = content.includes('全片字幕的分段要点')
          ? '一句话结论：测试视频摘要。\n\n## 章节\n- 第1点\n- 第2点\n'
          : content.includes('合并成更紧凑')
          ? '压缩后的要点'
          : `第${quickCalls.length}段要点`;
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: `data: ${JSON.stringify({ type: 'text', value: text })}\n\ndata: {"type":"done"}\n\n`,
        });
      }
      if (pathname === '/api/quick-chat') return route.fulfill({ json: { visionModels: [{ id: 'vision-1', name: 'Vision One' }] } });
      if (pathname === '/api/conversations') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const items = conversations.filter((x) => !q || x.title.toLowerCase().includes(q));
        return route.fulfill({ json: { items, total: items.length, hasMore: false } });
      }
      const match = pathname.match(/^\/api\/conversations\/(conv-\d+)$/);
      if (match) {
        if (mode === 'hold' && match[1] === 'conv-1') await new Promise((resolve) => { releaseHold = resolve; });
        if (mode === 'fail' && match[1] === 'conv-1') return route.fulfill({ status: 403, json: { error: 'forbidden' } });
        return route.fulfill({ json: {
          id: match[1], title: conversations.find((x) => x.id === match[1]).title,
          model: 'vision-1', mode: 'single', hasEarlier: false,
          messages: [
            { id: 'u1', role: 'user', content: sentinelFor(match[1]), model: null, groupId: null, streaming: false },
            { id: 'a1', role: 'assistant', content: '这是引用的回答正文。', model: 'vision-1', groupId: null, streaming: false },
          ],
        } });
      }
      if (pathname === '/api/chat') {
        const body = JSON.parse(request.postData() || '{}');
        payloads.push(body);
        const lastUser = body.messages?.[body.messages.length - 1]?.content || '';
        if (lastUser.includes('总结视频《测试视频》')) {
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Expose-Headers': 'X-Conversation-Id, X-Conversation-Title',
              'X-Conversation-Id': 'conv-summary',
              'X-Conversation-Title': encodeURIComponent('测试视频摘要'),
            },
            body:
              'data: {"type":"text-delta","delta":"一句话结论：测试视频摘要。"}\n\n' +
              'data: {"type":"text-delta","delta":"\\n\\n## 章节\\n- 第1点\\n- 第2点"}\n\n' +
              'data: [DONE]\n\n',
          });
        }
        return route.fulfill({ status: 503, json: { error: 'Test intercepted: no server writes' } });
      }
      return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    });

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: `http://127.0.0.1:${PORT}`,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(BASE);
    const input = page.locator('#input');
    const panel = page.locator('#shortcutPanel');
    const search = page.locator('#shortcutSearchInput');
    const group = (id) => page.locator(`[data-group-toggle="${id}"]`);
    const item = (id) => page.locator(`[data-shortcut-id="${id}"]`);
    const chip = (title) => page.locator('.reference-chip-label', { hasText: title });
    await input.waitFor();

    const emptyState = await page.evaluate(async () => {
      const app = document.querySelector('.app');
      const h1 = document.querySelector('.empty-state h1');
      const suggest = document.querySelector('.composer-suggest');
      const composer = document.querySelector('#composer');
      const stars = [...document.querySelectorAll('.star')];
      const title = h1.textContent;
      return {
        isEmpty: app.classList.contains('is-empty'),
        aura: getComputedStyle(document.querySelector('.empty-aura')).display,
        background: getComputedStyle(app).backgroundImage,
        scene: document.querySelectorAll('.scene-light').length,
        depths: document.querySelectorAll('.depth').length,
        orbs: document.querySelectorAll('.orb').length,
        stars: stars.length,
        shoots: document.querySelectorAll('.shoot').length,
        starDuration: getComputedStyle(stars[0]).animationDuration,
        h1: title,
        h1Chars: h1.querySelectorAll('.char').length,
        h1Label: h1.getAttribute('aria-label'),
        h1Family: getComputedStyle(h1).fontFamily,
        h1Weight: getComputedStyle(h1).fontWeight,
        serifLoaded: (await document.fonts.load('500 20px "Noto Serif SC UL"', title)).length > 0,
        pillCount: suggest ? suggest.querySelectorAll('.suggest-pill').length : 0,
        pillRadius: suggest ? getComputedStyle(suggest.querySelector('.suggest-pill')).borderRadius : '',
        pillsAboveInput: suggest && composer ? suggest.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top : false,
        topbarBorder: getComputedStyle(document.querySelector('.topbar')).borderBottomWidth,
        oldEmptyBlocks: document.querySelectorAll('.empty-state .empty-lede, .empty-state .empty-actions, .empty-state .empty-kbd').length,
      };
    });
    assert.equal(emptyState.isEmpty, true);
    assert.equal(emptyState.aura, 'block');
    assert.match(emptyState.background, /linear-gradient/);
    assert.equal(emptyState.scene, 1);
    assert.equal(emptyState.depths, 3);
    assert.equal(emptyState.orbs, 2);
    assert.equal(emptyState.stars, 9);
    assert.equal(emptyState.shoots, 2);
    assert.ok(parseFloat(emptyState.starDuration) > 0);
    assert.equal(emptyState.h1, '陪你跨越星海，探索一切未知');
    assert.equal(emptyState.h1Chars, 13);
    assert.equal(emptyState.h1Label, emptyState.h1);
    assert.ok(emptyState.h1Family.includes('Noto Serif SC UL'), emptyState.h1Family);
    assert.equal(emptyState.h1Weight, '500');
    assert.equal(emptyState.serifLoaded, true, 'Noto Serif SC UL subset not loaded');
    assert.equal(emptyState.pillCount, 2);
    assert.equal(emptyState.pillRadius, '999px');
    assert.equal(emptyState.pillsAboveInput, true);
    assert.equal(emptyState.topbarBorder, '0px');
    assert.equal(emptyState.oldEmptyBlocks, 0);
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-empty-light.png', animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-empty-dark.png', animations: 'disabled' });
    await page.evaluate(() => {
      const el = document.getElementById('toast');
      el.textContent = '已打开 · Two Power Banks Charging Case 超长标题用于验证通知条不折行';
      el.title = el.textContent;
      el.hidden = false;
    });
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-toast-empty-dark.png', animations: 'disabled' });
    await page.evaluate(() => { document.getElementById('toast').hidden = true; });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(
      () => document.querySelectorAll('.empty-state h1 .char.is-dim').length === 1,
      null,
      { timeout: 6000 }
    );
    const dimMin = await page.evaluate(() => new Promise((resolve) => {
      let min = 1;
      const timer = setInterval(() => {
        const el = document.querySelector('.empty-state h1 .char.is-dim');
        if (el) min = Math.min(min, Number(getComputedStyle(el).opacity));
      }, 16);
      setTimeout(() => {
        clearInterval(timer);
        resolve(min);
      }, 6000);
    }));
    assert.ok(dimMin < 0.7, `dim min ${dimMin}`);
    await page.waitForFunction(
      () => document.querySelectorAll('.empty-state h1 .char.is-lit').length === 1,
      null,
      { timeout: 6000 }
    );
    assert.equal(await page.evaluate(() => document.querySelectorAll('.empty-state h1 .char.is-lit').length), 1);
    ok('空态 v2：渐变/景深/星芒/思源宋/胶囊/单字闪烁');

    await input.fill('/');
    await panel.waitFor();
    assert.deepEqual(await page.locator('[data-group-toggle]').evaluateAll((nodes) => nodes.map((n) => n.dataset.groupToggle)), ['action', 'conversation']);
    assert.equal(await page.locator('.shortcut-item[data-shortcut-kind="action"]').first().innerText().then((t) => t.includes('深度思考')), true);
    const geometry = await page.evaluate(() => {
      const stack = document.querySelector('.composer-stack').getBoundingClientRect();
      const pop = document.querySelector('#shortcutPanel').getBoundingClientRect();
      return { gap: stack.top - pop.bottom, widthRatio: pop.width / stack.width, leftGap: pop.left - stack.left, rightGap: stack.right - pop.right, top: pop.top, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    assert.ok(Math.abs(geometry.gap) < 1.5, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.widthRatio - 0.9) < 0.01, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.leftGap - geometry.rightGap) < 1, JSON.stringify(geometry));
    assert.ok(geometry.top >= 0 && geometry.overflow <= 0, JSON.stringify(geometry));
    ok('/ 打开操作优先面板，90% 居中且不越界');

    await search.fill('思考');
    assert.equal(await input.inputValue(), '/');
    assert.equal(await page.locator('.shortcut-item[data-shortcut-kind="action"]').count(), 1);
    await search.fill('');
    await expectCount(page.locator('.shortcut-item[data-shortcut-kind="action"]'), 5);
    ok('面板内搜索只筛选项，不改正文');

    await group('action').click();
    await page.waitForTimeout(50);
    assert.equal(await item('action:think').isVisible(), false);
    const bodyDuration = await page.locator('[data-group-toggle="action"]').evaluate((node) => getComputedStyle(node.parentElement.querySelector('.shortcut-body')).transitionDuration);
    assert.ok(parseFloat(bodyDuration) > 0, bodyDuration);
    ok('分组折叠带伸缩过渡，标题可点击');
    await group('action').click();

    await input.fill('@');
    await item('conversation:conv-1').waitFor();
    assert.equal(await page.locator('[data-shortcut-id]').first().getAttribute('data-shortcut-kind'), 'conversation');
    ok('@ 打开历史会话优先面板');

    await item('conversation:conv-1').click();
    await chip('快捷入口测试资料').waitFor();
    assert.equal(await input.inputValue(), '');
    await page.waitForFunction(() => !document.querySelector('#sendBtn').disabled);
    assert.equal(await page.locator('#sendBtn').isEnabled(), true);
    ok('选择历史会话后生成真实引用标签');

    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#messages .msg.user').length > 0);
    await page.waitForTimeout(100);
    assert.equal(payloads.length, 1);
    const payload = JSON.stringify(payloads[0]);
    assert.ok(payload.includes('REFERENCE\\\\_BODY\\\\_CONV\\\\_1\\\\_739'), payload);
    assert.ok(payload.includes('请基于以上引用资料回答'));
    assert.ok(payload.includes('引用资料 1'));
    ok('发送载荷包含引用正文与本次正文，网络已拦截');
    assert.equal(await page.locator('.reference-chip').count(), 0);

    for (const id of ['conv-1', 'conv-2', 'conv-3']) {
      await input.fill('@');
      await item(`conversation:${id}`).waitFor();
      await item(`conversation:${id}`).click();
      await page.waitForFunction((count) => document.querySelectorAll('.reference-chip').length === count, ['conv-1', 'conv-2', 'conv-3'].indexOf(id) + 1);
    }
    await input.fill('@');
    await item('conversation:conv-4').waitFor();
    await item('conversation:conv-4').click();
    await page.locator('#shortcutStatus').waitFor();
    assert.match(await page.locator('#shortcutStatus').innerText(), /最多引用 3 个会话/);
    ok('第 4 个引用在面板内提示上限');
    while (await page.locator('.reference-chip button[data-remove-reference]').count()) {
      await page.locator('.reference-chip button[data-remove-reference]').first().click();
    }
    assert.equal(await page.locator('.reference-chip').count(), 0);

    mode = 'hold';
    await input.fill('@');
    await item('conversation:conv-1').waitFor();
    await item('conversation:conv-1').click();
    await page.locator('[data-cancel-reference]').waitFor();
    assert.equal(await page.locator('#sendBtn').isDisabled(), true);
    await page.locator('[data-cancel-reference]').click();
    await page.waitForTimeout(50);
    if (releaseHold) releaseHold();
    mode = 'ok';
    await page.waitForTimeout(80);
    assert.equal(await page.locator('.reference-chip').count(), 0);
    ok('读取引用期间禁发，可取消');

    await input.fill('/think');
    await item('action:think').waitFor();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#moreDeepState').textContent === '关');
    assert.equal(await panel.isVisible(), false);
    assert.equal(await input.inputValue(), '');
    ok('键盘 Enter 执行操作、关闭面板并还原正文');

    mode = 'fail';
    await input.fill('@');
    await item('conversation:conv-1').waitFor();
    await item('conversation:conv-1').click();
    await page.waitForFunction(() => /forbidden|没有权限|登录已失效|失败/.test(document.querySelector('#toast').textContent));
    const toastText = await page.locator('#toast').innerText();
    assert.equal(await page.locator('#toast').getAttribute('title'), toastText);
    mode = 'ok';
    ok('引用失败给出可读提示');

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => {
      const el = document.getElementById('toast');
      el.textContent = '已打开 · Two Power Banks Charging Case 超长标题用于验证通知条不折行';
      el.hidden = false;
    });
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-toast-long.png', animations: 'disabled' });
    const toastBox = await page.evaluate(() => {
      const el = document.getElementById('toast');
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        whiteSpace: cs.whiteSpace,
        overflow: cs.overflow,
        textOverflow: cs.textOverflow,
        background: cs.backgroundColor,
        backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
        height: rect.height,
        lineHeight: parseFloat(cs.lineHeight),
        width: rect.width,
        viewport: window.innerWidth,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });
    assert.equal(toastBox.whiteSpace, 'nowrap');
    assert.equal(toastBox.overflow, 'hidden');
    assert.equal(toastBox.textOverflow, 'ellipsis');
    assert.ok(toastBox.height <= toastBox.lineHeight + 20, JSON.stringify(toastBox));
    assert.ok(toastBox.width > toastBox.viewport * 0.55, JSON.stringify(toastBox));
    assert.ok(toastBox.width <= toastBox.viewport - 31, JSON.stringify(toastBox));
    assert.ok(toastBox.scrollWidth > toastBox.clientWidth, JSON.stringify(toastBox));
    const srgbMatch = toastBox.background.match(
      /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\)/
    );
    const rgbaMatch = toastBox.background.match(/rgba?\(([^)]+)\)/);
    let toastRgb = [];
    let toastAlpha = 1;
    if (srgbMatch) {
      toastRgb = srgbMatch.slice(1, 4).map(Number);
      toastAlpha = Number(srgbMatch[4]);
    } else if (rgbaMatch) {
      const parts = rgbaMatch[1].split(',').map(Number);
      toastRgb = parts.slice(0, 3).map((v) => v / 255);
      toastAlpha = parts.length === 4 ? parts[3] : 1;
    }
    assert.ok(toastRgb.length === 3, toastBox.background);
    assert.ok(toastAlpha > 0 && toastAlpha < 1, toastBox.background);
    assert.ok(toastRgb.every((v) => v < 0.3), toastBox.background);
    assert.match(toastBox.backdrop, /blur\(20px\)/, toastBox.backdrop);
    ok('通知条长文本单行省略，深色下为黑色毛玻璃');
    await page.evaluate(() => { document.getElementById('toast').hidden = true; });
    await page.emulateMedia({ colorScheme: 'light' });

    await input.fill('/');
    await panel.waitFor();
    await page.locator('#shortcutSearchInput').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(30);
    assert.equal(await panel.isVisible(), false);
    ok('Esc 关闭面板');

    await input.fill('/');
    await panel.waitFor();
    await page.locator('.topbar').click({ position: { x: 12, y: 12 } });
    await page.waitForTimeout(30);
    assert.equal(await panel.isVisible(), false);
    ok('点击面板外关闭');

    await input.fill('mail@example.com');
    await page.waitForTimeout(30);
    assert.equal(await panel.isVisible(), false);
    ok('邮箱不误触');

    await input.fill('/');
    await panel.waitFor();
    await page.locator('#shortcutSearchInput').fill('不存在的关键词');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.shortcut-state').filter({ hasText: '没有匹配项' }).count() > 0, true);
    await page.keyboard.press('Enter');
    assert.equal(await panel.isVisible(), true);
    ok('无结果 Enter 不发送也不误关');

    await page.locator('#closeShortcutBtn').click();
    await input.fill('');
    await page.setViewportSize({ width: 360, height: 640 });
    await page.locator('#historyBtn').click();
    await page.locator('#historySheet').waitFor();
    await page.locator('.history-load').first().click();
    await page.waitForFunction(() =>
      /这是引用的回答正文/.test(
        document.querySelector('.msg.assistant .assistant-content')?.textContent || ''
      )
    );
    assert.equal(await page.evaluate(() => document.querySelector('.app').classList.contains('is-empty')), false);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.empty-aura')).display), 'none');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.composer-suggest')).display), 'none');
    ok('进入对话后空态背景与胶囊自动收起');
    const contextMenu = page.locator('#contextMenu');
    const assistant = page.locator('.msg.assistant .assistant-content');
    await assistant.click({ button: 'right' });
    await contextMenu.waitFor();
    const menuGlass = await contextMenu.evaluate((menu) => ({
      blur: getComputedStyle(menu).backdropFilter,
      bg: getComputedStyle(menu).backgroundColor,
    }));
    assert.match(menuGlass.blur, /blur/);
    assert.notEqual(menuGlass.bg, 'rgb(255, 255, 255)');
    for (const label of ['复制全文', '引用这条回答', '存入错题本', '打开网页会话']) {
      assert.equal(
        await contextMenu.getByRole('menuitem', { name: label }).count(),
        1,
        label
      );
    }
    const box = await contextMenu.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 360 && box.y + box.height <= 640, JSON.stringify(box));
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-context-menu.png', animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-context-menu-dark.png', animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'light' });
    await contextMenu.getByRole('menuitem', { name: '引用这条回答' }).click();
    assert.equal(await contextMenu.isVisible(), false);
    const quoted = await input.inputValue();
    assert.ok(quoted.startsWith('关于你刚才的回答：'), quoted);
    assert.ok(quoted.includes('> 这是引用的回答正文。'), quoted);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'input');
    ok('回答区右键：引用整条回答并聚焦输入框');
    await input.fill('');

    await assistant.click({ button: 'right' });
    await contextMenu.waitFor();
    const firstItem = await page.evaluate(() => document.activeElement?.textContent || '');
    await page.keyboard.press('ArrowDown');
    const secondItem = await page.evaluate(() => document.activeElement?.textContent || '');
    assert.notEqual(firstItem, secondItem);
    await page.keyboard.press('Escape');
    assert.equal(await contextMenu.isVisible(), false);
    ok('右键菜单支持方向键与 Esc');

    const selectedText = await assistant.evaluate((el) => {
      const paragraph = el.querySelector('p') || el;
      const textNode = paragraph.firstChild;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(6, textNode.textContent.length));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const selected = selection.toString();
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 12,
          clientY: rect.top + 12,
        })
      );
      return selected;
    });
    await contextMenu.waitFor();
    assert.equal(selectedText, '这是引用的回');
    assert.equal(await contextMenu.getByRole('menuitem', { name: '引用这条回答' }).count(), 0);
    await contextMenu.getByRole('menuitem', { name: '复制选中' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '这是引用的回');
    ok('选中文字右键：复制选中');

    await assistant.evaluate((el) => {
      const paragraph = el.querySelector('p') || el;
      const textNode = paragraph.firstChild;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(6, textNode.textContent.length));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 12,
          clientY: rect.top + 12,
        })
      );
    });
    await contextMenu.waitFor();
    await contextMenu.getByRole('menuitem', { name: '就这段追问' }).click();
    const asked = await input.inputValue();
    assert.ok(asked.startsWith('> 这是引用的'), asked);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'input');
    ok('选中文字右键：就这段追问');
    await input.fill('');

    const selectAssistantText = () =>
      assistant.evaluate((el) => {
        const paragraph = el.querySelector('p') || el;
        const textNode = paragraph.firstChild;
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, Math.min(6, textNode.textContent.length));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
    const selectionBar = page.locator('#selectionBar');

    const answerParagraph = page.locator('.msg.assistant .assistant-content p').first();
    const paragraphBox = await answerParagraph.boundingBox();
    await page.mouse.move(paragraphBox.x + 2, paragraphBox.y + paragraphBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      paragraphBox.x + Math.min(90, paragraphBox.width - 4),
      paragraphBox.y + paragraphBox.height / 2,
      { steps: 12 }
    );
    await page.mouse.up();
    await selectionBar.waitFor();
    const draggedSelection = await page.evaluate(() =>
      window.getSelection().toString().trim()
    );
    assert.ok(draggedSelection.length > 0, draggedSelection);
    for (const label of ['追问', '解释', '复制']) {
      assert.equal(
        await selectionBar.getByRole('button', { name: label }).count(),
        1,
        label
      );
    }
    const barBox = await selectionBar.boundingBox();
    assert.ok(
      barBox.x >= 0 &&
        barBox.y >= 0 &&
        barBox.x + barBox.width <= 360 &&
        barBox.y + barBox.height <= 640,
      JSON.stringify(barBox)
    );
    await page.evaluate(() => { document.getElementById('toast').hidden = true; });
    await page.screenshot({
      path: 'public/tmp-shots/ask-aichatt-selection-bar.png',
      animations: 'disabled',
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({
      path: 'public/tmp-shots/ask-aichatt-selection-bar-dark.png',
      animations: 'disabled',
    });
    await page.emulateMedia({ colorScheme: 'light' });
    await selectionBar.getByRole('button', { name: '复制' }).click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      draggedSelection
    );
    assert.equal(await selectionBar.isVisible(), false);
    ok('鼠标拖选文字自动弹出操作条：复制');

    await selectAssistantText();
    await selectionBar.waitFor();
    await selectionBar.getByRole('button', { name: '追问' }).click();
    const selectedAsk = await input.inputValue();
    assert.ok(selectedAsk.startsWith('> 这是引用的'), selectedAsk);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'input');
    ok('选中文字自动弹出操作条：追问');
    await input.fill('');

    await selectAssistantText();
    await selectionBar.waitFor();
    await page.locator('[data-close-selection]').click();
    await page.waitForTimeout(300);
    assert.equal(await selectionBar.isVisible(), false);
    ok('回答区选中条可用 × 主动关闭');

    await selectAssistantText();
    await selectionBar.waitFor();
    await page.locator('.topbar').click({ position: { x: 6, y: 6 } });
    await page.waitForTimeout(150);
    assert.equal(await selectionBar.isVisible(), false);
    await page.waitForTimeout(300);
    assert.equal(await selectionBar.isVisible(), false);
    ok('点击别处关闭回答区选中条，不会被旧选区重新弹出');

    await page.locator('.msg.user .bubble').first().evaluate((el) => {
      const textNode = el.firstChild;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(4, textNode.textContent.length));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.waitForTimeout(120);
    assert.equal(await selectionBar.isVisible(), false);
    ok('用户消息选中不弹操作条');

    await page.locator('.msg.user').first().click({ button: 'right' });
    assert.equal(await contextMenu.isVisible(), false);
    await input.click({ button: 'right' });
    assert.equal(await contextMenu.isVisible(), false);
    ok('用户消息与输入框保留原生右键');

    await input.fill('/');
    await panel.waitFor();
    const small = await page.evaluate(() => {
      const pop = document.querySelector('#shortcutPanel').getBoundingClientRect();
      return { top: pop.top, height: pop.height, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    assert.ok(small.top >= 0 && small.height > 100 && small.overflow <= 0, JSON.stringify(small));
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-shortcuts-light.png', animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-shortcuts-dark.png', animations: 'disabled' });
    await page.setViewportSize({ width: 847, height: 800 });
    await page.evaluate(() => {
      document.querySelector('#syncText').textContent = '已同步 · 中上成绩如何突围';
      document.querySelector('#syncBar').hidden = false;
    });
    const glass = await page.evaluate(() => ({
      dock: getComputedStyle(document.querySelector('.session-dock')).backdropFilter,
      dockBg: getComputedStyle(document.querySelector('.session-dock')).backgroundColor,
      input: getComputedStyle(document.querySelector('#composer')).backdropFilter,
      inputBg: getComputedStyle(document.querySelector('#composer')).backgroundColor,
    }));
    assert.match(glass.dock, /blur/);
    assert.match(glass.input, /blur/);
    assert.notEqual(glass.dockBg, 'rgb(30, 30, 33)');
    assert.notEqual(glass.inputBg, 'rgb(32, 32, 36)');
    ok('同步卡片与输入框使用半透明毛玻璃');
    await page.locator('#closeShortcutBtn').click();
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-shortcuts-wide-closed.png', animations: 'disabled' });
    await input.fill('/');
    await panel.waitFor();
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-shortcuts-wide.png', animations: 'disabled' });
    await page.locator('#closeShortcutBtn').click();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-shortcuts-wide-light.png', animations: 'disabled' });
    ok('360px 窄面板布局与深浅色截图');

    await page.locator('#summarizeBtn').waitFor({ state: 'visible' });
    await input.fill('');
    await page.locator('#summarizeBtn').click();
    await page.waitForFunction(
      () => {
        const nodes = document.querySelectorAll('.msg.assistant .assistant-content');
        const last = nodes[nodes.length - 1];
        return last && /一句话结论/.test(last.textContent || '');
      },
      null,
      { timeout: 20000 }
    );
    assert.ok(quickCalls.length >= 2, `quick calls ${quickCalls.length}`);
    assert.equal(await page.locator('#summarySheet').isVisible(), false);
    assert.match(await page.locator('.msg.user .bubble').last().innerText(), /总结视频《测试视频》/);
    assert.match(await page.locator('#syncText').innerText(), /测试视频摘要/);
    await page.screenshot({ path: 'public/tmp-shots/ask-aichatt-summary-chat.png', animations: 'disabled' });
    ok('视频分段总结直接进入会话');

    await page.evaluate(() => { window.__subtitleMode = 'none'; });
    await page.locator('#summarizeBtn').click();
    await page.waitForFunction(
      () => /没有可提取/.test(
        [...document.querySelectorAll('.msg.assistant .assistant-content')].pop()?.textContent || ''
      ),
      null,
      { timeout: 8000 }
    );
    ok('无字幕时在会话里明确提示');

    await page.evaluate(() => {
      window.__subtitleMode = 'wrong-once';
      window.__subtitleCalls = 0;
    });
    await page.locator('#summarizeBtn').click();
    await page.waitForFunction(
      () => {
        const nodes = document.querySelectorAll('.msg.assistant .assistant-content');
        const last = nodes[nodes.length - 1];
        return last && /一句话结论/.test(last.textContent || '');
      },
      null,
      { timeout: 20000 }
    );
    assert.equal(await page.evaluate(() => window.__subtitleCalls), 2);
    ok('字幕轨错一次时自动重抓后成功');

    await page.evaluate(() => {
      window.__subtitleMode = 'empty-url-once';
      window.__subtitleCalls = 0;
    });
    await page.locator('#summarizeBtn').click();
    await page.waitForFunction(
      () => {
        const nodes = document.querySelectorAll('.msg.assistant .assistant-content');
        const last = nodes[nodes.length - 1];
        return last && /一句话结论/.test(last.textContent || '');
      },
      null,
      { timeout: 20000 }
    );
    assert.equal(await page.evaluate(() => window.__subtitleCalls), 2);
    ok('字幕地址为空（可重试）时自动重抓后成功');

    await page.evaluate(() => {
      window.__subtitleMode = 'wrong';
      window.__subtitleCalls = 0;
    });
    const summaryPayloadsBefore = payloads.length;
    await page.locator('#summarizeBtn').click();
    await page.waitForFunction(
      () => /连续 3 次抓取字幕失败/.test(
        [...document.querySelectorAll('.msg.assistant .assistant-content')].pop()?.textContent || ''
      ),
      null,
      { timeout: 12000 }
    );
    assert.equal(await page.evaluate(() => window.__subtitleCalls), 3);
    assert.equal(payloads.length, summaryPayloadsBefore);
    ok('连续错轨时拒绝生成错误摘要');

    const pendingSelection = {
      id: 'site-selection-restore-1',
      action: 'search',
      text: '网页上选中的一句话',
      ts: Date.now(),
    };
    const payloadsBeforePrefill = payloads.length;
    await page.evaluate((pending) => {
      window.__stubStore.aichattPendingSelection = pending;
      window.__dispatchRuntimeMessage({
        type: 'aichatt:selection-prefill',
        pending,
      });
    }, pendingSelection);
    await page.waitForFunction(
      () => document.querySelector('#input').value === '搜索：',
      null,
      { timeout: 4000 }
    );
    const selectionChip = page.locator('.reference-chip.is-selection');
    await selectionChip.waitFor();
    assert.match(await selectionChip.innerText(), /联网搜索 · 9 字/);
    await page.waitForTimeout(200);
    assert.equal(payloads.length, payloadsBeforePrefill);
    await selectionChip.click();
    await page.waitForTimeout(100);
    assert.equal(await selectionChip.isVisible(), false);
    assert.equal(await input.inputValue(), '');
    ok('全站选中文字加入引用 chip，不自动发送，点 chip 可移除');

    const pendingSelectionAgain = {
      ...pendingSelection,
      id: 'site-selection-restore-2',
    };
    await page.evaluate((pending) => {
      window.__stubStore.aichattPendingSelection = pending;
      window.__dispatchRuntimeMessage({
        type: 'aichatt:selection-prefill',
        pending,
      });
    }, pendingSelectionAgain);
    await page.waitForFunction(
      () => document.querySelector('#input').value === '搜索：',
      null,
      { timeout: 4000 }
    );
    await selectionChip.waitFor();
    const payloadsBeforeSelectionSend = payloads.length;
    await page.locator('#sendBtn').click();
    const selectionDeadline = Date.now() + 5000;
    while (
      payloads.length === payloadsBeforeSelectionSend &&
      Date.now() < selectionDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(payloads.length, payloadsBeforeSelectionSend + 1);
    const selectionPayload = JSON.stringify(payloads[payloads.length - 1]);
    assert.ok(selectionPayload.includes('搜索：'), selectionPayload);
    assert.ok(selectionPayload.includes('网页上选中的一句话'), selectionPayload);
    assert.equal(payloads[payloads.length - 1].webSearch, true);
    ok('选中文字随发送进入上下文，发送后清空');

    await page.locator('#moreBtn').click();
    await page.locator('#moreMenu').waitFor();
    assert.match(await page.locator('#moreSearchState').innerText(), /开/);
    assert.equal(
      await page.evaluate(() => window.__stubStore.settings.webSearch),
      true
    );
    await page.locator('#moreSearchBtn').click();
    await page.waitForFunction(
      () => document.querySelector('#moreSearchState').textContent === '关'
    );
    assert.equal(
      await page.evaluate(() => window.__stubStore.settings.webSearch),
      false
    );
    await page.locator('#moreSearchBtn').click();
    await page.waitForFunction(
      () => document.querySelector('#moreSearchState').textContent === '开'
    );
    assert.equal(
      await page.evaluate(() => window.__stubStore.settings.webSearch),
      true
    );
    const payloadsBeforeChatSearch = payloads.length;
    await input.fill('搜索一下今天的热点');
    await page.locator('#sendBtn').click();
    const chatSearchDeadline = Date.now() + 5000;
    while (
      payloads.length === payloadsBeforeChatSearch &&
      Date.now() < chatSearchDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(payloads.length, payloadsBeforeChatSearch + 1);
    const chatSearchBody = payloads[payloads.length - 1];
    assert.equal(chatSearchBody.webSearch, true);
    assert.equal(chatSearchBody.searchEngine, 'qianfan');
    ok('联网搜索默认开，可切换，发送时带上搜索引擎');

    await page.setViewportSize({ width: 360, height: 800 });
    await page.locator('#settingsBtn').click();
    await page.locator('#settingsSheet').waitFor();
    assert.equal(await page.locator('#webSearchInput').isChecked(), true);
    assert.equal(await page.locator('#searchEngineInput').inputValue(), 'qianfan');
    assert.equal(await page.locator('#searchEngineInput').isDisabled(), false);
    assert.equal(await page.locator('#selectionToolbarInput').isChecked(), false);
    await page.locator('#selectionToolbarInput').check();
    await page.waitForTimeout(100);
    await page.locator('#selectionToolbarInput').uncheck();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#selectionToolbarInput').isChecked(), false);
    ok('设置页划词工具条默认关闭且可切换');
    await page.locator('#webSearchInput').uncheck();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#searchEngineInput').isDisabled(), true);
    await page.screenshot({
      path: 'public/tmp-shots/ask-aichatt-settings-search-off.png',
      animations: 'disabled',
    });
    await page.locator('#webSearchInput').check();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#searchEngineInput').isDisabled(), false);
    await page.screenshot({
      path: 'public/tmp-shots/ask-aichatt-settings-search-on.png',
      animations: 'disabled',
    });
    await page.locator('#closeSettingsBtn').click();
    ok('设置页联网搜索与搜索引擎行联动');

    assert.equal(errors.length, 0, errors.join('\n'));
    ok('无浏览器运行时错误');
    console.log(JSON.stringify({ passed: passed.length, payloadCount: payloads.length }, null, 2));
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

async function expectCount(locator, count) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await locator.count()) === count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await locator.count(), count);
}
