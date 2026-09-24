# Codex Link To Phone

把电脑上的 Trae Codex 会话接到手机网页，支持查看历史和实时消息、发送文字与图片、追加指令、审批请求，以及查看计划和文件变更。

## 项目组成

| 目录 | 用途 |
| --- | --- |
| `assistant/` | C++ 桌面助手，管理代理配置、手机桥启停和连接状态 |
| `proxy/` | C# Native AOT 代理，转发 Trae 与 Codex 的 stdio 通信，并向手机桥提供控制连接 |
| `server/` | C# Native AOT 手机桥，处理会话、HTTP/WebSocket、图片和内置 Relay 客户端 |
| `public/` | 手机网页的 HTML、CSS、JavaScript，直接由手机桥提供 |
| `relay/` | 部署到公网 Windows 服务器的 C++ Relay 服务 |
| `tests/` | C#、C++ 和 JavaScript 测试、假上游及测试调度脚本 |
| `config/` | 手机桥连接配置模板 |

日常运行使用原生 EXE，无需安装 Node.js 或 .NET 运行库。Node.js 用于测试和可选的 npm 管理命令。手机桥从磁盘读取 `public/`，修改网页后刷新即可。

## 环境要求

- Windows x64；当前适配 Trae 扩展 `openai.chatgpt 26.901.22334` 和 `codex-cli 0.153.4`，启动时校验版本。
- 构建需要 Visual Studio C++ x64 工具链、Windows SDK、CMake 3.20+、.NET SDK `10.0.401` 或同一 `10.0.4xx` 系列的更高补丁版本。
- 助手依赖 nlohmann/json 3.12.0，头文件和 MIT 许可证随源码保存在 `assistant/third_party/`，构建无需另外下载。
- 运行测试另需 Node.js 20+ 和 Microsoft Edge；npm 开发依赖由 `package-lock.json` 锁定。

## 构建

以下命令均在项目根目录的 PowerShell 中执行。首次构建或目标程序未运行时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File assistant/scripts/build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File proxy/build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File server/build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File relay/scripts/build.ps1
```

| 组件 | 正式产物 |
| --- | --- |
| 桌面助手 | `assistant/dist/Codex手机助手.exe`，同时复制到项目根目录 |
| Codex 代理 | `proxy/dist/codex-phone.exe` |
| 手机桥 | `server/dist/codex-phone-bridge.exe` |
| Relay 服务 | `relay/dist/relay-server.exe` |

助手默认构建并执行 C++ 测试，因此需要保留 `tests/assistant/`。Relay 服务构建用于服务器部署和本机集成测试。

运行中的手机桥可通过以下命令构建、更新并重启，需要当前 Trae 代理已连接：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File server/build.ps1 -Restart
```

更新前的手机桥会保存到 `server/build/previous/`，重启失败时尝试恢复。代理运行时，`proxy/build.ps1` 会把新程序保留在 `proxy/build/publish/` 并停止部署；关闭使用该代理的扩展会话后，再执行构建脚本。

## 配置与使用

首次使用时，将 `config/phone-mode.example.ini` 复制为 `config/phone-mode.ini`，填写连接参数。已有配置可直接继续使用。

```ini
[phone]
mode=relay
local_host=127.0.0.1
local_port=8787
token=请设置手机连接口令

[relay]
server=服务器公网IP
agent_port=8789
public_port=8788
secret=CHANGE_ME_TO_A_RANDOM_SECRET_OF_32_CHARS
reconnect_delay_ms=2000
```

`mode` 固定为 `relay`。把 `secret` 替换为至少 32 个字符的随机密钥，并与服务器配置中的 `shared_secret` 保持一致。服务器模板是 `relay/config/relay-server.example.ini`；默认需开放 TCP 8788、8789。`phone.token` 用于手机网页连接，Relay 密钥用于电脑与中继服务器认证。

1. 在公网 Windows 服务器部署并启动 Relay，详见本地[部署说明](docs/relay/README.md)。当前手机桥和服务器使用 CPR2 协议。
2. 打开根目录 `Codex手机助手.exe`，点击“开启代理模式”，然后完整重启 Trae，让扩展加载代理。
3. 代理初始化后自动启动手机桥。手机访问 `http://服务器公网IP:8788/`，输入 `phone.token`；同一局域网也可访问 `http://电脑局域网IP:8787/`。

助手关闭窗口后，手机桥继续运行。通过助手启动的手机桥在代理连续消失 15 秒后自动退出；点击“结束手机桥”会暂停本轮 Trae 的自动启动，手动重启手机桥或下次完整打开 Trae 后恢复。

命令行也可直接调用助手，例如：

```powershell
& './assistant/dist/Codex手机助手.exe' --action Status
```

安装 Node.js 后可使用这些 npm 快捷命令：

| 命令 | 操作 |
| --- | --- |
| `npm run phone:enable` | 开启代理模式 |
| `npm run phone:disable` | 恢复启用前的 CLI 配置并停止手机桥 |
| `npm run phone:start` | 启动或重启手机桥 |
| `npm run phone:stop` | 停止手机桥，并暂停本轮自动启动 |
| `npm run phone:status` | 查看当前状态 |

直接执行 `server/dist/codex-phone-bridge.exe` 或 `npm start` 仅启动手机桥，需要自行保证代理已就绪。二维码接口为 `/qr.svg?token=手机连接口令`。当前 Relay 使用明文 HTTP/TCP；需要 HTTPS 时须另行配置入口。

## 测试

准备上述构建产物和运行配置后，在项目根目录执行：

```powershell
npm ci
npm test
```

默认运行 20 组测试，覆盖桥接模块、前端状态、代理协议、浏览器交互、生命周期、多实例路由、管理器和 Relay。测试使用假上游、独立状态目录及本地端口；UI 测试通过 Playwright 启动 Edge。

测试产物、日志和截图统一写入 `tests/build/`；汇总结果在 `tests/build/results-latest.json`，完整运行日志在 `tests/build/runs/`。测试目录清理后，下次运行会重新生成所需产物。

常用独立入口：

```powershell
npm run test:bridge-modules
npm run test:web-modules
npm run test:bridge-integration
npm run test:ui
npm run test:assistant
```

单独运行 `test:web-modules` 前，先执行 `test:bridge-modules`，生成前端展示契约需要的消息样本。`BRIDGE_TEST_EXE` 可指定其他手机桥构建。

`npm run test:live` 检查实际手机桥和公网连接；`npm run test:adb` 操作实体手机 `3B164801AQ300000`。两者均不在默认回归中，真机测试结束后需清理本次手机临时文件。更多入口见本地[测试说明](docs/tests/README.md)。

## 本地文件与维护

- `.state/` 保存实际运行状态、上传图片、未读记录和配置恢复信息，应保留。
- 各组件 `build/` 保存编译产物和缓存；`server/build/packages/`、`proxy/build/packages/` 是 NuGet 缓存，删除后下次构建需重新还原。
- `dist/` 中的 EXE 是启动和测试入口；构建副本与正式入口用途不同，清理时需区分。
- Git 只追踪根目录 `README.md`；`docs/` 文档在本地保留，其他目录的 `README.md` 忽略。真实配置未纳入 Git，单独检出后需从模板准备。
- 在根目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File relay/scripts/package.ps1`，生成 `relay/dist/codex-phone-relay-windows-x64.zip`。包内包含 EXE、配置模板和解压后使用说明；本地存在 `docs/relay/PROTOCOL.md` 时附带协议文档，缺少 `docs/` 也能打包。

本地详细文档统一从[文档索引](docs/README.md)进入，包括架构、手机桥、代理、Relay、测试指南和历史验证记录；这些链接指向当前工作区资料，单独检出 Git 仓库不包含 `docs/`。
