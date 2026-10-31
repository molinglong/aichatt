const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const CODE = fs.readFileSync(
  path.join(__dirname, '..', 'browser-extension', 'content.js'),
  'utf8'
);

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
  };
}

function createHarness(options) {
  let listener = null;
  const calls = [];
  const subtitles = options.subtitles || [];
  const subtitleBody = options.subtitleBody || { body: [] };

  const sandbox = {
    window: {},
    document: {
      title: '测试视频',
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    location: { href: 'https://www.bilibili.com/video/BV1TEST' },
    chrome: {
      runtime: {
        id: 'test-extension',
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
    },
    URL,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/x/web-interface/view')) {
        if (options.viewCode) {
          return jsonResponse({ code: options.viewCode, message: 'view failed' });
        }
        return jsonResponse({
          code: 0,
          data: {
            aid: 1,
            cid: 2,
            title: '测试视频',
            duration: 540,
            pages: [{ cid: 2, duration: 540 }],
          },
        });
      }
      if (String(url).includes('/x/player/v2')) {
        if (options.playerCode) {
          return jsonResponse({
            code: options.playerCode,
            message: options.playerMessage || 'player failed',
          });
        }
        return jsonResponse({
          code: 0,
          data: {
            need_login_subtitle: Boolean(options.needLogin),
            subtitle: { subtitles },
          },
        });
      }
      if (options.subtitleHtml) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'text/html; charset=utf-8' },
          json: async () => {
            throw new Error('not json');
          },
        };
      }
      if (options.subtitleBody) {
        return jsonResponse(options.subtitleBody);
      }
      return jsonResponse(subtitleBody);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'content.js' });

  return {
    calls,
    extract: () =>
      new Promise((resolve) => {
        assert.equal(typeof listener, 'function', 'message listener registered');
        listener({ type: 'aichatt:extract-subtitles' }, null, resolve);
      }),
  };
}

const validBody = {
  body: [
    { from: 0, to: 5, content: '第一句字幕' },
    { from: 5, to: 540, content: '第二句字幕' },
  ],
};

(async () => {
  {
    const harness = createHarness({
      subtitles: [
        { lan: 'ai-zh', subtitle_url: '' },
        { lan: 'zh-CN', subtitle_url: '//example.test/subtitle.json' },
      ],
      subtitleBody: validBody,
    });
    const result = await harness.extract();
    assert.equal(result.ok, true);
    assert.equal(result.lan, 'zh-CN');
    assert.equal(result.items.length, 2);
    assert.equal(result.duration, 540);
    assert.ok(
      harness.calls.some((url) => url === 'https://example.test/subtitle.json'),
      harness.calls.join('\n')
    );
    console.log('PASS 跳过地址为空的 AI 字幕，改用有效 CC 字幕');
  }

  {
    const harness = createHarness({
      subtitles: [{ lan: 'ai-zh', subtitle_url: '   ' }],
    });
    const result = await harness.extract();
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error, /地址为空/);
    console.log('PASS 全部字幕地址为空时标记为可重试');
  }

  {
    const harness = createHarness({
      subtitles: [],
      needLogin: false,
    });
    const result = await harness.extract();
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error, /没有可提取/);
    console.log('PASS 确实无字幕时不重试');
  }

  {
    const harness = createHarness({
      subtitles: [{ lan: 'zh-CN', subtitle_url: '//example.test/subtitle.json' }],
      subtitleHtml: true,
    });
    const result = await harness.extract();
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error, /接口返回异常/);
    console.log('PASS B 站返回 HTML/风控时标记为可重试');
  }

  {
    const harness = createHarness({
      playerCode: -412,
      playerMessage: '请求被拦截',
    });
    const result = await harness.extract();
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    console.log('PASS 字幕接口风控码标记为可重试');
  }

  {
    const harness = createHarness({
      subtitles: [{ lan: 'ai-zh', subtitle_url: '//example.test/subtitle.json' }],
      subtitleBody: { body: [] },
    });
    const result = await harness.extract();
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error, /字幕内容为空/);
    console.log('PASS 字幕内容为空时标记为可重试');
  }

  console.log(JSON.stringify({ passed: 6 }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
