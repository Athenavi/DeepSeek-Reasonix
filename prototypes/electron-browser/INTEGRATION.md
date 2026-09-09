# 真实 Reasonix 任务与原生浏览器集成验证

验证日期：2026-09-09（Asia/Singapore；JSON 时间使用 UTC）。
基线：`e2298bd782523169f0fe9d1dc4f5ee4c50d52c3c`，本地分支
`codex/electron-browser-runtime`，工作区修改尚未提交或推送。

## 结论

已有真实证据证明：现有 Go Agent 可以通过 ACP＋MCP 控制 Electron 内的同一个原生
浏览器，并与逐次确认、用户接管、会话持久化和崩溃恢复协同。macOS 与 Windows ARM64
各 10/10 项真实内核集成检查通过；macOS 上另外用当前配置的真实
`deepseek-v4-flash` 完成两轮任务，其中第二轮发生在 Go 进程重启、原会话恢复之后。

这一结果支持继续做有限浏览器集成，但不等于整个 Desktop 已迁移。生产 Desktop 仍为
Wails；此次没有复刻完整会话 UI、更新器、打包、远程工作区或任意网站自动化。

## 实际接入链路与成本

```text
Electron 任务 UI
  → stdio ACP → 生产 Reasonix boot / Agent / Controller / 会话存储
  → use_capability → 生产 MCP client → browser MCP adapter
  → 本机授权 broker → 原任务绑定的 WebContentsView
```

`npm run build:runtime` 构建仓库中的 `cmd/reasonix`，不是替代版 Agent。模型发现工具、
选择动作、审批等待、取消和历史加载均经过真实内核。故障注入检查仅把上游 HTTP 模型
替换为可重复响应；浏览器、Go 进程、MCP、controller 与持久化均为实际实现。

生产代码缺口集中在 ACP：原先没有协商 interactive MCP profile，也没有把 controller
的 MCP elicitation 事件送回宿主。新增可选、带版本的
`_reasonix.io/mcp/request_interaction` 反向请求，接入新建、加载及重建会话。
未协商的旧客户端保持 core profile。原工具权限规则、provider 实现和 transcript schema
未改动；启用 interactive profile 会改变 MCP capability/cache identity。
协议见 [ACP 文档](../../docs/ACP.zh-CN.md)。

写操作的确认通过生产 MCP 多轮交互请求、ACP 扩展和 controller 的持久化回答路径
完成。它不是把普通 MCP `ask` 配置误当成生效的权限门：现有内核对已授权 MCP 的普通
ask 策略有专门行为，此次没有修改该策略。原型只支持空表单的一次允许/拒绝，
不声称实现所有 MCP 表单或 URL elicitation UI。

宿主与 adapter 的核心新增代码约 450 行，另有 ACP 交互转发、回归测试与验收脚本。
这证明有限任务链的接入范围可控，不能据此估算完整产品迁移工期。

## 双平台自动集成结果

| 检查 | macOS ARM64 | Windows 11 ARM64 VM |
| --- | --- | --- |
| 生产 ACP / Agent / MCP 填写与保存，逐次确认 | PASS | PASS |
| 拒绝确认，零浏览器写入 | PASS | PASS |
| 原生输入撤销待确认请求，旧回答被拒绝 | PASS | PASS |
| 切换标签不把原任务转移到另一页 | PASS | PASS |
| 页面导航取消原任务 | PASS | PASS |
| 确认后、派发前接管，排队写入不得发生 | PASS | PASS |
| renderer 崩溃取消任务，不重放待执行动作 | PASS | PASS |
| Go 重启，加载同一会话，暂停后明确继续 | PASS | PASS |
| Electron 完整重启，保留会话与操作日志 | PASS | PASS |
| 保存已执行、回执未知时宿主突然退出，不重复提交 | PASS | PASS |

最后一项在实际 DOM 提交后阻断回执，确认磁盘操作记录为 `unknown`，再杀死实际
Electron 主进程。校验 Go 子进程退出、重启不发起模型请求、同一 operationId
再次出现也不重复写入。Windows 首次失败来自 Playwright 启动包装进程的 PID；
改为直接取 Electron `process.pid` 后，完整检查通过。

Windows 使用交互桌面 Session 1，Electron 与本轮 Reasonix/browser MCP 为 ARM64；
本地网页 fixture 沿用第一阶段的 Go amd64 构建。它仍是 Parallels VM，未覆盖物理 x64。

## 真实模型、IME 与登录

- macOS 当前配置的真实 `deepseek-v4-flash`：第一轮填写并保存一次，2 次确认；
  重启 Reasonix 后第二轮填写并保存一次，2 次确认；两轮均为 `end_turn`。
  验证器只自动接受这两条合成任务的精确填写内容及 `#save`，并核对实际页面结果。
- macOS 系统输入法：用户实际输入 `shu'ru'fa` 并选择“输入法”，最终文本与保存结果
  正确；原生页面记录到可信 `compositionupdate` / `input`。该次 `compositionend`
  的 `isTrusted` 为 false，按实际记录保留，不声称全部事件均可信。
- macOS GitHub：由用户完成真实登录。完整退出并重启 Electron 后，访问登录页返回
  已登录界面，自动校验用户菜单存在；同一 Reasonix 会话恢复且仍处于暂停状态。
- Windows 系统输入法与 GitHub：人工验收进行中，结果待补。

登录不由模型或 MCP 操作；broker 拒绝对外部网站读取页面或执行动作。没有导出
Cookie 值、密码或 dashboard 内容。真实登录证明该实际登录方式与持久化可用，
不代表其他 OAuth 提供商、passkey 硬件或所有验证码流程已验证。

## 资源与剩余边界

第一阶段的 1/5 标签成本见 [历史报告](VERIFICATION.md)，仍是独立 fixture 的观测。
真实模型报告中的 metrics 也只累计 Electron 与 fixture，**未包含 Reasonix/MCP RSS**，
不能当完整集成的总内存。当前没有同负载 Wails 对照、完整应用启动时间或生产压力结论。

操作被绑定到 session、runtime generation、tab epoch 和 document token。持久化日志在
副作用前写入；未知结果不自动重试。原型只实现本地页 `#message` / `#save` 两种动作，
没有持久化完整标签布局，也不能保证第三方网站的业务幂等性。系统掉电、磁盘损坏、
长时间资源压力、物理触控板和跨屏 DPI 仍不在本轮证据范围内。

## 复现与证据

```sh
go test ./internal/acp ./internal/cli ./internal/boot ./internal/plugin
go test -race ./internal/acp -run 'Test.*MCPInteraction|TestE2EApprovalRoundTrip'
go test ./prototypes/electron-browser/runtime-mcp
go run ./tools/repolint
cd prototypes/electron-browser
npm run build:go
npm run build:runtime
npm run test:runtime
```

上述 Go 检查已通过，repolint 为 clean，未提高 baseline。
`runtime-mcp` 的 `go test` 仅确认可编译（无独立单元测试），端到端行为由原生集成测试验证。
没有运行完整仓库 CI，也没有发布或修改主分支。

本机证据（`artifacts/` 被 Git 忽略）：

- `artifacts/darwin/runtime-final/verification.json`
- `artifacts/win32/runtime-final/verification.json`
- `artifacts/darwin/live-runtime/verification.json`
- `artifacts/darwin/live-runtime/manual-verification.json`
- `artifacts/darwin/live-runtime/native-ime.jpg`

真实模型配置与登录 profile 仅保存在被忽略的 `.profiles/`。源码提交不得包含该目录。
