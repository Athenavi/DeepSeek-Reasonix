// Run only after the user has completed GitHub login and closed the live lab.
// Persist booleans only: never export cookies, account details or dashboard DOM.
const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const profile = path.join(root, '.profiles', 'live-integration');
const artifacts = path.join(root, 'artifacts', process.platform, 'live-runtime');
const before = JSON.parse(fs.readFileSync(path.join(artifacts, 'verification.json')));
let electron;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await fn()) return; await sleep(200); }
  throw new Error('Timed out: ' + label);
}
const report = { createdAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  userConfirmedLoginAndIME: true, imeEvidence: 'Native user input: shu\'ru\'fa -> 输入法; trusted compositionupdate/input, final committed text observed. compositionend reported isTrusted=false.',
  credentialsHandledBy: 'user', results: {} };
(async () => {
  const env = { ...process.env, PROTOTYPE_TEST: '1', PROTOTYPE_RUNTIME: '1', PROTOTYPE_PROFILE: profile,
    PROTOTYPE_RUNTIME_HOME: path.join(root, '.profiles', 'runtime-live-home'), PROTOTYPE_ARTIFACTS: artifacts };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PROTOTYPE_MODEL_FIXTURE;
  electron = await _electron.launch({ args: [root], env });
  await until(() => electron.evaluate(() => global.browserLab?.runtime?.phase === 'restored-paused'), 'restored task paused');
  const state = await electron.evaluate(() => global.browserLab.runtime.snapshotState());
  assert.equal(state.sessionId, before.sessionId); assert.equal(state.operationCount, before.operationCount);
  report.results.sameSession = true; report.results.restoredPaused = true; report.results.noBrowserWriteReplay = true;
  await electron.evaluate(() => global.browserLab.command('github-login'));
  await until(async () => {
    const github = electron.context().pages().find(page => page.url().startsWith('https://github.com/'));
    return github && await github.getByRole('button', { name: 'Open user navigation menu', exact: true }).count() > 0;
  }, 'GitHub login retained');
  report.results.githubAuthenticatedAfterFullRestart = true;
  fs.writeFileSync(path.join(artifacts, 'manual-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await electron.evaluate(() => global.browserLab.command('activate', { id: 't1' }));
  console.log('Restored prototype remains available for review.');
  await new Promise(resolve => electron.process().once('exit', resolve));
})().catch(async error => {
  report.error = error.stack; fs.writeFileSync(path.join(artifacts, 'manual-verification.json'), JSON.stringify(report, null, 2));
  console.error(error); if (electron) await electron.close().catch(() => {}); process.exitCode = 1;
});
