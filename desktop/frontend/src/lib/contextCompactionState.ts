import type { ContextCompactionState } from "../generated/desktopContract.generated";

const statuses = new Set(["running", "completed", "failed", "cancelled", "recovery_required"]);
const phases = new Set(["preparing", "waiting_response", "generating", "saving"]);

/** Optional host state is untrusted on old/new remote and persisted-history boundaries. */
export function parseContextCompactionState(value: unknown): ContextCompactionState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.runId !== "string" || !raw.runId || typeof raw.status !== "string" || !statuses.has(raw.status)
    || typeof raw.phase !== "string" || !phases.has(raw.phase) || typeof raw.trigger !== "string") return undefined;
  for (const key of ["revision", "startedAt", "deadlineAt", "observedAt"]) {
    if (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0) return undefined;
  }
  for (const key of ["lastOutputAt", "requests", "completedParts", "totalParts"]) {
    if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) return undefined;
  }
  for (const key of ["parentOperationId", "runtimeEpoch", "turnId", "errorCode"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") return undefined;
  }
  for (const key of ["applied", "retryable"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") return undefined;
  }
  return value as ContextCompactionState;
}
