import type { ContextCompactionState } from "../generated/desktopContract.generated";
import type { State } from "./useController";
import { upsertSessionOperationItem, sessionOperationItem } from "./sessionMaintenanceOperation";
import { parseContextCompactionState } from "./contextCompactionState";

export type { ContextCompactionState };

export function reduceContextCompactionProgress(state: State, progress?: ContextCompactionState | null): State {
  if (!parseContextCompactionState(progress) || !progress) return state;
  if (progress.runtimeEpoch && state.runtimeStatusEpoch && progress.runtimeEpoch !== state.runtimeStatusEpoch) return state;
  const operationId = progress.parentOperationId || progress.runId;
  const prior = state.items.find(item => item.kind === "compaction" && item.operationId === operationId);
  if (prior?.kind === "compaction" && prior.contextCompaction) {
    const old = prior.contextCompaction;
    // A restored terminal receipt is re-bound by the current runtime. Keep its
    // durable card identity while replacing only the retry/progress binding.
    if (old.runId === progress.runId && old.runtimeEpoch !== progress.runtimeEpoch && old.status !== "running" && progress.status !== "running") {
      return { ...state, items: state.items.map(item => item === prior ? { ...prior, contextCompaction: progress } : item) };
    }
    if (old.runId === progress.runId && (old.revision >= progress.revision || (old.status !== "running" && progress.status === "running"))) return state;
    if (old.runId !== progress.runId && old.startedAt >= progress.startedAt) return state;
  }
  if (progress.parentOperationId && prior?.kind === "compaction") {
    return { ...state, items: state.items.map(item => item === prior ? { ...prior, contextCompaction: progress } : item) };
  }
  const item = { ...sessionOperationItem({ operationId, kind: "context_compaction", activity: progress.phase,
    status: progress.status, operationRevision: progress.revision, runtimeEpoch: progress.runtimeEpoch,
    errorCode: progress.errorCode, applied: progress.applied, trigger: progress.trigger, contextCompaction: progress }),
    observedRuntimeRevision: state.runtimeStateSnapshot?.revision ?? 0 };
  const updated = upsertSessionOperationItem(state.items, item);
  return { ...state, items: updated.items, seq: state.seq + (updated.inserted ? 1 : 0) };
}

export function compactionTiming(progress: ContextCompactionState, now: number) {
  const elapsed = Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  const waiting = progress.status === "running" && progress.phase !== "saving" && now - (progress.lastOutputAt || progress.startedAt) >= 60_000;
  return { elapsed, waiting };
}
