const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', process.platform, 'bench');
fs.mkdirSync(output, { recursive: true });
async function run(index) {
  const dir = path.join(output, String(index));
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, PROTOTYPE_PROFILE: fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-browser-bench-')), PROTOTYPE_ARTIFACTS: dir, PROTOTYPE_BENCH: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [root], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', data => fs.appendFileSync(path.join(dir, 'stderr.log'), data));
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (exit !== 0) throw new Error(`Benchmark ${index} exited ${exit}`);
  return JSON.parse(fs.readFileSync(path.join(dir, 'benchmark.json')));
}
(async () => {
  const runs = [];
  for (let index = 1; index <= 3; index++) { runs.push(await run(index)); console.log(`Benchmark ${index}/3 complete`); }
  const median = values => [...values].sort((a,b) => a-b)[1];
  const report = { platform: process.platform, arch: process.arch, runs,
    medianFirstReadyMs: median(runs.map(r => r.firstReadyMs)),
    medianOneTabRssMiB: median(runs.map(r => r.samples[0].electronRssMiB)),
    medianFiveTabRssMiB: median(runs.map(r => r.samples[1].electronRssMiB)),
    medianGoRssMiB: median(runs.map(r => r.samples[0].goRssMiB)),
    caveats: ['Fresh process and fresh profile, warm OS file cache; not disk-cold boot', 'Electron working set sum may double-count shared pages; Go working set measured separately', 'Synthetic same-origin pages, no production Reasonix UI/runtime', 'Two-second settling period; no long-duration leak claim'] };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ medianFirstReadyMs: report.medianFirstReadyMs, medianOneTabRssMiB: report.medianOneTabRssMiB, medianFiveTabRssMiB: report.medianFiveTabRssMiB }));
})().catch(error => { console.error(error); process.exitCode = 1; });
