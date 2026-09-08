#!/usr/bin/env node
// Launches a packaged shell against a disposable data home and proves the
// desktop/hello handshake reached ready, then quits it the way session end
// does (SIGTERM; taskkill on Windows) and checks the Go service is gone.
//
// usage: node desktop/packaging/smoke.mjs <Reasonix.app|app-dir|executable>
//        [--service <reasonix-desktop path>] [--hold <seconds>] [--timeout <seconds>] [--keep-home]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isDirectory, PRODUCT } from "./lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const targetArg = args.find((arg, index) => !arg.startsWith("--") && (index === 0 || !args[index - 1].startsWith("--") || args[index - 1] === "--keep-home"));
if (!targetArg) {
  console.error("usage: smoke.mjs <Reasonix.app|app-dir|executable> [--service <path>] [--hold <seconds>] [--timeout <seconds>] [--keep-home]");
  process.exit(2);
}
const hold = Number(option("--hold", "5")) * 1000;
const timeout = Number(option("--timeout", "60")) * 1000;
const service = option("--service", "");
const keepHome = args.includes("--keep-home");

function executableOf(path) {
  const full = resolve(path);
  if (!isDirectory(full)) return full;
  if (basename(full).endsWith(".app")) return join(full, "Contents", "MacOS", PRODUCT.executable);
  for (const name of [`${PRODUCT.executable}.exe`, PRODUCT.executable]) {
    if (existsSync(join(full, name))) return join(full, name);
  }
  throw new Error(`no ${PRODUCT.executable} executable inside ${full}`);
}

const executable = executableOf(targetArg);
if (!existsSync(executable)) throw new Error(`shell executable is missing: ${executable}`);
const home = mkdtempSync(join(tmpdir(), "reasonix-smoke-"));
const logs = join(home, "desktop-shell", "logs");
const env = {
  ...process.env,
  REASONIX_HOME: home,
  REASONIX_STATE_HOME: home,
  REASONIX_CACHE_HOME: join(home, "cache"),
  REASONIX_DEV: "1",
};
if (service !== "") env.REASONIX_DESKTOP_SERVICE = resolve(service);
const stdio = openSync(join(home, "smoke-stdio.log"), "a");
const started = Date.now();
const child = spawn(executable, [], { env, stdio: ["ignore", stdio, stdio] });
let exit = null;
child.on("exit", (code, signal) => { exit = { code, signal }; });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const readLog = (name) => {
  try {
    return readFileSync(join(logs, name), "utf8");
  } catch {
    return "";
  }
};
const tail = (name, lines = 40) => readLog(name).trimEnd().split("\n").slice(-lines).join("\n");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function fail(message) {
  console.error(`FAIL  ${message}`);
  console.error(`--- shell.log ---\n${tail("shell.log")}\n--- service.log ---\n${tail("service.log")}\n--- stdio ---\n${tail("../../smoke-stdio.log")}`);
  terminate();
  process.exit(1);
}

function terminate() {
  if (exit) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

let ready = null;
while (!ready) {
  if (exit) fail(`shell exited before the handshake (code ${exit.code}, signal ${exit.signal})`);
  if (Date.now() - started > timeout) fail(`no handshake within ${timeout / 1000}s`);
  const log = readLog("shell.log");
  const failed = /desktop service failed: .*/.exec(log);
  if (failed) fail(failed[0]);
  const line = /desktop service ready: generation (\S+), pid (\d+)/.exec(log);
  if (line) ready = { generation: line[1], pid: Number(line[2]), line: line[0] };
  else await sleep(250);
}
console.log(`PASS  handshake ready after ${((Date.now() - started) / 1000).toFixed(1)}s: ${ready.line}`);
await sleep(hold);
if (exit) fail(`shell exited during the ${hold / 1000}s hold (code ${exit.code}, signal ${exit.signal})`);
console.log(`PASS  shell still running after ${hold / 1000}s hold (service pid ${ready.pid} alive: ${process.platform === "win32" ? "unchecked" : alive(ready.pid)})`);

if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T"], { stdio: "ignore" });
else child.kill("SIGTERM");
const deadline = Date.now() + 15_000;
while (!exit && Date.now() < deadline) await sleep(100);
if (!exit) {
  terminate();
  fail("shell did not exit within 15s of SIGTERM");
}
console.log(`PASS  shell exited (code ${exit.code}, signal ${exit.signal})`);
if (process.platform !== "win32") {
  const serviceDeadline = Date.now() + 5_000;
  while (alive(ready.pid) && Date.now() < serviceDeadline) await sleep(100);
  if (alive(ready.pid)) fail(`Go service pid ${ready.pid} outlived the shell`);
  console.log(`PASS  Go service pid ${ready.pid} exited with the shell`);
}
if (keepHome) console.log(`home kept at ${home}`);
else rmSync(home, { recursive: true, force: true });
