# 人工浏览器接管（可选工作器）

工作台网页本身可以在任何受支持的客户端浏览器中打开。这里的 Chromium 是**服务器里另一份浏览器**：所有者手动打开管理员登记的站点，通过工作台查看实时画面、点击、滚动、输入，完成或跳过后回到同一个页面。模型不能启动或操纵它，网页里的凭据、帧及输入不进入会话记录。这与 Electron 自动化和普通浏览器客户端是三件不同的事。

## 目前的验收结果

这个组件仍是实验功能，默认关闭。`ready` 证明内部空白页面通过了真实沙箱探针，并不证明业务网页已经打开或完成了人工交还。现代 Linux 验收中，同一受限本地代理、同一个合成页面、同一个 ChromeDriver 启动的浏览器，分别经 W3C 导航和固定的 `Page.navigate` 都成功；独立工作器尚未通过完整的打开、输入、交还和回收流程。[受控客户端对照](https://github.com/Facetomyself/deva/actions/runs/45796082657/job/139826952734)。因此不要把这两项对照测试算作工作台的浏览器接管成功，也不要用开放的调试端口替代这个工作器。

原生旧内核上的结果另外记录：普通工作台能够运行；兼容镜像中的 Chromium 无法创建所需命名空间，可选产品镜像的首次依赖下载也未完成。更新浏览器或使用带版本的测试二进制属于不同环境的验收，不是原机通过。[Chrome 官方对测试版用途的说明](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)。

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

## 验证

```sh
node --test --test-concurrency=1 apps/browser-worker/test/*.test.mjs test/browser-handoff.test.mjs
CHROMIUM_PATH=/absolute/path/to/chromium node apps/browser-worker/test-real/engine-handoff.mjs
```

第二条是单独的真实浏览器门禁，必须有可工作的沙箱。从私有管道打开自建回环表单，核对像素、中文输入、同页会话状态与最终进程清理；失败退出是失败，协议夹具并不能替代它。不以能够对外发 HTTP 请求作为沙箱可用的证据。
