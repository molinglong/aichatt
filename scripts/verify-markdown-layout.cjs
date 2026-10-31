// Real MarkdownRenderer + project CSS in Chromium; no account, API or model calls.
// node scripts/verify-markdown-layout.cjs [--diagnose]
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { build } = require('esbuild')
const postcss = require('postcss')
const tailwind = require('tailwindcss')
const { chromium } = require('playwright')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'test-results', 'markdown-layout')
const diagnose = process.argv.includes('--diagnose')
const sample = '三周下来你会有个数字：在家 X 小时，在外面 Y 小时。如果 Y 比 X 多出一大截，说明你的问题是环境干扰，租房值得考虑；如果两个数字差不多，说明换个房间解决不了，你要练的是“坐下来就不动”的能力，那个得从行为规则入手，不是靠租一间房。'
const cases = [
  { name: 'screenshot', text: sample },
  { name: 'screenshot-price-paragraphs', text: '4699 + 3300 ≈ **8000 元**（B 方案），或者约 **7700 元**（A 方案双电）。\n\n所以如果你要改，**改 A 方案，别改 B。** 多买一块原厂电池比换大容量第三方电池更靠谱：同一套认证、同一套 BMS、不用动线路，还能顺便解决“第二天不用等充电”的问题。\n\n**一年很短，那辆 24 寸车先骑着。**' },
  { name: 'bold-lists', text: '**真正该算清的是你的使用场景**\n\n- **单程 100 km：** A 方案（双电轮换）中途换一块电池就能跑完。\n- **单程 150 km 以上：** 三个方案都不行。\n\n所以如果你要改，**改 A 方案，别改 B。**' },
  { name: 'soft-breaks', text: sample.replace('在家', '\n在家').replace('如果 Y', '\n如果 Y').replace('说明你的', '\n说明你的') },
  { name: 'cjk-soft-breaks', text: '比较\n两个\n方案\n的\n成本，如果 Y 比 X 多一些，就需要重新评估。随后继续比较收益。' },
  { name: 'inline', text: '第一句。**房间只做两件事：学习、睡觉。** 手机进门就放好。使用 `const x = 1` 保留代码。*短暂休息* 之后继续。' },
  { name: 'latin', text: 'A short sentence. Another sentence with office affinity and 3.14 numbers; keep the same wrapping! End.' },
]

async function bundle() {
  const stubs = {
    'next/navigation': 'export const usePathname = () => "/chat"; export const useRouter = () => ({ push(){}, replace(){}, back(){}, forward(){}, refresh(){}, prefetch(){} });',
    '@/hooks/useBackToClose': 'export const useBackToClose = () => ({ navigate(){} });',
    'next/dynamic': 'export default () => () => null;',
    '@/lib/client-diagnostics': 'export const useRenderProbe = () => {};',
    '@/lib/toast': 'export const toast = { success() {}, error() {} };',
    '@/store/contextMenuStore': 'export const useContextMenuStore = { getState: () => ({ openContextMenu() {} }) };',
    '@/store/chat-store': 'export const useChatStore = { getState: () => ({ setPreviewCode() {} }) };',
    '@/lib/input-bridge': 'export const insertTextToInput = () => {}; export const sendTextAsUser = () => {};',
    './ChartCard': 'export const ChartCard = () => null;',
  }
  const result = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { MarkdownRenderer } from './src/components/chat/MarkdownRenderer';
      const root = createRoot(document.getElementById('root'));
      window.renderMarkdown = (content, rich) => flushSync(() => root.render(
        React.createElement(MarkdownRenderer, {content, rich, live: true})
      ));
      window.measureMarkdown = () => {
        const el = document.querySelector('.rich-md');
        const origin = el.getBoundingClientRect();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const chars = []; let node;
        while ((node = walker.nextNode())) {
          for (let i = 0; i < node.length; i++) {
            if (/\\s/.test(node.data[i])) continue;
            const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
            const r = range.getBoundingClientRect();
            chars.push({c: node.data[i], x: +(r.x-origin.x).toFixed(3), y: +(r.y-origin.y).toFixed(3)});
          }
        }
        const lines = [];
        for (const c of chars) { let line = lines.find(l => Math.abs(l.y-c.y)<1); if (!line) lines.push(line={y:c.y,text:''}); line.text += c.c; }
        return {chars, lines, width: origin.width, height: origin.height, html: el.innerHTML};
      };
    `, resolveDir: ROOT, loader: 'tsx' },
    absWorkingDir: ROOT, bundle: true, write: false, format: 'iife', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'non-rendering-boundaries', setup(b) {
      b.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'stub' } : null)
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    } }],
  })
  return result.outputFiles[0].text
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const js = await bundle()
  const cssResult = await postcss([tailwind(path.join(ROOT, 'tailwind.config.ts'))]).process(
    fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8'), { from: path.join(ROOT, 'src/app/globals.css') },
  )
  cssResult.root.walkAtRules('import', rule => rule.remove())
  const css = cssResult.root.toString()
  const html = `<!doctype html><html lang="zh-CN" class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css">${[400,600].map(w=>`<link rel="stylesheet" href="/fonts-subset/${w}/result.css">`).join('')}<style>body{margin:0;padding:15px}#root{width:100%}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname
    if (url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return }
    if (url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); return }
    if (url === '/app.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); return }
    if (url.startsWith('/fonts-subset/') && !url.includes('..')) {
      const file = path.join(ROOT, 'public', url)
      if (fs.existsSync(file)) { res.setHeader('Content-Type', url.endsWith('.css') ? 'text/css' : 'font/woff2'); res.end(fs.readFileSync(file)); return }
    }
    res.statusCode = 404; res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  const results = []
  try {
    browser = await chromium.launch({ args: ['--mute-audio'] })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    const base = `http://127.0.0.1:${server.address().port}`
    await page.goto(base)
    // Hold font responses until fallback text has actually been painted.
    const cold = await browser.newPage({ viewport: { width: 520, height: 844 }, isMobile: true })
    let releaseFonts
    const fontGate = new Promise(resolve => { releaseFonts = resolve })
    await cold.route('**/*.woff2', async route => { await fontGate; await route.continue() })
    await cold.goto(base)
    await cold.addStyleTag({ content: '*,*::before,*::after { animation: none !important; transition: none !important }' })
    await cold.evaluate(text => window.renderMarkdown(text, true), sample)
    // Exceed the optional font's short block period before measuring visible fallback.
    await cold.waitForTimeout(250)
    const sweep = () => {
      const root = document.getElementById('root'); const rows = []
      for (let width=320; width<=560; width++) { root.style.width=width+'px'; rows.push({width,...window.measureMarkdown()}) }
      root.style.width='100%'
      return rows
    }
    const beforeFont = await cold.evaluate(sweep)
    releaseFonts()
    await cold.evaluate(() => document.fonts.ready)
    const afterFont = await cold.evaluate(sweep)
    const fontFailures = beforeFont.flatMap((before,i) => {
      const after = afterFont[i]
      const shifted = before.chars.filter((c,j) => Math.abs(c.x-after.chars[j].x)>0.1 || Math.abs(c.y-after.chars[j].y)>0.1).length
      return shifted ? [{width:before.width,shifted,before:before.lines,after:after.lines}] : []
    })
    const wraps = fontFailures.filter(f=>f.before.map(l=>l.text).join('|')!==f.after.map(l=>l.text).join('|'))
    const fontInfo = await cold.evaluate(() => ({family:getComputedStyle(document.body).fontFamily,loaded:[...document.fonts].filter(f=>f.status==='loaded').length}))
    if (!fontInfo.family.includes('PingFang SC Sub') || !fontInfo.loaded) throw new Error('Font fixture did not load real project fonts')
    console.log('FONT', JSON.stringify({shiftedWidths:fontFailures.length, changedWraps:wraps.length, example:wraps[0], info:fontInfo}))
    results.push({ name: 'font-arrival', checked:beforeFont.length, changedWraps:wraps.length, failures:fontFailures })
    // Streaming/render-mode updates must not activate a late font on existing lines either.
    const frozen = await cold.evaluate(() => window.measureMarkdown())
    for (const rich of [false, true]) {
      await cold.evaluate(({text,rich}) => window.renderMarkdown(text+'\n\n后续补充：保持学习与休息的平衡。',rich), {text:sample,rich})
      await cold.evaluate(() => document.fonts.ready)
      const next = await cold.evaluate(() => window.measureMarkdown())
      const changed = frozen.chars.filter((c,i)=>c.c!==next.chars[i].c || Math.abs(c.x-next.chars[i].x)>0.1 || Math.abs(c.y-next.chars[i].y)>0.1).length
      results.push({name:rich?'late-font-finalize':'late-font-stream',failures:changed?[{changed}]:[]})
      console.log(`${changed?'FAIL':'PASS'} late font ${rich?'finalize':'stream'}: ${changed} shifted characters`)
    }
    await cold.close()
    // Preload before first text paint: verify live/rich using real PingFang, not optional fallback.
    await page.evaluate(async text => {
      await Promise.all([400,600].map(w=>document.fonts.load(w+' 15px "PingFang SC Sub"',text)))
    }, cases.map(c=>c.text).join(''))
    // Geometry checks isolate renderer differences, not animation progress/font swap.
    await page.addStyleTag({ content: '*,*::before,*::after { animation: none !important; transition: none !important }' })
    await page.evaluate(text => window.renderMarkdown(text,true),sample)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
    const {root:dom} = await cdp.send('DOM.getDocument')
    const {nodeId} = await cdp.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'#root p'})
    const {fonts} = await cdp.send('CSS.getPlatformFontsForNode',{nodeId})
    const pingfangUsed = fonts.some(f=>f.isCustomFont && /PingFang/i.test(f.familyName) && f.glyphCount>0)
    if (!pingfangUsed) throw new Error('Warm-cache fixture did not actually render with PingFang: '+JSON.stringify(fonts))
    console.log('PASS warm PingFang:',JSON.stringify(fonts))
    results.push({name:'warm-font',fonts})
    await cdp.detach()
    for (const fixture of cases) {
      let checked = 0; const failures = []
      for (const width of [320, 360, 375, 390, 393, 412, 430, 768]) {
        await page.setViewportSize({ width, height: 844 })
        await page.evaluate(text => window.renderMarkdown(text, false), fixture.text)
        await page.evaluate(() => document.fonts.ready)
        const live = await page.evaluate(() => window.measureMarkdown())
        await page.evaluate(text => window.renderMarkdown(text, true), fixture.text)
        await page.evaluate(() => document.fonts.ready)
        const rich = await page.evaluate(() => window.measureMarkdown())
        const shifted = live.chars.filter((c,i) => !rich.chars[i] || c.c !== rich.chars[i].c || Math.abs(c.x-rich.chars[i].x) > 0.1 || Math.abs(c.y-rich.chars[i].y) > 0.1)
        checked++
        if (shifted.length || live.chars.length !== rich.chars.length) failures.push({width, shifted: shifted.length, live: live.lines, rich: rich.lines})
      }
      results.push({ name: fixture.name, checked, failures })
      console.log(`${failures.length ? 'FAIL' : 'PASS'} ${fixture.name}: ${checked-failures.length}/${checked} stable widths`)
      if (failures.length) console.log(JSON.stringify(failures[0]))
    }
    await page.setViewportSize({ width: 493, height: 844 })
    const animated = await browser.newPage({ viewport: { width: 493, height: 844 }, isMobile: true })
    await animated.goto(base)
    await animated.evaluate(text => window.renderMarkdown(text, true), sample)
    await animated.evaluate(() => document.fonts.ready)
    const motionResult = await animated.evaluate(async text => {
      window.renderMarkdown('', true)
      window.renderMarkdown(text, false)
      const samples = []; const start = performance.now()
      while (performance.now() - start < 700) {
        await new Promise(requestAnimationFrame)
        samples.push(window.measureMarkdown())
      }
      window.renderMarkdown(text, true)
      await new Promise(requestAnimationFrame)
      const final = window.measureMarkdown()
      return {frames:samples.length, changedFrames:samples.filter(s => s.chars.some((c,i) => Math.abs(c.x-final.chars[i].x)>0.1)).length, first:samples[0].lines, final:final.lines}
    }, sample)
    console.log('ANIMATION', JSON.stringify(motionResult))
    results.push({name:'sentence-animation', failures:motionResult.changedFrames ? [motionResult] : []})
    await animated.close()
    await page.evaluate(text => window.renderMarkdown(text + '\n\n## 如果最后决定要租，怎么设计才不白花钱\n\n1. **距离要真的很近。** 步行十分钟以内的房子才有意义。\n2. **房间只做两件事：学习、睡觉。** 手机进门就放好。', true), sample)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: path.join(OUT, 'mobile.png'), fullPage: true })
    results.push({ name: 'page-errors', errors })
    fs.writeFileSync(path.join(OUT, diagnose ? 'baseline.json' : 'result.json'), JSON.stringify(results, null, 2))
    if (!diagnose && (results.some(r => r.failures?.length) || errors.length)) process.exitCode = 1
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
