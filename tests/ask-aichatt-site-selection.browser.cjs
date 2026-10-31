const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');

const ROOT = path.join(process.cwd(), 'browser-extension');
const PORT = 4191;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')
);
const passed = [];
const ok = (name) => {
  passed.push(name);
  console.log('PASS', name);
};

const pageHtml = (enabled) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
body { margin: 0; padding: 48px; font: 16px/1.8 sans-serif; color: #222; background: #fff; }
#target, #other { max-width: 620px; }
input { width: 320px; padding: 8px; }
</style></head><body>
<p id="target">这是网页上的一段选中文字，用来验证全站工具栏能否自动弹出。</p>
<p id="other">第二段文字，用来测试点击别处后工具栏收起。</p>
<input id="field" value="输入框里的文字不该触发工具栏" />
<script>
window.__sent = [];
window.__toolbarSetting = { settings: { selectionToolbar: ${enabled ? 'true' : 'false'} } };
window.chrome = {
  runtime: { id: 'test-extension', sendMessage: (m) => { window.__sent.push(m); return Promise.resolve({ ok: true, delivered: true }); } },
  storage: {
    local: { get: (_keys, cb) => { cb(window.__toolbarSetting); } },
    onChanged: { addListener: () => {} },
  },
};
</script>
<script src="/selection.js"></script>
</body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, ORIGIN);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml(url.searchParams.get('mode') !== 'off'));
      return;
    }
    if (url.pathname === '/selection.js') {
      try {
        const body = fs.readFileSync(path.join(ROOT, 'selection.js'));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  assert.ok(
    MANIFEST.content_scripts.some(
      (entry) =>
        entry.js.includes('selection.js') && entry.matches.includes('<all_urls>')
    )
  );
  assert.ok(MANIFEST.permissions.includes('clipboardWrite'));
  ok('manifest 已恢复全站注入与剪贴板权限');

  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(ORIGIN);

    const barState = () =>
      page.evaluate(() => {
        const host = document.getElementById('aichatt-selection-toolbar-host');
        const bar = host && host.shadowRoot && host.shadowRoot.querySelector('.bar');
        return {
          hidden: !bar || bar.hidden,
          labels: bar
            ? [...bar.querySelectorAll('button[data-action] span')].map((n) => n.textContent)
            : [],
        };
      });
    const dragSelect = async () => {
      const box = await page.locator('#target').boundingBox();
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 170, box.y + box.height / 2, { steps: 14 });
      await page.mouse.up();
      await page.waitForFunction(() => {
        const host = document.getElementById('aichatt-selection-toolbar-host');
        const bar = host && host.shadowRoot && host.shadowRoot.querySelector('.bar');
        return Boolean(bar && !bar.hidden);
      });
    };

    await dragSelect();
    const selected = await page.evaluate(() =>
      window.getSelection().toString().trim()
    );
    assert.ok(selected.length > 0);
    assert.deepEqual((await barState()).labels, [
      '搜索',
      '追问',
      '解释',
      '翻译',
      '总结',
      '复制',
    ]);
    ok('网页拖选文字自动浮出全站工具栏');

    await page.locator('button[data-action="copy"]').click();
    await page.waitForFunction(() =>
      document
        .getElementById('aichatt-selection-toolbar-host')
        ?.shadowRoot?.querySelector('button[data-action="copy"] span')
        ?.textContent === '已复制'
    );
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selected);
    ok('全站工具栏复制选中文字');

    await page.evaluate(() => window.getSelection().removeAllRanges());
    await dragSelect();
    await page.evaluate(() => {
      const duplicate = document.createElement('div');
      duplicate.id = 'aichatt-selection-toolbar-host';
      duplicate.dataset.fake = '1';
      document.body.appendChild(duplicate);
    });
    await page.locator('button[data-close-toolbar]').click();
    await page.waitForTimeout(300);
    assert.equal((await barState()).hidden, true);
    assert.equal(
      await page.evaluate(
        () => document.querySelectorAll('[id="aichatt-selection-toolbar-host"]').length
      ),
      0
    );

    await page.evaluate(() => {
      const el = document.getElementById('target');
      const range = document.createRange();
      range.setStart(el.firstChild, 0);
      range.setEnd(el.firstChild, 6);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.waitForTimeout(300);
    assert.equal((await barState()).hidden, true);
    ok('× 关闭后页面重设选区也不会重弹');

    await page.evaluate(() => window.getSelection().removeAllRanges());
    await dragSelect();
    await page.locator('#other').click();
    await page.waitForTimeout(300);
    assert.equal((await barState()).hidden, true);
    ok('点击别处关闭全站工具条');

    await page.evaluate(() => window.getSelection().removeAllRanges());
    await dragSelect();
    await page.locator('button[data-action="summarize"]').click();
    await page.waitForFunction(() => window.__sent.length === 1);
    const sent = await page.evaluate(() => window.__sent[0]);
    assert.equal(sent.type, 'aichatt:selection-action');
    assert.equal(sent.action, 'summarize');
    assert.ok(sent.text.includes('这是网页'));
    assert.equal((await barState()).hidden, true);
    ok('全站动作交给扩展并收起');

    await page.evaluate(() => window.getSelection().removeAllRanges());
    await dragSelect();
    await page.waitForTimeout(8600);
    assert.equal((await barState()).hidden, true);
    ok('8 秒无操作自动关闭');

    // 默认关闭（kill switch）：拖选不弹条，且残留旧版宿主被 observer 清掉
    const pageOff = await context.newPage();
    pageOff.on('pageerror', (err) => errors.push(`off-page: ${err.message}`));
    await pageOff.goto(`${ORIGIN}/?mode=off`);
    const offBox = await pageOff.locator('#target').boundingBox();
    await pageOff.mouse.move(offBox.x + 2, offBox.y + offBox.height / 2);
    await pageOff.mouse.down();
    await pageOff.mouse.move(offBox.x + 170, offBox.y + offBox.height / 2, { steps: 14 });
    await pageOff.mouse.up();
    await pageOff.waitForTimeout(400);
    assert.equal(
      await pageOff.evaluate(
        () => document.querySelectorAll('[id="aichatt-selection-toolbar-host"]').length
      ),
      0
    );
    const offSelected = await pageOff.evaluate(() => window.getSelection().toString().trim());
    assert.ok(offSelected.length > 0);
    await pageOff.evaluate(() => {
      const fake = document.createElement('div');
      fake.id = 'aichatt-selection-toolbar-host';
      fake.dataset.legacy = '1';
      document.body.appendChild(fake);
    });
    await pageOff.waitForFunction(
      () => document.querySelectorAll('[id="aichatt-selection-toolbar-host"]').length === 0,
      null,
      { timeout: 2000 }
    );
    await pageOff.close();
    ok('默认关闭：拖选不弹条且残留旧宿主被清除');

    assert.equal(errors.length, 0, errors.join('\n'));
    ok('无页面运行时错误');
    console.log(JSON.stringify({ passed: passed.length }, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
