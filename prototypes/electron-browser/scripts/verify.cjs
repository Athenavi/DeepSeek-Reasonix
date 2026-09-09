const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const output = process.env.PROTOTYPE_ARTIFACTS || path.join(root, 'artifacts', process.platform);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-browser-verify-'));
fs.mkdirSync(output, { recursive: true });
const results = [];
let electron, shellPage, page, origin, tabId;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await wait(80); }
  throw new Error('Timed out: ' + description);
}
async function test(name, fn) {
  const start = performance.now();
  try { const evidence = await fn(); results.push({ name, status: 'PASS', ms: Math.round(performance.now() - start), evidence }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); }
  console.log(`${results.at(-1).status} ${name}`);
  fs.writeFileSync(path.join(output, 'checks-progress.json'), JSON.stringify(results, null, 2));
}
async function command(method, args = {}) { return electron.evaluate((_electron, { method, args }) => global.browserLab.command(method, args), { method, args }); }
async function launch() {
  const env = { ...process.env, PROTOTYPE_PROFILE: profile, PROTOTYPE_ARTIFACTS: output, PROTOTYPE_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({ args: [root], env, timeout: 30000 });
  electron.process().stderr.on('data', data => fs.appendFileSync(path.join(output, 'electron-stderr.log'), data));
  await until(() => electron.evaluate(() => Boolean(global.browserLab)), 'native browser ready', 20000);
  const state = await command('state'); origin = state.origin; tabId = state.activeId;
  await until(() => electron.context().pages().some(p => p.url().startsWith(origin)), 'fixture attached');
  shellPage = electron.context().pages().find(p => p.url().includes('shell.html'));
  page = electron.context().pages().find(p => p.url().startsWith(origin));
  page.setDefaultTimeout(5000); shellPage.setDefaultTimeout(5000);
  await page.locator('#message').waitFor();
  return state;
}
async function startDelayed(text) {
  await electron.evaluate((_electron, { tabId, text }) => {
    global.browserLab.pendingTest = global.browserLab.run(tabId, { text, delay: 450 });
  }, { tabId, text });
  await until(async () => (await command('state')).tabs.find(t => t.id === tabId).mode === 'agent', 'plan active');
}
async function planResult() { return electron.evaluate(() => global.browserLab.pendingTest); }
async function closeAndVerify() {
  const electronPid = electron.process().pid;
  const goPid = (await command('state')).goPid;
  await electron.close(); electron = undefined;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  await until(() => !alive(electronPid) && !alive(goPid), 'Electron and Go processes exit', 10000);
  return { electronPid, goPid, bothExited: true };
}

(async () => {
  const initial = await launch();
  await test('Native WebContentsView + live Go process', async () => {
    assert(initial.goPid > 0); assert(initial.tabs[0].wcId > 0);
    return { versions: initial.versions, firstReadyMs: initial.firstReadyMs, goPid: initial.goPid, browserWebContentsId: initial.tabs[0].wcId };
  });
  await test('Website cannot access shell IPC / Node', async () => {
    const capabilities = await page.evaluate(() => ({ require: typeof require, process: typeof process, bridge: typeof window.prototype }));
    assert.deepEqual(capabilities, { require: 'undefined', process: 'undefined', bridge: 'undefined' }); return capabilities;
  });
  await test('Chinese text entry and native selection/copy/paste commands', async () => {
    await page.locator('#message').fill('原生中文输入测试');
    await page.locator('#message').press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await electron.evaluate(() => global.browserLab.tabs.values().next().value.view.webContents.copy());
    const copied = await electron.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(copied, '原生中文输入测试');
    await page.locator('#message').fill('');
    await electron.evaluate(() => global.browserLab.tabs.values().next().value.view.webContents.paste());
    await until(async () => await page.locator('#message').inputValue() === copied, 'paste result');
    return { copiedText: copied, note: 'Native Chromium editing commands; not a physical IME test' };
  });
  await test('Chromium IME composition via CDP', async () => {
    await page.locator('#message').fill(''); await page.locator('#message').focus();
    const cdp = await electron.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '中文' });
    assert.equal(await page.locator('#message').inputValue(), '中文');
    const events = await page.evaluate(() => window.fixtureEvents);
    assert(events.some(e => e.type === 'compositionstart'));
    assert(events.some(e => e.type === 'compositionend'));
    await cdp.detach(); return { events: events.filter(e => e.type.startsWith('composition')), note: 'Composition protocol simulation, not OS candidate-window verification' };
  });
  await test('Go plan applies to the visible page', async () => {
    const result = await command('run', { id: tabId, text: 'Go 已通过独立进程填表' });
    assert.equal(result.cancelled, false);
    assert.equal(await page.locator('#saved').textContent(), 'Go 已通过独立进程填表');
    return { submitted: await page.locator('#saved').textContent() };
  });
  await test('User input cancels queued Go actions; explicit resume rereads page', async () => {
    await startDelayed('禁止覆盖用户内容');
    await page.locator('#message').click(); await page.locator('#message').fill('用户接管后的内容');
    assert.equal((await planResult()).cancelled, true);
    assert.equal(await page.locator('#message').inputValue(), '用户接管后的内容');
    await command('run', { id: tabId, text: '重新读取后继续' });
    assert.equal(await page.locator('#saved').textContent(), '重新读取后继续');
  });
  await test('Switching visible tab never retargets an existing plan', async () => {
    const other = await command('new');
    await command('activate', { id: tabId });
    await startDelayed('只能写入原目标');
    await command('activate', { id: other });
    assert.equal((await planResult()).cancelled, false);
    const values = await electron.evaluate(async (_electron, { tabId, other }) => {
      const read = id => global.browserLab.tabs.get(id).view.webContents.executeJavaScript('document.querySelector("#message").value');
      return { target: await read(tabId), other: await read(other) };
    }, { tabId, other });
    assert.deepEqual(values, { target: '只能写入原目标', other: '' });
    await command('close', { id: other }); await command('activate', { id: tabId }); return values;
  });
  await test('Navigation invalidates delayed actions', async () => {
    await startDelayed('旧文档动作');
    await page.goto(origin + '/?fresh=1');
    assert.equal((await planResult()).cancelled, true);
    assert.equal(await page.locator('#message').inputValue(), '');
  });
  await test('Native split bounds + window resize + zoom', async () => {
    const before = await page.evaluate(() => innerWidth);
    const splitter = await shellPage.locator('#splitter').boundingBox();
    await shellPage.mouse.move(splitter.x + 2, splitter.y + 100); await shellPage.mouse.down();
    await shellPage.mouse.move(420, splitter.y + 100, { steps: 10 }); await shellPage.mouse.up();
    await until(async () => await page.evaluate(() => innerWidth) < before - 80, 'split viewport width');
    const splitWidth = await page.evaluate(() => innerWidth);
    await electron.evaluate(() => global.browserLab.shell.setSize(980, 730));
    await until(async () => await page.evaluate(() => innerWidth) < splitWidth - 100, 'native resize');
    await command('zoom', { id: tabId, delta: .25 });
    const measured = await electron.evaluate((_electron, id) => {
      const tab = global.browserLab.tabs.get(id); return { bounds: tab.view.getBounds(), zoom: tab.view.webContents.getZoomFactor(), shell: global.browserLab.shell.getContentSize() };
    }, tabId);
    assert.equal(measured.zoom, 1.25);
    assert(measured.bounds.x + measured.bounds.width <= measured.shell[0]);
    assert(measured.bounds.y + measured.bounds.height <= measured.shell[1]);
    await command('zoom', { id: tabId, delta: -.25 });
    await electron.evaluate(() => global.browserLab.shell.setSize(1180, 850));
    return { before, splitWidth, measured };
  });
  await test('Native wheel scrolling', async () => {
    await page.mouse.move(200, 300); await page.mouse.wheel(0, 800);
    await until(async () => await page.evaluate(() => scrollY) > 200, 'page scroll');
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Home' : 'Control+Home');
    return { scrollY, note: 'Injected native wheel; physical trackpad momentum remains manual' };
  });
  await test('Popup login shares the same persistent browser session', async () => {
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#login').click(); const popup = await popupPromise;
    await popup.locator('#authorize').click(); await popup.waitForEvent('close').catch(() => {});
    await until(async () => (await page.locator('#login-state').textContent()).startsWith('已登录'), 'popup session handoff');
    return { note: 'Synthetic local HTTP cookie + popup callback; not Google/Microsoft OAuth' };
  });
  await test('Temporary profile does not inherit persistent login', async () => {
    const isolatedId = await command('new', { isolated: true });
    await until(async () => {
      const text = await electron.evaluate((_electron, id) => global.browserLab.tabs.get(id).view.webContents.executeJavaScript('document.querySelector("#login-state").textContent'), isolatedId);
      return text === '尚未登录';
    }, 'isolated session');
    await command('close', { id: isolatedId }); await command('activate', { id: tabId });
  });
  await test('File upload + native download', async () => {
    const file = path.join(output, 'upload-fixture.txt'); fs.writeFileSync(file, 'synthetic fixture');
    await page.locator('#upload').setInputFiles(file);
    assert.equal(await page.locator('#upload-result').textContent(), 'upload-fixture.txt');
    await page.locator('#download').click();
    await until(() => fs.existsSync(path.join(output, 'fixture-result.csv')), 'download');
    assert.equal(fs.readFileSync(path.join(output, 'fixture-result.csv'), 'utf8'), 'name,result\nprototype,passed\n');
  });
  await test('DevTools with attached CDP debugger, close and reattach', async () => {
    const observed = await electron.evaluate(async (_electron, id) => {
      const wc = global.browserLab.tabs.get(id).view.webContents;
      wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Runtime.enable');
      wc.openDevTools({ mode: 'detach' });
      return { attachedBefore: true };
    }, tabId);
    await until(() => electron.evaluate((_electron, id) => global.browserLab.tabs.get(id).view.webContents.isDevToolsOpened(), tabId), 'devtools opened');
    observed.attachedWithDevTools = await electron.evaluate((_electron, id) => global.browserLab.tabs.get(id).view.webContents.debugger.isAttached(), tabId);
    await command('devtools', { id: tabId });
    await until(() => electron.evaluate((_electron, id) => !global.browserLab.tabs.get(id).view.webContents.isDevToolsOpened(), tabId), 'devtools closed');
    observed.recovered = await electron.evaluate(async (_electron, id) => {
      const wc = global.browserLab.tabs.get(id).view.webContents;
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      return result.result.value;
    }, tabId);
    assert(observed.recovered.includes('Browser fixture')); return observed;
  });
  await test('Renderer crash restores page, preserves login, does not replay plan', async () => {
    await startDelayed('崩溃前旧动作');
    await command('crash', { id: tabId });
    await planResult().catch(() => {});
    await until(async () => (await command('state')).events.some(e => e.event === 'renderer-recovered'), 'renderer recovery', 15000);
    // Playwright marks its old Page object crashed. Verify through the host's
    // recovered WebContents, which is the real production control path here.
    const recovered = await electron.evaluate((_electron, id) => global.browserLab.tabs.get(id).view.webContents.executeJavaScript('({value:document.querySelector("#message").value,login:document.querySelector("#login-state").textContent})'), tabId);
    assert.equal(recovered.value, '');
    assert.equal((await command('state')).tabs.find(t => t.id === tabId).mode, 'human');
    assert(recovered.login.startsWith('已登录'));
    const png = await electron.evaluate(async (_electron, id) => (await global.browserLab.tabs.get(id).view.webContents.capturePage()).toPNG().toString('base64'), tabId);
    fs.writeFileSync(path.join(output, 'browser-page.png'), Buffer.from(png, 'base64'));
    const events = (await command('state')).events;
    return { ...recovered, recoveryMs: events.find(e=>e.event==='renderer-recovered').atMs - events.find(e=>e.event==='renderer-crashed').atMs };
  });
  const memory = await command('metrics');
  const shellImage = await electron.evaluate(async () => {
    const image = await global.browserLab.shell.capturePage();
    return image.toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(output, 'shell.png'), Buffer.from(shellImage, 'base64'));
  await test('App shutdown closes Electron and Go sidecar', closeAndVerify);
  await test('Full app restart preserves login in isolated test profile', async () => {
    await launch();
    await until(async () => (await page.locator('#login-state').textContent()).startsWith('已登录'), 'login after relaunch');
  });
  const report = { platform: process.platform, arch: process.arch, createdAt: new Date().toISOString(), memory, results,
    notVerified: ['Physical OS IME candidate window', 'Physical trackpad gesture quality', 'Third-party OAuth / passkeys', 'Full Reasonix runtime migration and production resource usage'] };
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  if (electron) await closeAndVerify();
  console.log(JSON.stringify({ passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, report: path.join(output, 'verification.json') }));
  process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
})().catch(async error => {
  fs.writeFileSync(path.join(output, 'verification-error.txt'), error.stack);
  console.error(error);
  if (electron) await electron.close().catch(() => {});
  process.exitCode = 1;
});
