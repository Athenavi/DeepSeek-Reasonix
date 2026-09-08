const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '../..');
fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
for (const [name, source] of [['reasonix', './cmd/reasonix'], ['browser-mcp', './prototypes/electron-browser/runtime-mcp']]) {
  const result = spawnSync('go', ['build', '-trimpath', '-o', path.join(root, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), source], { cwd: repo, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
