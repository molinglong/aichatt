// Offline, in-memory bundle + real React StrictMode; deterministic RAF, no HTTP server.
// node scripts/verify-typewriter-scheduler.cjs [--diagnose]
const path = require('node:path')
const { build } = require('esbuild')
const { chromium } = require('playwright')
const ROOT = path.resolve(__dirname, '..')

async function main() {
  const compiled = await build({
    absWorkingDir: ROOT, bundle: true, write: false, platform: 'browser', format: 'iife',
    logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
    stdin: { resolveDir: ROOT, loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {useTypewriter} from './src/lib/useTypewriter';
      let now=1000, id=0; const frames=new Map();
      window.requestAnimationFrame=cb=>{frames.set(++id,cb);return id};
      window.cancelAnimationFrame=id=>frames.delete(id);
      Object.defineProperty(performance,'now',{value:()=>now});
      const root=createRoot(document.getElementById('root'));
      window.commits=[];window.notices=[];window.suspendedRenders=0;
      function Probe({text,enabled,cap,drain,suspend,slot='value'}) {
        const value=useTypewriter(text,enabled,cap,drain);
        React.useLayoutEffect(()=>{window[slot]=value;window.commits.push({...value,time:now})});
        if(suspend){window.suspendedRenders++;throw new Promise(()=>{})}
        return null;
      }
      window.setHook=(text,enabled=true,drain=true,cap=undefined,key='test')=>{
        window.commits=[];
        flushSync(()=>root.render(React.createElement(React.StrictMode,null,
          React.createElement(React.Suspense,{fallback:null},React.createElement(Probe,{text,enabled,drain,cap,key})))));
        return {...window.value};
      };
      window.setPair=()=>flushSync(()=>root.render(React.createElement(React.StrictMode,null,
        React.createElement(Probe,{text:'A'.repeat(200),enabled:true,cap:12,key:'left',slot:'left'}),
        React.createElement(Probe,{text:'B'.repeat(200),enabled:true,cap:120,key:'right',slot:'right'}))));
      window.transition=text=>React.startTransition(()=>root.render(React.createElement(React.StrictMode,null,
        React.createElement(React.Suspense,{fallback:null},React.createElement(Probe,{text,enabled:true,drain:true,key:'test',suspend:true})))));
      window.advance=(dt=1000/60)=>{
        now+=dt;const pending=[...frames.values()];frames.clear();
        flushSync(()=>pending.forEach(cb=>cb(now)));
        return {...window.value,time:now,pending:frames.size};
      };
      window.clock=()=>now;
      window.pending=()=>frames.size;
      window.unmount=()=>flushSync(()=>root.unmount());
    ` },
    plugins: [{ name: 'observe-store', setup(b) {
      b.onResolve({ filter: /^react$/ }, args => args.importer.endsWith('useTypewriter.ts')
        ? { path: 'react-observer', namespace: 'observer' } : null)
      b.onLoad({ filter: /.*/, namespace: 'observer' }, () => ({ loader: 'js', resolveDir: ROOT, contents: `
        import {useSyncExternalStore as original} from 'react';
        export {useRef,useEffect,useMemo,useCallback} from 'react';
        export function useSyncExternalStore(subscribe,getSnapshot,server) {
          return original(listener=>{let last=getSnapshot();return subscribe(()=>{
            const next=getSnapshot();window.notices.push({same:next===last,time:performance.now()});last=next;listener();
          })},getSnapshot,server);
        }
      ` }))
    } }],
  })
  const browser = await chromium.launch({ args: ['--mute-audio'] })
  try {
    for (const fallback of [false, true]) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', e => errors.push(e.message))
      await page.route('**/*', route => route.abort())
      await page.setContent('<div id="root"></div>')
      // Keep the native segmenter solely as the test oracle in fallback mode.
      await page.evaluate(fallback => {
        window.oracle = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        if (fallback) Intl.Segmenter = undefined
      }, fallback)
      await page.addScriptTag({ content: compiled.outputFiles[0].text })
      const result = await page.evaluate(async fallback => {
        const failures = [], metrics = {}
        const check = (ok, message) => { if (!ok) failures.push(message) }
        const finish = (limit = 10000, dt = 1000 / 60) => {
          const start = clock(), samples = []
          while (value.isTyping && clock() - start < limit) samples.push(advance(dt))
          return { ms: Math.round(clock() - start), samples, complete: !value.isTyping }
        }
        const normal = (unit, key) => {
          setHook('', true, true, undefined, key)
          let text = '', delays = [], arrivals = [], revealed = 0, maxStep = 0
          for (let frame = 0; frame < 360; frame++) {
            if (frame % 3 === 0) {
              text += unit; for (let i = 0; i < unit.length; i++) arrivals.push(clock())
              setHook(text, true, true, undefined, key)
            }
            const sample = advance()
            maxStep = Math.max(maxStep, sample.displayText.length - revealed)
            while (revealed < sample.displayText.length) delays.push(clock() - arrivals[revealed++])
          }
          const tail = finish()
          for (const sample of tail.samples) while (revealed < sample.displayText.length) delays.push(sample.time - arrivals[revealed++])
          delays.sort((a, b) => a - b)
          return { p95: Math.round(delays[Math.floor(delays.length * .95)]), maxStep, tailMs: tail.ms }
        }
        if (!fallback) {
          metrics.normal = normal('甲乙丙丁戊己', 'normal')
          metrics.punctuation = normal('甲。乙，丙\n', 'punctuation')
          check(metrics.normal.p95 <= 250, 'normal stream p95 exceeds 250ms')
          check(metrics.punctuation.p95 <= 250, 'punctuation stream p95 exceeds 250ms')
          check(JSON.stringify(metrics.normal) === JSON.stringify(metrics.punctuation), 'punctuation adds artificial pauses')
          check(metrics.normal.maxStep <= 8, 'normal stream jumps more than 8 graphemes/frame')
          metrics.fasterStreams = [2, 4].map(scale => ({ perSecond: 120 * scale,
            ...normal('甲乙丙丁戊己'.repeat(scale), 'normal' + scale) }))
          check(metrics.fasterStreams.every(s => s.p95 <= 250), '240/480 graphemes per second stream exceeds latency budget')
          check(metrics.fasterStreams.every(s => s.maxStep <= Math.ceil(s.perSecond / 60) + 2), 'steady stream jumps instead of tracking input rate')
          metrics.bursts = []
          for (const hz of [60, 120, 30]) {
            setHook('字'.repeat(6000), true, true, undefined, 'burst' + hz)
            const burst = finish(4000, 1000 / hz)
            const steps = burst.samples.map((s, i) => s.displayText.length - (burst.samples[i - 1]?.displayText.length || 0))
            const acceleration = Math.max(...steps.map((s, i) => s - (steps[i - 1] || 0)))
            metrics.bursts.push({ hz, ms: burst.ms, maxStep: Math.max(...steps), firstStep: steps[0], acceleration })
            check(burst.complete && burst.ms <= 3000, '6000 grapheme burst exceeds 3s at ' + hz + 'Hz')
            // 500ms burst budget: allow at most 5% of the initial burst per 60Hz frame,
            // scaled by elapsed time, and acceleration consistent with an 80ms ramp.
            check(Math.max(...steps) <= Math.ceil(2400 / hz), 'burst exceeds 2400 graphemes/second safety ceiling')
            check(steps[0] <= Math.ceil(6000 * .015 * (60 / hz) ** 2), 'burst starts with a hard jump')
            check(acceleration <= Math.ceil(6000 * .012 * (60 / hz) ** 2), 'burst rate lacks a smooth ramp')
          }
        }
        const unicode = 'A👩🏽‍💻e\u0301🇨🇳👨‍👩‍👧‍👦1️⃣\r\n각क्‍षZ'.repeat(5)
        const boundaries = new Set([0, ...Array.from(oracle.segment(unicode), s => s.index + s.segment.length)])
        setHook(unicode, true, true, 55, 'unicode')
        const glyphs = finish()
        check(glyphs.complete && value.displayText === unicode, 'grapheme tail lost')
        check(glyphs.samples.every(s => boundaries.has(s.displayText.length)), 'reveal splits a grapheme cluster')
        const chunks = ['start \ud83d', 'start 👩', 'start 👩🏽', 'start 👩🏽‍', 'start 👩🏽‍💻',
          'start 👩🏽‍💻 e', 'start 👩🏽‍💻 e\u0301', 'start 👩🏽‍💻 e\u0301🇨', 'start 👩🏽‍💻 e\u0301🇨🇳 end']
        for (const text of chunks) {
          setHook(text, true, true, undefined, 'chunks')
          const allowed = new Set([0, ...Array.from(oracle.segment(text), s => s.index + s.segment.length)])
          for (let i = 0; i < 30; i++) advance()
          check(commits.every(s => allowed.has(s.displayText.length) && !/[\ud800-\udbff]$/.test(s.displayText)), 'chunk append splits a glyph/surrogate')
          check(pending() <= 1, 'chunk append creates duplicate RAF')
        }
        finish(); check(value.displayText === chunks.at(-1), 'split-chunk tail lost')
        const truncated = 'broken \ud83d'
        setHook(truncated, true, true, undefined, 'truncated')
        for (let i = 0; i < 60; i++) advance()
        check(value.isTyping && pending() === 0 && !/[\ud800-\udbff]$/.test(value.displayText), 'incomplete surrogate spins RAF or leaks early')
        setHook(truncated, false, true, undefined, 'truncated')
        check(finish().complete && value.displayText === truncated, 'malformed final source leaves drain stuck')
        setHook('稳定前缀abcdefghij', true, true, undefined, 'revision'); finish()
        const revision = setHook('稳定前缀XYZ', true, true, undefined, 'revision')
        check(revision.displayText === '稳定前缀' && commits.every(s => s.displayText.startsWith('稳定前缀')), 'revision clears stable visible prefix')
        finish(); check(value.displayText === '稳定前缀XYZ', 'revision finishes incorrectly')
        const shorter = setHook('稳定前缀', true, true, undefined, 'revision')
        check(shorter.displayText === '稳定前缀' && !shorter.isTyping, 'shortening clears stable prefix')
        const fresh = setHook('NEW RESPONSE', true, true, undefined, 'revision')
        check(fresh.displayText === '' && fresh.isTyping, 'new response flashes full text'); finish()
        setHook('e\u0301old', true, true, undefined, 'combination'); finish()
        const combining = setHook('e\u0300new', true, true, undefined, 'combination')
        check(combining.displayText === '', 'revision preserves only part of a grapheme'); finish()
        setHook('prefix-old', true, true, undefined, 'unseen')
        const unseen = setHook('prefix-new', true, true, undefined, 'unseen')
        check(unseen.displayText === '', 'revision reveals previously unseen common prefix'); finish()
        const history = setHook('历史👩🏽‍💻正文', false, true, undefined, 'history')
        check(!history.isTyping && commits.every(s => s.displayText === '历史👩🏽‍💻正文'), 'history first frame is incomplete')
        setHook('尾文'.repeat(400), true, true, undefined, 'drain'); advance()
        const before = value.displayText
        const stopped = setHook('尾文'.repeat(400) + '最终尾文👩🏽‍💻', false, true, undefined, 'drain')
        check(stopped.displayText === before && stopped.isTyping, 'final chunk flushes instead of draining')
        finish(); check(value.displayText === '尾文'.repeat(400) + '最终尾文👩🏽‍💻', 'drain loses or duplicates tail')
        const late = setHook(value.displayText + '迟到更新', false, true, undefined, 'drain')
        check(!late.isTyping && late.displayText.endsWith('迟到更新'), 'historical update animates')
        setHook('unfinished'.repeat(100), true, false, undefined, 'default'); advance()
        const disabled = setHook('complete', false, false, undefined, 'default')
        check(!disabled.isTyping && disabled.displayText === 'complete', 'default disabled no longer flushes')
        setHook('x'.repeat(1000), true, true, 20, 'cap')
        const capped = finish(1000)
        check(!capped.complete && value.displayText.length <= 21, 'explicit maxRate ignored')
        notices.length = 0
        setHook('abc', true, true, 1, 'quiet')
        for (let i = 0; i < 20; i++) advance()
        check(notices.every(n => !n.same), 'listener notified without snapshot change')
        check(pending() <= 1, 'multiple RAF callbacks per instance')
        setHook('', true, true, undefined, 'coalesce')
        notices.length = 0
        for (let i = 1; i <= 100; i++) setHook('x'.repeat(i), true, true, undefined, 'coalesce')
        check(pending() === 1 && notices.length === 0, 'busy append updates not coalesced')
        advance(); check(notices.length <= 1, 'more than one notification per RAF')
        setHook('x'.repeat(6000), true, true, undefined, 'background')
        const background = advance(5000)
        check(background.displayText.length < 300 && background.pending === 1, 'background stall spends unbounded time credit')
        setHook('committed', true, true, undefined); finish()
        transition('uncommitted replacement')
        await new Promise(r => setTimeout(r, 0))
        check(suspendedRenders > 0, 'concurrent suspended render was not exercised')
        advance(); check(value.displayText === 'committed', 'aborted render mutated committed store')
        setHook('committed plus tail', true, true, undefined)
        setPair(); check(pending() === 2, 'instances do not have separate RAF chains')
        for (let i = 0; i < 60; i++) advance()
        check(/^A+$/.test(left.displayText) && /^B+$/.test(right.displayText) && right.displayText.length > left.displayText.length * 5,
          'instance text/progress is not isolated')
        unmount(); check(pending() === 0, 'unmount leaks RAF')
        return { fallback, metrics, failures }
      }, fallback)
      result.errors = errors
      console.log(JSON.stringify(result))
      if ((result.failures.length || errors.length) && !process.argv.includes('--diagnose')) process.exitCode = 1
      await page.close()
    }
  } finally { await browser.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
