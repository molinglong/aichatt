// Real Chromium history + the production hook; only React/Next mounting is stubbed.
// Run: node scripts/verify-overlay-back.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, after } = require('node:test')
const ts = require('typescript')
const { chromium } = require('@playwright/test')

const source = fs.readFileSync(path.join(__dirname, '../src/hooks/useBackToClose.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const browserPromise = chromium.launch({ args: ['--mute-audio'] })
after(async () => (await browserPromise).close())

async function fixture(run) {
  const context = await (await browserPromise).newContext()
  try {
    const page = await context.newPage()
    await page.route('http://overlay-back.test/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<button id="open">Open settings</button><main>Home</main>',
    }))
    await page.goto('http://overlay-back.test/home')
    await page.evaluate(code => {
      const exports = {}
      const overlays = new Map()
      let effects = []
      let pushCount = 0
      let backCount = 0
      let forwardCount = 0
      const originalPush = history.pushState.bind(history)
      const originalBack = history.back.bind(history)
      const originalForward = history.forward.bind(history)
      history.pushState = (...args) => { pushCount++; originalPush(...args) }
      history.back = () => { backCount++; originalBack() }
      history.forward = () => { forwardCount++; originalForward() }
      const router = { replace: url => history.replaceState({ __NA: true }, '', url) }
      const require = name => name === 'react' ? {
        useRef: current => ({ current }),
        useCallback: callback => callback,
        useEffect: effect => effects.push(effect),
      } : { useRouter: () => router }
      new Function('require', 'exports', code)(require, exports)
      history.replaceState({ __NA: true, tree: 'preserved' }, '')
      window.__pageMarker = 'alive'
      window.probe = {
        depth: 1,
        mount(name, depth = 1) {
          effects = []
          const overlay = { depth, backs: 0, cleanup: null, navigate: null }
          overlays.set(name, overlay)
          const result = exports.useBackToClose(true, () => {
            overlay.backs++
            if (overlay.depth > 1) { overlay.depth--; return false }
            // Settings uses an exit animation before its effect cleanup.
            setTimeout(() => window.probe.close(name), 50)
          })
          overlay.navigate = result.navigate
          overlay.cleanup = effects[0]()
        },
        close(name) {
          const overlay = overlays.get(name)
          overlay?.cleanup?.()
          overlays.delete(name)
        },
        navigate(name, url) { overlays.get(name).navigate(url) },
        state() {
          return {
            overlays: [...overlays].map(([name, o]) => ({ name, depth: o.depth, backs: o.backs })),
            token: history.state?.aichattOverlayBackToken ?? null,
            tree: history.state?.tree,
            pushCount, backCount, forwardCount,
            marker: window.__pageMarker,
            pathname: location.pathname,
          }
        },
      }
      document.querySelector('#open').onclick = () => window.probe.mount('settings', window.probe.depth)
    }, compiled)
    await run(page)
  } finally {
    await context.close()
  }
}
const state = page => page.evaluate(() => window.probe.state())
async function open(page, depth) {
  await page.evaluate(depth => { window.probe.depth = depth }, depth)
  await page.locator('#open').click()
  return state(page)
}
async function back(page) {
  await page.evaluate(() => history.back())
}
async function settledClosed(page) {
  await page.waitForFunction(() => {
    const s = window.probe.state()
    return s.overlays.length === 0 && s.token === null
  })
  const s = await state(page)
  assert.equal(s.pathname, '/home')
  assert.equal(s.marker, 'alive')
  assert.equal(s.tree, 'preserved')
}

test('level one back closes settings without leaving home', () => fixture(async page => {
  await open(page, 1)
  await back(page)
  await settledClosed(page)
}))

for (const depth of [2, 3]) {
  test(`${depth} levels: restore the original sentinel, then close on the last back`, () => fixture(async page => {
    const initial = await open(page, depth)
    for (let remaining = depth - 1; remaining >= 1; remaining--) {
      await back(page)
      await page.waitForFunction(remaining => {
        const s = window.probe.state()
        return s.overlays[0]?.depth === remaining && s.token !== null
      }, remaining)
      const s = await state(page)
      assert.equal(s.token, initial.token, 'must reuse the activated sentinel, not push another entry in popstate')
      assert.equal(s.pushCount, initial.pushCount, 'internal back must not recreate history entries')
      assert.equal(s.overlays[0].backs, depth - remaining, 'restore popstate must not close another level')
      assert.equal(s.tree, 'preserved')
    }
    await back(page)
    await settledClosed(page)
  }))
}

test('stacked overlays restore the shared sentinel for the lower overlay', () => fixture(async page => {
  const initial = await open(page, 1)
  await page.evaluate(() => window.probe.mount('dialog'))
  await back(page)
  await page.waitForFunction(() => {
    const s = window.probe.state()
    return s.overlays.length === 1 && s.token !== null
  })
  const s = await state(page)
  assert.equal(s.token, initial.token)
  assert.equal(s.overlays[0].name, 'settings')
  assert.equal(s.overlays[0].backs, 0)
  await back(page)
  await settledClosed(page)
}))

test('manual close consumes the sentinel exactly once', () => fixture(async page => {
  await open(page, 1)
  await page.evaluate(() => window.probe.close('settings'))
  await settledClosed(page)
  assert.equal((await state(page)).backCount, 1)
}))

test('handoff in the same tick shares one entry', () => fixture(async page => {
  const initial = await open(page, 1)
  await page.evaluate(() => {
    window.probe.close('settings')
    window.probe.mount('drawer')
  })
  assert.equal((await state(page)).pushCount, initial.pushCount)
  await back(page)
  await settledClosed(page)
}))

test('close while forward restoration is pending leaves no orphan sentinel', () => fixture(async page => {
  await open(page, 2)
  await page.evaluate(() => {
    const forward = history.forward.bind(history)
    history.forward = () => {
      window.probe.close('settings')
      setTimeout(forward, 30)
    }
  })
  await back(page)
  await page.waitForFunction(() => window.probe.state().forwardCount === 1)
  await settledClosed(page)
}))

test('overlay navigation replaces the entry without rolling back the destination', () => fixture(async page => {
  await open(page, 1)
  await page.evaluate(() => window.probe.navigate('settings', '/conversation'))
  await page.waitForFunction(() => window.probe.state().overlays.length === 0)
  const s = await state(page)
  assert.equal(s.pathname, '/conversation')
  assert.equal(s.token, null)
  assert.equal(s.backCount, 0)
}))

test('new overlay during restoration cannot truncate the forward entry', () => fixture(async page => {
  const initial = await open(page, 2)
  await page.evaluate(() => {
    const forward = history.forward.bind(history)
    history.forward = () => {
      window.probe.mount('dialog')
      setTimeout(forward, 30)
    }
  })
  await back(page)
  await page.waitForFunction(() => window.probe.state().forwardCount === 1 && window.probe.state().token !== null)
  const s = await state(page)
  assert.equal(s.token, initial.token)
  assert.equal(s.pushCount, initial.pushCount)
  assert.equal(s.overlays.length, 2)
  assert.equal(s.overlays[1].backs, 0)
}))

test('navigation during restoration waits for the sentinel instead of replacing home', () => fixture(async page => {
  await open(page, 2)
  await page.evaluate(() => {
    const forward = history.forward.bind(history)
    history.forward = () => {
      window.probe.navigate('settings', '/conversation')
      // Cleanup completes first, exercising deferred navigation flag cleanup too.
      setTimeout(forward, 100)
    }
  })
  await back(page)
  await page.waitForFunction(() => location.pathname === '/conversation' && window.probe.state().overlays.length === 0)
  assert.equal((await state(page)).token, null)
  await back(page)
  await page.waitForFunction(() => location.pathname === '/home')
  assert.equal((await state(page)).marker, 'alive')
}))

test('missing forward acknowledgement cannot permanently block future overlays', () => fixture(async page => {
  await open(page, 2)
  await page.evaluate(() => {
    history.forward = () => {
      // Model an external navigation cancelling the pending traversal.
      window.probe.navigate('settings', '/conversation')
    }
  })
  await back(page)
  await page.waitForFunction(() => location.pathname === '/conversation' && window.probe.state().overlays.length === 0)
  await open(page, 1)
  assert.notEqual((await state(page)).token, null, 'timeout must release the global restoration lock')
  await back(page)
  await page.waitForFunction(() => window.probe.state().overlays.length === 0 && window.probe.state().token === null)
  assert.equal((await state(page)).pathname, '/conversation')
}))
