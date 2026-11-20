// 课堂分栏浏览器(第 2 波 2.1 骨架)——方案 design/focus-lock-plan.md §3.2,D12 定案分栏版。
//
// 布局模型:双 child 架构 —— 主聊天 webview 与 course webview 都是窗口的 child,
// 主铺满全窗口、course 盖「工具栏下方的网页区域」,bounds 永不重叠,z 序无关。
//
// 为什么主 webview 也必须是 child(2.1 实测定性):WebView2 同 parent 的 sibling
// Controller z 序随 Chromium widget 激活翻转(谁激活谁在上),窗口级 webview +
// child 并存时主 webview 一交互就盖住 course;set_focus(MoveFocus)与 show()
// 都不能可靠提顶,wry 只在 create_webview 时 SetWindowPos(HWND_TOP) 一次。
// 唯一稳态 = 两个 child 各占一侧、永不重叠。boot 期把 conf 建出的窗口级主
// webview close 掉,再 add_child 重建同 label child(tauri.conf 与安卓零改动)。
//
// spike 定案(§6 2.0,实测全绿):
// - 运行中动态 add_child 在 Windows 死锁(官方 Known issue)→ boot 期预创建,
//   且 add_child 必须在非主线程(spawn_blocking)发起;
// - 运行时只走 show/hide/set_bounds/navigate/eval 轻操作,无 controller 创建;
// - child webview 不自动跟随窗口 resize(窗口级 webview 的 WM_SIZE subclass
//   不适用)→ Moved/Resized 事件手动重算两个 webview 的 bounds;
// - on_navigation 仅主框架导航触发(子 iframe 不进回调)→ 2.2 门卫白名单插这里即可。
//
// 2.1 骨架范围:on_navigation 全放行(自由内置浏览器);2.2 在 cb_on_navigation
// 插锁定期白名单 + initialization_script 净化注入。
// 桌面专属:lib.rs 里 mod 声明与接线均带 #[cfg(desktop)]。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl, Window};

// ── 2.2 门卫白名单(锁定期;非锁定期全放行)────────────────────────────
// 白名单制:未列路径一律拒(黑名单会被 B 站新增入口穿透)。§8 拍板(2026-11-17):
// 专栏 /read 不放行。space/player 整域放行(用户空间与播放器宿主);www 按路径前缀,
// path 剥可选地区前缀(spike ⑤:/video/BV…/ 重定向 /zh-Hans/video/BV…/)。
// b23.tv = B 站官方短链域:放行入口,302 落点仍要过本门卫(直播/活动等短链
// 落到白名单外照样拒),监管口径不变(2026-11-19)。
const CB_ALLOW_HOSTS: [&str; 4] = [
    "www.bilibili.com",
    "space.bilibili.com",
    "player.bilibili.com",
    "b23.tv",
];
const CB_ALLOW_PREFIXES: [&str; 4] = ["/video/", "/list/", "/space/", "/cheese/"];
const CB_LOCALE_SEGS: [&str; 14] = [
    "zh-Hans", "zh-Hant", "en", "ja", "ko", "th", "vi", "id", "es", "pt", "fr", "de", "ru", "it",
];

fn cb_whitelisted(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if !CB_ALLOW_HOSTS.contains(&host) {
        return false;
    }
    if host != "www.bilibili.com" {
        return true;
    }
    let mut path = url.path();
    for loc in CB_LOCALE_SEGS {
        if let Some(rest) = path.strip_prefix(&format!("/{loc}/")) {
            path = rest;
            break;
        }
        if path == format!("/{loc}") {
            path = "/";
            break;
        }
    }
    CB_ALLOW_PREFIXES.iter().any(|p| path.starts_with(p))
}

// ── 2.2 净化注入(仅锁定期)───────────────────────────────────────────
// 方案 §3.2 原写 initialization_script,但 spike 定案 course webview 为 boot
// 预创建(锁可能中途才开始,init script 无运行时开关)→ 等价改走 eval 注入:
// 锁开始(面板已开)eval 一次 + on_page_load Finished(锁中)每次注入。
// 脚本幂等:html.cb-purify class 驱动 CSS,解锁摘 class 即还原(无需 reload);
// MutationObserver 防 B 站 SPA 重渲染,__cbPurify=false 时自动断开。
// 选择器 2026-11-17 对真页面 SSR HTML 核实:.bili-header = 顶栏+logo(首页入口);
// .recommend-list-v1 = 右栏相关推荐(2026-11-19 复核快照:video-page-card-small
// 均在其内,无需单藏);.recommend-list-container = 同区域另一形态。
// .bili-dialog-m/.bili-dialog-bomb = B 站全局对话框容器(活动弹窗/大会员推广,
// 2026-11-19 快照核实 ×2),锁定期属干扰,一并藏。
// .bpx-player-render-dm-wrap = 播放器弹幕层根(2026-11-19 拍板锁定期关弹幕;
// 真页核实:唯一根容器,adv/row/bas/cmd 四层全在其下,DOM 弹幕非 canvas,
// display:none 视频画面不受影响;解锁摘 class 即还原,不碰用户弹幕偏好)。
// 选择器失配静默降级,门卫兜底。
const CB_PURIFY_JS: &str = r#"(function(){
  try{
    if(window.__cbPurify===undefined){
      window.__cbPurify=true;
      var s=document.createElement('style');s.id='cb-purify-style';
      s.textContent='html.cb-purify .bili-header,html.cb-purify .recommend-list-v1,html.cb-purify .recommend-list-container,html.cb-purify .bili-dialog-m,html.cb-purify .bili-dialog-bomb,html.cb-purify .bpx-player-render-dm-wrap{display:none!important}';
      var mo=new MutationObserver(function(){
        if(!window.__cbPurify){mo.disconnect();return}
        document.documentElement.classList.add('cb-purify');
        if(!document.getElementById('cb-purify-style')){(document.head||document.documentElement).appendChild(s)}
      });
      mo.observe(document.documentElement,{childList:true,subtree:true});
    }
    if(window.__cbPurify){document.documentElement.classList.add('cb-purify')}
  }catch(e){}
})();"#;

const CB_UNPURIFY_JS: &str = r#"(function(){
  try{
    window.__cbPurify=false;
    document.documentElement.classList.remove('cb-purify');
  }catch(e){}
})();"#;

// 隐藏面板 ≠ 页面还活着:WebView2 IsVisible=false 不停媒体,收面板/锁结束
// 必须先 eval 暂停,否则「面板擦掉了视频还在响」。
const CB_PAUSE_JS: &str = r#"(function(){
  try{
    document.querySelectorAll('video,audio').forEach(function(m){try{m.pause()}catch(e){}});
  }catch(e){}
})();"#;

/// 工具栏高度(逻辑像素,与前端 CourseBrowser 玻璃条同值,两处必须同步改)
pub const TOOLBAR_H: f64 = 44.0;
/// 课程区宽度占窗口宽度比例,夹在 0.30–0.55,默认 0.40(60/40 分栏)
const SPLIT_MIN: f64 = 0.30;
const SPLIT_MAX: f64 = 0.55;
const SPLIT_DEFAULT: f64 = 0.40;

/// 面板是否打开(course webview 是否可见)
static CB_OPEN: AtomicBool = AtomicBool::new(false);
/// 预创建是否完成(boot 异步创建成功前,命令一律报「未就绪」)
static CB_READY: AtomicBool = AtomicBool::new(false);
/// 课程区宽度占比(写频率极低,Mutex 足够)
static CB_SPLIT: Mutex<f64> = Mutex::new(SPLIT_DEFAULT);
/// 当前页面地址(on_navigation 主框架导航时更新)
static CB_URL: Mutex<String> = Mutex::new(String::new());
/// 自动打开路径(锁定收紧/重启恢复)挂起的加载后暂停标记:
/// 自动恢复现场不该自带声音,加载完 eval 暂停,用户自己点播放。
static CB_AUTOPAUSE: AtomicBool = AtomicBool::new(false);

/// course webview bounds:窗口客户区右侧 split 比例、工具栏下方(逻辑坐标)。
fn cb_bounds(win: &Window, split: f64) -> Option<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let sf = win.scale_factor().ok()?;
    let sz = win.inner_size().ok()?; // 物理像素(undecorated 窗口 inner ≈ outer)
    let w = sz.width as f64 / sf;
    let h = sz.height as f64 / sf;
    let cw = (w * split).round().max(1.0);
    let x = (w - cw).round();
    Some((
        LogicalPosition::new(x, TOOLBAR_H),
        LogicalSize::new(cw, (h - TOOLBAR_H).round().max(1.0)),
    ))
}

fn cb_get_split() -> f64 {
    CB_SPLIT.lock().map(|g| *g).unwrap_or(SPLIT_DEFAULT)
}

fn cb_get_url() -> String {
    CB_URL.lock().map(|g| g.clone()).unwrap_or_default()
}

fn cb_set_url(url: &str) {
    if let Ok(mut g) = CB_URL.lock() {
        *g = url.to_string();
    }
}

/// setup 阶段调用(非阻塞):spawn_blocking 里先做主 webview 降级(cb_demote_main),
/// 再预创建 course webview(about:blank + hide)。主线程 setup 回调立即返回,
/// 事件循环起来后 controller 创建完成,blocking 线程的等待返回 —— 官方 Known
/// issue 死锁只发生在「同步命令/事件 handler 里同步等 add_child」,此形态已
/// spike 实测无死锁。
pub fn cb_boot(app: &tauri::AppHandle) {
    let app = app.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let r = cb_demote_main(&app).and_then(|_| cb_create_impl(&app));
        if let Err(e) = r {
            eprintln!("[course] boot failed: {e}");
        } else if crate::focus_lock::fl_is_locked() {
            // 2.2 重启恢复:boot 续锁且锁带 course_url → 重建面板进课程模式。
            // 放在 cb_boot 完成后是因为 fl_boot_restore(setup)先于 webview 就绪,
            // 那时 cb_show 会拿「not ready」错误 —— 这里是唯一就绪时机。
            // auto_pause=true:恢复现场不自动出声。
            if let Some(u) = crate::focus_lock::fl_boot_course_url() {
                if let Err(e) = cb_show(&app, Some(u), true) {
                    eprintln!("[course] boot restore panel failed: {e}");
                }
            }
        }
    });
    // 失败原因落日志即可;面板未就绪时前端 course_* 命令拿到明确错误
    let _ = task;
}

/// 双 child 改造第一步:把 tauri.conf 建出的窗口级主 webview 降级为 child。
/// close 旧 webview(label "main" 释放)→ add_child 同 label 重建,铺满全窗口。
/// 前端/IPC/emit_to 全部无感(URL 仍是 devUrl / frontendDist,window label 不变)。
/// 安卓不走这里(cfg(desktop)),conf 声明的窗口级 WebviewWindow 原样保留。
fn cb_demote_main(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_window("main") else {
        return Err("main window not found".into());
    };
    if let Some(old) = app.get_webview("main") {
        let _ = old.close();
        // close 是 dispatcher 调用,manager 里的移除可能异步落地:轮询等 label
        // 释放再复用,超时 5s 报错(正常路径毫秒级)
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while app.get_webview("main").is_some() {
            if std::time::Instant::now() > deadline {
                return Err("old main webview close timeout".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let sz = win.inner_size().map_err(|e| e.to_string())?;
    let builder = tauri::webview::WebviewBuilder::new(
        "main",
        // 与 tauri.conf 主窗口默认一致(dev = devUrl,生产 = frontendDist/index.html;
        // Next dev 对 /index.html 内置 redirect 到 /)
        WebviewUrl::App("index.html".into()),
    )
    // 圆角/透明窗口方案依赖 webview 透明(窗口 transparent:true + body CSS 圆角)
    .transparent(true);
    win.add_child(
        builder,
        tauri::PhysicalPosition::new(0i32, 0i32),
        tauri::PhysicalSize::new(sz.width, sz.height),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn cb_create_impl(app: &tauri::AppHandle) -> Result<(), String> {
    if CB_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    let Some(win) = app.get_window("main") else {
        return Err("main window not found".into());
    };
    let (pos, size) = cb_bounds(&win, cb_get_split()).ok_or("no bounds")?;
    let nav_app = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(
        "course",
        WebviewUrl::External("about:blank".parse().map_err(|e| format!("about:blank: {e}"))?),
    )
    .on_navigation(move |url| cb_on_navigation(&nav_app, url))
    // 2.2 净化:每次页面加载完成时若锁定期 → 注入(覆盖中途开锁后的新导航;
    // boot 期无法判锁,故 initialization_script 方案改为运行时按锁态注入)。
    // 自动打开路径的加载后暂停也挂这里(swap 消费,手动导航不受影响)。
    .on_page_load(|wv, evt| {
        if matches!(evt.event(), tauri::webview::PageLoadEvent::Finished) {
            if crate::focus_lock::fl_is_locked() {
                let _ = wv.eval(CB_PURIFY_JS);
            }
            if CB_AUTOPAUSE.swap(false, Ordering::AcqRel) {
                let _ = wv.eval(CB_PAUSE_JS);
            }
        }
    });
    let webview = win.add_child(builder, pos, size).map_err(|e| e.to_string())?;
    let _ = webview.hide();
    CB_READY.store(true, Ordering::Release);
    Ok(())
}

/// 拿已就绪的 course webview;未就绪给明确错误。
fn cb_ready_webview(app: &tauri::AppHandle) -> Result<Webview, String> {
    if !CB_READY.load(Ordering::Acquire) {
        return Err("course panel not ready".into());
    }
    app.get_webview("course")
        .ok_or_else(|| "course webview missing".into())
}

/// 主框架导航回调:2.2 门卫——锁定期白名单审核,拒绝静默(return false);
/// 拒绝时回推旧地址,前端乐观 setUrl 的地址栏弹回真值;另发 course://blocked
/// 给前端弹提示(此前纯静默,用户点不动还不知道为什么,2026-11-19 补口)。
/// 非锁定期全放行。
fn cb_on_navigation(app: &tauri::AppHandle, url: &Url) -> bool {
    if crate::focus_lock::fl_is_locked() && !cb_whitelisted(url) {
        eprintln!("[course] locked gate rejected: {url}");
        // 被拒事件(payload = 被拒地址):前端节流弹「专注中」提示
        let _ = app.emit("course://blocked", url.to_string());
        // 回推旧地址(可为空串):前端乐观 setUrl 弹回真值/空态
        let _ = app.emit("course://navigated", cb_get_url());
        // 被拒的导航不会有 load finished 事件,清掉挂起的自动暂停标记防误伤下次导航
        CB_AUTOPAUSE.store(false, Ordering::Relaxed);
        return false;
    }
    let s = url.to_string();
    cb_set_url(&s);
    // 地址栏同步:前端监听 course://navigated
    let _ = app.emit("course://navigated", s);
    true
}

/// 无 scheme 自动补 https://;非法输入报错。
fn parse_course_url(input: &str) -> Result<Url, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("empty url".into());
    }
    let s = if s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    Url::parse(&s).map_err(|e| format!("invalid url: {e}"))
}

/// 待导航地址与当前页面是否同一页(忽略 query/尾斜杠;B 站会补 vd_source 等
/// query 与地区前缀重定向,这里宽松匹配避免重开面板误重载)。
fn cb_same_page(url: &Url) -> bool {
    let cur = cb_get_url();
    if cur.is_empty() {
        return false;
    }
    let strip = |s: &str| {
        s.split('?')
            .next()
            .unwrap_or(s)
            .trim_end_matches('/')
            .to_string()
    };
    let a = strip(&cur);
    let b = strip(url.as_str());
    a == b || a.starts_with(&b) || b.starts_with(&a)
}

fn cb_set_bounds_with_split(app: &tauri::AppHandle, split: f64) -> Result<(), String> {
    let webview = cb_ready_webview(app)?;
    let win = app.get_window("main").ok_or("main window not found")?;
    let (pos, size) = cb_bounds(&win, split).ok_or("no bounds")?;
    webview
        .set_bounds(tauri::Rect {
            position: pos.into(),
            size: size.into(),
        })
        .map_err(|e| e.to_string())
}

// ── 命令面 ─────────────────────────────────────────────────────────────
// 涉及 webview 操作的命令走 async + spawn_blocking(官方 Known issue);
// course_get_state 纯读状态,同步即可。

#[tauri::command]
pub async fn course_panel_show(app: tauri::AppHandle, url: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cb_show(&app, url, false))
        .await
        .map_err(|e| e.to_string())?
}

/// auto_pause=true:自动恢复类打开(锁定收紧/重启续锁)→ 新加载完成后自动暂停,
/// 不自动出声;手动路径(重开面板/贴链接/选集)保持站点自动播放。
fn cb_show(app: &tauri::AppHandle, url: Option<String>, auto_pause: bool) -> Result<(), String> {
    let parsed = match url.as_deref() {
        Some(u) => Some(parse_course_url(u)?),
        None => None,
    };
    // 先摆 bounds(隐藏中的 webview 也合法,松手 resize/空态打开都走这里)
    cb_set_bounds_with_split(app, cb_get_split())?;
    let webview = cb_ready_webview(app)?;
    if let Some(u) = parsed {
        // 同页跳过重载:收面板时已 pause,重开直接 show 恢复原页面(进度保留、不自动播)
        if !cb_same_page(&u) {
            webview.navigate(u).map_err(|e| e.to_string())?;
            if auto_pause {
                CB_AUTOPAUSE.store(true, Ordering::Release);
            }
        }
        let _ = webview.show();
        // 双 child 后 z 序无关;set_focus 仅把键盘焦点切到课程区(看课场景合理)
        let _ = webview.set_focus();
    }
    // url=None:面板概念上打开(DOM 壳/空态由前端渲染),course webview 保持隐藏,
    // 等第一次导航(course_navigate 隐含打开)再 show —— 避免 about:blank 白屏盖住空态。
    CB_OPEN.store(true, Ordering::Release);
    // 2.2:非锁定期打开 → 摘净化(上次锁中文档残留的 cb-purify class),锁中打开则不动
    if !crate::focus_lock::fl_is_locked() {
        if let Some(wv) = app.get_webview("course") {
            let _ = wv.eval(CB_UNPURIFY_JS);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn course_panel_hide(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let webview = cb_ready_webview(&app)?;
        // 收面板先停媒体再隐藏(WebView2 隐藏不停声)
        let _ = webview.eval(CB_PAUSE_JS);
        let _ = webview.hide();
        CB_OPEN.store(false, Ordering::Release);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 回主页(启动首页):停媒体 + 隐藏 course webview + 清 CB_URL + 广播空 url,
/// 前端空态(CourseStartPage)随之显示。刻意不走 navigate(about:blank)——
/// 编程导航会过 cb_on_navigation,锁定期 gate 会拒 about:blank 并广播 blocked;
/// 隐藏态保留原页面,与收起面板状态一致,重开时 cb_same_page(cur 已空)为
/// false 必重载,不会串页。锁定期可点:主页是中性空态(入口已按白名单过滤)。
#[tauri::command]
pub async fn course_home(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        cb_set_url("");
        if let Ok(webview) = cb_ready_webview(&app) {
            let _ = webview.eval(CB_PAUSE_JS);
            let _ = webview.hide();
        }
        let _ = app.emit("course://navigated", "");
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 松手生效的分隔条:前端拖完一次性传 split(0.30–0.55),open 时重算 bounds。
#[tauri::command]
pub async fn course_panel_resize(app: tauri::AppHandle, split: f64) -> Result<(), String> {
    let split = split.clamp(SPLIT_MIN, SPLIT_MAX);
    if let Ok(mut g) = CB_SPLIT.lock() {
        *g = split;
    }
    if !CB_OPEN.load(Ordering::Acquire) {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || cb_set_bounds_with_split(&app, split))
        .await
        .map_err(|e| e.to_string())?
}

/// 窗口 Moved/Resized 时手动驱动两个 child webview 的 bounds(child 不自动跟随
/// 窗口尺寸):主聊天 webview 铺满全窗口,course 按开合态 + split 重算。
/// Resized 拖动过程中高频触发,全部是 dispatch 轻操作,无 controller 创建。
pub fn cb_on_resize(app: &tauri::AppHandle) {
    // 主聊天 webview:铺满全窗口(物理像素直传,免 scale 换算)
    if let (Some(win), Some(main_web)) = (app.get_window("main"), app.get_webview("main")) {
        if let Ok(sz) = win.inner_size() {
            let _ = main_web.set_bounds(tauri::Rect {
                position: tauri::PhysicalPosition::new(0i32, 0i32).into(),
                size: tauri::PhysicalSize::new(sz.width, sz.height).into(),
            });
        }
    }
    if !CB_OPEN.load(Ordering::Acquire) {
        return;
    }
    if let Err(e) = cb_set_bounds_with_split(app, cb_get_split()) {
        eprintln!("[course] resize recalc failed: {e}");
    }
}

#[tauri::command]
pub async fn course_navigate(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = parse_course_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || cb_navigate(&app, parsed))
        .await
        .map_err(|e| e.to_string())?
}

fn cb_navigate(app: &tauri::AppHandle, url: Url) -> Result<(), String> {
    // 面板未开时导航隐含打开(空态直接粘贴链接的场景)
    if !CB_OPEN.load(Ordering::Acquire) {
        return cb_show(app, Some(url.to_string()), false);
    }
    let webview = cb_ready_webview(app)?;
    // 不在这里预写 CB_URL:navigate 必触发 on_navigation,放行分支会 set——
    // 预写会让锁定期被拒导航把 CB_URL 污染成被拒地址,「回推旧地址」变成
    // 回推被拒地址,地址栏显示假地址(2.2 遗留,2026-11-19 修)。
    webview.navigate(url).map_err(|e| e.to_string())?;
    // 空态状态下首次导航:webview 还是隐藏的,显出来 + 焦点切到课程区
    let _ = webview.show();
    let _ = webview.set_focus();
    Ok(())
}

// 历史控制走页面内 history API:整 webview 级执行,无跨域限制(§3.2 定案)。
#[tauri::command]
pub async fn course_go_back(app: tauri::AppHandle) -> Result<(), String> {
    course_eval_js(&app, "history.back()").await
}

#[tauri::command]
pub async fn course_go_forward(app: tauri::AppHandle) -> Result<(), String> {
    course_eval_js(&app, "history.forward()").await
}

#[tauri::command]
pub async fn course_reload(app: tauri::AppHandle) -> Result<(), String> {
    course_eval_js(&app, "location.reload()").await
}

async fn course_eval_js(app: &tauri::AppHandle, js: &str) -> Result<(), String> {
    let app = app.clone();
    let js = js.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let webview = cb_ready_webview(&app)?;
        webview.eval(js).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn course_get_state() -> CourseState {
    CourseState {
        ready: CB_READY.load(Ordering::Acquire),
        open: CB_OPEN.load(Ordering::Acquire),
        split: cb_get_split(),
        url: cb_get_url(),
        locked: crate::focus_lock::fl_is_locked(),
    }
}

/// 框选截图配合(2026-11-20,方案 B 用户挑定):临时隐藏/恢复 course webview。
/// 课程区是原生子 webview,浮在主界面之上,DOM 框选层会被它整个盖住 —— 截图前
/// 先藏起来,让主 webview 的冻结帧 + 框选层可见;框完立即恢复。
/// 刻意不动 CB_OPEN / 不广播事件:DOM 壳(工具栏/空态)与分栏布局保持原样。
/// 隐藏时先暂停媒体,避免「画面看不见了声音还在」。
#[tauri::command]
pub async fn course_set_veiled(app: tauri::AppHandle, veiled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let webview = cb_ready_webview(&app)?;
        if veiled {
            let _ = webview.eval(CB_PAUSE_JS);
            webview.hide().map_err(|e| e.to_string())
        } else {
            // 防呆:框选途中面板被收起(如锁定结束 cb_on_lock_end 已 hide)或回到空态时,
            // 恢复分支不能盲目 show —— 会把已隐藏的旧页面盖回界面上。
            if CB_OPEN.load(Ordering::Acquire) && !cb_get_url().is_empty() {
                webview.show().map_err(|e| e.to_string())?;
                // hide/show 后焦点可能留在主 webview:课程区收不到鼠标输入,
                // 表现像「B 站控制条/暂停都点不动」。恢复时把焦点还给课程区。
                let _ = webview.set_focus();
                Ok(())
            } else {
                Ok(())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct CourseState {
    pub ready: bool,
    pub open: bool,
    pub split: f64,
    pub url: String,
    pub locked: bool,
}

// ── 2.2 锁定联动(focus_lock.rs 调用;桌面专属,与 mod 声明同 cfg)──────────

/// 锁定开始:带 course_url → 面板自动开 + 导航进课程模式(门卫/净化由既定
/// 机制接手);不带 → 若面板已开,对当前文档补一次净化 eval。
/// 注:course_url 非白名单(如 b23.tv 短链)会被门卫静默拒,面板停在旧文档 ——
/// v1 已知限制,2.3 弹层输入时提示贴 BV 链接。
pub fn cb_on_lock_start(app: &tauri::AppHandle, course_url: Option<String>) {
    match course_url {
        Some(u) => {
            // auto_pause=true:锁定收紧自动打开不自动出声,用户自己点播放
            if let Err(e) = cb_show(app, Some(u), true) {
                eprintln!("[course] lock-start open failed: {e}");
            }
        }
        None => {
            if CB_OPEN.load(Ordering::Acquire) {
                if let Some(wv) = app.get_webview("course") {
                    let _ = wv.eval(CB_PURIFY_JS);
                }
            }
        }
    }
}

/// 锁定结束(到点/手动停共经 fl_unlock):面板自动收起 —— 广播给前端收 DOM 壳
/// (聊天恢复全宽),再隐藏 course webview。CB_OPEN.swap 保证幂等。
pub fn cb_on_lock_end(app: &tauri::AppHandle) {
    if CB_OPEN.swap(false, Ordering::AcqRel) {
        let _ = app.emit("course://lock-ended", ());
        if let Some(wv) = app.get_webview("course") {
            // 收起先停媒体再隐藏(同 course_panel_hide:WebView2 隐藏不停声)
            let _ = wv.eval(CB_PAUSE_JS);
            let _ = wv.hide();
        }
    }
}

// ── 课堂截图提问(原型 design/preview-course-screenshot-ask.html A 案,2026-11-19)──
// WebView2 是独立原生层,DOM eval 拿不到视频帧,GDI 拷屏是唯一路:屏幕 DC BitBlt
// 截 course webview 当前物理矩形(窗口外框原点 + cb_bounds 逻辑值 × scale_factor),
// 加 CAPTUREBLT 才能把视频帧/分层窗口合成进结果。PNG 在 Rust 侧编码、base64 回传,
// 前端走 /api/upload 正常落 UploadFile 记录(Rust 直接写 public/uploads 会被孤儿
// 清扫误删)。面板未开/没加载页面报错,前端 toast 轻提示。仅 Windows 桌面实现,
// 其余平台明确报错(与 lf_exec 同法保持全平台可编译)。

#[derive(serde::Serialize)]
pub struct CourseScreenshot {
    /// PNG 整图 base64(无 data: 前缀)
    pub data: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn course_screenshot(app: tauri::AppHandle) -> Result<CourseScreenshot, String> {
    if !CB_READY.load(Ordering::Acquire) {
        return Err("course panel not ready".into());
    }
    if !CB_OPEN.load(Ordering::Acquire) {
        return Err("course panel not open".into());
    }
    if cb_get_url().is_empty() {
        return Err("course page not loaded".into());
    }
    // 拷屏 + PNG 编码是重调用(几十 ms),spawn_blocking 避免卡事件循环(面板命令同法)
    tauri::async_runtime::spawn_blocking(move || cb_screenshot_impl(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn cb_screenshot_impl(app: &tauri::AppHandle) -> Result<CourseScreenshot, String> {
    let win = app.get_window("main").ok_or("main window not found")?;
    let sf = win.scale_factor().map_err(|e| e.to_string())?;
    let (pos, size) = cb_bounds(&win, cb_get_split()).ok_or("no bounds")?;
    let outer = win.outer_position().map_err(|e| e.to_string())?;
    // undecorated 贴边壳外框原点 ≈ 客户区原点;物理矩形 = 外框原点 + 逻辑 bounds × sf
    let x = outer.x + (pos.x * sf).round() as i32;
    let y = outer.y + (pos.y * sf).round() as i32;
    let w = (size.width * sf).round() as i32;
    let h = (size.height * sf).round() as i32;
    let png = cb_capture_screen_png(x, y, w, h)?;
    use base64::Engine as _;
    Ok(CourseScreenshot {
        data: base64::engine::general_purpose::STANDARD.encode(&png),
        width: w as u32,
        height: h as u32,
    })
}

#[cfg(windows)]
fn cb_capture_screen_png(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, ROP_CODE, SRCCOPY,
    };
    if w <= 0 || h <= 0 || w > 20000 || h > 20000 {
        return Err(format!("bad capture rect {w}x{h}"));
    }
    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("screen dc unavailable".into());
        }
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        let bitmap = CreateCompatibleBitmap(screen_dc, w, h);
        let old = SelectObject(mem_dc, bitmap.into());
        // SRCCOPY 拷屏,叠加 CAPTUREBLT 把分层窗口(视频帧合成层)一起截进来
        let blit = BitBlt(
            mem_dc,
            0,
            0,
            w,
            h,
            Some(screen_dc),
            x,
            y,
            ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0),
        )
        .map_err(|e| format!("BitBlt: {e}"));
        let png = blit.and_then(|()| {
            let mut bi = BITMAPINFO::default();
            bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = w;
            bi.bmiHeader.biHeight = -h; // 负高 = top-down,首行即屏幕上缘
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            bi.bmiHeader.biCompression = BI_RGB.0;
            let mut buf = vec![0u8; w as usize * h as usize * 4];
            let copied = GetDIBits(
                screen_dc,
                bitmap,
                0,
                h as u32,
                Some(buf.as_mut_ptr().cast()),
                &mut bi,
                DIB_RGB_COLORS,
            );
            if copied == 0 {
                return Err("GetDIBits failed".into());
            }
            // 屏幕 DC 出来是 BGRA:R/B 互换 + alpha 提满(屏幕像素 alpha 无意义)
            for px in buf.chunks_exact_mut(4) {
                px.swap(0, 2);
                px[3] = 255;
            }
            let img = image::RgbaImage::from_raw(w as u32, h as u32, buf)
                .ok_or("bitmap buffer size mismatch")?;
            let mut out = std::io::Cursor::new(Vec::new());
            img.write_to(&mut out, image::ImageFormat::Png)
                .map_err(|e| format!("png encode: {e}"))?;
            Ok(out.into_inner())
        });
        // GDI 清理先行,成败都要走(句柄不还,长时间看课会漏着涨)
        let _ = SelectObject(mem_dc, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
        png
    }
}

/// 非 Windows 桌面:课堂截图暂不支持(保持全平台可编译)。
#[cfg(not(windows))]
fn cb_capture_screen_png(_x: i32, _y: i32, _w: i32, _h: i32) -> Result<Vec<u8>, String> {
    Err("课堂截图仅支持 Windows 桌面端".into())
}
