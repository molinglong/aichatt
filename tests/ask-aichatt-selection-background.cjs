const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const CODE = fs.readFileSync(
  path.join(__dirname, '..', 'browser-extension', 'background.js'),
  'utf8'
);

function createHarness(options = {}) {
  const events = [];
  const store = {};
  let messageListener = null;
  let panelReady = Boolean(options.panelOpen);
  let openFails = Boolean(options.openFails);

  const chrome = {
    sidePanel: {
      setPanelBehavior: () => Promise.resolve(),
      open: ({ windowId }) => {
        events.push(['open', windowId]);
        if (openFails) return Promise.reject(new Error('no gesture'));
        return Promise.resolve();
      },
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => { messageListener = fn; } },
      sendMessage: (message) => {
        events.push(['send', message.type]);
        if (!panelReady) {
          return Promise.reject(new Error('receiving end does not exist'));
        }
        return Promise.resolve({ ok: true });
      },
    },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
      session: {
        get: (key) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (value) => {
          events.push(['set', Object.keys(value)[0]]);
          Object.assign(store, value);
          return Promise.resolve();
        },
        remove: (key) => {
          delete store[key];
          return Promise.resolve();
        },
      },
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve({ ok: true }),
      captureVisibleTab: () => Promise.resolve('data:image/png;base64,'),
    },
    scripting: { executeScript: () => Promise.resolve() },
    contextMenus: {
      removeAll(cb) { if (cb) cb(); },
      create() {},
      onClicked: { addListener() {} },
    },
    commands: { onCommand: { addListener() {} } },
    action: {
      setBadgeBackgroundColor: () => Promise.resolve(),
      setBadgeText: () => Promise.resolve(),
    },
    windows: {},
  };

  const sandbox = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    URL,
    fetch: () => Promise.resolve(new Response('', { status: 200 })),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Uint8Array,
    ArrayBuffer,
    Blob,
    Response,
    TextDecoder,
    TextEncoder,
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'background.js' });
  assert.equal(typeof messageListener, 'function');

  return {
    events,
    store,
    dispatch(message, sender = { tab: { windowId: 7 } }) {
      return new Promise((resolve) => {
        const returned = messageListener(message, sender, resolve);
        if (returned !== true) resolve(undefined);
      });
    },
  };
}

(async () => {
  {
    const h = createHarness({ panelOpen: false });
    const response = await h.dispatch({
      type: 'aichatt:selection-action',
      action: 'search',
      text: '  网页上选中的一段文字  ',
    });
    assert.equal(response.ok, true);
    assert.equal(response.delivered, false);
    assert.equal(response.opened, true);
    assert.deepEqual(h.events[0], ['open', 7]);
    assert.equal(h.events[1][0], 'set');
    assert.equal(h.events.filter((e) => e[0] === 'send').length, 3);
    const pending = h.store.aichattPendingSelection;
    assert.equal(pending.action, 'search');
    assert.equal(pending.text, '网页上选中的一段文字');
    console.log('PASS sidePanel.open 先于 await，未送达时重试并落 storage');
  }

  {
    const h = createHarness({ panelOpen: true });
    const response = await h.dispatch({
      type: 'aichatt:selection-action',
      action: 'summarize',
      text: '选中内容',
    });
    assert.equal(response.ok, true);
    assert.equal(response.delivered, true);
    assert.equal(response.opened, true);
    assert.deepEqual(h.events.slice(0, 2), [
      ['open', 7],
      ['set', 'aichattPendingSelection'],
    ]);
    assert.equal(h.store.aichattPendingSelection.action, 'summarize');
    console.log('PASS 侧栏已开时直接送达');
  }

  {
    const h = createHarness({ panelOpen: false });
    const before = h.events.length;
    const response = await h.dispatch({
      type: 'aichatt:selection-action',
      action: 'ask',
      text: '   ',
    });
    assert.equal(response.ok, false);
    assert.equal(h.events.length, before);
    assert.equal(h.store.aichattPendingSelection, undefined);
    console.log('PASS 空选中不打开侧栏也不写 storage');
  }

  {
    const h = createHarness({ panelOpen: false, openFails: true });
    const response = await h.dispatch({
      type: 'aichatt:selection-action',
      action: 'explain',
      text: '选中内容',
    });
    assert.equal(response.ok, true);
    assert.equal(response.opened, false);
    assert.equal(h.store.aichattPendingSelection.text, '选中内容');
    console.log('PASS sidePanel.open 失败时不丢选中内容');
  }

  console.log(JSON.stringify({ passed: 4 }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
