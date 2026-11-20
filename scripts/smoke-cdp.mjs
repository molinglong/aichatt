/**
 * smoke-cdp.mjs — 深链冒烟 CDP 验证器(仅本机测试用,连 WebView2 --remote-debugging-port=9222)
 * 用法:
 *   node scripts/smoke-cdp.mjs check            列出页面目标 + 当前 DOM 快照
 *   node scripts/smoke-cdp.mjs login            用测试账号在 webview 内登录并软导航到 /chat
 *   node scripts/smoke-cdp.mjs wait-text <片段>  轮询直到输入框出现该片段,输出耗时与快照
 * 只读 DOM / 必要的一次登录 fetch,不做点击等批量交互。
 */
const PORT = 9222
const BASE = `http://127.0.0.1:${PORT}`
const t0 = Date.now()

function pickPage(targets) {
  const pages = targets.filter(
    (t) => t.type === 'page' && (t.url || '').startsWith('http://localhost:3456'),
  )
  const nonPet = pages.filter((t) => !/\/pet\b/.test(t.url))
  return (
    pages.find((t) => /^http:\/\/localhost:3456\/(chat\b|$|\?)/.test(t.url)) ||
    nonPet[0] ||
    pages[0] ||
    null
  )
}

let ws
let idc = 0
const pending = new Map()

function onWsMessage(ev) {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}

async function connect(maxMs = 15000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json()
      const page = pickPage(list)
      if (page?.webSocketDebuggerUrl) {
        const w = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          w.onopen = res
          w.onerror = () => rej(new Error('ws error'))
        })
        w.onmessage = onWsMessage
        return { ws: w, url: page.url, targets: list.length }
      }
    } catch {
      /* 9222 未就绪,继续等 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('NO_CDP_TARGET')
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++idc
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) {
    throw new Error('EVAL_FAIL: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
  }
  return r.result?.value
}

const SNAP_SRC = `(() => ({
  url: location.href,
  ready: document.readyState,
  input: document.querySelector('textarea') ? document.querySelector('textarea').value : null,
  hasShotName: document.body.innerText.includes('浏览器截图'),
  loginForm: /登录|注册/.test(document.body.innerText.slice(0, 2000)) && !document.querySelector('textarea'),
}))()`

const mode = process.argv[2] || 'check'
const expect = process.argv[3] || ''

const conn = await connect()
ws = conn.ws
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}

if (mode === 'check') {
  console.log(JSON.stringify({ targets: conn.targets, firstUrl: conn.url }, null, 1))
  console.log(JSON.stringify(await evalJs(SNAP_SRC)))
} else if (mode === 'login') {
  // 测试账号(admin)凭据登录: 一次 fetch,不做任何表单点击
  const status = await evalJs(`(async () => {
    const csrf = await (await fetch('/api/auth/csrf')).json()
    const body = new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email: 'admin',
      password: 'admin123',
      json: 'true',
    })
    const res = await fetch('/api/auth/callback/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'follow',
    })
    return res.status
  })()`)
  console.log('LOGIN_STATUS=' + status)
  await evalJs(`location.href = '/chat'`)
  // 等路由落位(导航中途 evaluate 可能撞上重建中的 document,吞掉重试)
  for (let i = 0; i < 40; i++) {
    try {
      const s = await evalJs(SNAP_SRC)
      if (s.url.includes('/chat') && s.ready === 'complete') break
    } catch {
      /* document 重建中,下一轮再试 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  try {
    console.log(JSON.stringify(await evalJs(SNAP_SRC)))
  } catch {
    console.log('{"url":"(snapshot skipped: page navigating)"}')
  }
} else if (mode === 'clear') {
  // 清空输入框:React 受控组件必须走原生 setter + input 事件
  const cleared = await evalJs(`(() => {
    const ta = document.querySelector('textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  console.log('CLEARED=' + cleared)
  console.log(JSON.stringify(await evalJs(SNAP_SRC)))
} else if (mode === 'wait-text') {
  if (!expect) {
    console.error('需要期待片段参数')
    process.exit(1)
  }
  let snap = null
  while (Date.now() - t0 < 30000) {
    // 冷启动期 webview target 会重建:ws 断了就重连,别让事件循环空转退出
    if (!(ws && ws.readyState === 1)) {
      try {
        ws = (await connect(5000)).ws
      } catch {
        /* exe 还没起,下一轮再试 */
      }
    }
    try {
      snap = await evalJs(SNAP_SRC)
      if (snap.input && snap.input.includes(expect)) break
    } catch {
      ws = null
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  const elapsed = Date.now() - t0
  if (snap?.input?.includes(expect)) {
    console.log('MATCHED elapsed_ms=' + elapsed)
    // 芯片渲染比文本晚几百毫秒,补拍一次终态快照
    await new Promise((r) => setTimeout(r, 900))
    console.log('FINAL ' + JSON.stringify(await evalJs(SNAP_SRC)))
  } else {
    console.log('NOT_MATCHED elapsed_ms=' + elapsed)
    console.log(JSON.stringify(snap))
    process.exit(3)
  }
}

try {
  ws.close()
} catch {
  /* ignore */
}
process.exit(0)
