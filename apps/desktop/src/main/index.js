'use strict';
/**
 * Electron 主进程：托盘常驻、全局快捷键、剪贴板、网关调用与 WS 推送。
 * client_token 只存在于主进程，渲染层拿不到。
 */
const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, nativeImage, dialog, ipcMain, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
// 生成客户档案 Excel 用；缺了也不让整个窗口起不来，会自动降级为只存 JSON
let XLSX = null;
try { XLSX = require('xlsx'); } catch (_) {}

const ROOT = path.resolve(__dirname, '../../../..');
const RENDERER = path.join(__dirname, '../renderer/index.html');
const ICON = path.join(__dirname, '../../assets/icon.png');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SERVER = path.join(ROOT, 'apps', 'gateway', 'src', 'server.ts');

function readEnv() {
  const out = {};
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 1) continue;
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}
const ENV = readEnv();
const GATEWAY_URL = process.env.GATEWAY_URL || ENV.GATEWAY_URL || 'http://127.0.0.1:8787';
const CLIENT_TOKEN = process.env.CLIENT_TOKEN || ENV.CLIENT_TOKEN || 'dev-client-token-change-me';

let win = null;
let tray = null;
let ws = null;

/**
 * 只允许一个桌面实例常驻。
 * 之前「重启程序」会留下旧进程，旧进程抢先注册了 Ctrl+Shift+X，
 * 新进程注册失败就静默改用 K —— 用户按 X 当然没反应。
 */
const GOT_LOCK = app.requestSingleInstanceLock();
if (!GOT_LOCK) app.quit();

// 当前真正生效的唤起快捷键；X 被占用时自动换键，托盘与界面同步显示
const HOTKEY = 'CommandOrControl+Shift+X';
const HOTKEY_CHOICES = [
  { key: HOTKEY, label: 'Ctrl+Shift+X' },
  { key: 'CommandOrControl+Shift+K', label: 'Ctrl+Shift+K' },
  { key: 'CommandOrControl+Shift+Y', label: 'Ctrl+Shift+Y' },
  { key: 'CommandOrControl+Shift+U', label: 'Ctrl+Shift+U' },
];
let hotkeyLabel = 'Ctrl+Shift+X';
let hotkeyKey = null;
let hotkeyBlocked = false;
let hotkeyPinned = null; // 用户在托盘里手动指定的键，记住后不再自动抢回 X
let hotkeyTimer = null;

function hotkeyFile() {
  return path.join(app.getPath('userData'), 'hotkey.json');
}
function readPreferredHotkey() {
  try {
    const key = JSON.parse(fs.readFileSync(hotkeyFile(), 'utf8')).key;
    return HOTKEY_CHOICES.some((c) => c.key === key) ? key : null;
  } catch (_) { return null; }
}
function savePreferredHotkey(key) {
  try {
    fs.writeFileSync(hotkeyFile(), JSON.stringify(key ? { key } : {}), 'utf8');
  } catch (_) {}
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function sendFrame(requestId, frame) {
  send('bridge:frame', { requestId, frame });
}
function headers() {
  return { Authorization: `Bearer ${CLIENT_TOKEN}`, 'Content-Type': 'application/json' };
}

/** 记住用户手动拉过的窗口大小和位置，下次启动还是那个尺寸 */
function boundsFile() {
  return path.join(app.getPath('userData'), 'window-bounds.json');
}
function readBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    if (b && Number.isFinite(b.width) && Number.isFinite(b.height) && b.width >= 400 && b.height >= 480) return b;
  } catch (_) {}
  return null;
}
function onScreen(x, y) {
  try {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x >= a.x - 40 && y >= a.y - 40 && x < a.x + a.width - 40 && y < a.y + a.height - 40;
    });
  } catch (_) { return false; }
}
let saveBoundsTimer = null;
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    try {
      if (win && !win.isDestroyed()) fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds()), 'utf8');
    } catch (_) {}
  }, 400);
}

function createWindow() {
  const saved = readBounds();
  const keepPos = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && onScreen(saved.x, saved.y);
  win = new BrowserWindow({
    width: saved ? saved.width : 460,
    height: saved ? saved.height : 740,
    minWidth: 400,
    minHeight: 480,
    ...(keepPos ? { x: saved.x, y: saved.y } : {}),
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    title: '客服回复助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(RENDERER);
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  // 重启完成后给新窗口一句中文交代，免得用户以为「点完没反应」
  win.webContents.once('did-finish-load', () => {
    // 稍等一下，等渲染层把 IPC 监听注册好再发，避免提示丢失
    if (process.argv.includes('--restarted')) setTimeout(() => send('bridge:restarted', { ok: true }), 800);
  });
  // 常驻显示：不再监听 blur。鼠标点别的地方、切到微信 / 浏览器都不会让窗口消失，
  // 只有再按唤起快捷键、或点窗口右上角 × 才会隐藏。
  win.on('closed', () => {
    win = null;
  });
}

/** 显示并聚焦（不切换隐藏状态） */
function showWindow() {
  if (!win) createWindow();
  if (!win.isVisible()) win.show();
  win.focus();
}

/** 唯一的隐藏 / 显示开关：只有唤起快捷键走这里 */
function toggleWindow() {
  if (!win) createWindow();
  if (win.isVisible()) win.hide();
  else showWindow();
}

/** 托盘菜单单独抽出来：换键后重建，菜单上写的永远是「真正生效」的那个键 */
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: `显示 / 隐藏（${hotkeyLabel}）`, click: toggleWindow },
    { type: 'separator' },
    {
      label: hotkeyBlocked ? `唤起快捷键（X 被占用，当前 ${hotkeyLabel}）` : '唤起快捷键',
      submenu: [
        ...HOTKEY_CHOICES.map((c) => ({
          label: c.label + (c.key === HOTKEY ? '（默认）' : ''),
          type: 'radio',
          checked: c.key === hotkeyKey,
          click: () => pinHotkey(c.key),
        })),
        { type: 'separator' },
        {
          label: '重新尝试 Ctrl+Shift+X',
          click: () => {
            hotkeyPinned = null;
            savePreferredHotkey(null);
            retryPrimaryHotkey(true);
          },
        },
      ],
    },
    { label: '窗口常驻显示 · 点别处不会消失', enabled: false },
    { type: 'separator' },
    { label: '重启程序', click: () => { doRestart().catch(() => {}); } },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: true,
      click: (item) => win && win.setAlwaysOnTop(item.checked),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

/* ============ 唤起快捷键：注册 / 换键 / 自动抢回 X ============ */

function hotkeyStatus() {
  return { label: hotkeyLabel, key: hotkeyKey, blocked: hotkeyBlocked };
}

function refreshHotkeyUI() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
    // 只有真正用上 X 时才显示这句（自检脚本也会核对这个提示）
    tray.setToolTip(hotkeyBlocked
      ? `客服回复助手 — Ctrl+Shift+X 被占用，当前按 ${hotkeyLabel} 唤起（托盘可改）`
      : '客服回复助手 — 按 Ctrl+Shift+X 唤起');
  }
  send('bridge:hotkey', hotkeyStatus());
}

/** 按「用户指定 → X → 其它候选」的顺序试注册，成功即同步托盘与界面 */
function registerHotkey(preferredKey) {
  const order = [];
  const first = HOTKEY_CHOICES.find((c) => c.key === preferredKey);
  if (first) order.push(first);
  for (const c of HOTKEY_CHOICES) if (!order.includes(c)) order.push(c);
  if (hotkeyKey) {
    try { globalShortcut.unregister(hotkeyKey); } catch (_) {}
  }
  hotkeyKey = null;
  for (const c of order) {
    try {
      if (globalShortcut.register(c.key, toggleWindow)) {
        hotkeyKey = c.key;
        hotkeyLabel = c.label;
        hotkeyBlocked = c.key !== HOTKEY;
        refreshHotkeyUI();
        return true;
      }
    } catch (_) {}
  }
  hotkeyLabel = '无（请点托盘图标）';
  hotkeyBlocked = true;
  refreshHotkeyUI();
  return false;
}

function pinHotkey(key) {
  hotkeyPinned = key;
  savePreferredHotkey(key);
  registerHotkey(key);
  scheduleHotkeyRetry();
}

/** 只试着把 X 抢回来：占用者一退出就自动切回 X，不用重启程序 */
function retryPrimaryHotkey(force) {
  if (!force && (hotkeyPinned || hotkeyKey === HOTKEY)) return true;
  try {
    if (globalShortcut.register(HOTKEY, toggleWindow)) {
      if (hotkeyKey && hotkeyKey !== HOTKEY) {
        try { globalShortcut.unregister(hotkeyKey); } catch (_) {}
      }
      hotkeyKey = HOTKEY;
      hotkeyLabel = 'Ctrl+Shift+X';
      hotkeyBlocked = false;
      refreshHotkeyUI();
      return true;
    }
  } catch (_) {}
  return false;
}

/** X 仍被占用时每 5 秒静默重试一次，抢回后自动停止 */
function scheduleHotkeyRetry() {
  clearTimeout(hotkeyTimer);
  if (hotkeyPinned || hotkeyKey === HOTKEY) return;
  hotkeyTimer = setTimeout(() => {
    if (!retryPrimaryHotkey(false)) scheduleHotkeyRetry();
  }, 5000);
}

function connectPush() {
  if (typeof WebSocket === 'undefined') return; // Node 18 以下的 Electron 直接跳过推送
  const url = `${GATEWAY_URL.replace(/^http/, 'ws')}/ws/stream?token=${encodeURIComponent(CLIENT_TOKEN)}`;
  try {
    ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(String(ev.data));
        if (frame.type === 'push') send('bridge:push', frame);
      } catch (_) {}
    };
    ws.onclose = () => {
      ws = null;
      if (!app.isQuitting) setTimeout(connectPush, 3000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch (_) {}
    };
  } catch (_) {
    if (!app.isQuitting) setTimeout(connectPush, 3000);
  }
}

/** 后台服务是否还活着（「一键启动.bat」的黑窗口可能被顺手关掉了） */
async function gatewayAlive() {
  try {
    const r = await fetch(GATEWAY_URL + '/v1/health', { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch (_) { return false; }
}

/**
 * 顶部 / 托盘的「重启程序」：
 *   ① 后台服务没开就顺手补启（和一键启动用的是同一条命令，端口已被占用时不会重复起）；
 *   ② 真正重启整个 Electron 程序，不是只刷新页面；
 *   ③ 先把结果回给界面，延迟一点再退出，让中文提示来得及显示。
 */
async function doRestart() {
  let revived = false;
  if (!(await gatewayAlive()) && fs.existsSync(TSX) && fs.existsSync(SERVER)) {
    try {
      const child = spawn(process.execPath, [TSX, SERVER], {
        cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await gatewayAlive()) { revived = true; break; }
      }
    } catch (_) { /* 服务起不来也不挡住窗口重启，界面会自己提示 */ }
  }
  setTimeout(() => {
    try { if (ws) ws.close(); } catch (_) {}
    // 用绝对路径重新启动，避免原来的相对路径在新工作目录下失效
    const args = [path.join(ROOT, 'apps', 'desktop'), '--restarted'];
    app.relaunch({ args });
    app.exit(0);
  }, 900);
  return {
    ok: true,
    gateway_restarted: revived,
    message: revived
      ? '正在重启：后台服务也一起拉起来了，窗口会闪一下后自动回来。'
      : '正在重启：窗口会闪一下后自动回来，并重新连接后台服务。',
  };
}

app.whenReady().then(() => {
  if (!GOT_LOCK) return;
  createWindow();

  if (fs.existsSync(ICON)) {
    tray = new Tray(ICON);
    tray.setToolTip('客服回复助手 — 按 Ctrl+Shift+X 唤起');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', toggleWindow);
  }

  // 唤起快捷键：默认 Ctrl+Shift+X。被别的实例 / 软件占用时自动换键，
  // 并在托盘菜单和窗口顶栏写明当前生效的那个键，不再静默改用 K。
  hotkeyPinned = readPreferredHotkey();
  registerHotkey(hotkeyPinned || HOTKEY);
  scheduleHotkeyRetry();

  globalShortcut.register('CommandOrControl+Shift+J', () => {
    const text = clipboard.readText();
    showWindow();
    send('bridge:shortcut', { kind: 'clipboard', text });
  });

  connectPush();
  // 常驻显示：启动后窗口就一直在，只有再按快捷键 / 点右上角 × 才隐藏
  showWindow();
});

app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  clearTimeout(hotkeyTimer);
  try { flushCustomers(); } catch (_) {} // 退出前把最后一次客户存档落盘
  globalShortcut.unregisterAll();
});
app.on('activate', () => { if (GOT_LOCK) showWindow(); });
// 第二次启动不再开新进程去抢快捷键，只把已经开着的窗口叫到前面
if (GOT_LOCK) app.on('second-instance', () => showWindow());

// 只把地址交给渲染层，token 留在主进程
ipcMain.handle('bridge:getConfig', () => ({ gatewayUrl: GATEWAY_URL, mode: 'electron' }));

ipcMain.handle('bridge:getAgents', async (_event, refresh) => {
  try {
    const url = `${GATEWAY_URL}/v1/agents${refresh ? '?refresh=1' : ''}`;
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) throw new Error('服务响应异常（错误码 ' + r.status + '）');
    return await r.json();
  } catch (e) {
    return { data: [], error: '后台服务没连上，请确认「一键启动」的黑窗口还开着' };
  }
});

/** 学习闭环用的通用接口：令牌仍只在主进程；只允许 /v1/ 下的接口 */
ipcMain.handle('bridge:api', async (_e, payload) => {
  const { path: apiPath, method, body } = payload || {};
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/v1/')) return { error: '不允许访问的接口' };
  try {
    const r = await fetch(GATEWAY_URL + apiPath, {
      method: method === 'POST' ? 'POST' : 'GET',
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) return { error: '后台服务返回错误（错误码 ' + r.status + '）' };
    return text ? JSON.parse(text) : {};
  } catch (_e2) {
    return { error: '后台服务没连上，请确认「一键启动」的黑窗口还开着' };
  }
});

/** 流式请求：主进程解析 SSE，逐帧转发给渲染层 */
ipcMain.handle('bridge:suggestStream', async (_e, payload) => {
  const requestId = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  (async () => {
    try {
      const r = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ ...payload, stream: true }),
      });
      if (!r.ok || !r.body) throw new Error(`服务响应异常（错误码 ${r.status}）`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finished = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            finished = true;
            break;
          }
          try {
            sendFrame(requestId, JSON.parse(data));
          } catch (_) {}
        }
        if (finished) break;
      }
      sendFrame(requestId, { type: 'stream_end' });
    } catch (e) {
      sendFrame(requestId, { type: 'error', message: String(e.message || e) });
      sendFrame(requestId, { type: 'stream_end' });
    }
  })();
  return requestId;
});

ipcMain.handle('bridge:copy', async (_e, { text }) => {
  clipboard.writeText(String(text ?? ''));
  return { ok: true };
});

/* ---- 图片消息：把资料库产品图复制进系统剪贴板 / 从剪贴板读图 / 另存为文件 ---- */
/** 只认 png / jpeg 的 dataURL；渲染层复制前会统一转成 PNG，避免 webp 写不进剪贴板 */
ipcMain.handle('bridge:copyImage', async (_e, { dataUrl } = {}) => {
  try {
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) {
      return { ok: false, error: '图片格式不对，请换成 png / jpg 再复制' };
    }
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return { ok: false, error: '这张图片是空的，复制不了' };
    clipboard.writeImage(img);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/** Ctrl+V 兜底：网页拿不到 clipboardData 时，直接问系统剪贴板要图 */
ipcMain.handle('bridge:readClipboardImage', async () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false };
    const size = img.getSize();
    let use = img;
    // 截图 / 位图可能非常大，压到长边 1600px 再交给渲染层，避免界面卡顿
    const long = Math.max(size.width || 0, size.height || 0);
    if (long > 1600) {
      const scale = 1600 / long;
      use = img.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'good',
      });
    }
    return { ok: true, dataUrl: use.toDataURL(), 宽: use.getSize().width, 高: use.getSize().height };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/** 另存为：让用户自己挑路径，程序不擅自往资料目录写东西 */
ipcMain.handle('bridge:saveImage', async (_e, { dataUrl, filename } = {}) => {
  try {
    const m = /^data:image\/([a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl ?? ''));
    if (!m) return { ok: false, error: '图片数据不对，另存失败' };
    const safe = String(filename || '产品图.png').replace(/[\\/:*?"<>|\r\n]/g, '_');
    const picked = await dialog.showSaveDialog({
      title: '把产品图另存为…',
      defaultPath: path.join(app.getPath('downloads'), safe),
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'webp'] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(picked.filePath, Buffer.from(m[2].replace(/\s/g, ''), 'base64'));
    return { ok: true, path: picked.filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/** 人工确认硬约束：confirmed !== true 一律拒绝写入剪贴板 */
ipcMain.handle('bridge:confirmSend', async (_e, { text, confirmed }) => {
  if (confirmed !== true) throw new Error('请先勾选「我已人工核对价格 / 交期 / 附件来源」');
  clipboard.writeText(String(text ?? ''));
  return { ok: true };
});

ipcMain.handle('bridge:logSent', async (_e, { session_id, operator }) => {
  try {
    await fetch(`${GATEWAY_URL}/v1/audit/sent`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ session_id, operator: operator || 'desktop', confirmed: true }),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

/** 窗口刚加载时主动问一次「现在到底用哪个快捷键」，避免启动时的推送早于界面监听 */
ipcMain.handle('bridge:getHotkey', () => hotkeyStatus());

/** 顶栏 ⌨ 徽标：一键重新抢回 Ctrl+Shift+X，并把结果用中文回给界面 */
ipcMain.handle('bridge:retryHotkey', async () => {
  hotkeyPinned = null;
  savePreferredHotkey(null);
  if (hotkeyKey === HOTKEY) {
    return { ok: true, status: hotkeyStatus(), message: '当前已经是 Ctrl+Shift+X，可以直接按它唤起 / 隐藏窗口' };
  }
  let ok = retryPrimaryHotkey(true);
  if (!ok && !hotkeyKey) {
    registerHotkey(HOTKEY);
    ok = hotkeyKey === HOTKEY;
  }
  scheduleHotkeyRetry();
  return {
    ok,
    status: hotkeyStatus(),
    message: ok
      ? '已切回 Ctrl+Shift+X，现在按它就能唤起 / 隐藏窗口'
      : `Ctrl+Shift+X 仍被别的程序占用，当前用 ${hotkeyLabel}；可在托盘「唤起快捷键」里换一个顺手的键`,
  };
});

ipcMain.handle('bridge:hide', async () => {
  if (win && !win.isDestroyed()) win.hide();
  return { ok: true };
});

/** 界面右上角「重启程序」：真正重启桌面程序，必要时补启后台服务 */
ipcMain.handle('bridge:restart', async () => doRestart());

/** 界面右上角的「?」：用系统默认浏览器打开中文说明书 */
/** 用系统浏览器打开只允许本网关的只读页面（例如话术库），不把令牌交给渲染层 */
ipcMain.handle('bridge:openUrl', async (_e, url) => {
  if (typeof url !== 'string' || !url.startsWith(GATEWAY_URL)) return { ok: false, error: '不允许打开的地址' };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('bridge:openManual', async () => {
  const file = path.join(ROOT, '使用说明书.html');
  if (!fs.existsSync(file)) return { ok: false, error: '项目里没有找到「使用说明书.html」' };
  const err = await shell.openPath(file);
  return err ? { ok: false, error: err } : { ok: true };
});

/** 界面「查看清单 / 打开资料文件夹」：只打开这两个固定位置，不接收任意路径 */
function kbFolderPath() {
  const p = ENV.KB_ROOT || 'data/客服资料库';
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}
ipcMain.handle('bridge:openKbPath', async (_e, kind) => {
  const isList = kind === 'list';
  const target = isList ? path.join(ROOT, 'data', '资料清单.md') : kbFolderPath();
  if (!fs.existsSync(target)) {
    return {
      ok: false,
      error: isList ? '清单还没生成，请先点「🗂 一键整理资料」' : `没找到资料文件夹：${target}`,
    };
  }
  const err = await shell.openPath(target);
  return err ? { ok: false, error: err } : { ok: true };
});

/* ==================== 客户档案：本地 Excel 存档 ====================
   界面勾选「保存客户资料」后，客户资料与每次聊天都会写到：
     data/客户档案.json  ← 可靠的主数据（Excel 被 WPS / Excel 打开写不进去时也不丢）
     data/客户档案.xlsx  ← 给人看的成品，每次从 JSON 整体重建
   Excel 是只读快照，直接在表格里改不会同步回程序。
===================================================================== */
const CUSTOMER_JSON = path.join(ROOT, 'data', '客户档案.json');
const CUSTOMER_XLSX = path.join(ROOT, 'data', '客户档案.xlsx');
let customerData = null;
let customerFlushTimer = null;
let customerWriteError = '';

function loadCustomers() {
  if (customerData) return customerData;
  try {
    const raw = JSON.parse(fs.readFileSync(CUSTOMER_JSON, 'utf8'));
    if (raw && raw.customers && typeof raw.customers === 'object') customerData = raw;
  } catch (_) {}
  if (!customerData) customerData = { version: 1, customers: {} };
  return customerData;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function displaySource(c) {
  if (c.source === '自定义') return c.sourceCustom ? `自定义：${c.sourceCustom}` : '自定义';
  return c.source || '未填';
}
function customerSummary(c) {
  return {
    name: c.name,
    source: displaySource(c),
    stageLabel: c.stageLabel || '',
    countryLabel: c.countryLabel || '',
    localeLabel: c.localeLabel || '',
    firstAt: c.firstAt || '',
    lastAt: c.lastAt || '',
    count: (c.chats || []).length,
    saved: c.saved !== false,
  };
}

/** 三张表：一行一客户的总览、一行一条消息的流水、怎么读的说明 */
function buildCustomerWorkbook(data) {
  const wb = XLSX.utils.book_new();
  const list = Object.values(data.customers).sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));

  const head1 = ['客户名称', '客户来源', '客户阶段', '国家 / 地区', '回复语种', '首次记录', '最近联系', '聊天条数', '存档状态'];
  const rows1 = [head1];
  for (const c of list) {
    rows1.push([
      c.name, displaySource(c), c.stageLabel || '', c.countryLabel || '', c.localeLabel || '',
      c.firstAt || '', c.lastAt || '', (c.chats || []).length, c.saved === false ? '已暂停' : '保存中',
    ]);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(rows1);
  ws1['!cols'] = [{ wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 14 }, { wch: 22 }, { wch: 20 }, { wch: 20 }, { wch: 10 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws1, '客户总览');

  const head2 = ['客户名称', '日期时间', '方向', '消息类型', '当时阶段', '消息内容', '会话编号'];
  const rows2 = [head2];
  for (const c of list) {
    for (const m of (c.chats || [])) {
      rows2.push([
        c.name, m.at || '', m.direction || '', m.kind || '', m.stage || '',
        String(m.text || '').replace(/\r/g, ''), m.session || '',
      ]);
    }
  }
  const ws2 = XLSX.utils.aoa_to_sheet(rows2);
  ws2['!cols'] = [{ wch: 20 }, { wch: 21 }, { wch: 10 }, { wch: 22 }, { wch: 16 }, { wch: 90 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, ws2, '聊天记录');

  const rows3 = [
    ['客户档案 · 阅读说明'],
    [''],
    ['① 这个文件由「客服回复助手」自动生成，请勿直接在 Excel 里改资料。要修改请在窗口的「客户信息」里改，保存后本文件会自动重建。'],
    ['②「客户总览」一行一个客户；「聊天记录」一行一条消息，按客户分组、组内时间从早到晚，方便顺着看完整对话。'],
    ['③ 只有勾选了「保存客户资料与聊天记录」的客户才会写入；取消勾选后原有记录保留，不再新增。'],
    ['④「方向」列：客户 = 客户发来的消息，我方 = 已复制去发送的回复稿（程序不会自动发消息给客户）。'],
    ['⑤ 表内价格是出厂价 / 内部价，发给客户前仍需人工核对来源文件对应行。'],
    ['⑥ 原始数据在 data/客户档案.json；本文件正被 Excel / WPS 打开时可能暂时写不进去，关掉表格后点一次「打开客户档案」即可重建。'],
    [''],
    ['生成时间：' + stamp()],
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(rows3);
  ws3['!cols'] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(wb, ws3, '阅读说明');
  return wb;
}

function flushCustomers() {
  clearTimeout(customerFlushTimer);
  customerFlushTimer = null;
  const data = loadCustomers();
  try {
    fs.mkdirSync(path.dirname(CUSTOMER_JSON), { recursive: true });
    fs.writeFileSync(CUSTOMER_JSON, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    customerWriteError = `资料缓存写入失败：${e.message}`;
    return;
  }
  if (!XLSX) {
    customerWriteError = '没装 Excel 生成组件（xlsx），资料已安全存到 客户档案.json。';
    return;
  }
  try {
    XLSX.writeFile(buildCustomerWorkbook(data), CUSTOMER_XLSX);
    customerWriteError = '';
  } catch (e) {
    customerWriteError = `客户档案.xlsx 暂时写不进去（可能正被 Excel / WPS 打开）：${e.message}。资料已安全存在 客户档案.json，关掉表格后点一次「打开客户档案」即可重建。`;
  }
}

function scheduleCustomerFlush() {
  clearTimeout(customerFlushTimer);
  customerFlushTimer = setTimeout(flushCustomers, 250);
}

function upsertCustomer(p) {
  const name = String((p && p.name) || '').trim();
  if (!name) return null;
  const data = loadCustomers();
  const now = stamp();
  const c = data.customers[name] || { name, firstAt: now, chats: [] };
  Object.assign(c, {
    name,
    source: p.source || '未填',
    sourceCustom: p.sourceCustom || '',
    stage: p.stage || '', stageLabel: p.stageLabel || '',
    country: p.country || '', countryLabel: p.countryLabel || '',
    locale: p.locale || '', localeLabel: p.localeLabel || '',
    saved: p.saved !== false,
    lastAt: c.lastAt || now,
  });
  if (!Array.isArray(c.chats)) c.chats = [];
  data.customers[name] = c;
  return c;
}

ipcMain.handle('bridge:customerList', () => {
  const data = loadCustomers();
  return {
    ok: true,
    customers: Object.values(data.customers).map(customerSummary),
    excel: !!XLSX,
    error: customerWriteError || undefined,
  };
});

ipcMain.handle('bridge:customerLoad', (_e, name) => {
  const c = loadCustomers().customers[String(name || '').trim()];
  return c ? { ok: true, customer: c } : { ok: false, error: '没找到这个客户的存档' };
});

ipcMain.handle('bridge:customerSave', (_e, profile) => {
  const c = upsertCustomer(profile || {});
  if (!c) return { ok: false, error: '客户名称不能为空，没保存' };
  scheduleCustomerFlush();
  return { ok: true, customer: customerSummary(c), error: customerWriteError || undefined };
});

ipcMain.handle('bridge:customerAppend', (_e, entry) => {
  const e = entry || {};
  const name = String(e.name || '').trim();
  if (!name) return { ok: false, error: '客户名称为空，这条没记录' };
  const data = loadCustomers();
  if (!data.customers[name]) upsertCustomer(Object.assign({ name }, e.profile || {}));
  const c = data.customers[name];
  const at = stamp();
  c.chats.push({
    at,
    direction: e.direction || '客户',
    kind: e.kind || '',
    text: String(e.text || ''),
    stage: e.stage || '',
    session: e.session || '',
  });
  if (c.chats.length > 2000) c.chats = c.chats.slice(-2000); // 防止无限膨胀
  c.lastAt = at;
  scheduleCustomerFlush();
  return { ok: true, error: customerWriteError || undefined };
});

ipcMain.handle('bridge:customerOpen', async () => {
  flushCustomers();
  if (!fs.existsSync(CUSTOMER_XLSX)) {
    return { ok: false, error: '还没有生成客户档案：先勾选「保存客户资料与聊天记录」，再产生一条聊天记录即可' };
  }
  const err = await shell.openPath(CUSTOMER_XLSX);
  return err ? { ok: false, error: err } : { ok: true, error: customerWriteError || undefined };
});
