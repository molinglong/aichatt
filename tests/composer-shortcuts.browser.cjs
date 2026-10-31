const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:3456';
const passed = [];
function ok(name) { passed.push(name); console.log('PASS', name); }
(async () => {
 const browser = await chromium.launch({headless:true,args:['--mute-audio']});
 try {
 const context = await browser.newContext({storageState:'.auth/admin.json',viewport:{width:1440,height:900}});
 // Isolated local storage; no changes to the user's open browser or server records.
 await context.addInitScript(() => {if(!sessionStorage.getItem('shortcut-test-init')){localStorage.removeItem('chat:drafts:v1');sessionStorage.setItem('shortcut-test-init','1');}});
 let payloads=[], writes=[], mode='ok', release;
 const choices=Array.from({length:4},(_,i)=>({id:'shortcut-fixture'+(i?'-'+i:''),title:'快捷入口测试资料'+(i?String(i):''),model:'fixture-model',mode:'chat'}));
 const handleRoute=async route=>{
  const req=route.request(),url=new URL(req.url());
  if(req.method()!=='GET'){
   writes.push(url.pathname);
   if(url.pathname==='/api/chat')payloads.push(req.postDataJSON());
   return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Test intercepted: no server writes'})});
  }
  if(url.pathname==='/api/conversations'&&url.searchParams.get('limit')==='20'){
   const q=url.searchParams.get('q')||'';
   const items=choices.filter(x=>x.title.includes(q));
   return route.fulfill({json:{items,total:items.length,hasMore:false}});
  }
  if(/^\/api\/conversations\/shortcut-fixture(?:-\d)?\/messages$/.test(url.pathname)){
   if(mode==='hold')await new Promise(r=>release=r);
   if(mode==='fail')return route.fulfill({status:403,json:{error:'forbidden'}});
   return route.fulfill({json:{messages:[{id:'m1',role:'user',content:'REFERENCE_BODY_SENTINEL_739',model:null,groupId:null,streaming:false}],nextCursor:null}});
  }
  return route.continue();
 };
 await context.route('**/api/**',handleRoute);
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/chat');
 if(new URL(page.url()).pathname==='/login'){
  require('dotenv').config({quiet:true});
  assert.ok(process.env.SMOKE_ADMIN_PASSWORD,'Missing configured smoke-test credentials');
  await context.route('**/api/auth/**', route=>route.continue());
  await page.locator('#email').fill(process.env.SMOKE_ADMIN_ID||'admin');
  await page.locator('#password').fill(process.env.SMOKE_ADMIN_PASSWORD);
  await page.getByRole('button',{name:/登\s*录/}).click();
  await page.waitForURL('**/chat',{timeout:60000});
 }
 const ta=page.locator('textarea');
 await expect(ta).toHaveAttribute('aria-autocomplete','list',{timeout:60000});
 const panel=page.locator('[data-composer-shortcuts]');
 const item=id=>page.locator(`[data-shortcut-id="${id}"]`);
 async function open(text){await page.waitForFunction(()=>!!document.querySelector('textarea')?.style.height);await ta.fill(text);await expect(ta).toHaveValue(text);await ta.press('End');await expect(panel).toBeVisible();}
 async function geom(label){
  await page.emulateMedia({reducedMotion:'reduce'});
  const g=await page.evaluate(()=>{const a=document.querySelector('[data-composer-anchor]'),p=document.querySelector('[data-composer-shortcuts]');const ar=a.getBoundingClientRect(),pr=p.getBoundingClientRect();return {gap:ar.top-pr.bottom,top:pr.top,left:pr.left,right:pr.right,width:innerWidth,radius:getComputedStyle(a).borderTopLeftRadius,overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.ok(Math.abs(g.gap)<0.5,JSON.stringify(g));assert.ok(g.top>=0,JSON.stringify(g));if(g.width>=768)assert.ok(parseFloat(g.radius)>0,'桌面输入框保留圆角');else assert.equal(g.radius,'0px');assert.ok(!g.overflow);
  const rowHeight=await page.locator('[data-shortcut-id]').first().evaluate(e=>e.getBoundingClientRect().height);
  assert.equal(rowHeight,g.width>=768?36:48,'桌面紧凑行高，手机触控尺寸不变');ok(label);
 }
 await open('/');await expect(item('conversation:shortcut-fixture')).toBeVisible();
 assert.equal(await page.locator('[data-shortcut-id]').first().getAttribute('data-shortcut-id'),'think');ok('/ 操作优先');
 await geom('桌面欢迎页 0px 贴合');
 const group=id=>page.locator(`[data-composer-group="${id}"]`);
 assert.deepEqual(await page.locator('[data-composer-group]').evaluateAll(es=>es.map(e=>e.dataset.composerGroup)),['action','conversation','file']);
 await expect(item('upload').locator('xpath=ancestor::*[@role="group"]')).toHaveAttribute('aria-label','文件附件');
 await expect(item('conversation:shortcut-fixture').locator('xpath=ancestor::*[@role="group"]')).toHaveAttribute('aria-label','聊天记录');ok('操作、聊天记录、文件附件独立分组');
 await expect(page.getByText('继续输入以搜索全部')).toHaveCount(0);
 const headerOrder=await page.evaluate(()=>{const p=document.querySelector('[data-composer-shortcuts]'),close=p.querySelector('[aria-label="关闭快捷面板"]'),keys=p.querySelector('[class*="keys"]');const caps=keys?[...keys.querySelectorAll('kbd')].map(e=>e.textContent):[];return {keysBeforeClose:!!keys&&keys.getBoundingClientRect().right<=close.getBoundingClientRect().left,withinHeader:!!keys&&keys.closest('div')===close.closest('div'),footer:!!p.querySelector('footer'),caps,keycapHasBorder:!!keys&&getComputedStyle(keys.querySelector('kbd')).borderTopWidth==='1px'};});
 assert.deepEqual(headerOrder,{keysBeforeClose:true,withinHeader:true,footer:false,caps:['↑','↓','Enter'],keycapHasBorder:true});ok('快捷键提示为键帽样式，位于关闭按钮左侧，底栏已删除');
 await group('conversation').click();await expect(item('conversation:shortcut-fixture')).not.toBeVisible();await expect(item('think')).toBeVisible();await expect(group('conversation').locator('..')).toHaveAttribute('aria-expanded','false');ok('聊天记录独立折叠');
 await ta.press('Escape');await open('/');await expect(item('conversation:shortcut-fixture')).not.toBeVisible();ok('重新打开保留折叠状态');
 await open('@快捷入口测试资料');await expect(item('conversation:shortcut-fixture')).toBeVisible();await group('conversation').click();await expect(item('conversation:shortcut-fixture')).not.toBeVisible();ok('搜索自动展开且仍可手动折叠');
 await open('@快捷入口测试资料1');await expect(item('conversation:shortcut-fixture-1')).toBeVisible();ok('新关键词重新展开匹配组');
 await open('/');await expect(item('conversation:shortcut-fixture')).not.toBeVisible();ok('清除搜索恢复原折叠状态');
 await group('action').click();await group('file').click();await expect(page.locator('[data-shortcut-id]:visible')).toHaveCount(0);await expect(page.getByText('没有匹配项，换个关键词试试')).toHaveCount(0);ok('全部折叠只显示分组，不误报无结果');
 await group('action').click();await group('file').click();
 await ta.focus();await ta.press('Home');await ta.press('End');await ta.press('ArrowUp');await ta.press('Enter');await expect(item('think')).not.toBeVisible();assert.equal(payloads.length,0);ok('键盘 Enter 折叠分组不发送');
 await ta.press('ArrowRight');await expect(item('think')).toBeVisible();await ta.press('ArrowLeft');await expect(item('think')).not.toBeVisible();await ta.press('ArrowRight');ok('左右键展开与折叠标题');
 const anim=await page.locator('[data-shortcut-id]').first().locator('xpath=ancestor::*[@role="treeitem"]/div[2]').evaluate(e=>{const s=getComputedStyle(e);return {rows:s.gridTemplateRows,duration:s.transitionDuration};});
 assert.ok(parseFloat(anim.duration)>0);ok('分组内容带高度伸缩过渡');
 const searchBox=page.locator('[data-composer-search]');
 await expect(searchBox).toBeVisible();
 await searchBox.fill('面具');await expect(item('masks')).toBeVisible();await expect(item('think')).toHaveCount(0);await expect(ta).toHaveValue('/');ok('面板搜索只筛选项，不改正文');
 await searchBox.fill('快捷入口测试资料');await expect(item('conversation:shortcut-fixture')).toBeVisible();await item('conversation:shortcut-fixture').click();
 await expect(page.getByRole('button',{name:'移除引用 快捷入口测试资料'})).toBeVisible();ok('面板搜索直接检索聊天记录并添加引用');
 await page.getByRole('button',{name:'移除引用 快捷入口测试资料'}).click();
 await open('/');await searchBox.fill('深度');await searchBox.press('Enter');await expect(panel).toHaveCount(0);
 await expect(page.getByText(/深度思考已(开启|关闭)/)).toBeVisible();assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'TEXTAREA');ok('搜索框 Enter 执行动作并交还焦点');
 await open('/');await searchBox.fill('zzzz');await expect(page.getByText('没有匹配项，换个关键词试试')).toBeVisible();
 await page.getByRole('button',{name:'清空搜索'}).click();await expect(ta).toHaveValue('/');await expect(item('think')).toBeVisible();ok('清空搜索恢复全部项');
 await group('conversation').click();await page.screenshot({path:'public/tmp-shots/shortcuts-groups-desktop.png',animations:'disabled'});
 await ta.fill('@');await expect(item('conversation:shortcut-fixture')).toBeVisible();
 assert.equal(await page.locator('[data-shortcut-id]').first().getAttribute('data-shortcut-id'),'conversation:shortcut-fixture');ok('@ 引用优先');
 await ta.press('Escape');await expect(panel).toHaveCount(0);ok('Esc 收起');
 for(const text of ['mail@example.com','https://a/b','/tmp/a.txt',String.fromCharCode(92)+'@abc']){await ta.fill(text);await expect(panel).toHaveCount(0);}ok('邮箱路径不误触发');
 await open('/zzzznomatch');await expect(page.getByText('没有匹配项，换个关键词试试')).toBeVisible();await ta.press('Enter');assert.equal(payloads.length,0);await expect(ta).toHaveValue('/zzzznomatch');ok('无结果 Enter 不误发');
 await ta.dispatchEvent('compositionstart');await ta.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});assert.equal(payloads.length,0);await expect(ta).toHaveValue('/zzzznomatch');await ta.dispatchEvent('compositionend');ok('IME 不误发');
 await open('/');await item('models').click();await expect(panel).toContainText('选择模型');await ta.press('ArrowDown');await ta.press('Enter');await expect(panel).toHaveCount(0);await expect(page.getByText('已切换模型：',{exact:false})).toBeVisible();ok('模型子页与键盘选择');
 await open('/面具');await item('masks').click();await expect(panel).toContainText('选择面具');
 const ids=await page.locator('[data-shortcut-id]').evaluateAll(es=>es.map(e=>e.dataset.shortcutId));assert.equal(new Set(ids).size,ids.length);await item('mask:none').click();await expect(panel).toHaveCount(0);ok('面具子页去重及执行');
 await open('/思考');await item('think').click();await expect(page.getByText(/深度思考已(开启|关闭)/)).toBeVisible();ok('深度思考操作');
 await open('/搜索');if(await item('search').count()){await item('search').click();await expect(page.getByText(/联网搜索已(开启|关闭)/)).toBeVisible();ok('联网搜索操作');}else{await ta.press('Escape');}
 await open('@文件');const chooser=page.waitForEvent('filechooser');await item('upload').click();await chooser;ok('复用文件选择器，无上传');
 async function add(){await open('@快捷入口测试资料');await item('conversation:shortcut-fixture').click();await expect(page.getByRole('button',{name:'移除引用 快捷入口测试资料'})).toBeVisible();}
 await add();await expect(ta).toHaveValue('');ok('引用真实加载函数生成标签');
 await open('@快捷入口测试资料');await item('conversation:shortcut-fixture').click();await expect(page.getByRole('button',{name:'移除引用 快捷入口测试资料'})).toHaveCount(1);ok('引用去重');
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('chat:drafts:v1')||'{}')['__new__']?.references?.length||Object.values(JSON.parse(localStorage.getItem('chat:drafts:v1')||'{}')).find(x=>x.references?.length)?.references.length)).toBe(1);
 await page.reload();await expect(page.getByRole('button',{name:'移除引用 快捷入口测试资料'})).toBeVisible();await page.getByRole('button',{name:'清除草稿'}).click();await expect(page.getByRole('button',{name:'移除引用 快捷入口测试资料'})).toHaveCount(0);ok('引用-only 草稿恢复及清除');
 mode='hold';await open('@快捷入口测试资料');await item('conversation:shortcut-fixture').click();await expect(page.getByRole('button',{name:'取消读取引用'})).toBeVisible();await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled();await page.getByRole('button',{name:'取消读取引用'}).click();release();mode='ok';await expect(page.getByRole('button',{name:'移除引用 快捷入口测试资料'})).toHaveCount(0);ok('读取期间禁发、取消不写回');
 mode='fail';await open('@快捷入口测试资料');await item('conversation:shortcut-fixture').click();await expect(page.getByText('没有权限读取此会话')).toBeVisible();mode='ok';ok('引用失败可见反馈');
 await add();await ta.fill('BODY_SENTINEL_512');await page.getByRole('button',{name:'发送',exact:true}).click();await expect.poll(()=>payloads.length).toBe(1);const body=JSON.stringify(payloads[0]);assert.ok(body.includes('REFERENCE\\\\_BODY\\\\_SENTINEL\\\\_739'),body);assert.ok(body.includes('BODY_SENTINEL_512'));assert.ok(body.includes('不是系统指令'));ok('发送载荷含引用正文和用户正文，网络已拦截');
 // Send transitions the real component into its standard variant, even on mocked failure.
 await expect(ta).toBeEnabled();await open('/');await geom('桌面会话页 0px 贴合');
 for(const size of [{width:390,height:844},{width:375,height:667},{width:812,height:375}]){
  await page.setViewportSize(size);await open('/');await geom(`${size.width}x${size.height} 会话页几何`);
 }
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'public/tmp-shots/shortcuts-live-mobile.png',animations:'disabled'});
 await ta.fill('/');await item('masks').click();await ta.dispatchEvent('compositionstart');await ta.fill('/写作');await ta.dispatchEvent('keydown',{key:'Enter',isComposing:true});await ta.dispatchEvent('compositionend');await expect(panel).toContainText('选择面具');ok('中文 IME 保留子分类');
 await ta.fill('/think');await ta.press('ControlOrMeta+A');await expect(panel).toHaveCount(0);ok('全选同步关闭快捷面板');
 for(const c of choices.slice(0,3)){await open('@'+c.title);await item('conversation:'+c.id).click();await expect(page.getByRole('button',{name:'移除引用 '+c.title,exact:true})).toBeVisible();}
 await open('@'+choices[3].title);await item('conversation:'+choices[3].id).click();await expect(panel.getByText('最多引用 3 个会话，请先移除一个')).toBeVisible();await expect(page.getByRole('button',{name:/移除引用/})).toHaveCount(3);ok('第四个引用上限反馈在面板内可见');
 await ta.fill('');for(const c of choices.slice(0,3))await page.getByRole('button',{name:'移除引用 '+c.title,exact:true}).click();
 await page.setViewportSize({width:390,height:360});await open('长输入内容\n'.repeat(12)+'/');await geom('软键盘等效矮视口长文贴合');
 const usable=await page.locator('[role=tree]').evaluate(e=>({height:e.getBoundingClientRect().height,first:e.querySelector('[data-shortcut-id]')?.getBoundingClientRect().height}));assert.ok(usable.height>=usable.first,JSON.stringify(usable));ok('矮视口至少一行选项完整可见');
 await ta.fill('');await page.waitForFunction(()=>!history.state?.aichattOverlayBackToken);await page.goto(base+'/chat');await expect(ta).toHaveAttribute('placeholder','输入问题...');
 for(const size of [{width:390,height:844},{width:375,height:667},{width:812,height:375}]){await page.setViewportSize(size);await open('/');await geom(`${size.width}x${size.height} 欢迎页几何`);}
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.documentElement.classList.add('dark'));await open('/');await page.screenshot({path:'public/tmp-shots/shortcuts-live-dark.png',animations:'disabled'});ok('正式欢迎页深色截图');
 await open('/');await item('models').click();await page.waitForFunction(()=>typeof history.state?.aichattOverlayBackToken==='number');const sentinel=await page.evaluate(()=>history.state.aichattOverlayBackToken);await page.evaluate(()=>history.back());await expect(panel).toContainText('快捷入口');await page.waitForFunction(t=>history.state?.aichattOverlayBackToken===t,sentinel);ok('JS 返回子页恢复原历史哨兵');await page.evaluate(()=>history.back());await expect(panel).toHaveCount(0);ok('JS 再次返回只关闭面板');
 const mobile=await browser.newContext({storageState:await context.storageState(),viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await mobile.addInitScript(()=>localStorage.removeItem('chat:drafts:v1'));await mobile.route('**/api/**',handleRoute);
 const touch=await mobile.newPage();touch.on('pageerror',e=>errors.push(e.message));await touch.goto(base+'/chat');const mt=touch.locator('textarea');await expect(mt).toBeVisible();await mt.fill('/思考');await touch.locator('[data-shortcut-id=think]').tap();await expect(touch.locator('[data-composer-shortcuts]')).toHaveCount(0);await expect(touch.getByText(/深度思考已(开启|关闭)/)).toBeVisible();ok('触屏点选操作');
 await mt.fill('/');await expect(touch.locator('[data-composer-shortcuts]')).toBeVisible();
 const mobileKeys=await touch.evaluate(()=>{const s=document.querySelector('[data-composer-shortcuts] [class*="keys"]');return s?getComputedStyle(s).display:'missing';});assert.equal(mobileKeys,'none');ok('手机不显示实体键盘提示');
 const msearch=touch.locator('[data-composer-search]');await expect(msearch).toBeVisible();assert.ok((await msearch.boundingBox()).height>=40);
 await msearch.fill('深度');await expect(touch.locator('[data-shortcut-id=think]')).toBeVisible();await touch.locator('[data-shortcut-id=think]').tap();await expect(touch.locator('[data-composer-shortcuts]')).toHaveCount(0);ok('手机搜索后触控执行');
 const radius=await touch.locator('[data-composer-anchor]').evaluate(e=>getComputedStyle(e).borderTopLeftRadius);assert.notEqual(radius,'0px');const buttons=touch.locator('[data-composer-anchor] button:visible');await expect(buttons).toHaveCount(2);ok('关闭后恢复圆角，手机空态仍为两钮');
 await mt.fill('@快捷入口测试资料');await touch.locator('[data-shortcut-id="conversation:shortcut-fixture"]').tap();await expect(touch.getByRole('button',{name:'移除引用 快捷入口测试资料',exact:true})).toBeVisible();await touch.getByRole('button',{name:'移除引用 快捷入口测试资料',exact:true}).tap();ok('触屏添加及移除引用');
 await mt.fill('@');const touchGroup=touch.locator('[data-composer-group=conversation]');await touchGroup.tap();await expect(touch.locator('[data-shortcut-id="conversation:shortcut-fixture"]')).not.toBeVisible();assert.ok(await touchGroup.evaluate(e=>e.getBoundingClientRect().height>=44));await touchGroup.tap();await expect(touch.locator('[data-shortcut-id="conversation:shortcut-fixture"]')).toBeVisible();ok('手机分组触控折叠，标题热区至少44px');
 await mt.fill('@文件');const mobileChooser=touch.waitForEvent('filechooser');await touch.locator('[data-shortcut-id=upload]').tap();await mobileChooser;ok('触屏文件入口');await mobile.close();
 assert.equal(errors.length,0,errors.join('\n'));ok('无浏览器运行时错误');
 console.log(JSON.stringify({passed:passed.length,interceptedWrites:[...new Set(writes)]},null,2));
 await context.close();
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
