// User-assisted native IME and GitHub persistence check in the Windows VM.
const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts', process.platform, 'manual');
const profile = path.join(root, '.profiles', 'manual-windows');
fs.mkdirSync(artifacts, { recursive: true });
let electron;
const report = { createdAt: new Date().toISOString(), platform: process.platform, arch: process.arch };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 1200000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(250); }
  throw new Error('Timed out: ' + label);
}
async function launch() {
  const env = { ...process.env, PROTOTYPE_TEST: '1', PROTOTYPE_RUNTIME: '1', PROTOTYPE_MODEL_FIXTURE: '1',
    PROTOTYPE_PROFILE: profile, PROTOTYPE_ARTIFACTS: artifacts };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PROTOTYPE_RUNTIME_HOME;
  electron = await _electron.launch({ args: [root], env });
  await until(() => electron.evaluate(() => ['ready', 'restored-paused'].includes(global.browserLab?.runtime?.phase)), 'runtime ready', 60000);
}
async function authenticated() {
  const page = electron.context().pages().find(page => page.url().startsWith('https://github.com/'));
  return page && await page.getByRole('button', { name: 'Open user navigation menu', exact: true }).count() > 0;
}
(async () => {
  await launch(); console.log('Ready for Windows native IME: type Chinese in the right #message box and click Save.');
  report.ime = await until(() => electron.evaluate(() => global.browserLab.tabs.get('t1').view.webContents.executeJavaScript(`(() => {
    const saved = document.querySelector('#saved').textContent;
    const events = window.fixtureEvents;
    return /[\\u3400-\\u9fff]/.test(saved) && events.some(e => e.type === 'compositionupdate' && e.isTrusted) ? {saved, events} : null;
  })()`)), 'native IME user input');
  fs.writeFileSync(path.join(artifacts, 'manual-verification.json'), JSON.stringify(report, null, 2));
  console.log('Native IME recorded. Opening GitHub login for user takeover.');
  await electron.evaluate(() => global.browserLab.command('github-login'));
  await until(authenticated, 'user GitHub login'); report.authenticatedBeforeRestart = true;
  console.log('GitHub authenticated. Restarting this prototype to verify persistence.');
  await electron.close(); electron = undefined; await launch();
  await electron.evaluate(() => global.browserLab.command('github-login'));
  await until(authenticated, 'GitHub login retained', 60000); report.authenticatedAfterRestart = true;
  fs.writeFileSync(path.join(artifacts, 'manual-verification.json'), JSON.stringify(report, null, 2));
  console.log('PASS Native Windows IME and GitHub session persistence after full restart.');
  await electron.close(); electron = undefined;
})().catch(async error => {
  report.error = error.message; fs.writeFileSync(path.join(artifacts, 'manual-verification.json'), JSON.stringify(report, null, 2));
  console.error(error); if (electron) await electron.close().catch(() => {}); process.exitCode = 1;
});
