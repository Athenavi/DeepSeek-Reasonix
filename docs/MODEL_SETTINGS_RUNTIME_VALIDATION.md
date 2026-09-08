# Model settings runtime validation

This record distinguishes implemented behavior from release qualification. The change is not qualified for publication until the final candidate passes the complete matrix, including native Windows upgrade acceptance.

| Requirement | Owning implementation | Evidence |
| --- | --- | --- |
| Save with no active session; default affects new sessions only | `desktop/model_settings_api.go`, `desktop/model_settings_preferences.go` | `TestModelSettingsSaveWithoutActiveSession`, default-model/new-session tests |
| Validate and compare before persistence; unknown fields retained | `internal/config/model_settings_edit.go`, unified API operation allowlist | `TestModelSettingsRequestRejectsStaleEdit`, `TestSaveModelSettingsPreservesUnknownFields`, catalog overlap tests |
| Copy-on-write credentials, grouped connections, failure recovery | `internal/config/model_credential_commit.go` | `TestModelSettingsGroupedCredentialCommitAndReceipt`, `TestModelSettingsFailedCommitCleansOnlyItsStagedCredential`, `TestModelSettingsCredentialWriteFailureKeepsConfig` |
| Current tool continuation retains its connection; next run refreshes | `internal/config/model_runtime_snapshot.go`, `internal/boot/boot.go`, `desktop/turn_admission.go` | `TestModelSettingsRunningToolContinuationKeepsOldConnection`, frozen-credential tests |
| FIFO follow-ups and bot requests use the new-run boundary | `internal/control/inbox_dispatch.go`, `internal/bot/model_settings.go` | `TestModelSettingsQueuedFollowupAppliesLatestBeforeDispatch`, `TestBotNewRunAppliesModelSettingsAndKeepsSessionOnFailure` |
| Per-project and inactive/detached application | Runtime-owner lookup and existing Desktop rebuild boundary | `TestModelSettingsProjectOverrideSkipsRebuild`, `TestModelSettingsRemovalRetryKeepsFailedTargetAndAppliesInactiveSibling`, `TestModelSettingsRetryAppliesDetachedRuntimeWithoutCreatingTab` |
| Startup and consecutive-save publication fencing | Startup model revision check and versioned deferred rebuild entries | `TestModelSettingsStartupPublicationRejectsCandidateBuiltBeforeSave`, deferred rebuild tests |
| Final lease invalidation preserves the old runtime and permits a safe retry | Final authority bind, fail-closed admission and refreshed authority before migration snapshot | `TestModelSettingsFinalAuthorityFailurePreservesRuntimeAndRecovers` releases the real lease immediately before final bind |
| Deletion blocks an unavailable next run without destroying history | Validated runtime model resolution | `TestModelSettingsLastProviderRemovalBlocksNewRun`, provider removal tests |
| Remote immutable routes, candidate ownership and automatic next-run application | `desktop/cred_proxy.go`, `desktop/remote_model_settings.go`, `internal/serve/model_settings_source.go` | `TestRemoteModelOwnershipRetiresOldRouteAfterInFlightRequest`, `TestRemoteModelSourceRefreshesAutonomousHTTPRunAndRetiresOldRoute`, Serve application-failure/receipt tests |
| Remote project configuration remains authoritative | `internal/config/model_runtime_settings.go` | `TestManagedModelSnapshotPreservesProjectProviderAndAssignments` |
| No architecture metadata in model prefixes | Transport-only snapshot metadata and unchanged serializers | `TestRemoteModelSnapshotPreservesWirePrefixAndKeepsKeysLocal` compares OpenAI, Anthropic and Responses request bytes |
| Saved/pending/failed states and draft races | Structured bridge result, request receipts, read/apply generations | `model-settings-receipt.test.ts`, `provider-editor-save-races.test.tsx`, settings refresh snapshot tests |
| Children created after a save and approval continuations retain the accepted snapshot | Boot-created child factories and controller approval resume | `TestModelSettingsChildCreatedAfterSaveInheritsAcceptedRunSnapshot`, `TestModelSettingsApprovalResumeKeepsAcceptedCredential` exercise actual HTTP requests |
| Source refresh supersession and uncertain completion | Shared runtime-owner refresh, source revision fencing and retained offers | `TestModelSettingsSourceFencesOvertakenBuildAndUncertainFinish` |
| Detached remote work retains its own admission boundary | `internal/serve/model_settings_detached.go` | `TestDetachedModelSettingsRefreshTargetsItsOwnerAndPreservesFailure`, `TestDetachedModelSettingsKeepsQueuedOwnerUntilAdmission` |
| Bounded remote ownership does not evict accepted routes | Proxy-scoped offer admission | `TestRemoteModelOfferCapacityPreservesOwnedRoutes` |
| Late ownership receipts and replaced connections cannot revoke current routes | Serve-wide incarnation/sequence, atomically pinned connection identity and route reconciliation | `TestRemoteOwnershipRejectsOvertakenReceipts`, `TestRemoteReplacedConnectionCannotPinOwnership`, `TestRemoteIncarnationReclaimsOldReservationsAndRejectsLateBuilders` |
| Rejected installs release reservations; unknown installs retain them until confirmed | Typed rejection and positive ownership readback | `TestRemoteInstallDistinguishesRejectionFromLostAcknowledgement`, `TestRemoteUnknownInstallRetainsOfferUntilOwned` |
| Controller shutdown prevents late inbox sidecar creation | Inbox open seal and synchronously registered publication kick | `TestClosedControllerCannotOpenInboxFromLateDispatch`, `TestStaleRecoveryCannotOverwritePublishedForegroundRoute` |
| HTTP retry retains accepted credentials after a save | Immutable provider credentials across transport retries | `TestModelSettingsHTTPRetryKeepsAcceptedCredential` returns an actual 503, then checks the retry and next runtime |

## Deterministic qualification

Run focused tests first, then race coverage for shared ownership, both Go modules, frontend types/tests/build and repository gates. Root tests do not include the nested Desktop module.

```sh
go test -p 4 ./...
go test -race ./internal/config ./internal/boot ./internal/control ./internal/bot ./internal/serve
(cd desktop && go test -p 2 ./...)
(cd desktop && go test -race . -run 'TestModelSettings|TestRemoteModel|TestCredentialProxy|TestDeferred')
(cd desktop/frontend && pnpm typecheck && pnpm test:all && pnpm build)
go run ./tools/repolint
```

The frontend test set includes receipt recovery, delayed editor saves, remote behavior and long-history performance. Uncertain writes are read back, never automatically repeated. Candidate route reservations protect builds, and Serve-wide ordered ownership receipts prevent stale status from retiring a published route. Offer release and retirement are atomic. Accepted old requests release their own references on completion.

## Native Windows release gate

Record the final candidate SHA, binary architecture and hashes, predecessor artifact identity, and outcomes for each row. A native compilation or browser-only check does not satisfy this gate.

| Native scenario | Required outcome | Qualification |
| --- | --- | --- |
| Isolated 1.38.2 installation → in-place candidate upgrade | Same home and session files; no credential re-entry or configuration deletion | Pending final candidate |
| Model preferences and model services with no active session | Save and read back; no implicit tab or model request | Pending native interaction |
| Idle and running sessions | Existing default unchanged; accepted work uses old connection; next run uses new connection | Pending native interaction |
| Restart and older-version read | Saved settings/history readable by candidate and 1.38.2 | Pending native upgrade fixture |
| Desktop-managed remote proxy | Same-model key versions coexist; current request and next request use their respective keys | Pending native remote acceptance |

The release remains NO-GO while any required native row or final-SHA CI/review gate is pending. Do not transfer evidence from an earlier candidate to a later product SHA. See [model settings](MODEL_SETTINGS.md) for persistence, downgrade and old-Serve behavior.
