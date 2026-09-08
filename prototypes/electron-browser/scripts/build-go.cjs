const { spawnSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
mkdirSync(path.join(root, 'bin'), { recursive: true });
const result = spawnSync('go', ['build', '-trimpath', '-o', path.join(root, 'bin', process.platform === 'win32' ? 'browser-fixture.exe' : 'browser-fixture'), '.'], {
  cwd: path.join(root, 'fixture'), stdio: 'inherit', env: { ...process.env, GOTOOLCHAIN: 'local' }
});
process.exit(result.status ?? 1);
