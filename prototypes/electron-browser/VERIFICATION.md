# Electron＋Go 原生浏览器验证

> 这是第一阶段的历史报告。第二阶段已接入真实 Reasonix 任务，并补测实际输入法与
> GitHub 登录；当前结果以 [INTEGRATION.md](INTEGRATION.md) 为准。

验证日期：2026-09-08（UTC 与新加坡本地日期）。基于 Reasonix
`e2298bd78` 工作区新增独立原型，未改动生产 Desktop、任务运行时或发布配置。

**结论：原生视图＋独立 Go 进程的技术链路成立，可以进入有限集成阶段；现有证据不足以批准整壳迁移。**
两平台各 17 项自动检查通过。内存成本已达到数百 MiB，接近 5 标签 0.9 GiB，必须作为架构取舍。

## 实际测试环境

| 项目 | macOS | Windows |
| --- | --- | --- |
| 系统 | macOS 26.6.2 / 25G83 | Windows 11 Pro / 10.0.26200 |
| 机器 | Apple M4 Max，64 GiB RAM | Parallels 27.0.1 虚拟机，4 vCPU、约 8 GiB RAM |
| 运行架构 | Electron ARM64、Go ARM64 | Electron ARM64；Go 工具链为 windows/amd64，fixture 在仿真环境运行 |
| GUI 环境 | 原生桌面窗口 | 已登录用户桌面 Session 1，非 Session 0 |
| 浏览器 | Electron 44.2.0 / Chromium 152.0.7977.76 | 相同 |
| 测试驱动 | Playwright 1.62.1，真实 Electron | 相同 |

Windows VM 的 GPU 合成开启，GPU rasterization 不可用。结果不能外推到物理 Windows x64，
也不能用两列数值直接比较系统优劣。两平台分别执行了相同源码的 `npm test` 和 `npm run bench`。

## 验证范围与结果

下表的“通过”都指该行明确描述的实验范围。

| 能力 | macOS | Windows | 已取得的证据 |
| --- | --- | --- | --- |
| 原生内嵌页面与 Go IPC | 通过 | 通过 | WebContentsView ID、独立 Go PID、Go 计划在同一页面填表提交 |
| 网页隔离 | 通过 | 通过 | 页面拿不到 Node `require`、`process` 或宿主 bridge |
| 中文编辑、复制粘贴 | 通过 | 通过 | Unicode 文本及 Chromium 原生 copy/paste 命令 |
| IME composition | 通过（模拟） | 通过（模拟） | CDP compositionstart/update/end 和中文落字；不是系统候选窗测试 |
| 接管与继续 | 通过 | 通过 | 输入使延迟动作失效，用户文本不被覆盖，显式继续生成新计划 |
| 标签目标与导航 | 通过 | 通过 | 切标签后计划仍绑定原标签；导航后旧计划作废 |
| 分栏、窗口、缩放 | 通过 | 通过 | 拖动分隔线、修改窗口尺寸、zoom 后检查原生 view bounds |
| 滚动 | 通过（注入） | 通过（注入） | native wheel 事件后 scrollY 改变；未测物理触控板惯性 |
| 弹窗登录与隔离 | 通过（合成） | 通过（合成） | 本地 popup＋HttpOnly cookie；持久 profile 共享、临时 profile 不继承 |
| 上传下载 | 通过 | 通过 | 测试文件选择和原生下载，核对下载内容 |
| DevTools / CDP | 通过 | 通过 | DevTools 打开期间 debugger 仍 attached；关闭后 CDP 查询成功 |
| 页面进程崩溃 | 通过 | 通过 | 自动恢复页面、保持登录、旧提交不重放、停留在人接管模式 |
| 退出与完整重启 | 通过 | 通过 | Electron 与 Go PID 均退出；重启相同测试 profile 保留合成登录 |

崩溃事件到 `renderer-recovered` 的一次观测分别为 **94 ms / 246 ms**。
这是本地页面加载完成的事件间隔，不是用户可感知恢复时延分布。DevTools 与 debugger
共存是这版 Electron 的实测结果，不应成为未来版本无需重测的假设。

另外直接查看了 macOS 原生窗口和 Windows VM 内的原生窗口，确认分栏内有真实网页。
macOS 的 `native-window.png` 是系统窗口截图。自动化生成的 `shell.png` 只包含宿主 surface，
不会包含子 WebContentsView 像素；不能用该截图的空白网页区域推断渲染失败。

## 启动与内存

每平台三轮，每轮使用**新进程、新 profile，但系统文件缓存已热**。开始计时点位于
Electron main 脚本加载后；结束点是 Go 服务启动、首个网页加载、两次 requestAnimationFrame
及 capturePage 完成。该数值**不包含操作系统创建进程到 main 脚本之前的时间，也不是真正冷机启动**。

内存是 Electron `app.getAppMetrics()` 各进程 working set 合计（换算 MiB）；共享页可能重复计数。
Go RSS/working set 单独列出。每个标签数等待 2 秒，页面为简单同源测试页，所有标签保留加载。

| 三轮中位数 | macOS | Windows VM |
| --- | ---: | ---: |
| main 到首屏就绪 | 408 ms | 574 ms |
| Electron，1 标签 | 532.1 MiB | 470.9 MiB |
| Electron，5 标签 | 877.4 MiB | 888.0 MiB |
| Go fixture，1 标签时 | 11.0 MiB | 16.5 MiB |

原始样本，顺序为“首屏 ms / Electron 1 标签 MiB / Electron 5 标签 MiB”：

- macOS：`396 / 535.0 / 972.0`，`455 / 531.1 / 877.4`，`408 / 532.1 / 824.6`。
- Windows：`753 / 473.2 / 890.6`，`574 / 470.4 / 887.9`，`403 / 470.9 / 888.0`。

这些是原型成本观测，不能解释为完整 Reasonix 的总内存或相对 Wails 的增量；本次未做
相同工作负载的 Wails 对照、长时间泄漏测试、跨站多进程重页测试或磁盘冷缓存测试。

## 发现并处理的问题

1. **退出时访问已销毁 WebContents。** debugger detach 回调广播状态时，tab 集合仍包含已关闭 view，
   触发主进程错误对话框，阻止正常退出。已改为退出前撤销 tab 所有权、停止广播，再关闭 views；
   增加 Electron 与 Go 进程均退出的检查，两平台通过。
2. **崩溃后的测试句柄失效。** Playwright 会把旧 Page 标记为 crashed。恢复验证改为经宿主的
   WebContents 读取恢复后的页面状态，避免把旧测试句柄当作应用未恢复。
3. **Windows 安装器的解压原生绑定加载失败。** 文件存在但报 `ERR_DLOPEN_FAILED`；通用错误文案
   误导为 optional dependency 缺失，尚未确定底层 DLL/系统策略原因。改用 PowerShell 解压
   `@electron/get` 已校验 checksum 的官方包，未关闭证书校验或系统保护。Electron ARM64 随后正常运行。

## 仍未满足的生产验收项

- **系统输入法候选窗**：当前 CUA 自动注入快捷键未能把 macOS ABC 切换到拼音，输入仍为拉丁字母；
  系统输入菜单接口超时。Windows VM 窗口可观察，但本次 CUA 点击没有可靠控制来宾 UI。
  两平台仅完成 Chromium composition 协议模拟，未把它算作真实系统 IME 通过。
- **真实第三方 OAuth、passkey、验证码**：本次只使用合成账户，不使用用户凭据。
- **物理触控板、多屏 DPI 与系统冷启动**：需要实际设备操作/冷启动采样，本次未覆盖。
- **Reasonix 集成**：Go 是独立 deterministic fixture，尚未接入真实 provider、审批、任务/WAL、
  持久 tab 注册表、下载权限、应用更新和签名分发。

因此建议先把这个原型作为受控实验入口接入真实任务生命周期，再评估是否迁移桌面壳。
入集成阶段应保留本次验证的所有权撤销、文档身份检查和“不重放未知提交”规则，并补齐上述
原生交互和身份认证门槛。当前证据支持技术方向，**不支持宣称所有验收项已经完成**。

## 本地证据

- [macOS 17 项结果](artifacts/darwin/verification.json)
- [Windows 17 项结果](artifacts/win32/verification.json)
- [macOS 三轮资源数据](artifacts/darwin/bench/summary.json)
- [Windows 三轮资源数据](artifacts/win32/bench/summary.json)
- [macOS 原生窗口截图](artifacts/darwin/native-window.png)
- [复现说明](README.md)

`artifacts/` 和测试 profile 默认忽略，不包含在源码提交中。当前原型未提交、未推送。
