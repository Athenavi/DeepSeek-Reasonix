// Bounded live-provider acceptance. Automatic confirmations are restricted to
// the synthetic local #message/#save task; login is always handed to the user.
const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const profile = path.join(root, '.profiles', 'live-integration');
const artifacts = path.join(root, 'artifacts', process.platform, 'live-runtime');
fs.mkdirSync(artifacts, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let electron;
const report = { createdAt: new Date().toISOString(), provider: 'configured deepseek-v4-flash', results: [] };
async function until(fn, label, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(150); }
  throw new Error('Timed out: ' + label);
}
const evaluate = (fn, arg) => electron.evaluate(fn, arg);
const command = (method, args = {}) => evaluate((_e, x) => global.browserLab.command(x.method, x.args), { method, args });
async function runTask(text) {
  await evaluate((_e, text) => {
    global.browserLab.liveResult = null;
    global.browserLab.runtime.run(`在本地测试页 #message 填写“${text}”，然后只点击一次 #save 保存。先读取页面，操作后再次读取核对。每个 act 使用新的唯一 operationId。不要打开其他网站，不要调用 shell。`).then(result => { global.browserLab.liveResult = { ok: true, result }; }, error => { global.browserLab.liveResult = { ok: false, error: error.message }; });
  }, text);
  let approved = 0;
  await until(async () => {
    const state = (await command('state')).runtime;
    for (const request of state.approvals) {
      assert.equal(request.source, 'mcp-elicitation');
      const raw = request.toolCall.rawInput;
      const args = JSON.parse(raw.slice(raw.indexOf('{')));
      assert((args.action === 'fill' && args.selector === '#message' && args.text === text) || (args.action === 'click' && args.selector === '#save'));
      const option = request.options.find(x => x.kind === 'allow_once');
      await command('runtime-approve', { id: request.id, generation: request.generation, optionId: option.optionId }); approved++;
      console.log('Confirmed local fixture action:', args.action);
    }
    return evaluate(() => global.browserLab.liveResult !== null);
  }, 'live task completes');
  const result = await evaluate(() => global.browserLab.liveResult); assert.equal(result.ok, true, result.error);
  const page = await evaluate(() => global.browserLab.tabs.get(global.browserLab.runtime.tabId).view.webContents.executeJavaScript('({saved:document.querySelector("#saved").textContent,message:document.querySelector("#message").value})'));
  assert.equal(page.saved, text); assert.equal(approved, 2);
  return { text, approved, stopReason: result.result.stopReason, page };
}
(async () => {
  const env = { ...process.env, PROTOTYPE_TEST: '1', PROTOTYPE_RUNTIME: '1', PROTOTYPE_PROFILE: profile,
    PROTOTYPE_RUNTIME_HOME: path.join(root, '.profiles', 'runtime-live-home'), PROTOTYPE_ARTIFACTS: artifacts };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PROTOTYPE_MODEL_FIXTURE;
  electron = await _electron.launch({ args: [root], env, timeout: 30000 });
  await until(() => evaluate(() => ['ready', 'restored-paused'].includes(global.browserLab?.runtime?.phase)), 'live runtime ready', 60000);
  console.log('Live production runtime ready');
  report.results.push({ name: 'live provider to browser', ...await runTask('真实模型驱动浏览器验证通过') });
  const before = (await command('state')).runtime;
  await command('runtime-restart'); const restored = (await command('state')).runtime;
  assert.equal(restored.sessionId, before.sessionId); assert.equal(restored.phase, 'restored-paused');
  report.results.push({ name: 'live provider after session recovery', ...await runTask('恢复会话后真实模型继续成功') });
  report.sessionId = restored.sessionId;
  report.operationCount = (await command('state')).runtime.operationCount;
  report.metrics = await command('metrics');
  fs.writeFileSync(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2));
  console.log('Live task and explicit recovery passed');
  await command('github-login');
  console.log('GitHub login opened for user takeover. The browser remains running.');
  // Preserve the real native browser for the user's login and OS IME validation.
  await new Promise(resolve => electron.process().once('exit', resolve));
})().catch(async error => {
  report.error = error.stack; fs.writeFileSync(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2));
  console.error(error);
  if (electron) await electron.close().catch(() => {});
  process.exitCode = 1;
});
