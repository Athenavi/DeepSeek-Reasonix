# Electron + Go native browser prototype

An isolated feasibility experiment for a browser inside Reasonix. The shell and
website render in separate native Chromium views. The default mode uses a Go
fixture; the optional runtime mode connects the production Reasonix ACP agent,
controller, MCP stack and persisted sessions to that same browser. Production
Desktop remains Wails. See [the runtime integration report](INTEGRATION.md).

The native verification passed **17/17 checks on macOS ARM64 and Windows 11 ARM64**.
See [the dated verification report](VERIFICATION.md) for measurements, environment
details, known limits, and the remaining production acceptance gates.

## Run

Requires Node.js 22.12+ and Go 1.24+. Dependencies are pinned in the lockfile.

```sh
npm ci
npm start
```

On Windows, `scripts/windows-verify.ps1` installs dependencies, verifies the native
runtime and runs three benchmark samples. If Electron's native ZIP extractor
cannot load, it uses PowerShell extraction of the same checksum-verified artifact.

```powershell
powershell -NoProfile -File scripts/windows-verify.ps1
```

The left pane runs the Go fixture, explicitly pauses automation, resumes with a
new plan, crashes the page renderer, and records memory. The right pane supports
direct editing, native scrolling, popup sign-in, tabs, zoom and DevTools. Drag the
divider to resize the native browser. The address bar accepts HTTP(S) websites;
the deterministic Go actions only operate on the local fixture.

## Reproduce evidence

```sh
npm test
npm run bench
```

`npm test` builds the Go sidecar and launches real Electron via Playwright. Each
test run uses a fresh profile; restart verification reuses only that test profile.
Artifacts go to `artifacts/darwin` or `artifacts/win32`, including JSON checks,
event logs, screenshots and memory measurements. Benchmarking requires a built
sidecar (`npm run build:go`) and uses three fresh processes/profiles.

`shell.png` captures only the shell surface; child WebContentsView pixels are not
included in that API capture. `browser-page.png` captures the guest separately;
`native-window.png`, when present, is the direct operating-system window capture.

## Ownership and lifecycle

- Website views use sandboxing, context isolation and no Node integration. The
  guest preload exposes no host API; trusted input only requests a pause.
- Each plan owns a tab ID and epoch. Input, navigation, closing, crash or explicit
  takeover invalidates queued actions. Switching tabs does not retarget a plan.
- Actions also verify document identity in the renderer. An action already
  executed cannot be rolled back by a subsequent pause.
- Renderer recovery reloads the last page and stays paused; it never repeats
  submissions. App shutdown clears tab ownership before closing WebContents and
  closes Go stdin. Tests verify both owning processes have exited.
- Persistent and temporary partitions are separate. Popup login is a synthetic
  local cookie/callback test, not third-party OAuth certification.

The default fixture is intentionally bounded and has no LLM. Runtime mode adds
real tasks and confirmations, but neither mode implements packaging/updater
integration or an arbitrary website tool catalog. Browser permissions are denied
by default. This experiment is not a complete production browser broker.

## Real Reasonix runtime

Run from this directory in a complete repository checkout:

```sh
npm run build:go
npm run build:runtime
npm run test:runtime
```

The last command uses a scripted HTTP model with the real production executable
for repeatable fault injection. To use the configured live provider on macOS:

```sh
bin/browser-mcp --prepare-live "$PWD/.profiles/runtime-live-home"
PROTOTYPE_RUNTIME=1 PROTOTYPE_RUNTIME_HOME="$PWD/.profiles/runtime-live-home" npm start
```

The preparation helper copies only the selected provider configuration into a
private ignored experiment directory. It does not print credentials. The browser
tools can read and edit only the local fixture. External login pages are operated
by the user. MCP writes request one-time confirmation through the negotiated ACP
extension; takeover revokes pending confirmations. Restoring a task always pauses
before any further model request or browser action.

中文说明与完整结论见 [VERIFICATION.md](VERIFICATION.md)。
