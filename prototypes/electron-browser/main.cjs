const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const started = performance.now();
const root = __dirname;
const profile = process.env.PROTOTYPE_PROFILE || path.join(root, '.profiles', 'interactive');
const artifacts = process.env.PROTOTYPE_ARTIFACTS || path.join(root, 'artifacts', process.platform);
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', profile);
app.setName('Reasonix Browser Prototype');
const tabs = new Map();
const events = [];
let shell, sidecar, origin, goPid, activeId, nextTab = 0, sequence = 0, quitting = false, runtime;
let status = '正在启动 Go 测试进程';
let bounds = { x: 296, y: 140, width: 884, height: 620 };
let firstReadyMs;
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function emit(event, details = {}) {
  events.push({ atMs: Math.round(performance.now() - started), event, ...details });
  if (events.length > 150) events.shift();
  if (!quitting && shell && !shell.isDestroyed() && !shell.webContents.isDestroyed()) shell.webContents.send('prototype:state', state());
}
function state() {
  return { status, activeId, goPid, origin, firstReadyMs, versions: process.versions, events, runtime: runtime?.snapshotState(),
    tabs: [...tabs.values()].filter(tab => tab.view.webContents && !tab.view.webContents.isDestroyed()).map(tab => ({ id: tab.id, epoch: tab.epoch, mode: tab.mode, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle(), wcId: tab.view.webContents.id, bounds: tab.view.getBounds() })) };
}
function getTab(id) { const tab = tabs.get(id); if (!tab) throw new Error('Unknown tab'); return tab; }
function pause(tab, reason) {
  tab.epoch++;
  const wasRunning = tab.mode === 'agent';
  tab.mode = 'human';
  runtime?.onPause(tab, reason);
  if (wasRunning) { status = `已暂停 ${tab.id}：${reason}`; emit('paused', { id: tab.id, reason }); }
}
function startSidecar() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Go sidecar startup timed out')), 10000);
    const executable = process.env.PROTOTYPE_GO_BINARY || path.join(root, 'bin', process.platform === 'win32' ? 'browser-fixture.exe' : 'browser-fixture');
    sidecar = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    sidecar.on('error', reject);
    sidecar.stderr.on('data', data => process.stderr.write(data));
    createInterface({ input: sidecar.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 0) { clearTimeout(timer); origin = message.result.origin; goPid = message.result.pid; resolve(); return; }
      const call = pending.get(message.id);
      if (call) { pending.delete(message.id); clearTimeout(call.timer); message.error ? call.reject(new Error(message.error)) : call.resolve(message.result); }
    });
    sidecar.on('exit', () => {
      clearTimeout(timer);
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Go sidecar exited')); }
      pending.clear();
      for (const tab of tabs.values()) pause(tab, 'Go 进程退出');
      if (!quitting) { status = 'Go 测试进程已退出'; emit('sidecar-exited'); }
    });
  });
}
function plan(text) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Go plan timeout')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    sidecar.stdin.write(JSON.stringify({ id, method: 'plan', text }) + '\n');
  });
}
function allowedURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) is supported by this prototype');
  return url.href;
}
function activate(id) {
  const tab = getTab(id);
  if (activeId && tabs.has(activeId)) tabs.get(activeId).view.setVisible(false);
  activeId = id;
  tab.view.setBounds(bounds); tab.view.setVisible(true);
  emit('tab-activated', { id });
}
async function newTab(url = origin + '/', isolated = false) {
  const id = `t${++nextTab}`;
  const view = new WebContentsView({ webPreferences: {
    preload: path.join(root, 'guest-preload.cjs'), contextIsolation: true, sandbox: true,
    nodeIntegration: false, partition: isolated ? `temporary-${id}` : 'persist:browser-lab',
    backgroundThrottling: false
  } });
  const tab = { id, view, epoch: 0, mode: 'human', lastURL: url, crashCount: 0 };
  tabs.set(id, tab);
  shell.contentView.addChildView(view);
  const wc = view.webContents;
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  wc.session.setPermissionCheckHandler(() => false);
  wc.on('before-input-event', (_event, input) => { if (input.type === 'keyDown') pause(tab, '用户键盘输入'); });
  wc.on('before-mouse-event', (_event, input) => { if (['mouseDown', 'mouseWheel'].includes(input.type)) pause(tab, '用户鼠标输入'); });
  wc.on('will-navigate', (event, url) => { try { allowedURL(url); } catch { event.preventDefault(); } });
  wc.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) pause(tab, '页面导航'); });
  wc.on('did-navigate', (_event, url) => { tab.lastURL = url; emit('navigated', { id }); });
  wc.on('page-title-updated', () => emit('title-updated', { id }));
  wc.on('console-message', (details) => { if (details?.level === 'error') emit('page-console-error', { id, message: details.message }); });
  wc.setWindowOpenHandler(({ url }) => {
    try { allowedURL(url); } catch { return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: {
      width: 500, height: 420, title: 'Browser Lab · popup', parent: shell,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, partition: isolated ? `temporary-${id}` : 'persist:browser-lab' }
    } };
  });
  wc.on('did-create-window', (popup) => {
    pause(tab, '登录弹窗');
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    emit('popup-opened', { id });
    popup.on('closed', () => emit('popup-closed', { id }));
  });
  wc.on('render-process-gone', (_event, details) => {
    pause(tab, '页面进程崩溃');
    emit('renderer-crashed', { id, reason: details.reason });
    if (!quitting && tab.crashCount++ < 2) {
      // Restore a page only. Never replay an unknown submission or prior plan.
      wc.loadURL(tab.lastURL).then(() => { status = '页面已恢复；自动化保持暂停'; emit('renderer-recovered', { id }); }).catch(error => emit('recovery-error', { message: error.message }));
    }
  });
  wc.debugger.on('detach', (_event, reason) => emit('debugger-detached', { id, reason }));
  wc.on('devtools-opened', () => { pause(tab, 'DevTools 已打开'); emit('devtools-opened', { id }); });
  wc.on('devtools-closed', () => emit('devtools-closed', { id }));
  activate(id);
  await wc.loadURL(allowedURL(url));
  return id;
}
function closeTab(id) {
  const tab = getTab(id); pause(tab, '标签关闭');
  tabs.delete(id); shell.contentView.removeChildView(tab.view); tab.view.webContents.close();
  if (activeId === id) { activeId = undefined; if (tabs.size) activate(tabs.keys().next().value); }
  emit('tab-closed', { id });
}
async function run(id, options = {}) {
  const tab = getTab(id), wc = tab.view.webContents;
  if (new URL(wc.getURL()).origin !== origin) throw new Error('The Go demo is limited to the local fixture');
  if (tab.mode === 'agent') throw new Error('An action plan is already running');
  tab.mode = 'agent'; const epoch = ++tab.epoch;
  status = `Agent 正在操作 ${id}`; emit('plan-started', { id, epoch });
  const stillOwned = () => tabs.get(id) === tab && tab.mode === 'agent' && tab.epoch === epoch && !wc.isDestroyed();
  try {
    const documentTime = await wc.executeJavaScript('performance.timeOrigin');
    const result = await plan(options.text || 'Go → Electron → 同一个浏览器页面');
    emit('go-plan-received', { id, epoch, source: result.source });
    for (const step of result.steps) {
      if (options.delay) await delay(options.delay);
      if (!stillOwned()) { emit('stale-plan-rejected', { id, epoch }); return { cancelled: true }; }
      // Recheck document identity inside the renderer: an IPC already in flight
      // must not silently land in a newer document at the same URL.
      const applied = await wc.executeJavaScript(`(() => {
        if (performance.timeOrigin !== ${JSON.stringify(documentTime)}) return false;
        const step = ${JSON.stringify(step)};
        const element = document.querySelector(step.selector);
        if (!element) throw new Error('Fixture element missing');
        if (step.action === 'fill') {
          element.value = step.text;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (step.action === 'click') element.click();
        else throw new Error('Unsupported fixture action');
        return true;
      })()`);
      if (!applied) { emit('document-action-rejected', { id }); return { cancelled: true }; }
      emit('action-applied', { id, action: step.action });
    }
    if (stillOwned()) { status = '操作完成；页面交还给用户'; emit('plan-complete', { id }); }
    return { cancelled: false };
  } finally { if (stillOwned()) { tab.mode = 'human'; emit('plan-released', { id }); } }
}
function metrics() {
  const processes = app.getAppMetrics();
  let goRssMiB = null;
  try {
    const raw = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${goPid}).WorkingSet64`], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      : execFileSync('ps', ['-o', 'rss=', '-p', String(goPid)], { encoding: 'utf8', timeout: 5000 });
    goRssMiB = Math.round(Number(raw.trim()) / (process.platform === 'win32' ? 1048576 : 1024) * 10) / 10;
  } catch { /* Unavailable metrics stay null, never zero. */ }
  const value = { platform: process.platform, arch: process.arch, firstReadyMs, goPid,
    goRssMiB,
    electronRssMiB: Math.round(processes.reduce((sum, entry) => sum + entry.memory.workingSetSize, 0) / 1024 * 10) / 10,
    processes, tabCount: tabs.size, capturedAt: new Date().toISOString(), gpu: app.getGPUFeatureStatus() };
  fs.writeFileSync(path.join(artifacts, 'metrics-latest.json'), JSON.stringify(value, null, 2));
  return value;
}
async function command(method, args = {}) {
  if (method === 'state') return state();
  if (method === 'new') return newTab(args.url, args.isolated);
  if (method === 'metrics') return metrics();
  if (method === 'runtime-run') return runtime.run(args.text);
  if (method === 'runtime-approve') return runtime.approve(args.id, args.generation, args.optionId);
  if (method === 'runtime-stop') return runtime.revoke('用户接管任务');
  if (method === 'runtime-restart') return runtime.restart();
  if (method === 'github-login') return newTab('https://github.com/login');
  if (method === 'bounds') {
    const [width, height] = shell.getContentSize();
    bounds = { x: Math.max(0, Math.round(args.x)), y: Math.max(0, Math.round(args.y)), width: Math.max(1, Math.min(width, Math.round(args.width))), height: Math.max(1, Math.min(height, Math.round(args.height))) };
    if (Object.values(bounds).some(value => !Number.isFinite(value))) throw new Error('Invalid bounds');
    if (activeId) getTab(activeId).view.setBounds(bounds);
    return bounds;
  }
  const tab = getTab(args.id), wc = tab.view.webContents;
  switch (method) {
    case 'activate': return activate(args.id);
    case 'close': return closeTab(args.id);
    case 'run': return run(args.id, args);
    case 'pause': pause(tab, '用户接管'); emit('user-takeover', { id: args.id }); return;
    case 'navigate': pause(tab, '用户导航'); return wc.loadURL(allowedURL(args.url));
    case 'reload': pause(tab, '用户刷新'); return wc.reload();
    case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return;
    case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return;
    case 'zoom': wc.setZoomFactor(Math.max(.5, Math.min(2, wc.getZoomFactor() + args.delta))); return wc.getZoomFactor();
    case 'devtools': wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' }); return;
    case 'crash': pause(tab, '崩溃测试'); return wc.forcefullyCrashRenderer();
    default: throw new Error('Unknown command');
  }
}
ipcMain.handle('prototype:command', (event, { method, args }) => {
  if (event.sender !== shell.webContents || event.senderFrame !== shell.webContents.mainFrame) throw new Error('Untrusted caller');
  return command(method, args);
});
ipcMain.on('prototype:human-input', (event, { type }) => {
  const tab = [...tabs.values()].find(tab => tab.view.webContents === event.sender);
  if (tab) pause(tab, `页面输入：${type}`);
});

app.whenReady().then(async () => {
  await startSidecar();
  shell = new BrowserWindow({ width: 1180, height: 850, minWidth: 680, minHeight: 560, show: false,
    title: 'Reasonix Browser Prototype', webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' }, { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ]));
  shell.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  shell.webContents.on('will-navigate', event => event.preventDefault());
  const browserSession = session.fromPartition('persist:browser-lab');
  browserSession.on('will-download', (_event, item) => {
    const filename = path.basename(item.getFilename());
    item.setSavePath(path.join(artifacts, filename));
    item.on('done', (_event, result) => emit('download-' + result, { filename }));
  });
  await shell.loadFile(path.join(root, 'shell.html'));
  shell.show();
  await newTab();
  await getTab(activeId).view.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await getTab(activeId).view.webContents.capturePage();
  firstReadyMs = Math.round(performance.now() - started);
  status = '浏览器就绪；可以直接操作右侧页面';
  emit('ready', { firstReadyMs });
  if (process.env.PROTOTYPE_TEST === '1') global.browserLab = { state, command, metrics, tabs, shell, run, events, profile };
  if (process.env.PROTOTYPE_RUNTIME === '1') {
    const { BrowserRuntime } = require('./browser-runtime.cjs');
    runtime = new BrowserRuntime({ root, profile, artifacts, origin, tabs, tabId: activeId, emit });
    if (global.browserLab) global.browserLab.runtime = runtime;
    await runtime.initialize();
    status = '真实 Reasonix 任务运行时已连接'; emit('runtime-ready');
  }
  if (process.env.PROTOTYPE_BENCH === '1') {
    const samples = [];
    for (const count of [1, 5]) {
      while (tabs.size < count) await newTab();
      await delay(2000);
      samples.push(metrics());
    }
    fs.writeFileSync(path.join(artifacts, 'benchmark.json'), JSON.stringify({ versions: process.versions, firstReadyMs, samples }, null, 2));
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
app.on('before-quit', (event) => {
  if (runtime && !runtime.shutdownComplete) {
    event.preventDefault();
    if (!runtime.shutdownPromise) runtime.shutdownPromise = runtime.close().then(() => { runtime.shutdownComplete = true; app.quit(); }).catch(error => { console.error(error); runtime.shutdownPromise = undefined; });
    return;
  }
  if (quitting) return;
  quitting = true;
  const closingTabs = [...tabs.values()];
  tabs.clear(); activeId = undefined;
  for (const tab of closingTabs) { pause(tab, '应用退出'); const wc = tab.view.webContents; if (wc && !wc.isDestroyed()) wc.close(); }
  fs.writeFileSync(path.join(artifacts, 'events.json'), JSON.stringify(events, null, 2));
  if (sidecar) sidecar.stdin.end();
});
app.on('window-all-closed', () => app.quit());
