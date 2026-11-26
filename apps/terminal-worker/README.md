# 可选 PTY 文本查看器

这是一个**只读终端程序**，用途是在工作区中逐页查看已经保存的文本。行列数由 Linux PTY 给出，翻页按键经 PTY 送入子进程；网页渲染的是这个程序的屏幕快照。它不是宿主 shell，也不是把浏览器输入交给模型或命令解释器。

## 启用（Linux/amd64 Docker）

准备一个只包含获准项目子目录的父目录，在仓库根目录运行：

```sh
export DEVA_WORKSPACE_PARENT=/absolute/path/to/approved-projects
docker compose -f compose.yaml -f compose.workspaces.yaml -f compose.terminal.yaml up -d --build
docker compose -f compose.yaml -f compose.workspaces.yaml -f compose.terminal.yaml exec -T terminal-viewer node /opt/terminal-worker/src/cli.mjs check
```

`check` 真正创建一个微型 PTY，改变尺寸、移动一行并等待 `q` 的正常退出；退出码 0 才表示该次探测成功。仅有二进制、容器或 socket 文件都不是就绪证明。默认部署不启用此工作器，普通工作台的就绪检查也不依赖它。

在原有**工作区文件**面板中打开已保存的普通文本，然后点击 **打开 TTY 查看器**。初始为 80×12，可切换到 64×8；屏幕下方的数字取自子进程的实际回执。查看区获得焦点后支持方向键、Page Up / Page Down、Home / End 和 `q`。`q` 保留真实退出结果供核对；关闭面板、切换文件或登出会回收相关会话。未保存的编辑内容不会送到工作器。

## 数据与隔离

- 主服务只接收已登记的项目 ID、相对文件名和现有磁盘版本，检查文件和每层目录的当前身份与读取权限，再把一份最多 **64 KiB、4096 行**的文本快照传给工作器。目录被同名替换、权限撤回、文件被改动时，旧视图失效。常见凭据文件名或明显的私钥内容不会转交；这不是对任意文件内容的通用保密扫描。
- 查看器容器使用 UID/GID 1000、只读根文件系统、无额外 capability、`no-new-privileges`、`network_mode: none`。它不挂载工作台数据卷、密钥卷、项目目录或 Docker socket。它只与主服务共用专属的私有 Unix socket 目录；该卷不应与其他服务共用。初始文本暂存在独立 tmpfs 的私有文件，子进程确认读到正确字节后即解除该文件名的链接。
- 工作器只启动镜像中的固定 Node 查看程序。浏览器没有选择可执行文件、命令、环境变量或原生工作目录的接口。通道只接受九种导航操作和有界行列数。终端控制字符作为可见文本处理；屏幕不会解释文件中的 ANSI、超链接或剪贴板控制序列。
- 同一登录最多打开 2 个查看器，整台工作器最多 4 个（健康探测也占用一个短时槽位）。主服务在 **75 秒无人工操作**或 **8 分钟总时长**后关闭视图；后台读取不续期。断线可以从当前游标恢复有界屏幕事件，来不及读取旧帧时改为完整快照。主服务不自动重试结果不明的按键。正常退出回执短暂保留约 15 秒；工作器连接丢失时显示未知退出结果，绝不报成退出码 0。

## 运维与验证

主服务仅挂载控制卷的只读一侧，工作器负责监听 `viewer.sock`。正常停止会拆除自己的监听、回收查看子进程。异常断电后若出现残留 socket，工作器会保留未知文件并报告不可用；先停止相关工作台与工作器并确认专属控制卷的身份，必要时给两个组件共同换用一份新的空控制卷。业务 `data`、`keys` 与项目文件均不属于这项恢复操作。

仓库包含三个互补的验证层：原生 Unix/PTY 测试、真实 Chrome 的业务操作、以及实际双镜像 Compose 的内核和清理检查。以下命令仅使用临时合成文件。真实浏览器测试要求匹配的普通非 root Chrome 和 ChromeDriver；双镜像测试在临时的原生 Linux/amd64 Docker 运行机执行。

```sh
node --test --test-concurrency=1 apps/terminal-worker/test/*.test.mjs
pnpm headless:test
node scripts/workbench/e2e-terminal-viewer.mjs
```
