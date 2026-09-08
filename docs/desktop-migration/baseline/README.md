# Wails baseline metrics

Captured with `scripts/desktop-shell-metrics.sh` on the frozen baseline build
(`wails build -platform darwin/arm64`, Apple silicon, macOS 26.6), three runs,
fresh disposable data home each run, `REASONIX_DEV=1`. Medians below; the raw
runs are the JSON files beside this file. Electron builds are measured with the
same script and compared only against these figures.

| Metric | Median of 3 |
| --- | ---: |
| Go `startup` → lifecycle `ready` | 332 ms |
| Go `startup` → frontend `healthy` (React mounted, bridge heartbeat) | 3692 ms |
| Process-tree RSS, healthy + 2 s | 389 MiB |
| Process-tree RSS, healthy + 10 s | 385 MiB |
| Process-tree RSS, healthy + 30 s | 412 MiB |
| Processes in the tree | 4 (com.apple.WebKit.GPU, com.apple.WebKit.Networking, com.apple.WebKit.WebContent, reasonix-desktop) |
| SIGTERM honoured within 10 s | no (the Wails shell ignores SIGTERM; the script had to SIGKILL it) |

Run 1 includes first-launch work in a cold data home; runs 2 and 3 reuse the
warm OS file cache. Startup here starts at Go `main`, not at process creation,
and `healthy` is the point where the React app has rendered and the bridge
heartbeat succeeded. Interaction latency (session switch, stop feedback, input)
is captured separately by the frontend benchmarks under `desktop/frontend/bench`.
