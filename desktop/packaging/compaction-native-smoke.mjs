// Release-mode macOS bundle + actual SSE heartbeat, with an isolated home.
// This deliberately waits the production 300 seconds (no timeout test hook).
// node desktop/packaging/compaction-native-smoke.mjs /path/Reasonix.app [evidence]
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packagedSmokeEnv } from "./smoke-env.mjs";
import { waitForSmokeCondition, parseServiceReady } from "./smoke-poll.mjs";
import { closeAndVerify } from "./smoke-lifecycle.mjs";

const require = createRequire(new URL("../electron/package.json", import.meta.url));
const { _electron } = require("playwright");
const bundle = resolve(process.argv[2]);
const evidence = resolve(process.argv[3] || "/tmp/reasonix-compaction-native");
const stopOnly = process.argv.includes("--stop-only");
const home = mkdtempSync(join(tmpdir(), "reasonix-compaction-native-"));
mkdirSync(evidence, { recursive: true });
let mode = "success", summaryRequests = 0, normalRequests = 0, activeStreams = 0;
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  const body = JSON.parse(raw || "{}");
  const instruction = body.messages?.at(-1)?.content;
  const summary = typeof instruction === "string" && instruction.includes("Compact the preceding conversation prefix");
  if (summary) summaryRequests++; else normalRequests++;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  if (summary && mode === "heartbeat") {
    activeStreams++;
    response.write(": heartbeat\n\n");
    const tick = setInterval(() => response.write(": heartbeat\n\n"), 1000);
    response.on("close", () => { clearInterval(tick); activeStreams--; });
    return;
  }
  const content = summary ? "## Goal\nKeep the native compaction task and its latest input.\n## Progress\nFour original turns remain in history."
    : `NATIVE_REPLY_${normalRequests}\n${"Preserved source details. ".repeat(400)}`;
  response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
writeFileSync(join(home, "config.toml"), `default_model = "fixture/model"\n[desktop]\nprovider_access = ["fixture"]\n[[providers]]\nname = "fixture"\nkind = "openai"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nmodels = ["model"]\ndefault = "model"\napi_key_env = "COMPACTION_FIXTURE_KEY"\n`);
let application, page, refA, tabA;
const invoke = (method, args = []) => page.evaluate(({ method, args }) => window.reasonixDesktop.invoke(method, args), { method, args });
const active = async () => (await invoke("ListTabs")).find(tab => tab.active);
const runtime = async () => (await invoke("GetRuntimeStateSnapshot")).sessions.find(item => item.tabId === tabA.id)?.state;
const history = async () => (await invoke("ReadSessionHistory", [refA, "", 32])).messages
  .filter(message => ["user", "assistant", "tool"].includes(message.role)).map(({ role, messageId, content }) => ({ role, messageId, content }));
async function launch() {
  application = await _electron.launch({ executablePath: join(bundle, "Contents/MacOS/Reasonix"),
    env: { ...packagedSmokeEnv(process.env, home), COMPACTION_FIXTURE_KEY: "local-fixture" } });
  await waitForSmokeCondition(async () => {
    page = application.windows().find(candidate => !candidate.isClosed());
    return page && await page.evaluate(() => Boolean(window.reasonixDesktop)).catch(() => false);
  });
  const build = JSON.parse(readFileSync(join(bundle, "Contents/Resources/build.json"), "utf8"));
  assert.equal(await invoke("Version"), build.version);
  assert.equal(await application.evaluate(({ app }) => app.isPackaged && !process.env.REASONIX_DEV), true);
  await page.locator(".sidebar__quick-action").waitFor();
}
async function close() {
  const ready = readFileSync(join(home, "desktop-shell/logs/shell.log"), "utf8").split("\n").reverse().map(parseServiceReady).find(Boolean);
  const pid = await application.evaluate(() => process.pid);
  await closeAndVerify(application, { shellPid: pid, servicePid: ready.pid });
  application = null;
}
async function send(input) {
  const before = normalRequests;
  await page.locator("textarea").first().fill(input);
  await page.locator(".composer__btn--send").click();
  await waitForSmokeCondition(async () => normalRequests > before && !(await active())?.running);
}
const compact = () => invoke("CompactForTab", [tabA.id]).then(() => null, error => error.message);
async function scenario() {
  await launch();
  await invoke("CreateSession", ["global"]);
  for (let index = 0; index < 4; index++) await send(`NATIVE_ORIGINAL_A_${index}`);
  tabA = await active(); refA = tabA.session;
  await invoke("RenameCanonicalSession", [refA, "Compaction native A"]);
  const original = await history();
  mode = "heartbeat";
  let pending = compact();
  await waitForSmokeCondition(async () => (await runtime())?.contextCompaction?.phase === "waiting_response" && activeStreams === 1);
  const binding = (await invoke("GetRuntimeStateSnapshot")).sessions.find(item => item.tabId === tabA.id);
  assert.equal(tabA.sessionGeneration, binding?.sessionGeneration, "initial generation must survive tab serialization");
  await page.locator(".composer__btn--stop").waitFor({ timeout: 5000 });
  await page.locator(".composer__btn--stop").click();
  assert.match(await pending, /cancel/i);
  await waitForSmokeCondition(() => activeStreams === 0);
  assert.deepEqual(await history(), original);
  console.log("PASS stop closes SSE and preserves canonical messages");

  const beforeTimeout = summaryRequests;
  pending = compact();
  await waitForSmokeCondition(async () => (await runtime())?.contextCompaction?.status === "running" && activeStreams === 1);
  const started = (await runtime()).contextCompaction;
  assert.ok(started.deadlineAt - started.startedAt >= 300000 && started.deadlineAt - started.startedAt <= 300010);
  await page.locator("textarea").first().fill("DRAFT_SURVIVES_COMPACTION_TIMEOUT");
  await page.locator(".sidebar__quick-action").click();
  await send("NATIVE_B_SEPARATE");
  assert.equal(await page.locator(".compaction--pending").count(), 0);
  await page.locator(".project-tree__topic-main").filter({ has: page.getByText("Compaction native A", { exact: true }) }).click();
  await waitForSmokeCondition(async () => (await active())?.session?.sessionId === refA.sessionId);
  tabA = await active();
  await page.locator(".composer__btn--stop").waitFor({ timeout: 5000 });
  if (stopOnly) {
    await page.locator(".composer__btn--stop").click();
    await pending;
    await waitForSmokeCondition(() => activeStreams === 0);
    assert.deepEqual(await history(), original);
    console.log("PASS stop remains available after session switching");
    return;
  }
  await waitForSmokeCondition(async () => Date.now() - started.startedAt >= 61000, { timeout: 70000, interval: 500 });
  await page.getByText(/Still waiting for model output|仍在等待模型[输輸]出/).waitFor();
  await page.screenshot({ path: join(evidence, "heartbeat-wait.png") });
  console.log("PASS session switching and 60-second heartbeat-only wait; waiting for the real five-minute deadline");
  await waitForSmokeCondition(async () => (await runtime())?.contextCompaction?.status === "failed", { timeout: 260000, interval: 250 });
  assert.match(await pending, /summary_budget_exceeded/);
  const terminal = (await runtime()).contextCompaction;
  assert.equal(terminal.errorCode, "summary_budget_exceeded");
  assert.equal(terminal.applied ?? false, false);
  assert.ok(terminal.observedAt - terminal.startedAt >= 300000 && terminal.observedAt - terminal.startedAt < 320000);
  assert.equal(summaryRequests, beforeTimeout + 1);
  await waitForSmokeCondition(() => activeStreams === 0);
  assert.deepEqual(await history(), original);
  assert.equal(await page.locator("textarea").first().inputValue(), "DRAFT_SURVIVES_COMPACTION_TIMEOUT");
  await page.getByText(/exceeded 5 minutes|超[过過] 5 分[钟鐘]/).waitFor();
  await page.screenshot({ path: join(evidence, "timeout.png") });
  console.log("PASS production 300-second budget with live heartbeats, no truncation or surviving SSE");
  await close();
  await launch();
  await invoke("OpenSession", [refA]); tabA = await active();
  await waitForSmokeCondition(async () => (await runtime())?.contextCompaction?.runId === terminal.runId);
  assert.deepEqual(await history(), original);
  const restored = (await runtime()).contextCompaction;
  assert.equal(restored.status, "failed");
  mode = "success";
  const beforeRetry = { summaryRequests, normalRequests };
  await page.getByRole("button", { name: /Retry preparation|重[试試]整理/ }).click();
  await waitForSmokeCondition(async () => (await runtime())?.contextCompaction?.status === "completed" && !(await runtime())?.running);
  assert.equal(summaryRequests, beforeRetry.summaryRequests + 1);
  assert.equal(normalRequests, beforeRetry.normalRequests, "retry must not resume the original user task");
  assert.deepEqual(await history(), original);
  assert.equal((await runtime()).running, false);
  await page.screenshot({ path: join(evidence, "retry-after-restart.png") });
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ home, bundle, terminal, summaryRequests, normalRequests,
    originalMessageCount: original.length, checks: ["strict-package-handshake", "stop", "heartbeat-budget", "session-switch", "canonical-history", "draft", "restart", "retry-only"] }, null, 2));
  await close();
  console.log(`PASS restart, retry-only and normal shutdown; evidence ${evidence}`);
}
try {
  await scenario();
} catch (error) {
  await page?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  writeFileSync(join(evidence, "failure.txt"), `${error.stack}\nhome=${home}\n${JSON.stringify(await runtime().catch(() => null))}\n${await page?.locator("body").innerText().catch(() => "")}`);
  const stopButtons = await page?.locator(".composer__btn--stop").evaluateAll(elements => elements.map(element => ({
    visible: element.getClientRects().length > 0, disabled: element.disabled,
  }))).catch(() => null);
  writeFileSync(join(evidence, "binding.json"), JSON.stringify({ tabs: await invoke("ListTabs").catch(() => null), runtime: await invoke("GetRuntimeStateSnapshot").catch(() => null), stopButtons }, null, 2));
  throw error;
} finally {
  if (application) {
    if (tabA) await invoke("CancelSessionForTab", [tabA.id]).catch(() => {});
    await close().catch(() => application.close());
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
