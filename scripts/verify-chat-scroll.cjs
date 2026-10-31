// Offline desktop regression: production scroll lifecycle, real Chromium input, no model calls.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { build } = require('esbuild')
const { chromium } = require('playwright')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'test-results', 'chat-scroll')
const baseline = process.argv.includes('--baseline')
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  let legacy = ''
  if (baseline) {
    const saved = path.join(OUT, 'legacy-scroll.txt')
    if (fs.existsSync(saved)) legacy = fs.readFileSync(saved, 'utf8')
    else {
      const panel = fs.readFileSync(path.join(ROOT, 'src/components/chat/ChatPanel.tsx'), 'utf8')
      legacy = panel.slice(panel.indexOf('  // 流式跟随滚动:'), panel.indexOf('  const pendingSendQueueRef'))
      if (!legacy.includes('distanceFromBottom > 24')) throw Error('Legacy baseline not found')
      fs.writeFileSync(saved, legacy)
    }
  }
  const code = `
    import React,{useState,useCallback,useRef,useEffect,useMemo} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {pinScrollToBottom,registerListFollowing} from './src/components/chat/chat-list-bridge';
    ${baseline ? '' : "import {useChatScroll} from './src/components/chat/useChatScroll';"}
    const NativeRO=window.ResizeObserver;
    window.ResizeObserver=class extends NativeRO {
      constructor(callback){super(callback);window.resizeForTest=()=>callback([],this);}
    };
    function Harness(){
      const [messagesScrollEl,setEl]=useState(null);
      const [isLoading,setLoading]=useState(true);
      const messages=[{id:'fixture'}];
      ${baseline ? legacy : 'const {showScrollToBottom,handleScrollToBottom}=useChatScroll(messagesScrollEl);'}
      useEffect(()=>{window.setLoading=setLoading;window.resume=handleScrollToBottom;window.state=()=>({detached:showScrollToBottom,top:messagesScrollEl?.scrollTop,height:messagesScrollEl?.scrollHeight});});
      return <><div id="scroll" tabIndex={0} ref={setEl} style={{height:600,overflowY:'auto',overflowAnchor:'none',width:700}}>
        <div id="content"><div id="above" style={{height:1000}}/><div data-message-id="anchor"><div className="rich-md"><p id="anchor" style={{height:80,margin:0}}>Reading anchor</p></div><div id="nested" style={{height:80,overflowY:'auto',overscrollBehavior:'contain'}}><div style={{height:400}}>Nested scroll area</div></div><div id="tail" style={{height:1000}}/></div></div>
      </div><button id="bottom" onClick={handleScrollToBottom}>Bottom</button><input id="input"/></>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
    window.frames=async(n=5)=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame)};
    window.grow=()=>{const t=document.getElementById('tail');t.style.height=(parseInt(t.style.height)+100)+'px'};
  `
  const result = await build({stdin:{contents:code,loader:'tsx',resolveDir:ROOT},absWorkingDir:ROOT,bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'}})
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?result.outputFiles[0].text:'<!doctype html><html><head><style>#scroll::-webkit-scrollbar{width:14px}#scroll::-webkit-scrollbar-thumb{background:#888}</style></head><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>')})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  let browser
  try {
    // Playwright hides scrollbars by default: remove that flag to exercise a real native thumb.
    browser=await chromium.launch({args:['--mute-audio'],ignoreDefaultArgs:['--hide-scrollbars']})
    const page=await browser.newPage({viewport:{width:1440,height:900}})
    const errors=[];page.on('pageerror',e=>errors.push(e.message))
    await page.goto('http://127.0.0.1:'+server.address().port)
    await page.waitForFunction(()=>window.resume&&window.state()?.height>1000)
    await page.evaluate(()=>window.frames(10))
    const cases=[]
    const check=async(name,fn)=>{const data=await fn();cases.push({name,...data});console.log(JSON.stringify(cases.at(-1)))}
    for(const amount of [1,20,100]) await check('wheel-up-'+amount,async()=>{
      await page.evaluate(()=>window.resume());await page.evaluate(()=>window.frames())
      await page.mouse.move(300,400);await page.mouse.wheel(0,-amount);await page.evaluate(()=>window.frames())
      const before=await page.evaluate(()=>window.state());await page.evaluate(()=>window.grow());await page.evaluate(()=>window.frames())
      const after=await page.evaluate(()=>window.state());return {pass:before.detached&&after.detached&&Math.abs(after.top-before.top)<=2,before,after}
    })
    await check('shrink-does-not-resume',async()=>{
      await page.evaluate(()=>window.resume());await page.evaluate(()=>window.frames());await page.mouse.wheel(0,-100);await page.evaluate(()=>window.frames())
      await page.evaluate(()=>{const el=document.getElementById('scroll'),tail=document.getElementById('tail');tail.style.height=(parseInt(tail.style.height)-(el.scrollHeight-el.scrollTop-el.clientHeight)-5)+'px'})
      await page.evaluate(()=>window.frames());const after=await page.evaluate(()=>window.state());return {pass:after.detached,after}
    })
    await check('loading-toggle-does-not-resume',async()=>{
      await page.evaluate(()=>window.setLoading(false));await page.evaluate(()=>window.frames());await page.evaluate(()=>window.setLoading(true));await page.evaluate(()=>window.frames());const after=await page.evaluate(()=>window.state());return {pass:after.detached,after}
    })
    await check('page-up-detaches',async()=>{
      await page.evaluate(()=>window.resume());await page.locator('#scroll').focus();await page.keyboard.press('PageUp');await page.evaluate(()=>window.frames(15));const after=await page.evaluate(()=>window.state());return {pass:after.detached,after}
    })
    await check('nested-scroll-isolated',async()=>{
      const height=await page.locator('#tail').evaluate(e=>e.style.height)
      await page.evaluate(()=>{document.getElementById('tail').style.height='100px';window.resume()});await page.evaluate(()=>window.frames())
      await page.locator('#nested').evaluate(e=>e.scrollTop=100)
      const box=await page.locator('#nested').boundingBox()
      const before=await page.evaluate(()=>window.state())
      await page.mouse.move(box.x+100,box.y+40);await page.mouse.wheel(0,-20);await page.evaluate(()=>window.frames(10))
      const after=await page.evaluate(()=>window.state()),inner=await page.locator('#nested').evaluate(e=>e.scrollTop)
      await page.locator('#tail').evaluate((e,h)=>e.style.height=h,height);await page.evaluate(()=>window.frames())
      return {pass:!before.detached&&!after.detached&&Math.abs(after.top-before.top)<=2&&inner<100,before,after,inner}
    })
    await check('input-keyboard-isolated',async()=>{
      await page.evaluate(()=>window.resume());await page.evaluate(()=>window.frames());await page.locator('#input').focus()
      const before=await page.evaluate(()=>window.state());await page.keyboard.press('ArrowUp');await page.keyboard.press('Home');await page.evaluate(()=>window.frames())
      const after=await page.evaluate(()=>window.state());return {pass:!after.detached&&after.top===before.top,before,after}
    })
    await check('wheel-and-resize-same-frame',async()=>{
      await page.evaluate(()=>{window.resume();document.getElementById('scroll').addEventListener('wheel',()=>window.grow(),{once:true})});await page.evaluate(()=>window.frames())
      const before=await page.evaluate(()=>window.state());await page.mouse.move(300,400);await page.mouse.wheel(0,-20);await page.evaluate(()=>window.frames(10))
      const after=await page.evaluate(()=>window.state());return {pass:after.detached&&after.top<before.top,before,after}
    })
    await check('scrollbar-drag-detaches',async()=>{
      await page.evaluate(()=>window.resume());await page.evaluate(()=>window.frames())
      const before=await page.evaluate(()=>window.state()),box=await page.locator('#scroll').boundingBox()
      await page.mouse.move(box.x+box.width-6,box.y+box.height-45);await page.mouse.down();await page.mouse.move(box.x+box.width-6,box.y+250,{steps:12});await page.mouse.up();await page.evaluate(()=>window.frames(10))
      const after=await page.evaluate(()=>window.state());return {pass:after.detached&&after.top<before.top,before,after}
    })
    await check('down-at-bottom-resumes',async()=>{
      await page.evaluate(()=>window.resume());await page.mouse.move(300,400);await page.mouse.wheel(0,-100);await page.evaluate(()=>window.frames());await page.mouse.wheel(0,1000);await page.evaluate(()=>window.frames(15));const after=await page.evaluate(()=>window.state());return {pass:!after.detached,after}
    })
    await check('down-at-bottom-with-pending-resize',async()=>{
      await page.evaluate(()=>window.resume());await page.mouse.move(300,400);await page.mouse.wheel(0,-100);await page.evaluate(()=>window.frames())
      // Deterministic browser event ordering: RO schedules RAF, then the user's
      // downward default scroll reaches bottom before that RAF is allowed to run.
      await page.evaluate(()=>{const el=document.getElementById('scroll');window.resizeForTest();el.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}));el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'))})
      await page.evaluate(()=>window.frames());const after=await page.evaluate(()=>window.state());return {pass:!after.detached,after}
    })
    await check('paragraph-anchor-survives-resize',async()=>{
      await page.evaluate(()=>window.resume());await page.mouse.wheel(0,-100);await page.evaluate(()=>window.frames());
      await page.evaluate(()=>{const el=document.getElementById('scroll');el.scrollTop=1000});await page.evaluate(()=>window.frames());
      const before=await page.locator('#anchor').evaluate(e=>e.getBoundingClientRect().top)
      await page.evaluate(()=>{document.getElementById('above').style.height='1120px'});await page.evaluate(()=>window.frames(10));
      const after=await page.locator('#anchor').evaluate(e=>e.getBoundingClientRect().top);return {pass:Math.abs(after-before)<=2,before,after}
    })
    await page.screenshot({path:path.join(OUT,baseline?'baseline.png':'desktop.png')})
    fs.writeFileSync(path.join(OUT,baseline?'baseline.json':'result.json'),JSON.stringify({baseline,cases,errors},null,2))
    if(errors.length||cases.some(c=>!c.pass))process.exitCode=1
  } finally {if(browser)await browser.close();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1})
