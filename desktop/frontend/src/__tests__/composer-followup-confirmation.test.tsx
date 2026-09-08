import assert from "node:assert/strict";
import { act } from "react";
import { installDom, installBridgeApp, renderComposer } from "./composerInboxHarness";
import { runtimeStateStore, type RuntimeProjection } from "../lib/runtimeStateStore";
import { acceptRuntimeState } from "../lib/runtimeStateReducer";
import { pendingFollowups, type InboxTarget } from "../lib/pendingFollowup";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function paste(text: string) {
  await act(async () => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [], items: [], types: ["text/plain"], getData: () => text } });
    document.querySelector("textarea.composer__input:not([aria-hidden=true])")!.dispatchEvent(event);
    await flush();
  });
}
async function send() {
  await act(async () => { (document.querySelector(".composer__btn--send") as HTMLButtonElement).click(); await flush(); });
}
function state(phase: "idle" | "executing" | "finishing", revision: number): RuntimeProjection {
  return { epoch: "confirmation-test", revision, topics: [], sessions: [{
    tabId: "tab-a", scope: "project", workspaceRoot: "/repo", topicId: "topic", sessionPath: "session-a", sessionGeneration: 1,
    open: true, remote: true, freshness: "synced", state: { schemaVersion: 1, runtimeEpoch: "controller", revision,
      phase, running: phase !== "idle", turnId: "turn", turnStatus: "completed", turnEventSeq: 3,
      pendingPrompt: false, cancelRequested: false, cancellable: phase === "executing", backgroundJobs: 0, activity: "" },
  }] };
}

for (const phase of ["idle", "executing", "finishing"] as const) {
  const dom = installDom();
  let posts = 0, direct = 0, steers = 0, queries = 0;
  const target: InboxTarget = { tabId: "tab-a", sessionPath: "session-a", generation: 7, selection: 3, remote: true };
  let key = "", confirmed = false;
  installBridgeApp({
    CaptureInboxTarget: async () => target,
    EnqueueInboxFollowupForTarget: async (captured: InboxTarget, _display: string, _submit: string, _invocations: unknown, id: string) => {
      posts++; key = id; assert.deepEqual(captured, target); throw new Error("reply and first receipt lookup lost");
    },
    LookupInboxFollowupForTarget: async (captured: InboxTarget, id: string) => {
      queries++; assert.deepEqual(captured, target); assert.equal(id, key);
      if (!confirmed) throw new Error("receipt unavailable");
      return { itemId: "already-consumed", disposition: "idempotent_hit", position: 0, paused: false };
    },
    InboxSnapshot: async () => ({ revision: 1, paused: false, recovered: false, items: [], itemsCount: 0, bytes: 0, maxItems: 64, maxBytes: 1024 }),
  });
  runtimeStateStore.commit(state("finishing", 1));
  let view = await renderComposer({ inboxSessionPath: "session-a", onSend: () => { direct++; }, onSteer: async () => { steers++; } });
  await paste("original follow-up");
  await send();
  assert.equal(posts, 1);
  assert.equal(document.querySelector(".composer__btn--send")?.getAttribute("aria-label"), "Check send result");
  await act(async () => { acceptRuntimeState(runtimeStateStore, state(phase, 2), true); await flush(); });
  await send();
  assert.equal(queries, 1);
  assert.equal(posts, 1);
  assert.equal(direct + steers, 0);
  assert.ok(pendingFollowups.get("session-a"));

  await view.rerender({ tabId: "tab-b", sessionKey: "session-b", inboxSessionPath: "session-b" });
  assert.notEqual(document.querySelector(".composer__btn--send")?.getAttribute("aria-label"), "Check send result");
  await view.rerender({ tabId: "tab-a", sessionKey: "session-a", inboxSessionPath: "session-a" });
  if (phase === "executing") {
    await act(async () => { view.root.unmount(); });
    view = await renderComposer({ inboxSessionPath: "session-a", onSend: () => { direct++; }, onSteer: async () => { steers++; } });
    assert.equal(document.querySelector(".composer__btn--send")?.getAttribute("aria-label"), "Check send result");
    assert.match(document.querySelector('[role="status"]')?.textContent ?? "", /original follow-up/, "the original request survives remount");
  }
  await paste("later draft edit");
  confirmed = true;
  await send();
  assert.equal(posts, 1);
  assert.equal(queries, 2);
  assert.equal(direct + steers, 0);
  assert.equal(pendingFollowups.get("session-a"), undefined);
  assert.match((document.querySelector("textarea.composer__input:not([aria-hidden=true])") as HTMLTextAreaElement).value, /later draft edit/);
  assert.equal(document.querySelector(".composer-guidance-item"), null, "completed receipt must not resurrect a queued row");
  await act(async () => { view.root.unmount(); });
  dom.window.close();
}

{
  const dom = installDom();
  let posts = 0;
  installBridgeApp({ EnqueueInboxFollowup: async () => { posts++; throw new Error("legacy transport outcome unknown"); } });
  runtimeStateStore.commit(state("finishing", 1));
  const view = await renderComposer();
  await paste("legacy follow-up");
  await send();
  await act(async () => { runtimeStateStore.commit(state("idle", 2)); });
  await send();
  assert.equal(posts, 1, "missing receipt capability never permits another POST");
  const pending = pendingFollowups.get("session-a");
  assert.ok(pending);
  await view.rerender({ inboxHostId: "different-host" });
  assert.notEqual(document.querySelector(".composer__btn--send")?.getAttribute("aria-label"), "Check send result", "host identity isolates otherwise identical draft keys");
  await act(async () => { pendingFollowups.clear("session-a", pending); view.root.unmount(); });
  dom.window.close();
}

{
  const dom = installDom();
  let posts = 0;
  installBridgeApp({ EnqueueInboxFollowup: async () => { posts++; throw new Error("reasonix_error:inbox_not_submitted"); } });
  runtimeStateStore.commit(state("finishing", 1));
  const view = await renderComposer();
  await paste("rejected follow-up");
  await send();
  assert.equal(pendingFollowups.get("session-a"), undefined, "a definite pre-execution rejection releases the request");
  assert.match((document.querySelector("textarea.composer__input:not([aria-hidden=true])") as HTMLTextAreaElement).value, /rejected follow-up/);
  await send();
  assert.equal(posts, 2, "a known unexecuted request remains retryable");
  await act(async () => { view.root.unmount(); });
  dom.window.close();
}
console.log("PASS: uncertain follow-up stays bound across phases, selection, edits, and remounts");
