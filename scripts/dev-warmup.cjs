/**
 * dev 预热脚本 — dev server(3456)起来后把全站页面 + 热点 API + 客户端 chunk 请求一遍。
 *
 * 背景:Next.js dev 是按需编译,server 每次重启后每个路由的第一次访问
 * 都要现场编译。实测三层冷成本:
 *   1. 服务端路由编译(HTML GET 触发,0.7~30s,组卷/聊天页最重)
 *   2. 客户端导航 flight 图(RSC:1 GET 触发)
 *   3. 浏览器客户端 chunk 文件(浏览器导航时逐个拉,首访共 2~5s)
 * 只打 HTML 时,用户首次点进该页仍要付 2+3 的成本,所以要三样全打。
 *
 * 用法:dev 起来后执行 `npm run warm`(predev 会自动派生本脚本,日志 dev-warmup.log)。
 *
 * - 等待 3456 就绪(最多 240s),dev 还没起完也不影响。
 * - 会话 cookie 从 .auth/admin.json 读取(不存在时 authed 页面会 307,输出会警告)。
 * - 页面请求顺序、chunk 并发小池:dev 编译器单线程,全量并行只会互相抢锁。
 * - 目标是触发编译而非验证业务,4xx/5xx 也算预热成功,只如实标注状态码。
 */

const BASE = 'http://localhost:3456'
// 冷启动时 Next 监听 + webpack 冷编可能要一两分钟,给足余量
const WAIT_TIMEOUT_MS = 240_000
const POLL_INTERVAL_MS = 1500
const CHUNK_POOL = 6

/** 页面路由(触发 page/layout/客户端 chunk 编译) */
const PAGES = [
  '/chat',
  '/study',
  '/explore',
  '/images',
  '/kb',
  '/write',
  '/papers/composed',
  '/papers/exam',
  '/chat/settings',
]

/** 热点 API(触发 API 路由编译;均为 GET 只读,无参数调用允许返回 4xx) */
const APIS = [
  '/api/main-chat',
  '/api/study',
  '/api/study/plan',
  '/api/study/queue',
  '/api/study/stats',
  '/api/study/notes',
  '/api/exam-records',
  '/api/papers',
  '/api/papers/composed',
  '/api/favorites',
  '/api/kb/docs',
  '/api/custom-models',
  '/api/providers',
]

async function waitForServer() {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { redirect: 'manual' })
      if (res.status) return true
    } catch {
      // 还没起来,继续等
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return false
}

function loadCookieHeader() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const j = require('../.auth/admin.json')
    return j.cookies.map((k) => `${k.name}=${k.value}`).join('; ')
  } catch {
    return ''
  }
}

async function hit(path, headers) {
  const t0 = Date.now()
  try {
    const res = await fetch(BASE + path, { headers, redirect: 'manual' })
    const text = await res.text()
    return { status: res.status, ms: Date.now() - t0, text }
  } catch (e) {
    return { status: -1, ms: Date.now() - t0, text: '', err: e.message }
  }
}

/** 从页面 HTML + RSC payload 里抠出客户端 chunk 路径并全部请求一遍。
 *  注意字符类必须允许括号——dev chunk 路径带 route group,如 app/(app)/study/page.js。 */
async function warmChunks(pagePath, headers, log) {
  const html = await hit(pagePath, headers)
  const rsc = await hit(pagePath, { ...headers, RSC: '1' })
  const body = html.text + '\n' + rsc.text
  const urls = [
    ...new Set(
      [...body.matchAll(/\/?(?:_next)?\/static\/chunks\/[^\s"'\\]+/g)]
        .map((m) => m[0])
        .filter((u) => u.endsWith('.js') || u.includes('.js?')),
    ),
  ].map((u) => (u.startsWith('/_next') ? u : '/_next' + u))

  const t0 = Date.now()
  let i = 0
  async function worker() {
    while (i < urls.length) {
      const u = urls[i++]
      await hit(u, headers)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHUNK_POOL, urls.length || 1) }, worker))
  log(`      chunks: ${urls.length} 个 ${Date.now() - t0}ms`)
  return { page: html, rsc, chunkCount: urls.length, chunkMs: Date.now() - t0 }
}

async function main() {
  console.log(`[warm] 等待 ${BASE} 就绪…`)
  if (!(await waitForServer())) {
    console.error(`[warm] ${WAIT_TIMEOUT_MS / 1000}s 内 dev server 未就绪,放弃预热。`)
    process.exit(1)
  }
  console.log('[warm] server 就绪,开始预热(顺序执行,编译慢属正常)…')

  const cookie = loadCookieHeader()
  if (!cookie) {
    console.warn('[warm] ⚠ 未找到 .auth/admin.json,authed 页面将 307 到登录页,只有中间件被预热。')
  }
  const headers = cookie ? { cookie } : {}

  const results = []
  let total = 0
  for (const p of PAGES) {
    const r = await warmChunks(p, headers, (s) => console.log('[warm]   ' + s))
    total += r.page.ms + r.rsc.ms + r.chunkMs
    results.push({ label: 'PAGE', path: p, status: r.page.status, ms: r.page.ms + r.rsc.ms + r.chunkMs })
    console.log(
      `[warm] PAGE ${p.padEnd(26)} ${String(r.page.status).padStart(3)} ${String(r.page.ms).padStart(6)}ms +rsc ${r.rsc.ms}ms`,
    )
  }
  for (const p of APIS) {
    const r = await hit(p, headers)
    total += r.ms
    results.push({ label: 'API ', path: p, ...r })
    console.log(
      `[warm] API  ${p.padEnd(26)} ${String(r.status).padStart(3)} ${String(r.ms).padStart(6)}ms`,
    )
  }

  // 动态段模板:[id] 段编译一次后全变体通用,各取一条真实数据预热,
  // 否则用户第一次点开任意会话/试卷还是要现场编译(实测会话切换 5.5s)。
  const dyn = []
  try {
    const mc = await hit('/api/main-chat', headers)
    const j = JSON.parse(mc.text || '{}')
    if (j?.conversation?.id) {
      dyn.push(`/chat/c/${j.conversation.id}`)
      dyn.push(`/api/conversations/${j.conversation.id}/messages?limit=30`)
    }
  } catch { /* 拿不到会话列表就跳过 */ }
  try {
    const ps = await hit('/api/papers', headers)
    const j = JSON.parse(ps.text || '{}')
    if (j?.papers?.[0]?.slug) dyn.push(`/papers/${j.papers[0].slug}`)
  } catch { /* 拿不到试卷列表就跳过 */ }
  for (const p of dyn) {
    if (p.startsWith('/api/')) {
      const r = await hit(p, headers)
      total += r.ms
      results.push({ label: 'API ', path: p.split('?')[0], ...r })
      console.log(`[warm] API  ${p.padEnd(40)} ${String(r.status).padStart(3)} ${String(r.ms).padStart(6)}ms`)
      continue
    }
    const r = await warmChunks(p, headers, (s) => console.log('[warm]   ' + s))
    total += r.page.ms + r.rsc.ms + r.chunkMs
    results.push({ label: 'PAGE', path: p, status: r.page.status, ms: r.page.ms + r.rsc.ms + r.chunkMs })
    console.log(
      `[warm] PAGE ${p.padEnd(40)} ${String(r.page.status).padStart(3)} ${String(r.page.ms).padStart(6)}ms +rsc ${r.rsc.ms}ms`,
    )
  }

  const bad = results.filter((r) => r.status === 307 || r.status === 401)
  if (bad.length) {
    console.warn(
      `[warm] ⚠ ${bad.length} 个路由返回 ${[...new Set(bad.map((r) => r.status))].join('/')} — 会话 cookie 可能已过期,重新生成 .auth/admin.json 后再跑一次。`,
    )
  }
  const failed = results.filter((r) => r.status === -1)
  if (failed.length) {
    console.warn(`[warm] ⚠ ${failed.length} 个路由请求失败:${failed.map((r) => r.path).join(', ')}`)
  }
  console.log(`[warm] 完成:${results.length} 个路由,总耗时 ${(total / 1000).toFixed(1)}s(首跑含全部冷编译)。`)
}

main()
