# 桌面壳迁移：从 Wails 到 Electron

[English](DESKTOP_SHELL_MIGRATION.md)

本文是把 Wails 桌面壳替换为 Electron、同时保留 Go 内核、Go 桌面业务层和 React 界面的
架构决策记录与工作计划。在最终阶段关闭之前，它是迁移分支的参考；线路契约见
[宿主协议](DESKTOP_HOST_PROTOCOL.zh-CN.md)，生成的入口清单见
`docs/desktop-migration/INVENTORY.md`。

## 决策

Reasonix Desktop 从 Wails v2（macOS WebKit、Windows WebView2、Linux WebKitGTK）迁移到
使用 Chromium 渲染的 Electron，原因是产品需要一个用户与 Agent 共同操作的原生浏览器，
而没有任何系统 webview 能在四个发行目标上提供第二个隔离、可编程、引擎稳定的网页
表面。Go 桌面层成为独立服务进程，通过一条私有 JSON-RPC 连接与壳相接。开发分支直接
替换 Wails，不维护双壳产品；在本文所有验收门槛通过之前，该分支不发布。

考虑并否决的替代方案：

- **保留 Wails，通过 CDP 嵌入系统 Chrome。** 依赖外部浏览器安装，无法安全共享登录
  分区，也无法控制应用窗口内的表面几何。
- **Wails v3 多窗口。** 每个平台仍是一个系统引擎，没有 `WebContentsView` 对应物，促成
  恢复代码的 WebKitGTK/WebView2 粗糙边缘依旧存在。
- **用 TypeScript 重写桌面层。** 抛弃 CLI、Serve 和 bot 前端共享的 controller、租约、
  恢复和远程逻辑。

接受的后果：更高的固定内存与包体占用，按完整进程树测量并如实公布；两套运行时必须
保持同一版本单元；Linux 上需要 Chromium sandbox。

## 基线

迁移基线是 `main-v2` 的 `7717f3eeab47f66560ea85cc7dbe27426c3adf47`，在建分支时冻结。
`e2298bd78` 上的原型成果（独立的 Electron＋Go 浏览器实验和 ACP MCP 交互转发）随分支
保留。两者之间的修复（欢迎布局中的会话恢复可见、全局新建会话工作区目标、设置搜索
与保存栏重叠）属于基线，必须保留。

Wails 指标用 `scripts/desktop-shell-metrics.sh` 在同一台机器上采集，保存在
`docs/desktop-migration/baseline/`。Electron 构建用同一脚本测量，保证对照口径一致。

## 架构

```text
React 界面 ──preload 类型化 IPC──▶ Electron 主进程 ──stdio JSON-RPC──▶ Go 桌面服务
                                      │                                │
                                      ├─ WebContentsView（网站）        └─ control.Controller、会话、
                                      ├─ 远程 Serve 窗口                   工具、租约、恢复、计费
                                      └─ 菜单、托盘、对话框、剪贴板
远程 Reasonix Agent ◀── 经现有 SSH 通道的受限 Host RPC ──▶ Go 桌面服务
```

| 层 | 负责 |
| --- | --- |
| React 界面 | 展示、意图、布局、状态投影；不访问 Electron 或 Go 全局对象 |
| Electron 主进程 | 窗口、浏览器视图、菜单、托盘、对话框、剪贴板、通知、原生生命周期 |
| Go 桌面服务 | 全部桌面业务命令、controller 所有权、审批、设置、终端、SSH、扩展、更新协调 |
| Go 内核 | Agent、provider、工具、持久化、租约、恢复与计费语义不变 |
| 远程适配器 | 转发经会话授权的宿主能力；不建立第二套浏览器实现 |

契约（线路形状见协议文档）：

- `DesktopContract`：对 Go `App` 值反射得到的命令注册表，生成 TypeScript 命令表和
  DTO 声明，握手校验其摘要。
- `DesktopEvent`：统一封装（`seq`、`generation`、`name`、`args`），原样携带现有事件载荷。
- `NativeHost`：替代 Go 中直接壳工具包调用的接口；由 Electron 宿主通过 `host/*` 请求实现。
- `BrowserExecutor`：本地与远程共享的浏览器读取/动作/截图/文件接口（阶段 D）。
- `HostCapabilityRegistry`：宿主能力发现、版本协商和会话授权；浏览器工具接入现有
  capability 与 tool registry。
- `DesktopLifecycle`：两进程共享的启动、就绪、隐藏、恢复、退出与更新交接状态。

## 阶段与状态

状态取值：`implemented`（代码在分支上）、`locally tested`（开发机上的测试或人工检查）、
`externally verified`（CI 或其他平台）、`blocked`（附原因）。只有在每个发行目标上满足
退出条件，阶段才算关闭。

### A. 冻结基线，建立完整入口清单

- 从冻结基线建立 `feature/electron-desktop-shell`，携带原型与 ACP 成果：implemented。
- `tools/desktopinventory` 生成命令、原生调用、事件、前端桥接用法、CSS 标记、持久化
  文件、旧壳专用 Go 文件、发布产物和 CI 任务的清单，每项恰有一个分类；`-check` 在
  漂移或未分类时失败：implemented，locally tested。
- Wails 基线指标：见 `docs/desktop-migration/baseline/`。
- 本记录、协议文档与清单的中英文版本：implemented。

退出条件：每个现有入口都有归属与验收用例。清单已满足；验收用例见下文门槛。

### B. 抽离桌面服务，建立统一桥接

- `nativeHost` 接口及其 Wails 实现；Go 业务代码不再直接调用壳工具包。
- `desktop/internal/hostrpc`：反射注册表、契约摘要、TypeScript 生成器、基于 `rpcwire`
  的严格 JSON-RPC 服务、事件封装、反向宿主请求。
- `reasonix-desktop --host-rpc`：一个 Go 服务进程管理全部会话与标签；`-emit-contract`
  输出生成的 TypeScript 与 JSON。
- `desktop/` 下统一的 pnpm workspace 管理前端与壳。
- 根 Go 模块保持纯静态构建；桌面模块保留自己的构建。

退出条件：服务可脱离 Wails 启动和测试；所有命令由契约映射；业务代码没有直接壳调用。

### C. Electron 承载完整现有桌面

主窗口、可信 preload、错误恢复页、服务监督器、带授权媒体转发的 `reasonix://app`
资源 scheme、窗口状态、主题、标题栏拖动、快捷键、文件拖放、剪贴板、对话框、远程
Serve 窗口、菜单、托盘、后台关闭与恢复。TranscriptKernel、稳定消息身份和单一滚动
写入者不动。

退出条件：完整现有桌面流程在 Electron 上可用，无 mock 兜底、无空按钮、无遗漏事件；
快速切换会话不串台。

### D. 生产浏览器与本地/远程统一执行器

右侧工作区的浏览器面板（任务内多标签、地址栏、历史、刷新、缩放、加载错误、下载、
DevTools），由 `BrowserSurfaceManager` 管理；Agent 能力（结构快照、截图、导航、点击、
输入、按键、滚动、标签、文件）接入现有 capability、审批、取消和证据体系；用户接管
撤销待执行动作；写操作先记录操作身份再执行，结果区分已执行/未执行/未知；远程
Agent 通过 SSH 承载的 Host RPC 使用同一执行器，授权绑定世代。

退出条件：本地与远程 Agent 通过相同工具完成真实网页任务，接管、审批、文件归属与
恢复行为一致。

### E. 平台功能、安装与更新

Electron 菜单、托盘、通知、文件关联、窗口恢复、单实例呈现；产品名称、安装位置、
快捷方式、卸载身份、数据目录和产物名称不变；Electron 打包接入现有 NSIS、nfpm 与
签名步骤；Go 更新协调器继续负责版本解析、签名校验、布局与恢复，Electron 提供准备
退出与重启；壳、服务、资源与辅助程序为同一版本单元；macOS Universal 并公证；Linux
Chromium sandbox 不使用 `--no-sandbox`；minisign 与摘要校验不变。

退出条件：四类产物均可安装、启动、卸载，并通过 Wails→Electron 升级、Electron→Electron
升级和安装失败恢复测试。

版本化安装布局（Windows 与 Linux）的设计说明：`installlayout` 激活器只允许
`versions/<v>/` 内的扁平常规文件。Electron 载荷新增一个树成员 `app/` 承载 Electron
包；Windows 载荷清单升级到 schema 2，列出 `app/` 下每个文件及其摘要，激活器在移动
`current.json` 之前校验整棵树。`reasonix-desktop(.exe)` 仍是瘦启动器启动的活动桌面
可执行文件：不带 `--host-rpc` 时它引导 `app/Reasonix(.exe)` 后退出，Electron 再以
`--host-rpc` 启动同一二进制作为服务。因此启动器、`current.json`、单实例身份与重启
逻辑保持现状。macOS 上 bundle 的主可执行文件是 Electron，Go 服务位于
`Contents/MacOS/`；`.app` 替换路径不变。

### F. 全矩阵验收并删除旧实现

CI 切换到新构建、契约生成和原生测试入口；删除 Wails 入口、依赖、生成绑定、WebView2
恢复与壳补丁；原型故障用例进入正式测试；删除迁移别名、重复 DTO 和临时适配。

退出条件：最终构建图中没有 Wails；业务代码没有旧桥接全局对象；全部矩阵项与门槛闭合。

## 能力矩阵

生成的清单列出每个入口。下表是验收执行遵循的产品级视图；每行映射到清单分类和下文
门槛。

| 能力 | 现状（Wails） | 目标（Electron） | 分类 |
| --- | --- | --- | --- |
| 会话：发送、停止、模型/effort 切换、历史、恢复、租约 | `App` 方法经 Wails 绑定 | 同一方法经 `desktop/invoke` | keep-business |
| 项目、工作树、文件预览、工作区监听 | Go＋资源中间件 | Go＋`reasonix://app` 转发到资源源 | keep-business |
| 终端 | Go PTY/ConPTY，事件 | 经 `desktop/event` 不变 | keep-business |
| 设置、MCP、MCP Apps、技能、插件 | Go | 不变；MCP Apps 保留各自回环源 | keep-business |
| 远程工作区与远程 Serve 窗口 | SSH 管理器＋每窗口一个 Wails 子进程 | SSH 管理器不变；每主机一个隔离分区的 `BrowserWindow` | migrate-host |
| 窗口几何、主题、拖动区域、快捷键、缩放 | Wails runtime | `host/window.*`、preload 窗口接口、`-webkit-app-region` | migrate-host |
| 文件拖放、剪贴板、外部链接、对话框 | Wails runtime | preload 原生接口与 `host/dialog.*` | migrate-host |
| 菜单、托盘、后台关闭、第二实例 | Wails 菜单、fyne systray、Wails 锁 | Electron 菜单、`Tray`、按规范数据目录键控的 `requestSingleInstanceLock` | migrate-host |
| 更新器 | Go 协调器＋Wails 重启 | Go 协调器＋`host/app.relaunch` | migrate-host |
| 渲染进程恢复（WebView2/WebKitGTK） | Go 恢复协调器 | Electron `render-process-gone` 处理 | delete-shell |
| Agent 原生浏览器 | 仅原型 | `WebContentsView` 面板＋`BrowserExecutor` | 新增 |

## 数据兼容

- 会话、配置、项目、任务、计费与租约格式不变；不修改 transcript schema。
- 浏览器元数据与操作日志是旧壳从不读取的新增带版本文件。
- 网站登录存放于 Chromium 持久分区；Cookie 值从不进入配置、日志或模型上下文。
- 恢复的浏览器标签只保留安全的导航条目；不持久化密码、表单状态或可重放提交。
- 文件化设置优先于旧 webview 本地偏好。唯一允许的重置是旧 webview 存储中的渲染
  进程本地外观偏好（字体、字号、面板宽度、排版）；旧 webview 数据保留在原处并在
  迁移说明中列明。
- 降级：停止 Electron 构建，运行上一个 Wails 构建；新增浏览器状态不得破坏其对会话
  和配置的读取。

## 验收门槛

| 领域 | 必须覆盖的场景 |
| --- | --- |
| 契约 | Go/TS 签名一致、空数组、可选字段、错误映射、取消、乱序回答、协议不匹配、大资源 |
| 会话与所有权 | 发送、停止、模型/effort 切换、快速切换项目与会话、后台重挂、租约冲突、controller 替换失败保留旧会话 |
| 事件恢复 | 渲染进程重载、事件积压、订阅断开与重新快照；无重复、无旧世代写入 |
| 桌面能力 | 终端输入输出与 resize、文件拖放、媒体预览、MCP Apps、设置、自动任务、远程连接与窗口 |
| 浏览器 | iframe、动态 DOM、受控输入、弹窗、上传下载、历史、临时分区、登录共享与隔离 |
| 接管与未知写入 | 审批前接管、审批后派发前接管、执行后回执丢失、崩溃后重启、重复 operation ID |
| 远程浏览器 | SSH 断连、重连世代变化、旧 token、跨会话误路由、远程上传下载、远程进程恢复 |
| 原生体验 | macOS、Windows、Linux 的真实中文 IME、焦点、选择复制、快捷键、标题栏、分栏、跨屏 DPI、托盘恢复 |
| 安装升级 | 旧版运行中升级、不同数据目录并存、相对数据目录、签名损坏、安装中断、重启失败与回滚 |
| 隔离 | 网站与 iframe 无桥接；伪造 IPC、过期资源 token、越界文件请求、外部协议调用被正确处理 |

真实任务验收：登录后的 GitHub PR 评审草稿并带来源；文档网站跨页检索并本地保存；
可控测试网站的表单提交、上传与下载，完整经过审批与接管；同样的任务从远程工作区
执行，浏览器在本机、结果归属远程任务；提交已发生但回执未知时中断，证明恢复后不会
自动重复提交。

资源与性能采样遵循 `scripts/desktop-shell-metrics.sh`（完整进程树；启动、空闲、1/5
标签、长会话、流式、一小时），另加 30 次标签与会话开关循环，证明进程、监听器、
`WebContents` 与会话资源被释放。交互 p95（会话切换、停止反馈、输入延迟）不超过同机
Wails 基线的 `max(1.2 倍基线，基线＋50ms)`。包体、启动与内存增量如实公布；固定占用
本身不判失败，持续泄漏必须修复。

最终证据绑定同一候选 SHA：根模块与桌面模块测试、变更并发路径的 race 测试、完整
前端 CI 套件，以及四类产物的原生验收。
