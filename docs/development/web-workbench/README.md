# Web Workbench 能力清单与门禁

[能力清单](./parity-manifest.json)按桌面 [preload 运行时 `const api`](../../../apps/desktop/src/preload/index.ts)逐项登记：**21 组、186 个方法（含 18 个订阅）、1 个值 `platform`**。当前独立首用设置页已注册 **9 个 `implemented`**（`config` 3、`secrets` 5、`provider.listModels` 1），其余 **173 个 `pending`、4 个 `desktop-only`**。`platform` 的完整工作台投影仍为 `pending`：为启动页面传递服务器平台名称不等于已经处理完整外壳的快捷键和客户端布局。已有手机版 PWA/relay 和桌面 IPC 都是参照，不是 Workbench 覆盖证明。

通用文本阶段另外给七个 `chat` 条目登记了 `web.partial`：`createSession`、`send`、`abort`、`listSessions`、`loadSession`、`attachSession`、`onEvent`。每项记录已验证范围、专有测试和仍缺的桌面行为；它们仍计入 `pending`，不等同于附件、工具、成员或审批均已接通。[通用文本协议与阶段限制](../../../apps/headless/src/chat/README.md)。

## 本地与 CI

依赖准备好后，从仓库根目录执行；脚本使用桌面已有的 `typescript` 开发依赖，运行无需网络或启动 Electron：

```sh
node scripts/workbench/check-parity.mjs
node --test scripts/workbench/parity.test.mjs
```

也可用 `node scripts/workbench/check-parity.mjs --extract` 查看 AST 提取的 JSON（用于人工逐项比对，不改文件）。[门禁](../../../scripts/workbench/check-parity.mjs)对比组名、方法名、IPC 模式/通道和顶层值来源，检查订阅是否返回匹配的清理函数，并校验清单的计数、状态、路径和用例引用。新增、删除、改名、改通道或无法可靠解析的形状均非零退出。仅移动 DTO/类型声明不应影响门禁；方法内部业务、参数/返回类型兼容、授权与端到端行为须由相应业务测试覆盖。

## 如何维护清单

1. 按 `组名.方法名` 补齐对应条目；`kind` 与 `channel` 记录桌面 IPC 事实，并非 Web RPC 名称。`desktop.surface` 区分 `ui`（链接到实际调用入口）、`bridge-only`（现有桥接，未见调用入口）与 `legacy-bridge`（历史桌面桥）。默认 `host` 在组上，特殊注册/推送位置可逐项覆盖。
2. 填写该方法的 `web.target` 和 `web.semantic`，说明具体 Web 行为，例如启动快照、RPC、事件、上传、下载或客户端等效。纯原生动作才标 `desktop-only`；其余在真实实现注册前保持 `pending`。升为 `implemented` 时提供实际 Workbench handler/客户端入口和行为测试的独立仓库相对路径；门禁验证证据文件存在，实际行为由测试验证。
3. **Git**：[Composer](../../../apps/desktop/src/renderer/src/redesign/Composer.tsx)在聚焦工作区展示 [GitWidget](../../../apps/desktop/src/renderer/src/redesign/GitWidget.tsx)，其中有分支、合并、提交及流式生成提交消息。`diff`、`unstage`、`discard`、`setConfig`、`log`、`init` 分别登记为桥接，不算现有桌面 UI。**PTY**：[历史终端桥](../../../apps/desktop/src/main/services/terminal.ts)经 [PTY 宿主](../../../apps/desktop/src/main/pty-host.ts)工作，当前桌面渲染器未接入；七项列为 `legacy-bridge`，Web 仍 `pending`，目标是私有 worker 和仅对所有者可见的事件。定位目录/交付项、页面全屏和受限部署助手也保留 Web 等效项。

## 行为验证样例

| 用例 | 实现后应验证的行为 |
| --- | --- |
| Bootstrap | 身份和协议版本验证后才返回获授权的初始投影；先应用主题和语言，再显示首屏。 |
| Reconnect | 在回复流中断时重连，取同一会话的历史与运行锚点，补齐错过的事件；终态只显示一次，旧订阅已释放。 |
| Upload | 选择、拖拽和粘贴统一使用字节上传；验证大小、取消、过期、上传引用的归属与发送后的历史预览，客户端路径不授予宿主权限。 |
| Approvals | 重连恢复未决卡，分别验证答复/取消、计划批准/退回和挂载选择/跳过；重复、过期或跨会话的决定不得触发动作，定时任务只创建一次。 |

[手机版适配器](../../../apps/desktop/src/main/services/remote/web/adapter.ts)和[文件处理](../../../apps/desktop/src/main/services/remote/web/files.ts)提供协议先例；清单 `flows` 将用例连到具体能力，但这些连接本身不代表用例已通过。
