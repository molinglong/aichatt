// Research only: real renderer/CSS reused from verify-markdown-layout, no production edits.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const http = require('node:http')
const postcss = require('postcss')
const tailwind = require('tailwindcss')
const { chromium } = require('playwright')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'test-results', 'live-prefix')
const price = '4699 + 3300 ≈ **8000 元**（B 方案），或者约 **7700 元**（A 方案双电）。'
const advice = '所以如果你要改，**改 A 方案，别改 B。** 多买一块原厂电池比换大容量第三方电池更靠谱：同一套认证、同一套 BMS、不用动线路，还能顺便解决“第二天不用等充电”的问题。'
const ending = '**一年很短，那辆 24 寸车先骑着。**'
const fixtures = [
  {name:'real-combined', text:price+'\n\n'+advice+'\n\n'+ending},
  {name:'single-newline-list', text:advice+'\n1. 原厂电池。\n2. 保留原车。\n'+ending},
  {name:'unordered-list', text:price+'\n- 原厂电池。\n- 保留原车。'},
  {name:'numeric-single-newline', text:advice+'\n'+price},
  {name:'numeric-blank-line', text:advice+'\n\n'+price},
  ...['#','-','1.','**','`','## 标题'].map((m,i)=>({name:'unfinished-'+i,text:advice+'\n'+m})),
]
async function main() {
  fs.mkdirSync(OUT,{recursive:true})
  const original=fs.readFileSync(path.join(ROOT,'scripts/verify-markdown-layout.cjs'),'utf8')
  // Keep RegExp in esbuild's realm: vm contexts fail its instanceof validation.
  const js=await new Function('require','__dirname',original.slice(0,original.indexOf('async function main()'))+'\nreturn bundle();')(require,__dirname)
  const processed=await postcss([tailwind(path.join(ROOT,'tailwind.config.ts'))]).process(fs.readFileSync(path.join(ROOT,'src/app/globals.css'),'utf8'),{from:path.join(ROOT,'src/app/globals.css')})
  processed.root.walkAtRules('import',r=>r.remove())
  const css=processed.root.toString()
  const html='<!doctype html><html lang="zh-CN" class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/fonts-subset/400/result.css"><link rel="stylesheet" href="/fonts-subset/600/result.css"><style>body{margin:0;padding:15px}#root{width:100%}#root,#root *{font-family:"PingFang SC Sub",sans-serif!important}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://localhost').pathname
    const staticData={'/':[html,'text/html; charset=utf-8'],'/app.js':[js,'text/javascript'],'/app.css':[css,'text/css']}
    if(staticData[u]) {res.setHeader('Content-Type',staticData[u][1]);res.end(staticData[u][0]);return}
    if(u.startsWith('/fonts-subset/')&&!u.includes('..')) {const f=path.join(ROOT,'public',u);if(fs.existsSync(f)){res.setHeader('Content-Type',u.endsWith('.css')?'text/css':'font/woff2');res.end(fs.readFileSync(f));return}}
    res.statusCode=404;res.end()
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  let browser
  try {
    browser=await chromium.launch()
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:2,reducedMotion:'no-preference'})
    const errors=[];page.on('pageerror',e=>errors.push(e.message))
    await page.goto('http://127.0.0.1:'+server.address().port)
    await page.evaluate(async text=>{await Promise.all([400,600].map(w=>document.fonts.load(w+' 15px "PingFang SC Sub"',text)));await document.fonts.ready},fixtures.map(f=>f.text).join(''))
    await page.evaluate(()=>{
      const ids=new WeakMap();let next=1
      const id=n=>{if(!n)return null;if(!ids.has(n))ids.set(n,next++);return ids.get(n)}
      window.snap=source=>{
        const root=document.querySelector('.rich-md'),origin=root.getBoundingClientRect();const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT)
        const chars=[];let n,cursor=0
        while(n=walker.nextNode())for(let i=0;i<n.length;i++){
          const c=n.data[i];if(/\s/.test(c))continue
          const src=source.indexOf(c,cursor);if(src>=0)cursor=src+1
          const range=document.createRange();range.setStart(n,i);range.setEnd(n,i+1);const r=range.getBoundingClientRect()
          let el=n.parentElement,opacity=1;while(el&&el!==document.body){opacity*=Number(getComputedStyle(el).opacity);el=el.parentElement}
          const sent=n.parentElement.closest('.md-sent');const block=n.parentElement.closest('p,li,h1,h2,h3,h4,blockquote')
          chars.push({c,src,x:r.x-origin.x,y:r.y-origin.y,node:id(n),sent:id(sent),block:id(block),opacity})
        }
        return {chars,html:root.innerHTML,text:root.textContent,height:origin.height,fonts:[...document.fonts].filter(f=>f.status==='loaded').length}
      }
      window.settle=()=>{document.getAnimations().forEach(a=>a.finish())}
      window.compare=(a,b)=>{
        const next=new Map(b.chars.map(c=>[c.src,c]));const deleted=[],moved=[],remounted=[],opacityDrops=[]
        for(const c of a.chars){const d=next.get(c.src);if(!d||d.c!==c.c){deleted.push(c);continue}if(Math.abs(c.x-d.x)>.2||Math.abs(c.y-d.y)>.2)moved.push({src:c.src,c:c.c,from:[c.x,c.y],to:[d.x,d.y]});if(c.node!==d.node||c.sent!==d.sent||c.block!==d.block)remounted.push({src:c.src,c:c.c,node:[c.node,d.node],sent:[c.sent,d.sent],block:[c.block,d.block]});if(d.opacity<c.opacity-.05)opacityDrops.push({src:c.src,c:c.c,from:c.opacity,to:d.opacity})}
        return {deleted,moved,remounted,opacityDrops}
      }
    })
    await page.evaluate(t=>window.renderMarkdown(t,false),advice)
    const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable')
    const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#root p'})
    const fonts=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});await cdp.detach()
    if(!fonts.fonts.some(f=>f.isCustomFont&&/PingFang/i.test(f.familyName)))throw Error('Real PingFang not active')
    const regressions=await page.evaluate(({advice,price,ending})=>{
      const failures=[];
      for(const text of [advice,price,ending]){
        const opening=text.indexOf('**'),closing=text.indexOf('**',opening+2);
        window.renderMarkdown(text.slice(0,closing),false);window.settle();
        const before=window.snap(text.slice(0,closing));
        for(const n of [1,2]){
          window.renderMarkdown(text.slice(0,closing+n),false);
          const after=window.snap(text.slice(0,closing+n));const diff=window.compare(before,after);
          if(after.text!==before.text||Object.values(diff).some(a=>a.length))failures.push({kind:'bold-close',text,n,diff});
        }
      }
      for(const marker of ['#','##','-','+','1','1.','`','``']){
        window.renderMarkdown(advice,false);window.settle();const before=window.snap(advice);
        window.renderMarkdown(advice+'\n'+marker,false);const after=window.snap(advice+'\n'+marker);
        const diff=window.compare(before,after);
        if(after.text!==before.text||Object.values(diff).some(a=>a.length))failures.push({kind:'pending-block',marker,diff});
      }
      return {failures};
    },{advice,price,ending});
    console.log('REGRESSIONS '+JSON.stringify(regressions));
    fs.writeFileSync(path.join(OUT,process.argv.includes('--diagnose')?'regression-baseline.json':'regressions.json'),JSON.stringify(regressions,null,2));
    if(regressions.failures.length&&!process.argv.includes('--diagnose'))process.exitCode=1;
    if(process.argv.includes('--targeted'))return;
    const results=[]
    for(const width of [360,390]){
      await page.setViewportSize({width,height:844})
      for(const fixture of fixtures){
        const result=await page.evaluate(async ({text,name})=>{
          window.renderMarkdown('',false);window.settle();const events=[];let previous=''
          for(let i=1;i<=text.length;i++){
            window.settle();const before=window.snap(previous);const input=text.slice(0,i)
            window.renderMarkdown(input,false)
            // Force animation initialization; finishing prior animations isolates re-entry on old text.
            const immediate=window.snap(input)
            const change=window.compare(before,immediate)
            if(Object.values(change).some(x=>x.length))events.push({i,added:text[i-1],beforeInput:previous,input,...change,before,after:immediate})
            previous=input
          }
          window.settle();return {name,prefixes:text.length,events,final:window.snap(text)}
        },fixture)
        result.width=width;results.push(result)
        console.log(JSON.stringify({name:result.name,width,prefixes:result.prefixes,events:result.events.length,deleted:result.events.filter(e=>e.deleted.length).length,moved:result.events.filter(e=>e.moved.length).length,remounted:result.events.filter(e=>e.remounted.length).length,opacityDrops:result.events.filter(e=>e.opacityDrops.length).length}))
      }
    }
    // Paint-level replay of the critical bold closing delimiter and list transition.
    const replays=[]
    const inputs=[advice.slice(0,advice.indexOf('**',10)+1),ending.slice(0,-1),advice+'\n1.',advice+'\n1. 原',price.slice(0,price.indexOf('**',16)+1)]
    for(let i=0;i<inputs.length;i++){
      const input=inputs[i],beforeInput=input.slice(0,-1)
      await page.evaluate(t=>{window.renderMarkdown('',false);window.renderMarkdown(t,false);window.settle()},beforeInput)
      await page.screenshot({path:path.join(OUT,'replay-'+i+'-before.png')})
      const replay=await page.evaluate(async ({input,beforeInput})=>{const before=window.snap(beforeInput);window.renderMarkdown(input,false);const frames=[];for(let i=0;i<4;i++){await new Promise(requestAnimationFrame);frames.push(window.snap(input))}return {input,beforeInput,before,frames,change:window.compare(before,frames[0])}},{input,beforeInput})
      await page.screenshot({path:path.join(OUT,'replay-'+i+'-after.png')});replays.push(replay)
    }
    const summary=results.map(r=>({name:r.name,width:r.width,prefixes:r.prefixes,events:r.events.length,deleted:r.events.filter(e=>e.deleted.length).length,moved:r.events.filter(e=>e.moved.length).length,remounted:r.events.filter(e=>e.remounted.length).length,opacityDrops:r.events.filter(e=>e.opacityDrops.length).length}))
    fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify({method:'One code unit per update; rich=false/live=true throughout. Preloaded actual fonts, fixed family, animation finish before next append; captures re-entry separately from ordinary initial fade. Positions relative to rich-md exclude scrolling. Source-index glyph tracking; remount means changed text/sentence/block identity, not necessarily entire paragraph.',fonts,errors,summary,results,replays},null,2))
    console.log('RESULT '+path.join(OUT,'result.json'))
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1})
