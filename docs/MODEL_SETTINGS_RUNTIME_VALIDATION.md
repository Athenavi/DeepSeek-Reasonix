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
| Retired snapshots cannot overwrite the selected connection | Listing publication holds the current lease generation through metadata commit | `TestListingProjectionCannotOverwriteModelAfterAuthorityReplacement`, `TestListingAuthorityGuardRetainsGenerationThroughCommit`, `TestOwnedListingRejectsMissingAuthority`, `TestModelSettingsCredentialRefreshPersistsSelectedConnection` |
| Restored sessions show the correct connection before opening the selector | Catalog refresh follows readiness and session identity with stale-response fencing | `model-switcher-refresh.test.tsx`, native cold restoration with two connections sharing a model |
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

Native qualification completed on product commit `61114b005cfbb54fc09d85572ce6e1b1a6c52d92` using Windows 11 ARM64, Go 1.26.6, Wails 2.13.0, CGO and production frontend assets. The candidate executable SHA-256 was `7D7FD432EDE0DEE8005D22DE9AF980F78DE9D4A22A7A19EFCFF3D9A6389BA194`; the official 1.38.2 predecessor executable was `C20863C47A52B2D69F72E201D5FBAA3C57BC6132FF0AF69046FE0667D8E60B1D`. The isolated versioned installation retained its launcher, configuration home and history. Requests used a local HTTP fixture with disposable credentials; this does not claim real-provider compatibility testing.

| Native scenario | Required outcome | Qualification |
| --- | --- | --- |
| Isolated 1.38.2 installation → in-place candidate upgrade | Same home and session files; no credential re-entry or configuration deletion | Passed through the existing launcher; saved connection and seven prior responses restored |
| Model preferences and model services with no active session | Save and read back; no implicit tab or model request | Passed with an injected pre-controller startup failure; default and credential saved, zero session files before/after, request count unchanged |
| Idle and running sessions | Existing default unchanged; accepted work uses old connection; next run uses new connection | Passed with a held HTTP request; next request used the saved credential. Existing flash session remained unchanged and a new local session used vision-exp |
| Restart and older-version read | Saved settings/history readable by candidate and 1.38.2 | Passed; both read the selected second connection and nine local responses. 1.38.2 read the updated default selection |
| Desktop-managed remote proxy | Same-model key versions coexist; current request and next request use their respective keys | Passed through a real SSH connection and the candidate Serve; held and subsequent requests used their respective credential versions |

Both Go modules passed their full suites; ownership race tests, frontend full tests and production build, both Go linters and repository lint passed. Publication still requires terminal CI and review of the final PR head, followed by the release candidate gates. Documentation-only follow-ups do not change the qualified product binaries; any later product change requires reassessment. See [model settings](MODEL_SETTINGS.md) for persistence, downgrade and old-Serve behavior.
