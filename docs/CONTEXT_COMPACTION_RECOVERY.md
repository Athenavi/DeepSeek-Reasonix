# Context compaction deadlines and recovery

Automatic pressure maintenance, `/compact`, positional compaction, the compress
tool, and overflow recovery share one summary execution context. A compaction
operation has a **300-second total budget**, including preparation, cancellable
execution-gate waiting, replanning, fragment summaries and final merges. Nested
calls inherit the deadline. The ordinary model answer retains its own context.

Only nonempty text and reasoning deltas count as model output. Heartbeats,
connection activity, usage and role-only frames do not extend the deadline.
After 60 seconds without effective output, the card says it is still waiting;
this hint does not shorten the budget. Partial summaries remain buffered and
are never sent to the transcript. Summary tool calls are counted for diagnosis,
never executed.

## Failure and persistence

Below the safe input ceiling, failed automatic maintenance keeps the last
committed model projection and may continue the current turn. The existing
failed-input suppression prevents immediate repeat compaction. At the hard
ceiling or after provider-confirmed overflow, the current attempt stops with
`ErrCompactionRequired` and preserves the summary failure cause. No summary
failure installs a truncation fallback. Empty/no-reduction results, oversized
fixed prefixes and unavailable fold regions follow the same boundary decision.

Cancellation or deadline expiry before the commit boundary prevents installation.
Once a batch enters that boundary, its durability work finishes independently of
generation cancellation. A later batch cannot start with an expired context.
Previously committed summary batches or tool-result pruning remain applied;
`applied=true` accurately reports this partial progress. Persistence failures use
the existing recovery barrier. Summary-buffer workers are joined before execution
ownership is released; an adapter ignoring cancellation does not gain a detached
writer. The controller's existing stop grace and recovery ownership remain active.

The source transcript is separate from the model projection. This change does
not alter history pagination, raw message IDs, content or order. Old `truncate`
receipts remain readable; their production fallback writer has been removed.

## Progress protocol and UI

`context_compaction_progress` is an appended event kind. The same optional
`contextCompaction` object is carried in runtime snapshots and maintenance
receipts. No existing event number changes. Fields are:

| Group | Fields |
| --- | --- |
| Identity | `runId`, optional `parentOperationId`, `turnId`, `runtimeEpoch` |
| Ordering | monotonically increasing `revision` within one run |
| Stage | `trigger`; `phase`: `preparing`, `waiting_response`, `generating`, `saving` |
| Status | `running`, `completed`, `failed`, `cancelled`, `recovery_required` |
| Time | Unix milliseconds: `startedAt`, `deadlineAt`, `observedAt`, optional `lastOutputAt` |
| Counts | `requests`, optional `completedParts`, `totalParts` |
| Result | `errorCode`, `applied`, `retryable` |

Phase transitions and terminal states publish immediately; output updates publish
at most once per second. Card timers run locally. Intermediate updates are not
written to the session log. Manual progress decorates its existing maintenance
card; automatic progress does not acquire independent maintenance ownership.
Only terminal automatic receipts are persisted as optional, model-excluded
maintenance diagnostics. The latest terminal receipt is also retained in the
session projection checkpoint, allowing a new runtime to rebind retry identity.

Snapshots restore offscreen/reconnected sessions. Revision and epoch guards stop
old events reopening terminal cards or crossing sessions. Pending history without
an active owner becomes interrupted. Unknown/malformed progress is ignored while
the existing card remains readable. Missing fields from older servers use the
legacy UI; no deadline is invented for them. Existing protocol and contract hash
checks still apply.

“Retry preparation” runs only compaction through the session-bound compact route.
Admission checks the current run, runtime epoch, write authority and execution
ownership, including overlapping windows. It never resubmits a user message,
replays tools or resumes the original task. Successful retry asks the user to
continue. Save recovery uses the existing recovery path instead of this retry.

## Diagnostics

`SummaryError` supports `errors.As` and retains the underlying cause. Codes:
`summary_budget_exceeded`, `summary_provider_error`, `summary_empty`,
`summary_output_truncated`, `summary_no_reduction`, `summary_context_changed`.
User stop remains cancellation. Save failures remain persistence errors.

The operation log records run ID, trigger, status, error code, applied result,
elapsed milliseconds, request count, last effective output time and completed
parts. Debug request logs record duration and tool-call chunk count. Existing
content-free request observations provide connection, headers, first body byte,
body-byte count and finish phase; extra observers preserve previous observers.
Body bytes may be heartbeats and are not proof of model progress. Progress never
contains summary/reasoning text, credentials, URLs or complete request bodies.

## Validation and evidence boundaries

Deterministic Go `testing/synctest` cases advance the real execution clock without
sleeping five minutes: silent/usage-only streams, continuous reasoning, nested
budget, queued cancellation, partial commit and late output. Commit-boundary tests
cover both cancellation orderings. Controller tests cover retry admission,
session switching and receipt recovery. Provider tests verify observation before
complete buffering and transport observer composition. Existing cache request
shape tests continue to protect successful model request bytes.

Run the root and Desktop Go modules separately, targeted race tests, `repolint`,
frontend typecheck/transcript tests and `test:maintenance-browser`.
`desktop/packaging/compaction-native-smoke.mjs` accepts a real release-mode macOS
bundle and a disposable evidence directory. It uses an isolated Reasonix home,
an actual local SSE server and the production 300-second deadline to exercise
stop, heartbeat-only timeout, A/B switching, source history, draft preservation,
restart, retry-only behavior and normal process shutdown. It does not bypass the
shell/service identity handshake or replace bundled binaries.

These local fixtures do not establish success rates or latency for real long
contexts on every provider or reasoning model. Real-provider evidence must be
reported separately. No release/publication is part of this change.
