import { useEffect, useState } from "react";
import { app } from "../lib/bridge";
import { compactionTiming, type ContextCompactionState } from "../lib/contextCompactionProgress";
import { getTranscriptStore } from "../lib/transcriptStore";
import { useT } from "../lib/i18n";
import { ErrorMessage } from "./ErrorMessage";

export function CompactionProgress({ progress, tabId }: { progress: ContextCompactionState; tabId?: string }) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  useEffect(() => {
    if (progress.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress.runId, progress.status]);
  const timing = compactionTiming(progress, now);
  const label = progress.status === "running"
    ? progress.phase === "saving" ? t("compaction.saving")
      : progress.phase === "preparing" ? t("compaction.preparing")
        : timing.waiting ? t("compaction.noProgress")
          : progress.phase === "generating" ? t("compaction.generating") : t("compaction.waitingResponse")
    : progress.errorCode === "summary_budget_exceeded" ? t("compaction.timeout")
      : progress.status === "failed" ? t("compaction.failedPreserved")
        : progress.status === "cancelled" ? t("compaction.cancelled")
          : progress.status === "recovery_required" ? t("compaction.recoveryRequired") : t("compaction.title");
  const retry = async () => {
    if (!tabId || busy) return;
    const state = getTranscriptStore().states.get(tabId);
    const current = state?.runtimeStateSnapshot?.contextCompaction;
    if (!current || current.runId !== progress.runId || current.runtimeEpoch !== progress.runtimeEpoch || state?.running || state?.backendActivationPending) {
      setError(t("compaction.targetChanged")); return;
    }
    setBusy(true); setError("");
    try { await app.RetryContextCompactionForTab(tabId, progress.runId, progress.runtimeEpoch || ""); setComplete(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="compaction__hint" role="status">
    {label}
    {progress.status === "running" && progress.phase !== "saving" && <span> · {t("compaction.elapsed", { seconds: timing.elapsed })}</span>}
    {!!progress.completedParts && <span> · {t("compaction.parts", { n: progress.completedParts })}</span>}
    {progress.applied && progress.status !== "completed" && <div>{t("compaction.partialSaved")}</div>}
    {progress.status === "failed" && progress.retryable && tabId && <button className="btn" disabled={busy || complete} onClick={() => void retry()}>{t("compaction.retry")}</button>}
    {complete && <div>{t("compaction.readyToContinue")}</div>}
    {error && <ErrorMessage error={error} />}
  </div>;
}
