/**
 * Ask aichatt · service worker
 * - 快捷键先让页面进入框选，截完图再开侧边栏：
 *   侧边栏属于浏览器 chrome，全屏播放时打开它会直接踢出全屏，
 *   所以全屏下必须“先截后开”。
 * - 截图由 service worker 统一完成（captureVisibleTab + 裁切），
 *   面板只负责展示与提问，避免面板未打开时丢图。
 * - action 点击仍然只是打开侧边栏。
 */
const PENDING_KEY = "aichattPendingCapture";
const PENDING_SELECTION_KEY = "aichattPendingSelection";
const SHOT_KEY = "aichattPendingShot";
const MAX_IMAGE_BYTES = 3_300_000;

function enableActionSidePanel() {
  try {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  } catch {
    // 旧版本 Chrome 没有 sidePanel，忽略即可
  }
}

enableActionSidePanel();
chrome.runtime.onInstalled.addListener(enableActionSidePanel);
chrome.runtime.onStartup.addListener(enableActionSidePanel);

/** 右键菜单只做一个入口：打开 Ask aichatt 侧边栏。截图仍走面板里的按钮/快捷键。 */
function setupContextMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "aichatt-open",
        title: "问问 Ask aichatt",
        contexts: ["all"],
      });
    });
  } catch {
    // 旧版本 Chrome 或权限未生效时静默跳过，面板入口仍然可用
  }
}

setupContextMenus();
chrome.runtime.onInstalled.addListener(setupContextMenus);
chrome.runtime.onStartup.addListener(setupContextMenus);

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function getPageSettings() {
  try {
    const data = await chrome.storage.local.get("settings");
    const settings = (data && data.settings) || {};
    return {
      pause: settings.autoPause !== false,
      hideDanmaku: settings.hideDanmaku !== false,
    };
  } catch {
    return { pause: true, hideDanmaku: true };
  }
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "aichatt:ping" });
    if (res && res.ok) return true;
  } catch {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return true;
  } catch {
    return false;
  }
}

async function openPanel(windowId) {
  try {
    if (typeof windowId === "number") {
      await chrome.sidePanel.open({ windowId });
      return true;
    }
  } catch {}
  return false;
}

const SELECTION_ACTIONS = new Set([
  "search",
  "ask",
  "explain",
  "translate",
  "summarize",
]);

async function handleSelectionAction(message, sender) {
  const text = String(message.text || "").trim().slice(0, 12000);
  if (!text) return { ok: false, error: "没有选中文字" };
  const action = SELECTION_ACTIONS.has(message.action) ? message.action : "ask";
  const pending = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    action,
    text,
    ts: Date.now(),
  };

  // 必须赶在第一个 await 之前调用 sidePanel.open，否则用户手势会丢失。
  const windowId = sender.tab && sender.tab.windowId;
  let openPromise = null;
  try {
    if (typeof windowId === "number") {
      openPromise = chrome.sidePanel.open({ windowId }).then(
        () => ({ ok: true }),
        () => ({ ok: false })
      );
    }
  } catch {}

  try {
    await chrome.storage.session.set({ [PENDING_SELECTION_KEY]: pending });
  } catch {}

  let delivered = false;
  for (let attempt = 0; attempt < 3 && !delivered; attempt += 1) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "aichatt:selection-prefill",
        pending,
      });
      delivered = Boolean(res && res.ok);
    } catch {}
    if (!delivered && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  let opened = false;
  if (openPromise) {
    try {
      const result = await openPromise;
      opened = Boolean(result && result.ok);
    } catch {}
  }
  return { ok: true, delivered, opened };
}

/** 侧边栏打不开时给个角标，用户退出全屏后能看到“有截图待处理”。 */
async function flagPendingShot() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#4d7cff" });
    await chrome.action.setBadgeText({ text: "1" });
  } catch {}
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function blobToDataUrl(blob) {
  return `data:${blob.type || "image/png"};base64,${base64FromBuffer(
    await blob.arrayBuffer()
  )}`;
}

async function encodeCanvas(canvas) {
  let out = await canvas.convertToBlob({ type: "image/png" });
  if (out.size > MAX_IMAGE_BYTES * 0.55) {
    out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  }
  if (out.size > MAX_IMAGE_BYTES) {
    const scale = Math.min(
      0.85,
      Math.sqrt(MAX_IMAGE_BYTES / Math.max(1, out.size))
    );
    const next = new OffscreenCanvas(
      Math.max(1, Math.round(canvas.width * scale)),
      Math.max(1, Math.round(canvas.height * scale))
    );
    const nextCtx = next.getContext("2d");
    nextCtx.imageSmoothingQuality = "high";
    nextCtx.drawImage(canvas, 0, 0, next.width, next.height);
    canvas = next;
    out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
  }
  return {
    dataUrl: await blobToDataUrl(out),
    width: canvas.width,
    height: canvas.height,
  };
}

async function cropCapture(dataUrl, message) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const viewport = message.viewport || {
    w: bitmap.width,
    h: bitmap.height,
  };
  const viewportW = Math.max(1, Number(viewport.w) || 1);
  const viewportH = Math.max(1, Number(viewport.h) || 1);
  const scaleX = bitmap.width / viewportW;
  const scaleY = bitmap.height / viewportH;
  const rect = message.rect || { x: 0, y: 0, w: viewportW, h: viewportH };
  const sx = Math.max(0, Math.min(bitmap.width - 1, rect.x * scaleX));
  const sy = Math.max(0, Math.min(bitmap.height - 1, rect.y * scaleY));
  const sw = Math.max(1, Math.min(bitmap.width - sx, rect.w * scaleX));
  const sh = Math.max(1, Math.min(bitmap.height - sy, rect.h * scaleY));

  const canvas = new OffscreenCanvas(Math.round(sw), Math.round(sh));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  return encodeCanvas(canvas);
}

function makeShotId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function captureForMessage(message, tab) {
  const id = makeShotId();
  try {
    // 内容脚本隐藏弹幕/控制条后，让画面再稳定一帧
    await new Promise((resolve) => setTimeout(resolve, 60));
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    const cropped = await cropCapture(raw, message);
    return {
      id,
      dataUrl: cropped.dataUrl,
      width: cropped.width,
      height: cropped.height,
      title: message.title || "当前页面",
      time: Number(message.currentTime) || 0,
      kind: message.kind === "region" ? "框选" : "整帧",
      autoPaused: Boolean(message.autoPaused),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      id,
      error: detail || "截图失败",
      needsPermission: /activeTab|all_urls|Cannot access/i.test(detail),
    };
  }
}

async function deliverShot(shot, windowId) {
  // 先落 storage：面板无论“已打开”还是“稍后才打开”都能取到同一张图
  let stored = false;
  try {
    await chrome.storage.session.set({ [SHOT_KEY]: shot });
    stored = true;
  } catch {}

  let delivered = false;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "aichatt:shot-ready",
      id: shot.id,
    });
    delivered = Boolean(res && res.ok);
  } catch {}

  if (delivered) return;
  const opened = await openPanel(windowId);
  if (!opened) {
    if (stored) await flagPendingShot();
  }
}

async function handleRegionSelected(message, tab) {
  if (!tab || typeof tab.windowId !== "number") return;
  const shot = await captureForMessage(message, tab);
  try {
    // 截完立即恢复控制条/弹幕，避免页面长时间停在“隐藏态”
    await chrome.tabs.sendMessage(tab.id, { type: "aichatt:restore" });
  } catch {}
  await deliverShot(shot, tab.windowId);
}

async function fallbackOpenPanel(tab) {
  try {
    if (tab && typeof tab.windowId === "number") {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch {}
  await chrome.storage.session.set({ [PENDING_KEY]: true });
  try {
    await chrome.runtime.sendMessage({ type: "aichatt:start-capture" });
    await chrome.storage.session.remove(PENDING_KEY);
  } catch {
    // 面板还没打开/没有监听者，由 panel-ready 补发
  }
}

async function requestCapture(tabArg) {
  try {
    const tab = tabArg || (await getActiveTab());
    if (!tab || typeof tab.id !== "number") return;

    // 上一张截图还没被面板取走（例如全屏时侧边栏打不开）：
    // 再按一次快捷键先打开面板，不要重新框选。
    const pending = await chrome.storage.session.get(SHOT_KEY).catch(() => ({}));
    if (pending && pending[SHOT_KEY]) {
      await openPanel(tab.windowId);
      return;
    }

    const settings = await getPageSettings();
    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      await fallbackOpenPanel(tab);
      return;
    }
    // 关键顺序：先框选、后开面板，全屏播放不会被提前打断
    await chrome.tabs.sendMessage(tab.id, {
      type: "aichatt:select-region",
      pause: settings.pause,
      hideDanmaku: settings.hideDanmaku,
    });
  } catch (err) {
    console.warn("[aichatt] request capture failed:", err);
    await fallbackOpenPanel(tabArg || (await getActiveTab()));
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-region") requestCapture();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info || info.menuItemId !== "aichatt-open") return;
  openPanel(tab && tab.windowId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "aichatt:region-selected") {
    handleRegionSelected(message, sender.tab)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "aichatt:selection-action") {
    handleSelectionAction(message, sender)
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    return true;
  }

  if (message.type === "aichatt:panel-ready") {
    chrome.storage.session
      .get(PENDING_KEY)
      .then((data) => {
        const pending = Boolean(data && data[PENDING_KEY]);
        if (pending) chrome.storage.session.remove(PENDING_KEY);
        sendResponse({ pendingCapture: pending });
      })
      .catch(() => sendResponse({ pendingCapture: false }));
    return true;
  }
});
