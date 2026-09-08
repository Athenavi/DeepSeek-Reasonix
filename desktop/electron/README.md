# Reasonix Desktop shell (Electron)

The Electron process that hosts the React UI and supervises the Go desktop
service. The wire contract between the two is
[`docs/DESKTOP_HOST_PROTOCOL.md`](../../docs/DESKTOP_HOST_PROTOCOL.md); this
package implements the shell side of it and nothing else. Business logic stays
in Go, the UI stays in `../frontend`.

```text
renderer (reasonix://app) ──preload (window.reasonixDesktop)──▶ main process ──NDJSON JSON-RPC over stdio──▶ reasonix-desktop --host-rpc
```

## Layout

| Path | Concern |
| --- | --- |
| `src/main/index.ts` | bootstrap: data home, single instance, privileged scheme, wiring |
| `src/main/service.ts` | Go service supervisor: spawn, stderr log, restart budget, shutdown |
| `src/main/rpc.ts` | NDJSON JSON-RPC 2.0 client (64 MiB frames, timeouts, reverse requests) |
| `src/main/handshake.ts` | `desktop/hello` params, result validation, failure descriptions |
| `src/main/window.ts` | main `BrowserWindow`, `host/window.*`, close and crash handling |
| `src/main/protocol.ts` | `reasonix://app` file serving and resource-origin forwarding |
| `src/main/ipc.ts` | renderer IPC: sender check, contract allowlist, native calls |
| `src/main/hostCalls.ts` | `host/*` dispatch table |
| `src/main/lifecycle.ts` | quit sequencing (`beforeClose` → `shutdown` → stdin close → exit) |
| `src/main/menu.ts`, `tray.ts`, `dialogs.ts`, `remoteWindows.ts` | native surfaces |
| `src/preload/index.ts` | the single `window.reasonixDesktop` object |
| `src/shared/ipc.ts` | channel names and types shared by main and preload |

## Build

Prerequisites: Node 24+, pnpm 10, Go. Install from the workspace root once:

```sh
cd desktop
pnpm install
```

`pnpm install` also downloads the Electron binary (`allowBuilds: electron` in
`pnpm-workspace.yaml`). If `node_modules/electron/dist` is missing afterwards,
run `node node_modules/electron/install.js` inside `desktop/electron`.

Build the Go service and the UI, then the shell:

```sh
cd desktop
go build -o build/bin/reasonix-desktop-service .     # accepts --host-rpc
go run . -emit-contract frontend/src/generated       # desktopContract.generated.{ts,json}
pnpm --filter reasonix-desktop-frontend build        # frontend/dist
pnpm --filter reasonix-desktop-shell build           # electron/dist/{main,preload}.cjs + desktopContract.json
```

The shell build reads `frontend/src/generated/desktopContract.generated.json`,
recomputes its digest the way `hostrpc.Contract.Canonical` defines it
(sorted keys, compact, no HTML escaping), checks it against the
`DESKTOP_CONTRACT_DIGEST` the generator emitted, and writes the contract plus
`digest` to `dist/desktopContract.json`. A missing contract fails the build;
set `REASONIX_ELECTRON_ALLOW_MISSING_CONTRACT=1` to build without it (every
`desktop/invoke` is then rejected and the hello digest is empty).

## Run

```sh
cd desktop/electron
pnpm start                     # electron . against ../build/bin/reasonix-desktop-service
REASONIX_DESKTOP_SERVICE=/path/to/binary pnpm start
```

Development against the Vite dev server instead of the packaged UI:

```sh
cd desktop/frontend && pnpm dev                      # http://127.0.0.1:5173
cd desktop/electron && pnpm dev                      # REASONIX_DEV=1, loads REASONIX_ELECTRON_DEV_URL
```

Environment:

| Variable | Effect |
| --- | --- |
| `REASONIX_DESKTOP_SERVICE` | path of the Go service binary (packaged default: `resources/service/reasonix-desktop[.exe]`) |
| `REASONIX_HOME` | data home, resolved exactly like `internal/config.ReasonixHomeDir` and sent in `hello.instance.home` |
| `REASONIX_DEV` | skips the single-instance lock and marks the instance as `dev` |
| `REASONIX_ELECTRON_DEV_URL` | loads this URL instead of `reasonix://app/index.html` |
| `REASONIX_FRONTEND_DIST` | overrides the directory served under `reasonix://app/` |
| `REASONIX_CHANNEL`, `REASONIX_COMMIT` | build identity in `hello.build` (default `dev`) |

Logs live under `<home>/desktop-shell/logs/`: `shell.log` (main process) and
`service.log` (the Go service's stderr), each rotating at 5 MB. In dev both
are echoed to the terminal.

## Verify

```sh
pnpm typecheck     # main + preload tsconfigs
pnpm test          # node --test; pure modules only, Electron is injected through interfaces
```

## Security boundaries

- The application window runs with `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, no spellcheck, and loads only `reasonix://app`.
  Every navigation away from the app origin is blocked; popups are denied;
  `<webview>` is refused.
- The preload exposes exactly one object, `window.reasonixDesktop`, shaped as
  the protocol document's `ReasonixDesktopHost`. IPC replies are envelopes, so
  a Go error reaches the renderer as `Error(<Go message>)` with no Electron
  prefix.
- `ipcMain` handlers accept calls only from the main window's top frame
  (`event.sender` and `event.senderFrame` are both checked); any other sender
  is rejected and logged.
- `desktop/invoke` names are validated against the embedded contract before
  they reach Go; unknown names fail with a `-32601` error.
- `reasonix://app` serves files strictly under the frontend dist (no `..`,
  no absolute escapes, no directory index fallback except `/`). Only the
  three resource prefixes are forwarded to the loopback origin, and the bearer
  token is attached in the main process; it never reaches any renderer.
- Remote Serve windows use their own `persist:remote-<hostKey>` session, no
  preload, sandbox on, popups denied, navigation pinned to the page origin.
- `shell.openExternal` from the renderer accepts `http:`, `https:` and
  `mailto:` only.
- The service is restarted automatically at most three times per five
  minutes after an unexpected exit; afterwards the failure page offers a
  manual restart, the logs folder, and quit. There is no mock fallback.

Packaging (`electron-builder`) is intentionally not part of this package yet.
