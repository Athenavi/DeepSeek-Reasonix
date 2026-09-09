// Polls the whole-tree diff tally behind the launcher's changed row. The
// backend call is a bounded `git numstat` probe, cheap enough to repeat while
// the launcher is visible. Non-git workspaces skip it entirely — the changed
// entry is hidden there anyway.
import { useCallback, useEffect, useRef, useState } from "react";
import { app } from "./bridge";

const DIFF_STATS_POLL_MS = 5000;

export interface DiffStats {
  added: number;
  removed: number;
}

export function useWorkspaceDiffStats(gitBranch: string | undefined) {
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    if (!gitBranch) {
      setDiffStats(null);
      return;
    }
    const load = async () => {
      try {
        // Empty tab id resolves to the active tab on the backend.
        const result = await app.WorkspaceChanges("");
        if (cancelled) return;
        setDiffStats({ added: result?.added ?? 0, removed: result?.removed ?? 0 });
      } catch {
        // Keep the last known totals; a transient git failure must not blank the badge.
      }
    };
    reloadRef.current = load;
    void load();
    const timer = window.setInterval(() => void load(), DIFF_STATS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [gitBranch]);

  const reloadDiffStats = useCallback(() => reloadRef.current(), []);
  return { diffStats, reloadDiffStats };
}
