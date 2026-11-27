# 人工浏览器接管（可选工作器）

工作台网页本身可以在任何受支持的客户端浏览器中打开。这里的 Chromium 是**服务器里另一份浏览器**：所有者手动打开管理员登记的站点，通过工作台查看实时画面、点击、滚动、输入，完成或跳过后回到同一个页面。模型不能启动或操纵它，网页里的凭据、帧及输入不进入会话记录。这与 Electron 自动化和普通浏览器客户端是三件不同的事。

## 已验证到哪一步

| 环境 | 实际结果 |
|---|---|
| [原生 Linux 工作器](https://github.com/Facetomyself/deva/actions/runs/45866511888/job/140070596393) | 沙箱 Chromium 在真实表单中接收中文输入，提交后校验 PNG、同标签页会话状态、前进/后退和进程回收。 |
| [真实工作台页面控制第二个沙箱浏览器](https://github.com/Facetomyself/deva/actions/runs/45866511888/job/140070596078) | 所有者登录后选择已登记站点、接管、输入、确认、交还并重新接管。第二次接管验证的是第一次提交后的同一文档，而非重开的页面。60 秒租约到期、切换对话、退出登录和回收也已验证。 |
| [默认 Docker Compose 三组件](https://github.com/Facetomyself/deva/actions/runs/45866511888/job/140070596510) | 三份 linux/amd64 镜像均已构建，工作台和出口可用，但该运行机内的 Chromium 在握手前报告 `sandbox-denied`。已登录的打开操作返回 503，普通工作台就绪检查仍为 200；站点收到零次 GET/POST，所有本次测试资源正常清理。此环境尚未通过容器内接管验收。 |

以上回执对应提交 `40c6d20`。前两项证明人工工作流有效；镜像构建成功、宿主能运行 Chrome 或空白页探针通过，都不能代替当前容器的同页接管验证。

## 部署边界

- 默认 Compose 只有聊天工作台。可选配置另起两个普通用户进程：`browser-worker` 运行沙箱 Chromium，无网络接口（除其自身回环）；`browser-egress` 有出站网络，只接收私有 Unix socket 上的请求，并匹配管理员登记的精确 origin。工作台只挂控制 socket，不挂工作器临时配置、数据或 Chromium profile；两个旁路容器都无工作台数据卷、模型密钥、宿主 Docker socket 和发布端口。
- Chromium 非 root、使用匿名管道管理自己的子进程，不开放网络调试端口。就绪探针会启动实际 Chromium、渲染 `about:blank`，核实渲染进程的 PID 命名空间、权限和 seccomp，然后回收。存在二进制不等于可用。环境缺少所需沙箱时，仅此面板受限，保留默认工作台功能。配置不提供特权模式、`SYS_ADMIN` 或 `--no-sandbox` 回退。
- 每个对话一次只开一页。服务器按当前登录实例、对话、页面和短时独占租约授权。截图和输入走受认证的业务接口；旧租约、其他登录和换页不会获得控制。关闭面板或租约失效后，新操作和迟到帧应被丢弃；已经送出的真实用户动作不能撤回。
- 当前只面向管理员挑选的独立同源页面。禁止任意地址、嵌套页面、新窗口、跨站登录跳转、文件选择和下载，也没有远程脚本/DOM 调试器。站点如依赖其他域名、第三方验证码或桌面系统对话框，不能计为已支持。

## 启动

1. 把许可清单放在仓库外、容器 UID 1000 可读的普通文件中。格式见 [示例](sites.example.json)，一项形如 `{"id":"docs","label":"帮助文档","url":"https://docs.example.com/start"}`。改为自己的实际站点；不得填写口令、查询串、片段或通配主机名。默认是公开 HTTPS；仅在部署者明确需要访问私有站点时，把它的精确 origin 同时登记到 `DEVA_BROWSER_PRIVATE_ORIGINS`，并保持许可列表最小。
2. 在仓库根目录运行（不要在环境里填写登录凭据）：

   ```sh
   export DEVA_BROWSER_SITES=/absolute/path/to/browser-sites.json
   docker compose -f compose.yaml -f compose.browser.yaml up -d --build
   docker compose -f compose.yaml -f compose.browser.yaml exec -T browser-worker node /opt/browser-worker/src/cli.mjs check-worker
   ```

   `ready` 指真实沙箱探针通过，`unconfigured`、`egress-unavailable`、`binary-missing`、`sandbox-startup-failure` 分别表示未配置、受限出口不可达、未找到浏览器、实际启动/沙箱验证失败。Compose 要支持相应目标架构、本地命名卷和 bind 配置；这个覆盖文件不把宿主浏览器、工作台 Cookie 或历史目录挂入工作器。部署前应确认操作系统、容器引擎和 seccomp 配置本来就能运行非特权 Chromium。若不具备，保留默认工作台，不改变宿主安全策略来冒充通过。

### 单独核对工作器容器里的 Chromium 沙箱

```sh
docker compose -f compose.yaml -f compose.browser.yaml exec -T browser-worker node /opt/browser-worker/src/cli.mjs diagnose-sandbox
```

这是本地运维命令，不是网页接口或后台健康检查。它只在新的私有 profile 中启动一次 Chromium，配置不可达的回环代理，渲染空白页并验证实际渲染器的内核沙箱，随后关闭进程。退出码 0 及 `BROWSER_BLANK_VERIFIED` 表示这条链成功；非零时，JSON 只显示固定的阶段和故障类别，不输出浏览器原始日志。它不连接已注册站点，因此不能代替表单提交、同标签页交还或工作台登录测试。

工作器保留禁用浏览器崩溃报告的常规设置，但不传 Chromium 的测试专用 Crashpad 开关：实测该开关会令部分版本的网络子进程在首次请求前反复重启，即便空白页的沙箱验证已经通过。Compose 仅为此工作器设置 core 文件软、硬上限为 0，继续使用只读根、独立临时文件系统、无出站网络和最小权限。

## 验证

```sh
node --test --test-concurrency=1 apps/browser-worker/test/*.test.mjs test/browser-handoff.test.mjs
CHROMIUM_PATH=/absolute/path/to/chromium node apps/browser-worker/test-real/engine-handoff.mjs
```

第二条是单独的真实浏览器门禁，必须有可工作的沙箱。从私有管道打开自建回环表单，核对像素、中文输入、同页会话状态与最终进程清理；失败退出是失败，协议夹具并不能替代它。不以能够对外发 HTTP 请求作为沙箱可用的证据。

本地还可用页面清单诊断，验证空白启动只有一个页面、零 worker：

```sh
node apps/browser-worker/test-real/blank-targets.mjs --compare /absolute/path/to/chromium
```

诊断使用新建的空白私有 profile 和固定的空代理，输出仅含目标类型、URL scheme 和计数。`--compare` 可省略；基线观察只用于对照。诊断与真实 Chromium 门禁及工作台所有者租约验证分开，后两项仍需各自通过。
