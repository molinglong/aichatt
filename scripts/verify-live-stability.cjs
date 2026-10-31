// Offline DOM identity/render-count regression. No server, account or model requests.
// node scripts/verify-live-stability.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { build } = require('esbuild')
const { chromium } = require('playwright')
const ROOT = path.resolve(__dirname, '..')
const TARGET = path.join(ROOT, 'src/components/chat/MarkdownRenderer.tsx')

async function bundle() {
  const stubs = {
    'next/navigation': 'export const usePathname = () => "/chat"; export const useRouter = () => ({ push(){}, replace(){}, back(){}, forward(){}, refresh(){}, prefetch(){} });',
    '@/hooks/useBackToClose': 'export const useBackToClose = () => ({ navigate(){} });',
    'next/dynamic': 'export default () => () => null;',
    '@/lib/client-diagnostics': 'export const useRenderProbe = () => {};',
    '@/lib/toast': 'export const toast = { success() {}, error() {} };',
    '@/store/contextMenuStore': 'export const useContextMenuStore = { getState: () => ({ openContextMenu(items) { globalThis.menu = items; } }) };',
    '@/store/chat-store': 'export const useChatStore = { getState: () => ({ setPreviewCode(code) { globalThis.previewCode = code; } }) };',
    '@/lib/input-bridge': 'export const insertTextToInput = () => {}; export const sendTextAsUser = text => { globalThis.sentText = text; };',
    './ChartCard': 'export const ChartCard = () => null;',
  }
  let instrumented = false
  const result = await build({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {MarkdownRenderer, FullRichMarkdown, keepLive} from './src/components/chat/MarkdownRenderer';
      const root = createRoot(document.getElementById('root'));
      const referenceHost = document.createElement('div');
      referenceHost.id = 'reference'; document.body.appendChild(referenceHost);
      const reference = createRoot(referenceHost);
      let referenceKey = 0;
      window.renderFullLive = content => flushSync(() => reference.render(React.createElement(MarkdownRenderer, {content, live:true, key:++referenceKey})));
      window.renderReference = content => flushSync(() => reference.render(React.createElement(FullRichMarkdown, {content})));
      window.keepLive = keepLive;
      window.render = (content, rich = false, inlineImages) => flushSync(() => root.render(
        React.createElement(MarkdownRenderer, {content, rich, live: !rich, inlineImages})
      ));
      window.reset = () => flushSync(() => root.render(null));
      window.counts = {parse: 0, render: 0};
      Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => {window.copiedText = text}}});
    `, resolveDir: ROOT, loader: 'tsx' },
    absWorkingDir: ROOT, bundle: true, write: false, jsx: 'automatic', format: 'iife', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'offline-boundaries-and-counters', setup(b) {
      b.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'stub' } : null)
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
      b.onLoad({ filter: /MarkdownRenderer\.tsx$/ }, args => {
        assert.equal(path.resolve(args.path), TARGET)
        let source = fs.readFileSync(args.path, 'utf8')
        // Count actual work in the real functions, not a production probe or React commit count.
        for (const [name, counter] of [['parseLiveBlocks', 'parse'], ['renderLiveBlock', 'render']]) {
          const signature = new RegExp('(function ' + name + '\\([^\\n]+\\)\\s*:[^\\n]+\\{)')
          assert.ok(signature.test(source), 'Missing instrumentation anchor: ' + name)
          source = source.replace(signature, '$1\n  globalThis.counts.' + counter + '++;' + (counter === 'parse' ? '\n  globalThis.counts.parseChars = (globalThis.counts.parseChars || 0) + md.length;' : ''))
        }
        if (process.argv.includes('--full-scan')) {
          assert.ok(source.includes('if (previous && !sourceLines'))
          source = source.replace('if (previous && !sourceLines', 'if (false && previous && !sourceLines')
        }
        // Test-only exports: compare to the unchanged full rich pipeline, not to itself.
        source += '\nexport {RichMarkdown as FullRichMarkdown};\n'
        source += source.includes('function canKeepLiveMarkdown(')
          ? 'export {canKeepLiveMarkdown as keepLive};\n'
          : 'export const keepLive = () => false;\n'
        instrumented = true
        return { contents: source, loader: 'tsx', resolveDir: path.dirname(args.path) }
      })
    } }],
  })
  assert.ok(instrumented)
  return result.outputFiles[0].text
}

async function main() {
  const js = await bundle()
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] })
  const results = []
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const requests = []
    await context.route('**/*', route => {
      if (route.request().url() === 'https://offline.test/image.gif') return route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') })
      requests.push(route.request().url()); return route.abort()
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<!doctype html><html><head><base href="https://offline.test/"></head><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: js })
    const check = async (name, run) => {
      try { const detail = await page.evaluate(run); results.push({ name, pass: true, detail }) }
      catch (error) { results.push({ name, pass: false, error: error.message }) }
    }
    await check('no sentence wrappers or link-close identity churn', () => {
      window.reset()
      const text = '前文。链接 [标题。第二段](https://example.test/a'
      window.render(text)
      const root = document.querySelector('.rich-md')
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const before = []; let node
      while ((node = walker.nextNode())) before.push(node)
      window.render(text + ')')
      if (before.some(node => !node.isConnected)) throw Error('Link closure remounted existing text')
      if (root.querySelector('.md-sent')) throw Error('Sentence identity/animation wrapper still present')
      return { retainedTextNodes: before.length }
    })
    await check('completed blocks skip rendering, parsing remains explicit', () => {
      window.reset()
      const prefix = Array.from({ length: 80 }, (_, i) => '第' + i + '段 **稳定正文**。').join('\n\n') + '\n\n'
      window.render(prefix + '尾部')
      const old = [...document.querySelectorAll('.rich-md p')].slice(0, 80)
      window.counts = {parse: 0, render: 0}
      // MessageBubble extracts a new image array for every message snapshot.
      for (let i = 1; i <= 40; i++) window.render(prefix + '尾部' + '续'.repeat(i), false, [])
      const counts = {...window.counts}
      if (counts.render !== 40) throw Error('Expected 40 tail renders, got ' + JSON.stringify(counts))
      if (counts.parse !== 40) throw Error('Parse accounting changed: ' + JSON.stringify(counts))
      if (!(counts.parseChars <= 2000)) throw Error('Stable prefix was rescanned: ' + JSON.stringify(counts))
      if (old.some(node => !node.isConnected)) throw Error('Completed paragraph remounted')
      return { blocks: 81, updates: 40, ...counts }
    })
    await check('all live block types memoize without freezing changed arrays', () => {
      window.reset()
      const prefix = '## 标题\n\n段落\n\n> 引用\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n```js\nconst n = 1\n```\n\n| 表头 | 值 |\n| --- | --- |\n| 数据 | 1 |\n\n'
      window.render(prefix + '尾部')
      const nodes = [...document.querySelectorAll('#root .rich-md p, #root h2, #root li, #root blockquote, #root pre, #root td')].slice(0, -1)
      window.counts = {parse: 0, render: 0}
      for (let i = 1; i <= 8; i++) window.render(prefix + '尾部' + '续'.repeat(i))
      const counts = {...window.counts}
      if (counts.render !== 8 || nodes.some(n => !n.isConnected)) throw Error('Mixed block memo failed: ' + JSON.stringify(counts))
      window.render(prefix.replace('- 乙', '- 已更新').replace('| 数据 | 1 |', '| 新值 | 2 |') + '尾部')
      if (!document.querySelector('#root').textContent.includes('已更新') || !document.querySelector('#root').textContent.includes('新值')) throw Error('Array-valued blocks frozen')
      window.render('| --- |') // An incomplete separator-only table has no header yet.
      window.render('| --- |\n| 数据 |')
      if (!document.querySelector('#root').textContent.includes('数据')) throw Error('Pending table lost content')
      window.render('```triangle\ninvalid\n```', true)
      if (!document.querySelector('.tri-raw')?.textContent.includes('invalid')) throw Error('Invalid triangle did not fall back to source')
      return { types: 7, updates: 8, ...counts, replacements: true, invalidTriangle: true }
    })
    await check('source-position identity survives triangle hoisting', () => {
      window.reset()
      const text = '## 原标题\n\n原段落 **不重挂载**。\n\n```triangle\n{"sides":{"a":3,"b":4,"c":5}}\n'
      window.render(text)
      const heading = document.querySelector('h2')
      const paragraph = document.querySelector('.rich-md p')
      window.render(text + '```')
      if (heading !== document.querySelector('h2') || paragraph !== document.querySelector('.rich-md p')) throw Error('Hoisting shifted block identity')
      if (!document.querySelector('.tri-figure')) throw Error('Triangle did not render')
      return { heading: heading.isConnected, paragraph: paragraph.isConnected }
    })
    await check('ordinary live/rich finalization preserves DOM nodes', () => {
      const fixtures = [
        '第一段普通正文。\n\n第二段普通正文。',
        '## 标题\n\n所以如果你要改，**改 A 方案，别改 B。** 多买一块电池。\n\n- **距离要近。** 保持原车。\n- 使用 `const x = 1`。\n\n*短暂休息* 之后继续。',
      ]
      let retained = 0
      for (const text of fixtures) {
        window.reset(); window.render(text)
        const root = document.querySelector('.rich-md')
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL)
        const before = []; let node
        while ((node = walker.nextNode())) before.push(node)
        window.render(text, true)
        if (root !== document.querySelector('.rich-md') || before.some(n => !n.isConnected)) throw Error('Finalization replaced ordinary DOM')
        if (root.classList.contains('md-live')) throw Error('Final mode still marked live')
        retained += before.length
      }
      return { fixtures: fixtures.length, retained }
    })
    await check('every appended prefix matches fresh full live parsing', () => {
      const fixtures = [
        '1. a\n1000. b\n1001. c', '1. a\n1234567890. b',
        '正文\n\n## 标题\n\n- 甲\n- 乙\n\n尾文',
        '| 表头 | 值 |\n| --- | --- |\n| 数据 | 1 |\n\n后文',
        '前文\n\n```js\nconst a = 1;\n```\n\n后文',
        '> 引用\n> 后行\n\n后文', '段落\n1. 项目\n2. 后项\n\n结束',
        '- 甲\n+ 乙\n* 丙\n\n正文', '1. a\n\n1000. b',
      ]
      let prefixes = 0
      for (const fixture of fixtures) {
        window.reset()
        for (let i = 1; i <= fixture.length; i++) {
          const text = fixture.slice(0, i)
          window.render(text); window.renderFullLive(text)
          const actual = document.querySelector('#root .rich-md').innerHTML
          const expected = document.querySelector('#reference .rich-md').innerHTML
          if (actual !== expected) throw Error('Incremental mismatch: ' + JSON.stringify(text))
          prefixes++
        }
      }
      window.renderReference('')
      return { fixtures: fixtures.length, prefixes }
    })
    await check('ambiguous ordered markers fall back to rich semantics', () => {
      for (const text of ['1000.', '1000)', '1000. first', '2. first']) {
        if (window.keepLive(text)) throw Error('Ambiguous ordered marker kept live: ' + text)
      }
      return { fixtures: 4 }
    })
    await check('updates/replacements never freeze old content or references', () => {
      window.reset()
      window.render('旧正文。\n\n后文。')
      window.render('新正文。\n\n后文。')
      if (!document.querySelector('.rich-md').textContent.startsWith('新正文')) throw Error('Live block frozen')
      const reference = '[资料][ref]\n\n正文。'
      window.render(reference)
      window.render(reference + '\n\n[ref]: https://example.test/ref', true)
      if (document.querySelector('.rich-md a')?.getAttribute('href') !== 'https://example.test/ref') throw Error('Late reference definition lost')
      window.render('新的历史正文。', true)
      if (document.querySelector('.rich-md').textContent !== '新的历史正文。') throw Error('Historical update frozen')
      return { lateReference: true, replacement: true }
    })
    await check('rich features, safe URLs, code and essay copy, game actions', async () => {
      window.reset()
      window.render(':::choice\n选一个。\nA. 甲\nB. 乙\n:::\n:::answer\n正确答案甲。\n:::', true)
      const answer = document.querySelector('[aria-label="显示答案"]')
      if (!document.querySelector('.exam-choice') || !answer) throw Error('Paper/collapse missing')
      answer.click(); await new Promise(requestAnimationFrame)
      if (!document.querySelector('.exam-answer').textContent.includes('正确答案甲')) throw Error('Answer did not expand')
      window.render(':::gamestatus\n体力: 80/100\n:::\n:::gamechoice\n- 去图书馆\n- 休息\n:::', true)
      const action = document.querySelector('.game-choice-btn')
      if (!document.querySelector('.game-status') || !action) throw Error('Game cards missing')
      action.click()
      if (window.sentText !== action.textContent) throw Error('Game action missing')
      window.render('```html\n<b>hello</b>\n```', true)
      document.querySelector('[aria-label="复制代码"]').click()
      await Promise.resolve()
      if (!window.copiedText.includes('<b>hello</b>')) throw Error('Code copy missing')
      document.querySelector('[aria-label="预览"]').click()
      if (!window.previewCode.includes('<b>hello</b>')) throw Error('Code preview missing')
      window.render(':::essay\n我的标题\n\n这是作文正文。\n:::', true)
      document.querySelector('[aria-label="复制作文"]').click()
      await Promise.resolve()
      if (!window.copiedText.includes('这是作文正文')) throw Error('Essay copy missing')
      window.render('$x^2$\n\n~~删除~~ [危险](javascript:alert%281%29)\n\n<script>window.pwned = true</script>', true)
      if (!document.querySelector('.katex') || !document.querySelector('del')) throw Error('Math/GFM missing')
      if (document.querySelector('.rich-md script') || window.pwned || document.querySelector('.rich-md a')?.getAttribute('href')) throw Error('Unsafe markup activated')
      return { paper: true, game: true, copy: true, math: true, safe: true }
    })
    await check('whitelisted inline image card works and retains live state', async () => {
      window.reset()
      const images = [{ n: 1, url: 'https://offline.test/image.gif', host: 'offline.test', description: '离线配图' }]
      window.render('前文。\n\n[图1]\n\n尾部', false, images)
      const image = document.querySelector('.inline-fig')
      if (!image) throw Error('Live image placeholder did not become card')
      window.render('前文。\n\n[图1]\n\n尾部追加', false, images)
      if (image !== document.querySelector('.inline-fig')) throw Error('Image remounted during tail append')
      window.render('前文。\n\n[图1]\n\n尾部追加', false, [{...images[0], description: '更新图注'}])
      if (image !== document.querySelector('.inline-fig') || !image.textContent.includes('更新图注')) throw Error('Image context update blocked by memo')
      window.render('正文中的 [图1] 也显示。', false, images)
      if (!document.querySelector('.inline-fig')) throw Error('Mixed inline image missing')
      window.render('前文。\n\n[图1]', true, images)
      const button = document.querySelector('.inline-fig button')
      if (!button) throw Error('Rich image card missing')
      button.click(); await new Promise(requestAnimationFrame)
      if (!document.querySelector('[role="dialog"]')) throw Error('Image viewer did not open')
      return { card: true, viewer: true }
    })
    await check('final semantics match the full rich pipeline, including fallback', () => {
      const fixtures = [
        '普通正文。', 'a=b', '=', '123', '1.', '-', '---', '- - -', '===', ':::unknown\n正文\n:::',
        '# 标题', '## 标题', '### 标题', '#### 标题', '##### 标题', '## 标题 ###',
        '标题\n---', '正文\n软换行', '正文  \n硬换行', '    缩进代码', '\t缩进代码',
        '- 甲\n- 乙', '+ 甲\n+ 乙', '* 甲\n* 乙', '1. 甲\n2. 乙', '1) 甲\n2) 乙',
        '- 甲\n+ 乙', '1. 甲\n2) 乙', '- 甲\n\n- 乙', '- 甲\n  - 嵌套', '- ---', '- ## 标题',
        '**正常。** 文字 `const x = 1`。', '**未闭合', '*未闭合', '`未闭合', '** a**', '**a **',
        '**bold *nested* text**', '**code `x`**', '***bold italic***', '` padded `', '`  `',
        '两个 **格式** **节点**。', 'a**词**b', '**词。**后文', '前**。词**', '中文==术语== @@材料@@。',
        '[资料][ref]\n\n正文。\n\n[ref]: https://example.test/ref', '[坏](javascript:alert%281%29)',
        'https://example.test', 'www.example.test', 'name@example.test', '&amp; &#65;', '\\*转义\\*',
        '> 引用\n> 第二行', '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |', '- [x] 完成',
        '$x^2$', '\\(x^2\\)', '~~删除~~', '<b>raw</b>', '```js\nconst x = 1\n```',
      ]
      // Exercise delimiter flanking, not merely a list of hand-picked happy paths.
      for (const prefix of ['', '前', ' ', '.', '（', 'a']) {
        for (const suffix of ['', '后', ' ', '.', '）', 'b']) {
          for (const inner of ['词', '词。', '。词', '!', 'a b']) {
            for (const marker of ['*', '**']) fixtures.push('开头' + prefix + marker + inner + marker + suffix + '结尾')
          }
        }
      }
      const canonical = node => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent.trim() ? node.textContent.replace(/\s+/g, ' ') : null
        if (node.nodeType !== Node.ELEMENT_NODE) return null
        const children = []
        for (const child of node.childNodes) {
          const next = canonical(child)
          if (next === null) continue
          if (typeof next === 'string' && typeof children.at(-1) === 'string') children[children.length - 1] += next
          else children.push(next)
        }
        return [node.localName, [...node.attributes].map(a => [a.name, a.value]).sort(), children]
      }
      const failures = []; let kept = 0
      for (const content of fixtures) {
        window.reset(); window.render(content, true); window.renderReference(content)
        if (window.keepLive(content)) kept++
        const actual = canonical(document.querySelector('#root .rich-md'))
        const expected = canonical(document.querySelector('#reference .rich-md'))
        if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({content, kept:window.keepLive(content), actual, expected})
      }
      if (failures.length) throw Error(JSON.stringify({count:failures.length, examples:failures.slice(0, 4)}))
      return { fixtures: fixtures.length, kept, fallback: fixtures.length - kept }
    })
    results.push({ name: 'no browser errors or network requests', pass: !errors.length && !requests.length, detail: { errors, requests } })
    for (const result of results) console.log((result.pass ? 'PASS ' : 'FAIL ') + result.name + ': ' + JSON.stringify(result.detail || result.error))
    if (results.some(result => !result.pass)) process.exitCode = 1
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
