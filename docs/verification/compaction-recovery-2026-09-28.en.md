# Context compaction recovery verification

[简体中文](compaction-recovery-2026-09-28.md)

Baseline: `main-v2@d9ba90ed04a9d030b2f0ea9d83f5a07fe524739b`. Date: 2026-09-28.
This records local implementation evidence, not release qualification. No release was published.

## Behavior and compatibility

- Automatic, manual, range, tool, and overflow compaction share one 300-second
  operation budget across queueing, replanning, chunks, and merging. Text and
  reasoning activity is observed before complete buffering; heartbeats do not
  extend the budget.
- Summary failure no longer invokes automatic lossy truncation. Safe requests
  continue with the last valid projection; hard-limit or confirmed-overflow
  failures stop with the concrete summary cause. Legacy receipts remain readable.
- Cancellation before commit rejects installation. An accepted commit completes
  persistence; partial application is reported. Workers retain ownership and the
  recovery barrier until they exit.
- Optional events, snapshots, and terminal receipts carry progress. Manual
  operations retain their existing card and owner. Session, run, epoch, and
  revision fences reject stale updates and terminal-state reopening.
- Retry admission validates the current failure identity. Retrying only compacts;
  completion does not dispatch queued turns, inbox work, goals, messages, or tools.
- Progress never enters model requests. Successful summary prompts, schemas,
  message order, and parameters remain unchanged. Old records remain readable;
  old remotes do not acquire fabricated deadlines. Handshake checks stay strict.

See [the behavior and diagnostic reference](../CONTEXT_COMPACTION_RECOVERY.md).

## Local checks

| Check | Result and scope |
| --- | --- |
| Formatting and `git diff --check` | Passed |
| `go run ./tools/repolint` | Passed without added baseline exceptions |
| Desktop contract and root inventory | Regenerated; build checked contract freshness |
| Root `go test -timeout 30m ./...` | Full pass, including final overflow-recovery changes |
| Focused Go and race tests | Agent, Control, Provider, and eventwire passed: budgets, nesting, observation, queueing, commit races, retries, persistence, and error classification |
| Related Desktop tests | Remote budget/forwarding, maintenance, compaction, contract, and command ownership passed; final initial-generation, OpenSession, runtime-state, and maintenance race checks passed |
| Frontend | Typecheck, transcript, and maintenance browser tests passed; Electron build checked hooks, CSS, scroll writes, and bundle budgets |

An additional unpartitioned Desktop `go test ./...` did not finish: its aggregate
default ten-minute timeout expired while
`TestModelSettingsRunningToolContinuationKeepsOldConnection` had run for only four
seconds. This is neither a full Desktop pass nor evidence that this test hung.
The affected Desktop suites passed.

Go `testing/synctest` supplies virtual time for silent streams, continuously slow
reasoning, nested budgets, and actual chunk aggregation. Regressions also prove
that confirmed provider overflow retains `ErrCompactionRequired` and
`summary_budget_exceeded` without resubmitting the original request, and that an
outer ten-minute task budget does not misclassify the five-minute summary budget.
The latter regression reproduced the error before the ownership fix and passed
with race detection afterward.

## Native package

The [native smoke script](../../desktop/packaging/compaction-native-smoke.mjs) used
an actual macOS arm64 Electron package, disposable home, local SSE fixture, the
production 300-second deadline, and strict protocol handshake. Its final run
exited zero with these assertions:

- Clicking Stop closes SSE and preserves original messages, including after A→B→A.
- Heartbeats leave the budget at `300000 ms`; the terminal state was observed at
  `300003 ms`, with `summary_budget_exceeded`, one summary request, and a closed connection.
- All eight original user/assistant message IDs, order, and content survive stop,
  timeout, restart, and successful retry. The draft survives timeout and restart.
- Retry after restart adds one summary request and no ordinary requests. The UI
  reports that compaction is complete and the runtime becomes idle.
- Shell and Go service exit normally; no fixture SSE remains active.

The script writes `result.json`, `heartbeat-wait.png`, `timeout.png`, and
`retry-after-restart.png` to its evidence directory. These local artifacts are
not committed. Waiting and restart/retry screenshots were visually inspected.

Native interaction exposed two binding defects that are covered by regressions:
initial generation zero must survive TabMeta serialization, and returning to a
quiet maintenance session must immediately publish the newly bound runtime state.
Both fixes preserve strict session identity selection. Frontend decoding also
accepts the existing cancelling and recovery-required phases. The final full
300-second native rerun passed after these changes.

The final package rebuilt the Go service and CLI while reusing the same frontend
artifact that had passed the full Electron build checks, verified by the existing
artifact digest contract. This manual-compaction fixture does not set a task
budget; automatic overflow and task-budget combinations are covered separately
by deterministic Go and concurrency tests.

## Unverified scope

- No real-provider long-context run; there is no claim that every reasoning
  model can successfully summarize within five minutes.
- No Windows/Linux native-package run. The local macOS package is ad-hoc signed
  and not notarized.
- Independent history-pagination defects remain outside scope; original-message
  retention, switching, and restart are regression scenarios here.
