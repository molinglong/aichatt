/**
 * Ask aichatt · 页面侧桥接
 * - 提供当前页/视频上下文
 * - 手动框选或整帧截图前的“暂停 + 隐藏弹幕/控制条”
 * - 选区只把坐标和上下文发给扩展，真正的截图由 service worker 调用
 *   chrome.tabs.captureVisibleTab 完成（全屏下先截后开面板）
 */
(() => {
  if (window.__aichattBridgeLoaded === chrome.runtime.id) return;
  window.__aichattBridgeLoaded = chrome.runtime.id;

  const HIDE_STYLE_ID = "__aichatt_hide_style__";
  const OVERLAY_ID = "__aichatt_overlay_host__";

  let wasPlaying = false;
  let hideSheet = null;
  let hideFallbackStyle = null;
  let hideTimer = 0;
  let overlay = null;
  let drag = null;

  function getVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    return (
      videos.find((v) => {
        const r = v.getBoundingClientRect();
        return v.readyState > 0 && r.width > 120 && r.height > 80;
      }) ||
      videos[0] ||
      null
    );
  }

  function pageTitle() {
    const node =
      document.querySelector("h1.video-title") ||
      document.querySelector(".video-title") ||
      document.querySelector("h1");
    const raw = (node && node.textContent) || document.title || "";
    return raw
      .replace(/\s*[-_]\s*哔哩哔哩.*$/i, "")
      .replace(/\s*[-_]\s*bilibili.*$/i, "")
      .trim()
      .slice(0, 160);
  }

  function getContext() {
    const video = getVideo();
    const rect = video ? video.getBoundingClientRect() : null;
    return {
      ok: true,
      title: pageTitle(),
      url: location.href,
      hasVideo: Boolean(video),
      playing: video ? !video.paused && !video.ended : false,
      currentTime: video ? video.currentTime || 0 : 0,
      duration: video ? video.duration || 0 : 0,
      videoRect: rect
        ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
        : null,
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      },
    };
  }

  function pauseForCapture(pause) {
    wasPlaying = false;
    if (pause === false) return;
    const video = getVideo();
    if (!video || video.paused || video.ended) return;
    wasPlaying = true;
    try {
      video.pause();
    } catch {
      wasPlaying = false;
    }
  }

  function resumeVideo() {
    if (!wasPlaying) return;
    wasPlaying = false;
    const video = getVideo();
    if (video && video.paused) video.play().catch(() => {});
  }

  const CONTROL_SELECTORS = [
    ".bpx-player-control-wrap",
    ".bpx-player-control-bottom",
    ".bpx-player-control-bottom-left",
    ".bpx-player-control-bottom-center",
    ".bpx-player-control-bottom-right",
    ".bpx-player-progress-wrap",
    ".bpx-player-progress-schedule",
    ".bpx-player-video-btn",
    // 全屏/暂停时才会出现的浮层：暂停键、顶部栏、提示气泡
    ".bpx-player-state-wrap",
    ".bpx-player-state-play",
    ".bpx-player-state-pause",
    ".bpx-player-top-wrap",
    ".bpx-player-toast-wrap",
    ".bilibili-player-video-control",
    ".bilibili-player-video-btn",
  ].join(",");

  const DANMAKU_SELECTORS = [
    ".bpx-player-dm-wrap",
    ".bpx-player-dm-layer",
    ".bpx-player-danmaku",
    ".bilibili-player-video-danmaku",
    ".bilibili-player-video-danmaku-wrap",
  ].join(",");

  function removeHideStyle() {
    clearTimeout(hideTimer);
    if (hideSheet) {
      try {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (sheet) => sheet !== hideSheet
        );
      } catch {}
      hideSheet = null;
    }
    if (hideFallbackStyle && hideFallbackStyle.parentNode) {
      hideFallbackStyle.parentNode.removeChild(hideFallbackStyle);
    }
    hideFallbackStyle = null;
  }

  function hidePageOverlays(hideDanmaku) {
    removeHideStyle();
    const css = `${CONTROL_SELECTORS}{display:none !important;}${
      hideDanmaku ? `${DANMAKU_SELECTORS}{display:none !important;}` : ""
    }`;
    try {
      hideSheet = new CSSStyleSheet();
      hideSheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, hideSheet];
    } catch {
      const style = document.createElement("style");
      style.id = HIDE_STYLE_ID;
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
      hideFallbackStyle = style;
    }
    // 面板若异常关闭，避免页面一直处于“控制条消失”的状态
    hideTimer = window.setTimeout(removeHideStyle, 6000);
  }

  function nextFrame() {
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  }

  function clampRect(rect, viewport) {
    const x1 = Math.max(0, Math.min(viewport.w, rect.x));
    const y1 = Math.max(0, Math.min(viewport.h, rect.y));
    const x2 = Math.max(0, Math.min(viewport.w, rect.x + rect.w));
    const y2 = Math.max(0, Math.min(viewport.h, rect.y + rect.h));
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
  }

  function fullFrameRect(ctx) {
    if (ctx.videoRect && ctx.videoRect.w > 40 && ctx.videoRect.h > 40) {
      return clampRect(ctx.videoRect, ctx.viewport);
    }
    return { x: 0, y: 0, w: ctx.viewport.w, h: ctx.viewport.h };
  }

  function showCapturedToast() {
    const fsElement = document.fullscreenElement;
    const mount =
      fsElement && fsElement.tagName !== "VIDEO"
        ? fsElement
        : document.documentElement;
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:50%;bottom:36px;transform:translateX(-50%);" +
      "z-index:2147483647;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<div style="padding:9px 15px;border-radius:999px;background:rgba(17,19,25,.94);' +
      'color:#eef1f7;font:500 12.5px/1.2 -apple-system,BlinkMacSystemFont,\'Segoe UI\',"PingFang SC",' +
      '"Microsoft YaHei",sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.4);white-space:nowrap">' +
      "截图已就绪 · 按 Alt+Shift+S 打开 Ask aichatt</div>";
    try {
      mount.appendChild(host);
      window.setTimeout(() => host.remove(), 2800);
    } catch {}
  }

  function sendRegion(rect, ctx, extra) {
    showCapturedToast();
    return chrome.runtime
      .sendMessage({
        type: "aichatt:region-selected",
        rect,
        title: ctx.title,
        url: ctx.url,
        hasVideo: ctx.hasVideo,
        currentTime: ctx.currentTime,
        duration: ctx.duration,
        viewport: ctx.viewport,
        autoPaused: wasPlaying,
        ...extra,
      })
      .catch(() => {});
  }

  async function completeFullFrame(opts) {
    // 全屏播放时直接截可见画面，不退出全屏：captureVisibleTab 拍到的就是全屏内容
    pauseForCapture(opts.pause);
    const ctx = getContext();
    const rect = fullFrameRect(ctx);
    hidePageOverlays(opts.hideDanmaku !== false);
    await nextFrame();
    await new Promise((r) => setTimeout(r, 90));
    await sendRegion(rect, ctx, { kind: "frame" });
    window.setTimeout(removeHideStyle, 5000);
  }

  function cleanupOverlay() {
    if (!overlay) return;
    try {
      window.removeEventListener("keydown", overlay.onKeyDown, true);
    } catch {}
    try {
      overlay.host.remove();
    } catch {}
    overlay = null;
    drag = null;
  }

  function cancelSelection() {
    const shouldResume = wasPlaying;
    cleanupOverlay();
    removeHideStyle();
    if (shouldResume) resumeVideo();
  }

  async function completeSelection(rect) {
    const ctx = getContext();
    const viewport = ctx.viewport;
    const safeRect = clampRect(rect, viewport);
    if (safeRect.w < 12 || safeRect.h < 12) {
      cancelSelection();
      return;
    }
    cleanupOverlay();
    hidePageOverlays(overlayOptions.hideDanmaku !== false);
    await nextFrame();
    await new Promise((r) => setTimeout(r, 90));
    await sendRegion(safeRect, ctx, { kind: "region" });
    window.setTimeout(removeHideStyle, 5000);
  }

  let overlayOptions = {};

  async function startRegionSelection(opts) {
    if (overlay) return;
    overlayOptions = opts || {};
    // 全屏播放时把选区层挂进全屏元素内部（全屏下只有该子树参与渲染），
    // 这样截图提问不用先退出全屏、打断观看。
    const fsElement = document.fullscreenElement;
    if (fsElement && fsElement.tagName === "VIDEO") {
      // <video> 自身全屏时无法在它内部挂选区层，只能退回旧行为
      try {
        await document.exitFullscreen();
      } catch {}
      await new Promise((r) => setTimeout(r, 220));
    }
    const mount =
      document.fullscreenElement && document.fullscreenElement.tagName !== "VIDEO"
        ? document.fullscreenElement
        : document.documentElement;
    pauseForCapture(opts.pause);

    const host = document.createElement("div");
    host.id = OVERLAY_ID;
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483647";
    host.style.cursor = "crosshair";
    host.style.background = "transparent";
    host.style.userSelect = "none";
    host.style.touchAction = "none";
    const shadow = host.attachShadow({ mode: "open" });

    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      *{box-sizing:border-box}
      .hint{position:absolute;top:14px;left:50%;transform:translateX(-50%);
        display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:999px;
        background:rgba(17,19,25,.92);color:#eef1f7;font:500 12.5px/1.2 -apple-system,
        BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
        box-shadow:0 8px 30px rgba(0,0,0,.35);white-space:nowrap;pointer-events:none}
      .hint b{color:#8fb0ff;font-weight:600}
      .hint kbd{font:inherit;padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.1);
        color:#c9d2e4}
      .sel{position:absolute;border:1.5px solid #7ea2ff;border-radius:3px;
        background:rgba(126,162,255,.08);box-shadow:0 0 0 9999px rgba(10,12,16,.55);
        pointer-events:none;display:none}
      .size{position:absolute;right:-1px;bottom:-24px;padding:2px 6px;border-radius:5px;
        background:#1a2030;color:#dfe6f5;font:500 11px/1.2 ui-monospace,SFMono-Regular,
        Consolas,monospace;white-space:nowrap}
    `);
    shadow.adoptedStyleSheets = [sheet];
    shadow.innerHTML =
      '<div class="hint">拖拽框选要提问的区域 <kbd>Esc</kbd> 取消</div>' +
      '<div class="sel"><span class="size"></span></div>';

    const sel = shadow.querySelector(".sel");
    const size = shadow.querySelector(".size");
    const hint = shadow.querySelector(".hint");

    // 选区层在页面里的实际原点（全屏元素可能带 transform/偏移），
    // 选区内部用局部坐标画，发给面板的 rect 再换算回视口坐标。
    function hostOrigin() {
      const r = host.getBoundingClientRect();
      return { x: r.left, y: r.top };
    }

    function updateSelection(x, y) {
      const left = Math.min(drag.sx, x);
      const top = Math.min(drag.sy, y);
      const width = Math.abs(x - drag.sx);
      const height = Math.abs(y - drag.sy);
      sel.style.display = "block";
      sel.style.left = `${left}px`;
      sel.style.top = `${top}px`;
      sel.style.width = `${width}px`;
      sel.style.height = `${height}px`;
      size.textContent = `${Math.round(width)} × ${Math.round(height)}`;
      return { x: left, y: top, w: width, h: height };
    }

    function toViewportRect(local) {
      const origin = drag ? drag.origin : hostOrigin();
      return {
        x: origin.x + local.x,
        y: origin.y + local.y,
        w: local.w,
        h: local.h,
      };
    }

    host.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const origin = hostOrigin();
        drag = {
          sx: e.clientX - origin.x,
          sy: e.clientY - origin.y,
          origin,
          id: e.pointerId,
        };
        try {
          host.setPointerCapture(e.pointerId);
        } catch {}
        hint.innerHTML = "松开完成框选 <kbd>Esc</kbd> 取消";
        updateSelection(drag.sx, drag.sy);
      },
      true
    );
    host.addEventListener(
      "pointermove",
      (e) => {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        updateSelection(e.clientX - drag.origin.x, e.clientY - drag.origin.y);
      },
      true
    );
    host.addEventListener(
      "pointerup",
      (e) => {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        const local = updateSelection(
          e.clientX - drag.origin.x,
          e.clientY - drag.origin.y
        );
        const rect = toViewportRect(local);
        drag = null;
        completeSelection(rect);
      },
      true
    );
    host.addEventListener("contextmenu", (e) => e.preventDefault(), true);
    host.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") cancelSelection();
      },
      true
    );
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    overlay = { host, onKeyDown };

    host.addEventListener(
      "pointercancel",
      () => {
        cancelSelection();
      },
      true
    );

    mount.appendChild(host);
    host.focus?.();
  }

  function retryableBiliError(message, cause) {
    const err = new Error(message);
    err.retryable = true;
    if (cause) err.cause = cause;
    return err;
  }

  function biliApiError(code, message, fallback) {
    const text = message || fallback;
    const transient =
      code === -412 ||
      code === -500 ||
      code === -503 ||
      code === -504 ||
      /风控|请求过于频繁|稍后重试/.test(text || "");
    return transient ? retryableBiliError(text) : new Error(text);
  }

  async function fetchBiliJson(url, options = {}) {
    let res;
    try {
      res = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        ...options,
      });
    } catch (err) {
      throw retryableBiliError("B 站接口网络请求失败，请稍后重试", err);
    }
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.includes("json")) {
      throw retryableBiliError(
        `B 站接口返回异常（HTTP ${res.status || "?"}），可能触发了风控，请稍后重试`
      );
    }
    try {
      return await res.json();
    } catch (err) {
      throw retryableBiliError("B 站接口返回的 JSON 无效，请稍后重试", err);
    }
  }

  async function extractBilibiliSubtitles() {
    const url = new URL(location.href);
    const bvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1];
    const epId = url.pathname.match(/\/cheese\/play\/ep(\d+)/)?.[1];
    const ssId = url.pathname.match(/\/cheese\/play\/ss(\d+)/)?.[1];
    let aid = 0;
    let cid = 0;
    let videoDuration = 0;
    let title = pageTitle();

    if (bvid) {
      const p = Math.max(1, Number(url.searchParams.get("p")) || 1);
      const view = await fetchBiliJson(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}&_t=${Date.now()}`
      );
      if (view.code !== 0) throw biliApiError(view.code, view.message, "无法读取视频信息");
      const page = view.data.pages?.[p - 1] || view.data.pages?.[0];
      aid = view.data.aid;
      cid = page?.cid || view.data.cid;
      videoDuration = Number(page?.duration || view.data.duration || 0);
      title = page?.part ? `${view.data.title} · ${page.part}` : view.data.title;
    } else if (epId) {
      const ep = await fetchBiliJson(
        `https://api.bilibili.com/pugv/view/web/episode?ep_id=${encodeURIComponent(epId)}&_t=${Date.now()}`
      );
      if (ep.code !== 0) throw biliApiError(ep.code, ep.message, "无法读取课程信息");
      const data = ep.data || {};
      aid = data.aid || data.epInfo?.aid || data.video_info?.aid;
      cid = data.cid || data.epInfo?.cid || data.video_info?.cid;
      videoDuration = Number(data.duration || data.epInfo?.duration || 0);
      title = data.title || data.epInfo?.title || title;
      if (!aid || !cid) throw new Error("课程分集信息不完整，请打开具体 EP 页面后重试");
    } else if (ssId) {
      throw new Error("请打开课程的具体一集（EP）后再总结");
    } else {
      throw new Error("当前页面不是 B 站视频页");
    }

    if (!aid || !cid) throw new Error("没有找到视频的分 P 信息");

    const player = await fetchBiliJson(
      `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}&_t=${Date.now()}`
    );
    if (player.code !== 0) throw biliApiError(player.code, player.message, "字幕接口读取失败");
    const rawSubtitles = Array.isArray(player.data?.subtitle?.subtitles)
      ? player.data.subtitle.subtitles
      : [];
    // B 站偶发返回 subtitle_url 为空的条目：先过滤再选轨，避免误报“字幕地址为空”。
    const usable = rawSubtitles.filter(
      (s) => s && typeof s.subtitle_url === "string" && s.subtitle_url.trim()
    );
    const track =
      usable.find((s) => s.lan === "ai-zh") ||
      usable.find((s) => /^zh/i.test(s.lan || "")) ||
      usable[0];
    if (!track) {
      if (rawSubtitles.length) {
        throw retryableBiliError(
          "字幕条目已返回但地址为空（B 站接口偶发异常），正在重试"
        );
      }
      throw new Error(
        player.data?.need_login_subtitle
          ? "需要先登录 B 站账号才能读取这个视频的字幕"
          : "这个视频没有可提取的 AI/CC 字幕（硬字幕需要 Whisper）"
      );
    }
    const subUrl = track.subtitle_url.startsWith("//")
      ? `https:${track.subtitle_url}`
      : track.subtitle_url;
    const subData = await fetchBiliJson(subUrl, { credentials: "omit" });
    const body = Array.isArray(subData.body) ? subData.body : [];
    const items = body
      .filter(
        (item) =>
          item && typeof item.content === "string" && item.content.trim()
      )
      .map((item) => ({
        from: Number(item.from) || 0,
        to: Number(item.to) || 0,
        content: item.content.trim(),
      }));
    if (!items.length) {
      throw retryableBiliError("字幕内容为空（B 站接口偶发异常），正在重试");
    }
    return {
      ok: true,
      title,
      url: location.href,
      lan: track.lan || "",
      lanDoc: track.lan_doc || "",
      duration: videoDuration,
      items,
      chars: items.reduce((sum, item) => sum + item.content.length, 0),
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;

    if (message.type === "aichatt:extract-subtitles") {
      extractBilibiliSubtitles()
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            retryable: Boolean(err && err.retryable),
          })
        );
      return true;
    }

    if (message.type === "aichatt:ping" || message.type === "aichatt:get-context") {
      sendResponse(getContext());
      return;
    }

    if (message.type === "aichatt:select-region") {
      startRegionSelection(message)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (message.type === "aichatt:capture-full") {
      completeFullFrame(message)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (message.type === "aichatt:restore") {
      removeHideStyle();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "aichatt:resume") {
      resumeVideo();
      sendResponse({ ok: true });
      return;
    }
  });
})();
