/**
 * 一次性前端性能取证脚本（audit，非交付物）。
 * 对已跑起来的生产构建（audit 构建 .next-audit）逐路由采集：
 *   首屏 JS/CSS/字体传输量、FCP/LCP、长任务、控制台报错、慢资源。
 *
 * 用法： node scripts/audit-frontend-perf.mjs [baseUrl]
 * 默认 baseUrl http://127.0.0.1:3457
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const base = process.argv[2] || 'http://127.0.0.1:3457'
const routes = [
  { path: '/chat', label: '新对话' },
  { path: '/study', label: '学习室' },
  { path: '/images', label: '生图' },
  { path: '/kb', label: '知识库' },
  { path: '/papers/composed', label: '拟卷' },
  { path: '/write', label: '写作' },
  { path: '/settings-window', label: '设置窗' },
]

const initScript = () => {
  window.__audit = { lcp: 0, lcpEl: '', cls: 0, longtasks: 0, longtaskMs: 0, fcp: 0, shifts: [] }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__audit.lcp = e.startTime
        const el = e.element
        window.__audit.lcpEl = el
          ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${(el.className && typeof el.className === 'string' ? el.className : '').split(' ').slice(0, 2).join('.')}`
          : ''
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (!e.hadRecentInput) window.__audit.cls += e.value
      }
    }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__audit.longtasks++
        window.__audit.longtaskMs += e.duration
      }
    }).observe({ type: 'longtask', buffered: true })
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__audit.fcp = e.startTime
    }).observe({ type: 'paint', buffered: true })
  } catch {}
}

const browser = await chromium.launch()
const context = await browser.newContext({
  storageState: '.auth/admin.json',
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
})
const results = []

for (const route of routes) {
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)))
  await page.addInitScript(initScript)
  const t0 = Date.now()
  let status = 0
  try {
    const resp = await page.goto(base + route.path, { waitUntil: 'load', timeout: 60000 })
    status = resp?.status() ?? 0
  } catch (e) {
    consoleErrors.push('goto failed: ' + e.message)
  }
  await page.waitForTimeout(2500)
  const data = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const res = performance.getEntriesByType('resource')
    const sum = (pred) => res.filter(pred).reduce((a, r) => a + (r.transferSize || 0), 0)
    const cnt = (pred) => res.filter(pred).length
    const isJS = (r) => r.initiatorType === 'script' || /\.js(\?|$)/.test(r.name)
    const isCSS = (r) => r.initiatorType === 'link' || /\.css(\?|$)/.test(r.name) || /result\.css/.test(r.name)
    const isFont = (r) => /\.woff2?(\?|$)/.test(r.name)
    const isImg = (r) => r.initiatorType === 'img' || /\.(webp|png|jpe?g|svg|avif)(\?|$)/.test(r.name)
    const jsList = res
      .filter(isJS)
      .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
      .slice(0, 8)
      .map((r) => ({ url: r.name.replace(location.origin, ''), kb: Math.round((r.transferSize || 0) / 1024) }))
    return {
      ttfb: nav ? Math.round(nav.responseStart) : null,
      dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load: nav ? Math.round(nav.loadEventEnd) : null,
      fcp: Math.round(window.__audit.fcp),
      lcp: Math.round(window.__audit.lcp),
      lcpEl: window.__audit.lcpEl,
      cls: Number(window.__audit.cls.toFixed(3)),
      longtasks: window.__audit.longtasks,
      longtaskMs: Math.round(window.__audit.longtaskMs),
      jsKb: Math.round(sum(isJS) / 1024),
      jsN: cnt(isJS),
      cssKb: Math.round(sum(isCSS) / 1024),
      cssN: cnt(isCSS),
      fontKb: Math.round(sum(isFont) / 1024),
      fontN: cnt(isFont),
      imgKb: Math.round(sum(isImg) / 1024),
      totalKb: Math.round(res.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
      topJs: jsList,
      domNodes: document.querySelectorAll('*').length,
    }
  })
  results.push({ ...route, status, wallMs: Date.now() - t0, consoleErrors: consoleErrors.slice(0, 5), ...data })
  await page.close()
}

await browser.close()
const out = { base, at: new Date().toISOString(), results }
fs.mkdirSync('logs', { recursive: true })
fs.writeFileSync('logs/frontend-perf-audit.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify(results, null, 2))
