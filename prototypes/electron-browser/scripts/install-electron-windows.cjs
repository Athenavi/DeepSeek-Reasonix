// System ZIP extraction fallback for Windows hosts where the installer's
// native extract-zip binding cannot load. Artifact checksum verification stays on.
const { downloadArtifact } = require('@electron/get');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.platform !== 'win32') throw new Error('Windows only');
(async () => {
  const pkg = path.dirname(require.resolve('electron/package.json'));
  const { version } = require('electron/package.json');
  const zip = await downloadArtifact({ version, artifactName: 'electron', platform: 'win32', arch: process.arch,
    checksums: require('electron/checksums.json') });
  const dist = path.join(pkg, 'dist');
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Expand-Archive -LiteralPath $env:LAB_ELECTRON_ZIP -DestinationPath $env:LAB_ELECTRON_DIST -Force'],
  { env: { ...process.env, LAB_ELECTRON_ZIP: zip, LAB_ELECTRON_DIST: dist }, stdio: 'inherit' });
  fs.writeFileSync(path.join(pkg, 'path.txt'), 'electron.exe');
  console.log(`Electron ${version} ${process.arch}: checksum-verified ZIP extracted with PowerShell`);
})().catch(error => { console.error(error); process.exitCode = 1; });
