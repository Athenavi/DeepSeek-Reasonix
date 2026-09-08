# 模型设置运行时验证

本记录区分已实现行为与发布资格。最终候选必须通过完整矩阵，包括 Windows 原生升级验收，才能发布。

| 需求 | 实现归属 | 证据 |
| --- | --- | --- |
| 无活动会话保存；默认模型只影响新会话 | `desktop/model_settings_api.go`、`desktop/model_settings_preferences.go` | `TestModelSettingsSaveWithoutActiveSession`、默认模型与新会话测试 |
| 校验和并发比较先于保存；保留未知字段 | `internal/config/model_settings_edit.go`、统一 API 操作字段白名单 | `TestModelSettingsRequestRejectsStaleEdit`、`TestSaveModelSettingsPreservesUnknownFields`、目录提交并发测试 |
| 独立凭据引用、分组连接与失败恢复 | `internal/config/model_credential_commit.go` | `TestModelSettingsGroupedCredentialCommitAndReceipt`、`TestModelSettingsFailedCommitCleansOnlyItsStagedCredential`、`TestModelSettingsCredentialWriteFailureKeepsConfig` |
| 当前工具续轮保持原连接，下一轮刷新 | `internal/config/model_runtime_snapshot.go`、`internal/boot/boot.go`、`desktop/turn_admission.go` | `TestModelSettingsRunningToolContinuationKeepsOldConnection`、凭据冻结测试 |
| 队列后续消息与机器人请求经过新运行边界 | `internal/control/inbox_dispatch.go`、`internal/bot/model_settings.go` | `TestModelSettingsQueuedFollowupAppliesLatestBeforeDispatch`、`TestBotNewRunAppliesModelSettingsAndKeepsSessionOnFailure` |
| 项目覆盖及非活动、后台分离会话分别应用 | 运行时所有者查找和既有 Desktop 重建流程 | `TestModelSettingsProjectOverrideSkipsRebuild`、`TestModelSettingsRemovalRetryKeepsFailedTargetAndAppliesInactiveSibling`、`TestModelSettingsRetryAppliesDetachedRuntimeWithoutCreatingTab` |
| 启动和连续保存的发布保护 | 启动版本校验、携带版本的延迟重建项 | `TestModelSettingsStartupPublicationRejectsCandidateBuiltBeforeSave`、延迟重建测试 |
| 删除后没有可用模型时阻止新运行，保留历史 | 经过校验的运行时模型选择 | `TestModelSettingsLastProviderRemovalBlocksNewRun`、服务删除测试 |
| 远程不可变路由、候选所有权和自动下一轮应用 | `desktop/cred_proxy.go`、`desktop/remote_model_settings.go`、`internal/serve/model_settings_source.go` | `TestRemoteModelOwnershipRetiresOldRouteAfterInFlightRequest`、`TestRemoteModelSourceRefreshesAutonomousHTTPRunAndRetiresOldRoute`、Serve 应用失败与回执测试 |
| 远端项目配置继续优先 | `internal/config/model_runtime_settings.go` | `TestManagedModelSnapshotPreservesProjectProviderAndAssignments` |
| 架构状态不进入模型前缀 | 仅传输层使用快照元数据，保留序列化行为 | `TestRemoteModelSnapshotPreservesWirePrefixAndKeepsKeysLocal` 比较 OpenAI、Anthropic、Responses 请求字节 |
| 已保存、待应用、失败状态及草稿竞态 | 结构化桥接结果、请求回执和读写代次 | `model-settings-receipt.test.ts`、`provider-editor-save-races.test.tsx`、设置回读快照测试 |
| 保存后创建的子代理及审批续轮保持已接受的快照 | Boot 子代理工厂和控制器审批恢复 | `TestModelSettingsChildCreatedAfterSaveInheritsAcceptedRunSnapshot`、`TestModelSettingsApprovalResumeKeepsAcceptedCredential` 验证真实 HTTP 请求 |
| 连续保存超过构建进度及完成响应丢失 | 共享运行时所有者刷新、源版本校验和候选保留 | `TestModelSettingsSourceFencesOvertakenBuildAndUncertainFinish` |
| 远程后台分离工作保留自己的接纳边界 | `internal/serve/model_settings_detached.go` | `TestDetachedModelSettingsRefreshTargetsItsOwnerAndPreservesFailure`、`TestDetachedModelSettingsKeepsQueuedOwnerUntilAdmission` |
| 远程所有权达到容量上限时不清理已接受路由 | 代理范围内的候选接纳 | `TestRemoteModelOfferCapacityPreservesOwnedRoutes` |
| 迟到回执和旧连接不能撤销当前路由 | Serve 实例及递增序列、原子连接身份绑定和路由回收 | `TestRemoteOwnershipRejectsOvertakenReceipts`、`TestRemoteReplacedConnectionCannotPinOwnership`、`TestRemoteIncarnationReclaimsOldReservationsAndRejectsLateBuilders` |
| 明确拒绝释放候选；结果未知时保留至确认 | 拒绝类型与正向所有权回读 | `TestRemoteInstallDistinguishesRejectionFromLostAcknowledgement`、`TestRemoteUnknownInstallRetainsOfferUntilOwned` |
| 控制器关闭后不再创建 inbox 文件 | inbox 打开封锁和同步登记的发布通知 | `TestClosedControllerCannotOpenInboxFromLateDispatch`、`TestStaleRecoveryCannotOverwritePublishedForegroundRoute` |
| 保存后的 HTTP 重试保持已接受的凭据 | 传输重试复用不可变服务凭据 | `TestModelSettingsHTTPRetryKeepsAcceptedCredential` 返回真实 503，验证重试和下一运行 |

## 确定性验证

先执行针对性测试，再运行共享所有权的 race 测试、两个 Go 模块、前端类型检查／测试／构建及仓库检查。根模块测试不包含独立的 Desktop 模块。

```sh
go test -p 4 ./...
go test -race ./internal/config ./internal/boot ./internal/control ./internal/bot ./internal/serve
(cd desktop && go test -p 2 ./...)
(cd desktop && go test -race . -run 'TestModelSettings|TestRemoteModel|TestCredentialProxy|TestDeferred')
(cd desktop/frontend && pnpm typecheck && pnpm test:all && pnpm build)
go run ./tools/repolint
```

前端测试包含回执恢复、延迟保存草稿、远程行为和长历史性能。结果不明的写入先回读，不自动重做。候选保留机制保护构建过程，Serve 全局有序的所有权回执阻止旧状态撤销已发布路由。候选释放与路由回收原子完成；已接受的旧请求在完成时释放自己的引用。

## Windows 原生发布门槛

记录最终候选 SHA、二进制架构和哈希、升级前产物身份及下列每项结果。原生编译或浏览器检查不能替代这一门槛。

| 原生场景 | 必须达到的结果 | 验收状态 |
| --- | --- | --- |
| 隔离的 1.38.2 原地升级到候选版本 | 沿用同一配置目录和会话，不要求重新输入凭据或删除配置 | 待最终候选 |
| 无活动会话下的模型偏好、模型服务页面 | 保存并回读，不创建隐式标签页或模型请求 | 待原生交互 |
| 空闲及运行中会话 | 已有会话默认模型不变；当前工作使用旧连接，下一次使用新连接 | 待原生交互 |
| 重启与旧版本读取 | 候选和 1.38.2 均能读取保存后的设置与历史 | 待原生升级夹具 |
| Desktop 凭据代理远程会话 | 同模型的密钥版本并存，当前和下一次请求分别使用对应密钥 | 待原生远程验收 |

任何必需的原生项目、最终 SHA 的 CI 或评审尚未完成时，发布结论仍为 NO-GO。较早候选的证据不能直接归到后续产品 SHA。持久化、降级和旧 Serve 行为见[模型设置](MODEL_SETTINGS.zh-CN.md)。
