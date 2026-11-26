# Web Workbench 能力清单与门禁

[能力清单](./parity-manifest.json)按桌面 [preload 运行时 `const api`](../../../apps/desktop/src/preload/index.ts)逐项登记：**21 组、186 个方法（含 18 个订阅）、1 个值 `platform`**。当前有 **47 个 `implemented`**：模型与设置 9 项、个人资料 3 项、分域记忆 4 项、角色管理 7 项、授权项目文件读取 2 项、网页文件选择与粘贴上传 2 项、会话模型与归档及列表订阅 3 项、授权交付清单与定位 2 项、Git 只读能力探测 1 项、项目选择与会话绑定 2 项、原生任务详情与日程预览 2 项、客户端页面全屏状态与订阅 2 项、客户端文本复制与粘贴 2 项、PTY 回收与退出事件 2 项、技能目录及已保存的启用和角色偏好与目录失效订阅 4 项；其余 **135 个 `pending`、4 个 `desktop-only`**。其中 37 个 `pending` 有明确的部分实现和测试记录，98 个仍待实现；这些数不是用户工作流的完成百分比。任务列表按需读取，状态变化目前仅支持对既有活动任务的人工确认暂停；这两项登记为部分覆盖。Git 的已跟踪状态、暂存与工作树差异、分支和首父历史按部分覆盖登记；写入及远程操作仍待移植。交付下载覆盖明确的成品格式；静态图预览与整个桌面缩略图机制仍有差别。空闲会话可以改名；在途改名和非默认思考档位仍属部分覆盖。上传格式与模型协议限制在部署说明中列出；目录拖放及图片缩略资源仍按部分覆盖登记。选择授权项目、保存会话关联和手动打开该项目的资料已接通；文件保存仍限于现有文本。角色私有默认目录的创建与完整工具授权未计入。角色删除可处理未被引用的自定义角色，对受保护的默认角色和已有引用报冲突；未将其列为桌面级联删除已完成。单独的 `platform` 值已实现：设置显示经过认证的启动投影中的宿主平台，Linux 容器不会因客户端使用 macOS 而显示为 macOS。浏览器全屏、布局和侧栏快捷键使用客户端状态，而不把宿主平台当作操作电脑。已有手机版 PWA/relay 和桌面 IPC 都是参照，不是 Workbench 覆盖证明。

通用文本阶段另外给七个 `chat` 条目登记了 `web.partial`：`createSession`、`send`、`abort`、`listSessions`、`loadSession`、`attachSession`、`onEvent`。每项记录已验证范围、专有测试和仍缺的桌面行为；它们仍计入 `pending`，不等同于附件、工具、成员或审批均已接通。[通用文本协议与阶段限制](../../../apps/headless/src/chat/README.md)。

[可选人工浏览器](../../../apps/browser-worker/README.md) 仅对当前真实登录、已绑定会话和工作器页面发放短租约。`browser.getState`、`ready`、`open`、`liveStart`、`liveStop`、`onLiveFrame`、`handoff` 和 `closeTab` 已登记具体人工操作范围，仍按部分覆盖计算。它不是多标签自动化、团队转交，也不是让模型读取人工页面内容。

**技能管理与技能执行分别计数。** `skills.list` 返回真实来源、启用和角色范围的目录摘要；`setEnabled` 和 `setRoles` 保存原生配置并读回；`onChanged` 向已打开的设置页发送修订号，页面重取列表，断线后重新确认选中的文档。`skills.get` 针对自定义文档已接通，但不下发内置运行指令，因此登记为部分覆盖。导入和删除仍待实现。此处没有把目录偏好登记为 Web 聊天已能执行技能。

## 本地与 CI

依赖准备好后，从仓库根目录执行；脚本使用桌面已有的 `typescript` 开发依赖，运行无需网络或启动 Electron：

```sh
node scripts/workbench/check-parity.mjs
node --test scripts/workbench/parity.test.mjs
```

执行 `node scripts/workbench/check-parity.mjs --coverage` 可在校验通过后读到 JSON 报表，按模块区分完整、部分、有待实现、桌面原生四种互斥计数。也可用 `node scripts/workbench/check-parity.mjs --extract` 查看 AST 提取的 JSON（用于人工逐项比对，不改文件）。[门禁](../../../scripts/workbench/check-parity.mjs)对比组名、方法名、IPC 模式/通道和顶层值来源，检查订阅是否返回匹配的清理函数，并校验清单的计数、状态、路径和用例引用。新增、删除、改名、改通道或无法可靠解析的形状均非零退出。仅移动 DTO/类型声明不应影响门禁；方法内部业务、参数/返回类型兼容、授权与端到端行为须由相应业务测试覆盖。

### 导出可复核的 Excel 验收表

在已安装锁定依赖的检出目录里执行 `node scripts/workbench/export-parity-workbook.mjs`。命令按当前 **Git HEAD** 核对真实 preload、清单和每个证据文件：源码与索引或提交内容不一致时退出，避免把工作树里的改动标成已发布版本。输出位于 `test-results/parity-<提交前7位>/`，含总览、逐方法验收、跨功能流程和平台值四张工作表，源码与用例链接固定到完整提交。相同版本和参数可重复执行；已有文件内容不同则原样保留。`--repo owner/repo` 可指定证据链接所属仓库，只有已知 PR 编号时才加 `--pr 15`。仓库的 PR 工作流直接从 PR 的 head commit 生成同一份附件。

## 如何维护清单

1. 按 `组名.方法名` 补齐对应条目；`kind` 与 `channel` 记录桌面 IPC 事实，并非 Web RPC 名称。`desktop.surface` 区分 `ui`（链接到实际调用入口）、`bridge-only`（现有桥接，未见调用入口）与 `legacy-bridge`（历史桌面桥）。默认 `host` 在组上，特殊注册/推送位置可逐项覆盖。
2. 填写该方法的 `web.target` 和 `web.semantic`，说明具体 Web 行为，例如启动快照、RPC、事件、上传、下载或客户端等效。纯原生动作才标 `desktop-only`；其余在真实实现注册前保持 `pending`。升为 `implemented` 时提供实际 Workbench handler/客户端入口和行为测试的独立仓库相对路径；门禁验证证据文件存在，实际行为由测试验证。
3. **Git**：[Composer](../../../apps/desktop/src/renderer/src/redesign/Composer.tsx)在聚焦工作区展示 [GitWidget](../../../apps/desktop/src/renderer/src/redesign/GitWidget.tsx)，其中有分支、合并、提交及流式生成提交消息。`diff`、`unstage`、`discard`、`setConfig`、`log`、`init` 分别登记为桥接，不算现有桌面 UI。**PTY**：[历史终端桥](../../../apps/desktop/src/main/services/terminal.ts)经 [PTY 宿主](../../../apps/desktop/src/main/pty-host.ts)工作，当前桌面渲染器未接入；七项仍属桌面 `legacy-bridge`。Web 的[可选私有 PTY 工作器](../../../apps/terminal-worker/README.md)为当前所有者打开已保存文本的固定查看程序。回收和真实退出事件已接通；程序列表、创建、输入、尺寸与输出按部分覆盖登记，未将其计为通用 shell。定位目录/交付项、页面全屏和受限部署助手也保留 Web 等效项。

## 行为验证样例

| 用例 | 实现后应验证的行为 |
| --- | --- |
| Bootstrap | 身份和协议版本验证后才返回获授权的初始投影；先应用主题和语言，再显示首屏。 |
| Reconnect | 在回复流中断时重连，取同一会话的历史与运行锚点，补齐错过的事件；终态只显示一次，旧订阅已释放。 |
| Upload | 选择、拖拽和粘贴统一使用字节上传；验证大小、取消、过期、上传引用的归属与发送后的历史预览，客户端路径不授予宿主权限。 |
| Approvals | 重连恢复未决卡，分别验证答复/取消、计划批准/退回和挂载选择/跳过；重复、过期或跨会话的决定不得触发动作，定时任务只创建一次。 |

[手机版适配器](../../../apps/desktop/src/main/services/remote/web/adapter.ts)和[文件处理](../../../apps/desktop/src/main/services/remote/web/files.ts)提供协议先例；清单 `flows` 将用例连到具体能力，但这些连接本身不代表用例已通过。
