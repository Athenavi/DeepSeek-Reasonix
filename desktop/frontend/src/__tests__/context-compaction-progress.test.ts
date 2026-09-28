import assert from "node:assert/strict";
import { initialState, reducer, type State } from "../lib/useController";
import { compactionTiming, type ContextCompactionState } from "../lib/contextCompactionProgress";
import { parseSessionOperation, sessionOperationHistoryMessage } from "../lib/sessionMaintenanceOperation";
import { parseContextCompactionState } from "../lib/contextCompactionState";

const start: ContextCompactionState = { runId: "run-A", runtimeEpoch: "epoch-A", trigger: "pressure", revision: 1,
  phase: "waiting_response", status: "running", startedAt: 1000, observedAt: 1000, deadlineAt: 301000 };
const apply = (state: State, progress: ContextCompactionState) => reducer(state, { type: "event", e: { kind: "context_compaction_progress", contextCompaction: progress } });
let state = apply(initialState, start);
assert.equal(state.items.length, 1);
const id = state.items[0].id;
state = reducer(state, { type: "event", e: { kind: "compaction_started", compaction: { trigger: "pressure" } } });
assert.equal(state.items.length, 1, "legacy start cannot duplicate a progress card");
state = reducer(state, { type: "event", e: { kind: "compaction_done", compaction: { trigger: "pressure", summary: "complete digest" } } });
assert.equal(state.items[0].id, id);
const failed = { ...start, revision: 3, status: "failed", errorCode: "summary_budget_exceeded", retryable: true };
state = apply(state, failed);
state = apply(state, { ...start, revision: 4 });
assert.equal(state.items[0].kind === "compaction" && state.items[0].status, "failed", "terminal state survives late running updates");
assert.equal(apply({ ...state, runtimeStatusEpoch: "epoch-B" }, start).items, state.items, "another runtime cannot write the card");
assert.deepEqual(compactionTiming(start, 61000), { elapsed: 60, waiting: true });
assert.equal(compactionTiming({ ...start, lastOutputAt: 60900 }, 61000).waiting, false);
assert.equal(compactionTiming({ ...start, phase: "saving" }, 301000).waiting, false);

const operation = parseSessionOperation(JSON.parse(JSON.stringify({ operationId: start.runId, kind: "context_compaction", status: "failed", activity: "waiting_response", trigger: "pressure", contextCompaction: failed })))!;
const restored = reducer(initialState, { type: "history", messages: [sessionOperationHistoryMessage("receipt", operation)] });
assert.equal(restored.items[0].kind === "compaction" && restored.items[0].contextCompaction?.errorCode, "summary_budget_exceeded");
const rebound = apply({ ...restored, runtimeStatusEpoch: "epoch-new" }, { ...failed, runtimeEpoch: "epoch-new" });
assert.equal(rebound.items.length, 1);
assert.equal(rebound.items[0].kind === "compaction" && rebound.items[0].contextCompaction?.runtimeEpoch, "epoch-new");
assert.equal(parseContextCompactionState({ ...start, startedAt: "invalid" }), undefined);
assert.equal(parseContextCompactionState({ ...start, status: "future-unknown" }), undefined);
const orphan = reducer(apply(initialState, start), { type: "runtime_snapshot", snapshot: {
  schemaVersion: 1, projectionEpoch: "next", runtimeEpoch: "next", revision: 1, activityRevision: 0, phase: "idle", running: false,
  turnId: "", turnStatus: "", turnEventSeq: 0, pendingPrompt: false, cancellable: false, cancelRequested: false, backgroundJobs: 0, activity: "",
} });
assert.equal(orphan.items[0].kind === "compaction" && orphan.items[0].status, "interrupted");
assert.equal(orphan.items[0].kind === "compaction" && orphan.items[0].contextCompaction, undefined);

let manual = reducer(initialState, { type: "event", e: { kind: "session_operation", sessionOperation: {
  operationId: "manual", kind: "compact", status: "running", activity: "running", operationRevision: 1,
} } });
manual = apply(manual, { ...start, parentOperationId: "manual" });
assert.equal(manual.items.length, 1, "manual lifecycle and progress share one card");
assert.equal(manual.items[0].kind === "compaction" && manual.items[0].contextCompaction?.runId, "run-A");
console.log("context compaction: progress, terminality, identity, timer and history restore passed");
