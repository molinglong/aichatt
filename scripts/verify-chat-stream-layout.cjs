// Real MessageList + MessageBubble + useTypewriter + MarkdownRenderer in Chromium.
// Non-chat external services are stubbed; no API/model writes. --diagnose saves baseline.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { build } = require('esbuild')
const postcss = require('postcss')
const tailwind = require('tailwindcss')
const { chromium } = require('playwright')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'test-results', 'chat-stream-layout')
const diagnose = process.argv.includes('--diagnose')
const text = `三、**充电时间反而更长。** 40Ah 用原装 5A 充电器要充 8 小时左右。想快充得自带 10A 充电器（几百块），但旅馆和小饭馆未必肯让你用。**所以改电池换来的是“不用中途充”，不是“充得快”。** 这个区别很重要。

**总投入大概多少**

4699 + 3300 ≈ **8000 元**（B 方案），或者约 **7700 元**（A 方案双电）。

这个数已经超过二手 125 踏板了。但那辆车你现在还骑不了（要 E 照、满 18 岁），所以这笔账不能简单比。

**真正该算清的是你的使用场景**

你的需求是“小短假两天、单程 100 km 左右、到了能过夜充电”：

- **单程 100 km：** A 方案（双电轮换）中途换一块电池就能跑完，回到住宿处慢慢充，第二天换另一块回来。这**确实解决问题**，而且合规、安全。
- **单程 150 km 以上：** 三个方案都不行，还是得中途等充电。

所以如果你要改，**改 A 方案，别改 B。** 多买一块原厂电池比换大容量第三方电池更靠谱：同一套认证、同一套 BMS、不用动线路，还能顺便解决“第二天不用等充电”的问题。

**但我还是建议先别花这笔钱**

先花 500 把 24 寸车配上货架和驮包，跑两次 100–120 km 的短假。跑完你会知道自己到底想不想一年出门七八次。想，就攒钱——但攒的目标应该是**将来能考 E 照后买油摩**，而不是现在把钱押在一辆 25 km/h 的电自上。

九号这套改装花掉八千，一箱油能跑 300 km 的车就在这个价位。只是它还得等一年。

**一年很短，那辆 24 寸车先骑着。**`
async function main() {
  fs.mkdirSync(OUT, {recursive:true})
  const stubs = {
    'next/navigation':'export const usePathname=()=>"/chat";',
    'next/dynamic':'export default ()=>()=>null;',
    '@/lib/client-diagnostics':'export const useRenderProbe=()=>{};',
    // Non-chat services are out of scope: favorites count invalidation only.
    '@tanstack/react-query':`const none=()=>({invalidateQueries:()=>Promise.resolve(),refetch:()=>Promise.resolve(),fetchNextPage:()=>Promise.resolve()});
      export const useQueryClient=none;
      export const useQuery=()=>({data:undefined,isLoading:false,error:null,...none()});
      export const useInfiniteQuery=()=>({data:undefined,isLoading:false,error:null,...none()});`,
    '@/lib/toast':'export const toast={success(){},error(){},info(){}};',
    '@/store/contextMenuStore':'export const useContextMenuStore={getState:()=>({openContextMenu(){}})};',
    '@/store/chat-store':'const s={autoCollapseReasoning:true,currentConversationId:null,focusedMessageId:null,setFocusedMessageId(){}}; export const useChatStore=Object.assign(f=>f(s),{getState:()=>s});',
    '@/lib/input-bridge':'export const insertTextToInput=()=>{}; export const sendTextAsUser=()=>{};',
    './ChartCard':'export const ChartCard=()=>null;',
    './ChatImageLightbox':'export const ChatImageLightbox=()=>null;',
    './ToolCallCard':'const empty=[]; export const ToolCallCard=()=>null; export const extractToolCallViews=()=>empty; export const extractInlineImages=()=>empty;',
    './TurnFileSummary':'export const TurnFileSummary=()=>null;',
  }
  const compiled=await build({stdin:{contents:`
    import React,{useState,useEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {MessageList} from './src/components/chat/MessageList';
    import {useChatScroll} from './src/components/chat/useChatScroll';
    import {useTypewriter} from './src/lib/useTypewriter';
    const probeEl=document.createElement('div');probeEl.hidden=true;document.body.appendChild(probeEl);
    const probeRoot=createRoot(probeEl);window.hookCommits=[];
    function Probe({text,enabled,drain}){
      const value=useTypewriter(text,enabled,420,drain);
      React.useLayoutEffect(()=>{window.hookValue=value;window.hookCommits.push(value)});
      return null;
    }
    window.setHook=(text,enabled,drain=true,key='probe')=>{
      window.hookCommits=[];
      flushSync(()=>probeRoot.render(React.createElement(React.StrictMode,null,React.createElement(Probe,{text,enabled,drain,key}))));
      return {value:window.hookValue,commits:window.hookCommits.slice()};
    };
    const root=createRoot(document.getElementById('root'));
    const el=document.getElementById('scroll');
    const longHistory=Array.from({length:160},(_,i)=>({id:'history-'+i,role:i%2?'assistant':'user',parts:[{type:'text',text:('第'+i+'条历史正文。稳定的历史内容用于验证长会话回看。').repeat(i%2?35:2)}]}));
    function Harness({content,streaming,state,session,history=false}){
      const scroll=useChatScroll(el);
      React.useLayoutEffect(()=>{window.scrollApi=scroll;});
      return React.createElement(MessageList,{
        key:session,
        messages:[...(history?longHistory:[]),{id:'user-1',role:'user',parts:[{type:'text',text:'分析我的使用场景'}]},{id:'answer-1',role:'assistant',parts:[{type:'text',text:content,state}]}],
        isStreaming:streaming,virtualized:true,scrollElement:el,onNavigate:scroll.detachScroll
      });
    }
    window.setLongChat=(content,streaming=true)=>flushSync(()=>root.render(React.createElement(Harness,{content,streaming,state:streaming?'streaming':'done',session:'long',history:true})));
    Object.defineProperty(window,'follow',{get:()=>!window.scrollApi?.showScrollToBottom,set:value=>{
      if(value)window.scrollApi?.handleScrollToBottom();else window.scrollApi?.detachScroll();
    }});
    window.setChat=(content,streaming,state='streaming',session='default')=>flushSync(()=>root.render(React.createElement(Harness,{content,streaming,state,session})));
    window.inspect=()=>{
      const bubble=document.querySelector('[data-message-id="answer-1"]');
      const md=bubble?.querySelector('.rich-md');
      const p=md?.querySelector('p'); const rect=p?.getBoundingClientRect();
      return {time:window.sampleFrameTime??performance.now(),text:md?.textContent||'',height:md?.getBoundingClientRect().height||0,
        scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,
        top:rect?.top,opacity:md?getComputedStyle(md.parentElement).opacity:1,live:!!md?.classList.contains('md-live'),
        anims:md?[...md.getAnimations({subtree:true}),...md.parentElement.getAnimations()].map(a=>({name:a.animationName,time:a.currentTime})):[]};
    };
  `,resolveDir:ROOT,loader:'tsx'},absWorkingDir:ROOT,bundle:true,write:false,jsx:'automatic',platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'external-boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(stubs,a.path)?{path:a.path,namespace:'stub'}:null);b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:stubs[a.path],loader:'js'}))}}]})
  const style=await postcss([tailwind(path.join(ROOT,'tailwind.config.ts'))]).process(fs.readFileSync(path.join(ROOT,'src/app/globals.css'),'utf8'),{from:path.join(ROOT,'src/app/globals.css')});style.root.walkAtRules('import',r=>r.remove())
  const html='<!doctype html><html lang="zh-CN" class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;height:100%;}#scroll{height:90vh;overflow-y:auto;overflow-anchor:none;padding:60px 0 40px}#root{width:100%}</style></head><body><div id="scroll"><div id="root"></div></div><script src="/app.js"></script></body></html>'
  const server=http.createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(compiled.outputFiles[0].text)}else if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(style.root.toString())}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html)}})
  await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser
  try{
    const mobile=process.argv.includes('--mobile');
    browser=await chromium.launch({args:['--mute-audio']});const page=await browser.newPage({viewport:mobile?{width:493,height:1090}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port)
    const result=await page.evaluate(async text=>{
      // RAF timestamp, not post-render performance.now(): a costly previous
      // commit can make adjacent wall-clock samples only 4ms apart on a 16ms frame.
      const frame=()=>new Promise(resolve=>requestAnimationFrame(t=>{window.sampleFrameTime=t;resolve()}));const samples=[];
      window.setChat(text,true); // burst: wait for partial text before completing the stream
      const start=performance.now();
      while(performance.now()-start<500){await frame();samples.push(window.inspect())}
      const before=window.inspect();window.setChat(text,false,'done');const immediate=window.inspect();
      const finish=[];const end=performance.now();
      do{await frame();finish.push(window.inspect())}while((window.inspect().live||performance.now()-end<700)&&performance.now()-end<8000);
      // Historical remount must be complete in its first paint, not a zero-height shell.
      const final=window.inspect();window.setChat(text,false,'done','history');const history=window.inspect();
      const failures=[];
      // This fixture is an all-at-once burst, not a normal token stream. Bound
      // progress by the scheduler's 2400/s safety ceiling and actual frame time;
      // steady-stream <=250ms latency/small steps are tested in verify-typewriter-scheduler.
      // Exclude the one-time live→rich whitespace normalization.
      const seq=[...samples,...finish].filter(s=>s.live)
      const steps=seq.slice(1).map((s,i)=>s.text.length-seq[i].text.length)
      const maxStep=Math.max(0,...steps)
      if(seq.slice(1).some((s,i)=>steps[i]>Math.ceil(2400*Math.min(48,s.time-seq[i].time)/1000)+2))failures.push('typing burst exceeded time-based ceiling');
      if(final.live||!final.text.includes('先骑着。'))failures.push('tail did not finish');
      if(history.text!==final.text||history.live||Math.abs(history.height-final.height)>1)failures.push('history first render differs');
      const waitUntil=async predicate=>{const t=performance.now();while(!predicate()&&performance.now()-t<8000)await frame();if(!predicate())throw Error('state timeout')};
      // Catch up, pause, append; never restart old text. Final event may contain a new chunk.
      const first='第一段已经显示。';const second=first+'\n\n第二段继续显示。';const full=second+'\n\n'+text;
      window.follow=false;window.setChat(first,true,'streaming','chunks');
      await waitUntil(()=>window.inspect().text===first);
      window.setChat(second,true,'streaming','chunks');const resumed=window.inspect();
      if(!resumed.text.startsWith(first))failures.push('append replayed old text');
      await waitUntil(()=>window.inspect().text.includes('第二段继续显示。'));
      const preFinal=window.inspect();document.getElementById('scroll').scrollTop=0;
      window.setChat(full,false,'done','chunks');const finalChunk=window.inspect();
      if(finalChunk.text.length-preFinal.text.length>30)failures.push('final chunk flushed');
      const detached=[];await waitUntil(()=>{detached.push(window.inspect());return !window.inspect().live});
      if(detached.some(s=>s.scrollTop>1))failures.push('detached view forced to bottom');
      window.setChat(full,false,'done','chunks-history');const chunksHistory=window.inspect();
      if(detached.at(-1).text!==chunksHistory.text)failures.push('chunked tail lost content');
      window.follow=true;window.setChat(text,false,'done','screenshot');await frame();await frame();
      return {before,immediate,finish,samples,history,failures,maxStep,resumed,preFinal,finalChunk,detached};
    },text)
    result.hooks=await page.evaluate(async()=>{
      const failures=[];const cases=[];const frame=()=>new Promise(requestAnimationFrame);
      const finish=async()=>{const start=performance.now();while(window.hookValue.isTyping&&performance.now()-start<8000)await frame();if(window.hookValue.isTyping)throw Error('hook timeout')};
      const history=window.setHook('历史正文',false);cases.push({history});
      if(history.commits.some(s=>s.displayText!=='历史正文'||s.isTyping))failures.push('history hook empty');
      window.setHook('abcdef',true);await finish();
      for(const text of ['UVWXYZ','HI']){
        const reset=window.setHook(text,true);cases.push({text,reset});
        if(reset.commits.some(s=>s.displayText!==''||!s.isTyping))failures.push('replacement full-text flash');
        await finish();if(window.hookValue.displayText!==text)failures.push('replacement not synced');
      }
      window.setHook('推理内容'.repeat(100),true,false,'reasoning');await frame();
      const reasoning=window.setHook('推理内容'.repeat(100),false,false,'reasoning');cases.push({reasoning});
      if(reasoning.value.isTyping||reasoning.value.displayText.length!==400)failures.push('default disable stopped flushing');
      window.setHook('尾文'.repeat(100),true,true,'drain');await frame();
      const before=window.hookValue;const stopped=window.setHook('尾文'.repeat(100),false,true,'drain');
      if(stopped.value.displayText!==before.displayText||!stopped.value.isTyping)failures.push('drain disable flushed');
      await finish();
      const late=window.setHook('尾文'.repeat(100)+'完成后更新',false,true,'drain');
      if(late.value.isTyping||!late.value.displayText.endsWith('完成后更新'))failures.push('completed historical update animates');
      cases.push({before,stopped,late});return {failures,cases};
    });
    result.failures.push(...result.hooks.failures);
    result.longList=await page.evaluate(async()=>{
      const frame=()=>new Promise(requestAnimationFrame),intervals=[],longTasks=[];
      const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));
      observer.observe({type:'longtask',buffered:false});
      window.follow=true;window.setLongChat('');for(let i=0;i<12;i++)await frame();
      let text='',last=await frame(),maxMounted=0;
      for(let i=0;i<240;i++){
        if(i%3===0){text+='逐步追加正文。'+(i%12===0?'\n\n':'');window.setLongChat(text);}
        const time=await frame();intervals.push(time-last);last=time;
        maxMounted=Math.max(maxMounted,document.querySelectorAll('[data-message-id]').length);
      }
      window.setLongChat(text,false);
      const start=performance.now();while(window.inspect().live&&performance.now()-start<5000)await frame();
      const complete=!window.inspect().live;
      observer.disconnect();intervals.sort((a,b)=>a-b);
      return {messages:162,frames:intervals.length,p95FrameMs:Math.round(intervals[Math.floor(intervals.length*.95)]*10)/10,maxFrameMs:Math.round(Math.max(...intervals)*10)/10,longTasks:longTasks.length,maxLongTaskMs:Math.round(Math.max(0,...longTasks)),maxMounted,complete};
    });
    if(!result.longList.complete)result.failures.push('long list tail did not complete');
    if(result.longList.maxMounted>=162)result.failures.push('long list virtualizer mounted every message');
    // Actual MessageList keyboard navigation must detach before its programmatic jump.
    await page.locator('body').click({position:{x:5,y:5}});
    await page.keyboard.press('j');
    await page.evaluate(async()=>{for(let i=0;i<6;i++)await new Promise(requestAnimationFrame)});
    result.longList.keyboardDetached=await page.evaluate(()=>!window.follow);
    if(!result.longList.keyboardDetached)result.failures.push('message keyboard navigation retained auto-follow');
    await page.evaluate(text=>{window.follow=true;window.setChat(text,false,'done','screenshot')},text);
    await page.evaluate(async()=>{for(let i=0;i<6;i++)await new Promise(requestAnimationFrame)});
    const minOpacity=Math.min(...result.finish.map(x=>Number(x.opacity)))
    const burstJump=result.immediate.text.length-result.before.text.length
    console.log(JSON.stringify({beforeChars:result.before.text.length,immediateChars:result.immediate.text.length,burstJump,minOpacity,liveBefore:result.before.live,liveAfter:result.immediate.live,finalChars:result.finish.at(-1).text.length,maxStep:result.maxStep,scrollBefore:result.before.scrollTop,scrollAfter:result.finish.at(-1).scrollTop,failures:result.failures,errors}))
    fs.writeFileSync(path.join(OUT,(mobile?'mobile-':'desktop-')+(diagnose?'baseline.json':'result.json')),JSON.stringify({burstJump,minOpacity,...result,errors},null,2))
    await page.screenshot({path:path.join(OUT,mobile?'mobile.png':'desktop.png'),fullPage:true})
    if(!diagnose&&(burstJump>30||minOpacity<0.99||result.failures.length||errors.length))process.exitCode=1
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1})
