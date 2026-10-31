/**
 * Ask aichatt · 全站选中文字工具条
 * 任意网页选中文字后浮出「追问 / 解释 / 翻译 / 总结 / 复制」。
 * AI 动作把选中文字和动作交给 service worker，由它唤醒侧边栏并填入输入框。
 */
(() => {
  if (window.__aichattSelectionToolbarLoaded) return;
  window.__aichattSelectionToolbarLoaded = true;

  const HOST_ID = "aichatt-selection-toolbar-host";
  const ICONS = {
    search:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>',
    ask: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/></svg>',
    explain:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2.4 4.8.8.8 1.6 1.6 1.6 2.7V18h4v-1.5c0-1.1.8-1.9 1.6-2.7C16.8 12.6 18 11.2 18 9a6 6 0 0 0-6-6Z"/><path d="M9.5 21h5"/></svg>',
    translate:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 3.2 2.6 14.8 0 18M12 3c-2.6 3.2-2.6 14.8 0 18"/></svg>',
    summarize:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h9"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  };
  const ACTIONS = [
    { id: "search", label: "搜索" },
    { id: "ask", label: "追问" },
    { id: "explain", label: "解释" },
    { id: "translate", label: "翻译" },
    { id: "summarize", label: "总结" },
    { id: "copy", label: "复制" },
  ];

  const CSS = `
    .bar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px;
      border: 1px solid rgba(120, 120, 132, 0.28);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.78);
      color: #1d1d1f;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
      user-select: none;
      -webkit-user-select: none;
      pointer-events: auto;
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      backdrop-filter: blur(20px) saturate(180%);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72), 0 10px 28px rgba(16, 16, 20, 0.18);
      animation: aichatt-sel-in 140ms cubic-bezier(0.22, 0.7, 0.25, 1);
    }
    .notice {
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.86);
      color: #1d1d1f;
      font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      white-space: nowrap;
      pointer-events: none;
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      backdrop-filter: blur(20px) saturate(180%);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 10px 28px rgba(16, 16, 20, 0.18);
    }
    .bar button {
      all: unset;
      display: flex;
      align-items: center;
      gap: 5px;
      height: 28px;
      padding: 0 9px;
      border-radius: 999px;
      color: inherit;
      font: inherit;
      cursor: pointer;
      transition: background 140ms ease, opacity 140ms ease;
    }
    .bar button:hover,
    .bar button:focus-visible {
      background: rgba(0, 0, 0, 0.07);
      outline: none;
    }
    .bar button:active {
      transform: scale(0.97);
    }
    .bar button[disabled] {
      cursor: default;
    }
    .bar button svg {
      width: 13px;
      height: 13px;
      flex: none;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.68;
    }
    .bar button:hover svg,
    .bar button:focus-visible svg {
      opacity: 1;
    }
    .bar-sep {
      width: 1px;
      height: 16px;
      margin: 0 3px;
      background: rgba(128, 128, 140, 0.28);
    }
    .bar button.bar-close {
      width: 24px;
      height: 24px;
      padding: 0;
      gap: 0;
      justify-content: center;
      opacity: 0.62;
    }
    .bar button.bar-close svg {
      width: 11px;
      height: 11px;
    }
    .bar button.bar-close:hover {
      opacity: 1;
    }
    @media (prefers-color-scheme: dark) {
      .bar {
        border-color: rgba(255, 255, 255, 0.16);
        background: rgba(24, 24, 27, 0.78);
        color: #f2f2f4;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 12px 30px rgba(0, 0, 0, 0.45);
      }
      .bar button:hover,
      .bar button:focus-visible {
        background: rgba(255, 255, 255, 0.1);
      }
      .notice {
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: rgba(24, 24, 27, 0.82);
        color: #f2f2f4;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 12px 30px rgba(0, 0, 0, 0.45);
      }
    }
    @keyframes aichatt-sel-in {
      from { opacity: 0; transform: translateY(3px) scale(0.97); }
      to { opacity: 1; transform: none; }
    }
    @media (max-width: 520px) {
      .bar button {
        padding: 0 8px;
      }
      .bar button span {
        display: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .bar { animation: none; }
    }
  `;

  let host = null;
  let root = null;
  let bar = null;
  let notice = null;
  let updateTimer = 0;
  let copyTimer = 0;
  let noticeTimer = 0;
  let autoHideTimer = 0;
  let pointerDown = false;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let suppressUntil = 0;
  let dismissed = true;
  let toolbarEnabled = false;
  let currentText = "";
  let lastRect = null;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "all: initial; position: fixed; left: 0; top: 0; z-index: 2147483647; display: block; width: max-content; pointer-events: none;";
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    bar = document.createElement("div");
    bar.className = "bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "选中文字操作");
    bar.hidden = true;
    bar.innerHTML =
      ACTIONS.map(
        (action) =>
          `<button type="button" data-action="${action.id}" data-label="${action.label}" title="${action.label}">${ICONS[action.id] || ""}<span>${action.label}</span></button>`
      ).join("") +
      '<span class="bar-sep" aria-hidden="true"></span>' +
      '<button type="button" class="bar-close" data-close-toolbar title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
    root.appendChild(bar);

    notice = document.createElement("div");
    notice.className = "notice";
    notice.setAttribute("role", "status");
    notice.hidden = true;
    root.appendChild(notice);

    root.addEventListener(
      "pointerdown",
      (event) => {
        if (event.target.closest("[data-close-toolbar]")) {
          event.preventDefault();
          event.stopPropagation();
          suppressUntil = Date.now() + 1200;
          const selection = window.getSelection();
          if (selection) selection.removeAllRanges();
          hideBar();
        }
      },
      true
    );

    root.addEventListener("click", (event) => {
      if (event.target.closest("[data-close-toolbar]")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      runAction(button);
    });

    (document.body || document.documentElement).appendChild(host);
  }

  function isEditable(element) {
    try {
      if (element.isContentEditable) return true;
      return Boolean(
        element.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
        )
      );
    } catch {
      return false;
    }
  }

  function getSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (!anchor || !focus) return null;
    const anchorEl = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    const focusEl = focus.nodeType === 1 ? focus : focus.parentElement;
    if (!anchorEl || !focusEl) return null;
    if (isEditable(anchorEl) || isEditable(focusEl)) return null;
    if (root && (root.contains(anchorEl) || root.contains(focusEl))) return null;
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0
    );
    const rect = rects.length
      ? rects[rects.length - 1]
      : range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return null;
    return { text, rect };
  }

  function placeHost(anchorRect, box) {
    const gap = 8;
    let top = anchorRect ? anchorRect.top - box.height - gap : 12;
    if (anchorRect && top < 8) top = anchorRect.bottom + gap;
    top = Math.max(8, Math.min(top, window.innerHeight - box.height - 8));
    let left = anchorRect
      ? anchorRect.left + anchorRect.width / 2 - box.width / 2
      : (window.innerWidth - box.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  }

  function resetBar() {
    for (const button of bar.querySelectorAll("button")) {
      button.disabled = false;
      button.style.opacity = "";
      const label = button.querySelector("span");
      if (label) label.textContent = button.dataset.label || "";
    }
  }

  function showBar(rect) {
    ensureHost();
    notice.hidden = true;
    resetBar();
    const wasHidden = bar.hidden;
    bar.hidden = false;
    host.style.left = "0px";
    host.style.top = "0px";
    const barRect = bar.getBoundingClientRect();
    placeHost(rect, barRect);
    if (wasHidden) {
      clearTimeout(autoHideTimer);
      autoHideTimer = window.setTimeout(hideBar, 8000);
    }
  }

  function hideBar() {
    dismissed = true;
    clearTimeout(autoHideTimer);
    clearTimeout(copyTimer);
    // 顺手清掉旧版本/重复注入留下的同名宿主，避免叠着一条怎么都关不掉。
    document
      .querySelectorAll(`[id="${HOST_ID}"]`)
      .forEach((node) => node.remove());
    host = null;
    root = null;
    bar = null;
    notice = null;
  }

  function clearSelection() {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  }

  function showNotice(message, ms = 2400) {
    ensureHost();
    bar.hidden = true;
    notice.textContent = message;
    notice.hidden = false;
    host.style.left = "0px";
    host.style.top = "0px";
    placeHost(lastRect, notice.getBoundingClientRect());
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      notice.hidden = true;
    }, ms);
  }

  function updateBar() {
    if (!hasExtensionContext() || !toolbarEnabled) {
      hideBar();
      return;
    }
    if (pointerDown || dismissed || Date.now() < suppressUntil) return;
    const info = getSelectionInfo();
    if (!info) {
      hideBar();
      return;
    }
    currentText = info.text;
    lastRect = info.rect;
    showBar(info.rect);
  }

  function scheduleUpdate(delay = 30) {
    clearTimeout(updateTimer);
    updateTimer = window.setTimeout(updateBar, delay);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText =
        "position: fixed; left: -9999px; top: 0; opacity: 0; pointer-events: none;";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function hasExtensionContext() {
    try {
      return Boolean(globalThis.chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  async function sendToExtension(action, text) {
    try {
      if (!hasExtensionContext() || !chrome.runtime.sendMessage) {
        return {
          ok: false,
          error: "扩展已更新，请刷新本页后重试",
          needsRefresh: true,
        };
      }
      const res = await chrome.runtime.sendMessage({
        type: "aichatt:selection-action",
        action,
        text: text.slice(0, 12000),
      });
      return res || { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Extension context invalidated/i.test(message)) {
        return {
          ok: false,
          error: "扩展已更新，请刷新本页后重试",
          needsRefresh: true,
        };
      }
      return { ok: false, error: message };
    }
  }

  async function runAction(button) {
    const action = button.dataset.action;
    const text = currentText;
    if (!action || !text) return;

    if (action === "copy") {
      const ok = await copyText(text);
      if (!ok) {
        showNotice("复制失败，请手动复制");
        return;
      }
      suppressUntil = Date.now() + 900;
      const label = button.querySelector("span");
      if (label) label.textContent = "已复制";
      button.disabled = true;
      button.style.opacity = "0.55";
      clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        hideBar();
        clearSelection();
      }, 800);
      return;
    }

    suppressUntil = Date.now() + 500;
    hideBar();
    clearSelection();
    const res = await sendToExtension(action, text);
    if (!res || res.ok === false) {
      showNotice((res && res.error) || "打开侧栏失败，请点扩展图标重试");
    }
  }

  function watchDuplicateHosts() {
    const clean = () => {
      const hosts = document.querySelectorAll(`[id="${HOST_ID}"]`);
      if (!hosts.length) return;
      if (dismissed) {
        hosts.forEach((el) => {
          if (el === host && notice && !notice.hidden) return;
          el.remove();
        });
      } else if (host) {
        hosts.forEach((el) => {
          if (el !== host) el.remove();
        });
      }
    };
    const observer = new MutationObserver(clean);
    observer.observe(document.body || document.documentElement, {
      childList: true,
    });
    clean();
  }

  watchDuplicateHosts();

  // 划词工具条默认关闭（设置→划词）；关闭时本脚本只当清道夫，
  // 主动移除页面上残留的一切旧版工具条宿主。
  function applyToolbarSetting(enabled) {
    toolbarEnabled = enabled === true;
    if (!toolbarEnabled) hideBar();
  }

  function readToolbarSetting() {
    try {
      if (!hasExtensionContext() || !chrome.storage?.local) return;
      chrome.storage.local.get("settings", (res) => {
        applyToolbarSetting(Boolean(res && res.settings && res.settings.selectionToolbar));
      });
    } catch {}
  }

  try {
    if (hasExtensionContext() && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes.settings) return;
        const next = changes.settings.newValue;
        applyToolbarSetting(Boolean(next && next.selectionToolbar === true));
      });
    }
  } catch {}
  readToolbarSetting();

  document.addEventListener(
    "pointerdown",
    (event) => {
      const inside = Boolean(bar && event.composedPath().includes(bar));
      if (inside) return;
      pointerDown = true;
      suppressUntil = 0;
      hideBar();
      pointerStartX = event.clientX;
      pointerStartY = event.clientY;
      if (event.button !== 0) suppressUntil = Date.now() + 1200;
    },
    true
  );

  document.addEventListener(
    "pointerup",
    (event) => {
      pointerDown = false;
      const moved =
        Math.hypot(
          event.clientX - pointerStartX,
          event.clientY - pointerStartY
        ) > 4;
      const selection = window.getSelection();
      const current = selection ? selection.toString() : "";
      if (moved) {
        dismissed = false;
        suppressUntil = 0;
      } else {
        dismissed = true;
        if (current) suppressUntil = Date.now() + 250;
      }
      scheduleUpdate(10);
    },
    true
  );

  document.addEventListener(
    "dblclick",
    () => {
      dismissed = false;
      suppressUntil = 0;
      scheduleUpdate(60);
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (bar && event.composedPath().includes(bar)) return;
      if (event.detail >= 2) {
        dismissed = false;
        suppressUntil = 0;
        scheduleUpdate(30);
      }
    },
    true
  );

  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) hideBar();
  });

  document.addEventListener("keyup", (event) => {
    if (
      event.shiftKey ||
      /^(Arrow|Home|End|PageUp|PageDown)/.test(event.key) ||
      (event.ctrlKey && event.key.toLowerCase() === "a")
    ) {
      dismissed = false;
      suppressUntil = 0;
      scheduleUpdate(20);
    }
  });

  document.addEventListener(
    "mousedown",
    (event) => {
      if (bar && event.composedPath().includes(bar)) {
        event.preventDefault();
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") hideBar();
    },
    true
  );

  document.addEventListener("scroll", hideBar, true);
  window.addEventListener("resize", hideBar);
  window.addEventListener("blur", hideBar);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hideBar();
  });

  if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === "aichatt:hide-selection-toolbar") {
        suppressUntil = Date.now() + 1200;
        hideBar();
        sendResponse({ ok: true });
      }
    });
  }
})();
