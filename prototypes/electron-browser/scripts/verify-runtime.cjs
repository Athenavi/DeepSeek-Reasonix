const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const artifacts = process.env.PROTOTYPE_RUNTIME_ARTIFACTS || path.join(root, 'artifacts', process.platform, 'runtime');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-runtime-'));
fs.mkdirSync(artifacts, { recursive: true });
let electron, shell, page;
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100); }
  throw new Error('Timed out: ' + label);
}
const evaluate = (fn, arg) => electron.evaluate(fn, arg);
const command = (method, args = {}) => evaluate((_e, x) => global.browserLab.command(x.method, x.args), { method, args });
async function state() { return (await command('state')).runtime; }
async function test(name, fn) {
  try { const evidence = await fn(); results.push({ name, status: 'PASS', evidence }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); }
  fs.writeFileSync(path.join(artifacts, 'checks.json'), JSON.stringify(results, null, 2));
  console.log(results.at(-1).status + ' ' + name);
  if (results.at(-1).status === 'FAIL') throw new Error('Integration gate failed: ' + name);
}
async function launch() {
  const env = { ...process.env, PROTOTYPE_TEST: '1', PROTOTYPE_RUNTIME: '1', PROTOTYPE_MODEL_FIXTURE: '1', PROTOTYPE_PROFILE: profile, PROTOTYPE_ARTIFACTS: artifacts };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PROTOTYPE_RUNTIME_HOME;
  electron = await _electron.launch({ args: [root], env, timeout: 30000 });
  electron.process().stderr.on('data', data => fs.appendFileSync(path.join(artifacts, 'electron-stderr.log'), data));
  await until(() => evaluate(() => ['ready', 'restored-paused'].includes(global.browserLab?.runtime?.phase)), 'production ACP ready');
  const initial = await command('state');
  shell = electron.context().pages().find(p => p.url().includes('shell.html'));
  page = electron.context().pages().find(p => p.url().startsWith(initial.origin));
  return initial.runtime;
}
async function begin(caseId, text) {
  await evaluate((_e, prompt) => {
    global.browserLab.runtimeTestResult = null;
    global.browserLab.runtime.run(prompt).then(result => { global.browserLab.runtimeTestResult = { ok: true, result }; }, error => { global.browserLab.runtimeTestResult = { ok: false, error: error.message }; });
  }, `LAB_CASE:${caseId}:${text}`);
}
async function approvals(kind = 'allow_once') {
  let count = 0;
  await until(async () => {
    const current = await state();
    for (const request of current.approvals) {
      assert.match(request.toolCall.title, /browser.*act/);
      assert(JSON.stringify(request.toolCall.rawInput).includes('#message') || JSON.stringify(request.toolCall.rawInput).includes('#save'));
      const option = request.options.find(x => x.kind === kind); assert(option);
      await command('runtime-approve', { id: request.id, generation: request.generation, optionId: option.optionId }); count++;
    }
    return evaluate(() => global.browserLab.runtimeTestResult !== null);
  }, 'turn completes with approvals', 90000);
  return { count, result: await evaluate(() => global.browserLab.runtimeTestResult) };
}
async function waitApproval() { await until(async () => (await state()).approvals.length > 0, 'approval'); return (await state()).approvals[0]; }
async function waitTurn() { await until(() => evaluate(() => global.browserLab.runtimeTestResult !== null), 'turn stopped'); }
async function answerOne(request, kind = 'allow_once') {
  const option = request.options.find(x => x.kind === kind);
  await command('runtime-approve', { id: request.id, generation: request.generation, optionId: option.optionId });
}

(async () => {
  const initial = await launch();
  await test('Production ACP boot, Agent, MCP write approval and browser effect', async () => {
    await begin('first', '真实内核链路通过'); const completed = await approvals();
    assert.equal(completed.count, 2); assert.equal(completed.result.ok, true);
    assert.equal(await page.locator('#saved').textContent(), '真实内核链路通过');
    const current = await state(); assert(current.sessionId); assert(current.reasonixPid > 0);
    return { sessionId: current.sessionId, reasonixPid: current.reasonixPid, approvals: completed.count, operationCount: current.operationCount };
  });
  await test('Rejecting real approval performs zero browser writes', async () => {
    const before = await page.locator('#saved').textContent(); const count = (await state()).operationCount;
    await begin('deny', '拒绝后不得写入'); const completed = await approvals('reject_once');
    assert(completed.count > 0); assert.equal(await page.locator('#saved').textContent(), before); assert.equal((await state()).operationCount, count);
    return { rejected: completed.count, operationCount: count };
  });
  await test('Native user input revokes pending approval and rejects its stale response', async () => {
    await begin('takeover', '不能覆盖用户'); const old = await waitApproval();
    await page.locator('#message').click(); await page.locator('#message').fill('用户正在输入'); await waitTurn();
    assert.equal((await state()).approvals.length, 0);
    await assert.rejects(command('runtime-approve', { id: old.id, generation: old.generation, optionId: old.options.find(x => x.kind === 'allow_once').optionId }), /stale|another runtime/);
    assert.equal(await page.locator('#message').inputValue(), '用户正在输入');
    return { staleApprovalRejected: true };
  });
  await test('Switching tabs does not retarget the real task', async () => {
    const other = await command('new'); const target = (await state()).tabId;
    await begin('tabtarget', '只写任务绑定标签'); await approvals();
    const values = await evaluate(async (_e, ids) => {
      const read = id => global.browserLab.tabs.get(id).view.webContents.executeJavaScript('document.querySelector("#message").value');
      return { target: await read(ids.target), other: await read(ids.other) };
    }, { target, other });
    assert.equal(values.target, '只写任务绑定标签'); assert.equal(values.other, '');
    await command('close', { id: other }); await command('activate', { id: target }); return values;
  });
  await test('Navigation cancels the real task before approval applies', async () => {
    await begin('navigate', '旧页面不得写入'); await waitApproval();
    const current = await command('state'); await command('navigate', { id: current.runtime.tabId, url: current.origin + '/?after-navigation=1' });
    await waitTurn(); assert.equal(await page.locator('#message').inputValue(), ''); assert.equal((await state()).approvals.length, 0);
  });
  await test('Takeover after confirmation but before dispatch prevents queued writes', async () => {
    const before = (await state()).operationCount;
    await evaluate(() => {
      const runtime = global.browserLab.runtime;
      global.browserLab.actionEntered = false;
      runtime.faults.beforeAction = new Promise(resolve => { global.browserLab.releaseAction = resolve; });
      runtime.faults.beforeActionReached = () => { global.browserLab.actionEntered = true; };
    });
    await begin('queued', '已确认但不得覆盖'); await answerOne(await waitApproval());
    await until(() => evaluate(() => global.browserLab.actionEntered), 'action queued before dispatch');
    await page.locator('#message').click(); await page.locator('#message').fill('确认后接管保留');
    await evaluate(() => { global.browserLab.releaseAction(); global.browserLab.runtime.faults = {}; });
    await waitTurn(); assert.equal(await page.locator('#message').inputValue(), '确认后接管保留');
    assert.equal((await state()).operationCount, before);
    return { alreadyConfirmed: true, dispatched: false };
  });
  await test('Renderer crash cancels the production turn and never replays its pending action', async () => {
    const before = (await state()).operationCount;
    await begin('renderer', '崩溃后不得重放'); await waitApproval();
    const id = (await state()).tabId; await command('crash', { id }); await waitTurn();
    await until(async () => (await command('state')).events.some(x => x.event === 'renderer-recovered'), 'renderer recovery');
    const restored = await evaluate((_e, id) => global.browserLab.tabs.get(id).view.webContents.executeJavaScript('document.querySelector("#message").value'), id);
    assert.equal(restored, ''); assert.equal((await state()).operationCount, before); assert.equal((await state()).approvals.length, 0);
    // Reattach Playwright to the recovered target by creating a fresh Page handle
    // through a full navigation; subsequent assertions use host WebContents.
  });
  await test('Reasonix process restart reloads transcript, starts paused, and continues explicitly', async () => {
    const before = await state(); await command('runtime-restart'); const restored = await state();
    assert.equal(restored.sessionId, before.sessionId); assert.notEqual(restored.generation, before.generation);
    assert.equal(restored.phase, 'restored-paused');
    assert(JSON.stringify(restored.updates).includes('真实内核链路通过'));
    await begin('resume', '真实会话恢复后继续'); await approvals();
    assert.equal(await evaluate((_e, id) => global.browserLab.tabs.get(id).view.webContents.executeJavaScript('document.querySelector("#saved").textContent'), restored.tabId), '真实会话恢复后继续');
    return { sameSession: true, newGeneration: true };
  });
  const beforeClose = await state();
  await electron.close(); electron = undefined;
  await test('Full Electron restart preserves session and browser-operation journal without replay', async () => {
    const restored = await launch(); assert.equal(restored.sessionId, beforeClose.sessionId);
    assert.equal(restored.phase, 'restored-paused'); assert.equal(restored.operationCount, beforeClose.operationCount);
    assert.equal(await page.locator('#message').inputValue(), '');
    await begin('fullresume', '应用重启后明确继续'); await approvals();
    assert.equal(await page.locator('#saved').textContent(), '应用重启后明确继续');
    return { sameSession: true, journalRetained: true, autoReplay: false };
  });
  await test('Abrupt host death after browser submission leaves an unknown journal entry and never replays it', async () => {
    await begin('unknown', '只能提交一次');
    await answerOne(await waitApproval()); // fill
    const saveApproval = await waitApproval();
    assert(JSON.stringify(saveApproval.toolCall.rawInput).includes('#save'));
    await evaluate(() => {
      const runtime = global.browserLab.runtime;
      global.browserLab.actionApplied = false;
      runtime.faults.afterAction = new Promise(() => {});
      runtime.faults.afterActionReached = () => { global.browserLab.actionApplied = true; };
    });
    await answerOne(saveApproval);
    await until(() => evaluate(() => global.browserLab.actionApplied), 'browser submission applied before result acknowledgment');
    assert.equal(await page.locator('#saved').textContent(), '只能提交一次');
    const before = await state(); const journal = JSON.parse(fs.readFileSync(path.join(profile, 'runtime-state.json')));
    assert.equal(journal.operations['unknown-save'].status, 'unknown');
    const { hostPid, pids } = await evaluate(() => ({ hostPid: process.pid, pids: [global.browserLab.runtime.client.child.pid, global.browserLab.state().goPid] }));
    const processHandle = electron.process(); const exited = new Promise(resolve => processHandle.once('exit', resolve));
    // Playwright may expose a launcher wrapper on Windows. Kill the actual
    // Electron host only; killing a wrapper does not simulate host failure.
    process.kill(hostPid, 'SIGKILL'); await exited; electron = undefined;
    await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }), 'Go processes exit after parent pipe closure');
    const restored = await launch(); assert.equal(restored.sessionId, before.sessionId); assert.equal(restored.phase, 'restored-paused');
    assert.equal(await page.locator('#saved').textContent(), '');
    assert.equal(await evaluate(() => global.browserLab.runtime.saved.operations['unknown-save'].status), 'unknown');
    assert.equal(await evaluate(() => global.browserLab.runtime.modelFixture.calls), 0);
    await begin('unknown', '同一个操作不得重试'); await approvals();
    assert.equal(await page.locator('#saved').textContent(), '');
    assert.equal(await page.locator('#message').inputValue(), '');
    assert.equal(await evaluate(() => global.browserLab.runtime.saved.operations['unknown-save'].status), 'unknown');
    return { appliedBeforeCrash: true, journalOutcome: 'unknown', replayed: false, sidecarsExited: true };
  });
  fs.writeFileSync(path.join(artifacts, 'runtime-state.json'), JSON.stringify(await state(), null, 2));
  fs.writeFileSync(path.join(artifacts, 'verification.json'), JSON.stringify({ platform: process.platform, arch: process.arch, provider: 'scripted HTTP provider; production Reasonix executable', createdAt: new Date().toISOString(), results }, null, 2));
  await electron.close(); electron = undefined;
  console.log(JSON.stringify({ passed: results.filter(x => x.status === 'PASS').length, failed: results.filter(x => x.status === 'FAIL').length, artifacts }));
  process.exitCode = results.some(x => x.status === 'FAIL') ? 1 : 0;
})().catch(async error => {
  console.error(error); fs.writeFileSync(path.join(artifacts, 'fatal.txt'), error.stack);
  if (electron) { try { fs.writeFileSync(path.join(artifacts, 'failure-state.json'), JSON.stringify(await state(), null, 2)); } catch {} await electron.close().catch(() => {}); }
  process.exitCode = 1;
});
