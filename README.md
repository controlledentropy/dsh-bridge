# dsh-bridge

**通过 MCP，让 Codex、Claude Desktop、Cursor 等客户端调用本机的 DeepSeek Harness（`dsh web`）。**

`dsh-bridge` 是一个基于 **stdio** 的 MCP Server。它将 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) 的本机 `/api` 封装为 **9 个 MCP 工具**，让 AI 客户端能够创建或接管会话、派发任务、等待执行、查看结果，并保留可审计的任务记录。

无需修改 `dsh`，也无需在 Codex 中安装专用插件。

> **兼容性说明**：当前已在 `@deepseek-ai/dsh@0.2.1-rc.2`、Windows 11、Node.js 24 上完成实机验证。项目要求 Node.js **≥ 18.14**；GitHub Actions 已配置在 Linux / Windows、Node.js 20 / 22 上运行离线测试，跨版本结果以实际 CI 运行为准。`dsh web` 的 `/api` 并非稳定公开契约，升级 `dsh` 后请先按[兼容性与升级](#兼容性与升级)检查。

## 目录

- [适用场景](#适用场景)
- [工作原理](#工作原理)
- [快速开始](#快速开始)
- [典型工作流](#典型工作流)
- [MCP 工具一览](#mcp-工具一览)
- [配置说明](#配置说明)
- [长期本地部署](#长期本地部署)
- [测试与调试](#测试与调试)
- [常见问题](#常见问题)
- [安全与使用边界](#安全与使用边界)
- [兼容性与升级](#兼容性与升级)
- [贡献与许可](#贡献与许可)

## 适用场景

当你希望**一个 AI 客户端负责规划与验收，另一个执行环境负责落地任务**时，可以使用这个桥接：

- **并行处理工作**：让 Codex 主会话继续分析，同时把独立的编码、测试或排查任务交给 `dsh`。
- **保持任务隔离**：`dsh` 不继承 MCP 客户端的对话上下文，只接收明确下发的任务说明。
- **跨客户端管理会话**：通过命名别名找回任务，也可接管在 `dsh web` 中已有的会话。
- **审计执行过程**：按轮读取状态、助手输出、工具调用和文件产物，而不是仅凭“请求已接受”判断成功。

`dsh-bridge` **不是**远程任务队列、云端执行平台或 `dsh` 的替代品。它面向受信任的**本机** MCP 客户端与 `dsh web` 实例。

## 工作原理

```text
Codex / Claude Desktop / Cursor
              │
              │ MCP（stdio）
              ▼
         dsh-bridge
    ├─ 工具参数与模型策略预检
    ├─ 命名会话账本 / 审计日志
    └─ 启动或连接本机 dsh web
              │
              │ HTTP /api（localhost）
              ▼
           dsh web
              │
              ▼
     dsh 会话 / 工具 / 工作区
```

桥接只负责**连接、约束和观察**，实际任务仍由 `dsh` 执行。两侧的会话与工作区互不等同，因此需要遵守三个约定：

1. **书面交接**：任务明确写出*目标、边界、验收标准、交付物*。
2. **按轮验收**：`accepted: true` 仅表示收到请求；只有 `state: "completed"` 表示本轮正常结束，仍应检查结果和产物。
3. **先预检后执行**：别名、目录、模型和推理强度不符合策略时，桥接会在调用 `/api` 前拒绝请求。

启动鉴权使用 `dsh web` 写到 **stdout** 的一次性启动 token；桥接通过捕获文件读取 token 并建立本机 API 连接。相关实现与协议细节见 [docs/API-CONTRACT.md](docs/API-CONTRACT.md)。

## 快速开始

### 1. 安装并检查

前提：已安装并能运行 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)，本机有 Node.js **≥ 18.14**（需要 `headers.getSetCookie()`）。

```bash
git clone <your-repository-url>
cd dsh-bridge
npm install
npm test                    # 离线契约及 MCP 子进程测试；不启动 dsh web，不消耗模型额度
node launch.mjs resolve     # 确认 Node / dsh 路径和版本
node launch.mjs check       # 预检版本和 profile；不启动 dsh web 服务
```

> 将 `<your-repository-url>` 替换为仓库发布后的实际 GitHub 地址。`npm install` 需要正常获取 npm 依赖；`npm test` 会运行测试子进程，但不需要连接 `dsh web` 或消耗模型额度。`node launch.mjs check` **会启动一次短生命周期的 `dsh --profile web --dump-config` 命令**（默认最多等待 25 秒），但不会启动 web 服务；一小时内命中 `check.json` 缓存时可跳过该检查。

### 2. 启动或连接 `dsh web`

任选一种方式：

**方式 A：手动启动（便于管理生命周期）**

在 Windows PowerShell 中运行：

```powershell
powershell -File start-dsh-web.ps1
```

脚本将 `dsh web` 的 stdout 捕获到桥接可读取的位置。启动 token **不会**由 `dsh` 自动保存到它自己的配置文件中。

**方式 B：由桥接自动启动（最简单）**

不必提前运行 `dsh web`。当目标端口空闲时，桥接会尝试自行启动实例，并将 stdout 保存到 `DSH_BRIDGE_STATE/dsh-web.out`。

> 建议一台机器只运行**一个** `dsh web` 实例。多个实例同时写入 `~/.dsh/storages/workspace.json` 的行为尚未验证。

### 3. 在 MCP 客户端中注册

**Codex**：编辑 `~/.codex/config.toml`（请将路径替换为本机绝对路径）。

```toml
[mcp_servers.dsh]
command = 'node'
args = ['/absolute/path/to/dsh-bridge/bridge.mjs']
startup_timeout_sec = 120
tool_timeout_sec = 180

[mcp_servers.dsh.env]
DSH_PORT = '3080'
DSH_BRIDGE_STATE = '/absolute/path/to/dsh-bridge/.state'
```

Windows 路径也可以写成 TOML 单引号字符串，例如 `C:\tools\dsh-bridge\bridge.mjs`。`startup_timeout_sec` 只控制 MCP Server 启动；示例将 `tool_timeout_sec` 设为 180 秒，以便为首次自动启动 `dsh web` 留出较大余量。

> **冷启动注意**：首次调用可能依次经历 web 启动（默认最多 90 秒）、provider 目录加载（15 秒）、首轮内部等待（40 秒），此外还有 API 调用与重试开销，**60 秒的工具超时可能不够**。建议提前启动 `dsh web`，或按实际耗时提高客户端工具超时。即使 MCP 调用超时，已被 `dsh` 接受的任务仍可能继续执行；重新下发前，请先核查会话状态。

**Claude Desktop 及采用 JSON 配置的 MCP 客户端**：使用同样的 `command`、`args` 和 `env` 字段。

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-bridge/bridge.mjs"],
      "env": {
        "DSH_PORT": "3080",
        "DSH_BRIDGE_STATE": "/absolute/path/to/dsh-bridge/.state"
      }
    }
  }
}
```

请按具体客户端的配置格式放置上述字段；JSON 中的 Windows 反斜杠需写为 `\\`。**修改 `bridge.mjs` 或 MCP 配置后，请重启 MCP 客户端**，子进程不会热更新代码。

### 4. 验证连接

重启客户端后，让它调用 `dsh_models`。如需排查本地环境，再执行：

```bash
node launch.mjs doctor
```

`doctor` 依次检查路径、版本、profile、端口、token、鉴权和模型目录，并指出不可用的环节。模型目录需要在 `dsh` 启动后加载完成；出现临时空目录时可结合日志检查。

## 典型工作流

例如，你想把一个仓库的测试修复交给 `dsh`，可以对 MCP 客户端说：

> 请使用 dsh-bridge 在 `C:\work\my-project` 新建别名 `fix-tests` 的会话，执行以下任务：
>
> - **目标**：定位并修复当前失败的测试。
> - **边界**：不要改动无关功能，不要提交 Git commit。
> - **验收标准**：相关测试通过，并说明验证命令及结果。
> - **交付物**：变更文件清单、修复说明和仍存在的风险。
>
> 提交任务后轮询，只有本轮 `completed` 才汇报成功；最后取回执行结果供我复核。

典型工具调用顺序：

```text
dsh_models                         查看可选模型（如需指定）
dsh_sessions {cwd}                 查看该工作区已有会话
dsh_launch {alias, cwd, task}      新建会话并提交任务
  或 dsh_send {alias, task}        在已有会话中继续一轮
dsh_wait {alias, maxSeconds: 45}   可重复调用，直到本轮结束
dsh_result {alias}                 读取本轮输出、工具调用和文件产物
dsh_status {alias}                 查看模型、token 用量和上下文压力
```

如果会话已在 `dsh web` 界面存在，可以用 `dsh_adopt` 接管；如需停止正在运行的一轮，用 `dsh_cancel` 请求取消后再调用 `dsh_wait` 确认结果。

### 如何判断任务状态

| `state` | 含义 | 建议动作 |
| --- | --- | --- |
| `completed` | 本轮正常结束（`turn/end.reason.kind == completed`） | 检查 `dsh_result` 和实际产物 |
| `error` | 本轮以错误结束 | 上报 `error.code` / `error.message`，不要静默换模型重跑 |
| `running` | 仍在执行 | 再次调用 `dsh_wait` |
| `idle` | 请求可能已受理，但本轮没有可确认的 turn | 视为**未验证**，不能当作成功 |

同样地，`session/list.running` 从 `true` 变为 `false` **不能**用于区分成功与失败。更详细的编排原则见 [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md)。

### 失败要看正文，越界要看边界

一轮里出现工具错误时，`dsh_result` / `dsh_status` 会给出 `toolErrorCount`（数量）、`toolErrors[]`（每条含 `seq / turn / step / name / code / body`，正文截断到 400 字符）与 `sandboxDenials`（其中属于沙箱拒绝的条数）。`tool/result` 事件本身**不带工具名**，桥接按 `(turn, step)` 回连到对应的 `tool/call`，所以 `toolErrors[].name` 能直接告诉你是 `run_code` 还是 `Write` 失败。

沙箱拒绝**不会**在服务端排队等待审批：它以 `isError` 的工具结果返回，dsh 把"可以提权重试"的提示写在正文里。因此 `sandboxDenials > 0` 的含义是"任务的写入范围超出了会话工作区"，而不是"等用户点确认"。

会话的写入边界就是它的 `cwd`。`dsh_launch` / `dsh_send` 的返回里带 `scope`（`workingDirectory` / `sandbox` / `agentPreset` / `model`）、`warnings` 与 `outsideCwd`（任务文本里出现的工作区外绝对路径，最多 8 条）。**会话建在哪个目录，就由那个目录决定它能写哪里**：任务要改动别的仓库时，应以那个仓库作为 `cwd` 建会话（侧边栏分栏跟随 `cwd`），而不是在 A 工作区的会话里写 B 目录。

## MCP 工具一览

| 工具 | 主要参数 | 作用 |
| --- | --- | --- |
| `dsh_models` | 无 | 返回实时模型目录与允许清单的交集，包含默认模型、可路由 provider 和加载失败信息 |
| `dsh_launch` | `alias`, `cwd`, `task`; 可选 `phase`, `group`, `dryRun`, `model`, `reasoningEffort` | 新建命名会话、设置模型并提交第一轮；`dryRun` 只创建会话，不执行任务 |
| `dsh_send` | `alias`, `task`; 可选 `model`, `reasoningEffort` | 向同一会话提交下一轮 |
| `dsh_adopt` | `alias`, `sessionId`, `cwd`; 可选 `phase` 等 | 接管已存在的 `dsh web` 会话，不改变其分栏 |
| `dsh_wait` | `alias`; 可选 `maxSeconds`（≤ 45） | 在限定时间内等待本轮完成或返回当前状态 |
| `dsh_status` | `alias` | 返回本轮状态、模型、token 用量、上下文压力、待答问题，以及会话边界信息：`workingDirectory`、`sandbox`（如 `workspace-write`）、`agentPreset`、`sessionStats` |
| `dsh_result` | `alias`; 可选 `messages`（≤ 40） | 获取本轮验收载荷：助手文本、工具调用、落盘文件、`toolErrors[]`（含失败正文与错误码）、`sandboxDenials`；默认只读取本轮 |
| `dsh_sessions` | 可选 `cwd` | 查看桥接持有的别名；传入 `cwd` 时额外查询该工作区的活会话 |
| `dsh_cancel` | `alias` | 请求取消当前轮；需再次检查最终状态 |

**会话标识约定**：

- `alias` 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，对应的会话 ID 为 `dsh-<alias>`。
- `cwd` 必须是**已存在的绝对路径**。Windows 下桥接会统一路径分隔符，避免 `C:/x` 和 `C:\x` 在 `dsh` 中被记录为两个工作区。
- 默认可将新会话放到对应项目的侧边栏分栏：桥接通过 `workspace/create {path}` 找到 `workspaceId`。**分栏只能在创建会话时确定**，接管现有会话不能替它改组。
- 会话账本位于 `DSH_BRIDGE_STATE/sessions.json`，按状态目录隔离；它记录别名、会话、每轮请求标识及**下发任务的完整原文**（可能含项目路径、需求描述或其他敏感信息），但不保存模型输出。执行结果始终从 `dsh` 重新读取，**账本应按敏感文件保护**。

## 配置说明

所有配置均通过 MCP Server 的环境变量设置。不需要的字段可保持默认。

### 连接与运行

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_HOST` / `DSH_PORT` | `127.0.0.1` / `3080` | 本机 API 地址；`localhost` 与 `127.0.0.1` 的 cookie audience 不相同，请统一使用一种写法 |
| `DSH_BRIDGE_STATE` | `<包目录>/.state` | token 捕获、实例信息、会话账本、审计日志及子进程工作目录（`run/`） |
| `DSH_ATTACH_OUTFILE` | 空 | 指定外部捕获的 `dsh web` stdout 文件，鉴权时优先从该文件读取 token；**单独设置不会禁止自动启动**，如需禁止请另设 `DSH_NO_SPAWN=1` |
| `DSH_NO_SPAWN` | 空 | 设为 `1` 后禁止桥接自动启动 `dsh web` |
| `DSH_AUTO_GROUP` | 空 | 设为 `0` 时默认关闭自动侧边栏分栏；单次调用还可设置 `group: false` |
| `DSH_NODE` / `DSH_PKG_DIR` | 自动探测 | 覆盖 Node 可执行文件和 `@deepseek-ai/dsh` 包目录 |

### 模型访问策略

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_ALLOWED_MODELS` | 空（不限制） | 允许的 `provider/model` 及推理强度清单；文法为 `provider/model[:effort\|effort][, ...]` |
| `DSH_DEFAULT_MODEL` | 空 | 调用方未指定时使用的 `provider/model` |
| `DSH_DEFAULT_EFFORT` | 空 | 默认推理强度，与默认模型配套使用 |

模型策略在请求发送前检查；配置不合法或默认值与允许清单冲突时会明确报错，不会悄悄放宽权限。配置了却无法解析出任何条目的 `DSH_ALLOWED_MODELS` 会导致启动失败。

`dsh_models` 根据**实时模型目录与允许清单**返回可选项，并提供可路由 provider 与加载失败信息；桥接在设置模型前会等待对应 provider 进入目录，避免冷启动时因目录未加载而浪费一次任务。具体模型可用的 `reasoningEffort` 由 `dsh` 自行验证；不支持时可能返回 `session/model-unavailable`。

### 超时、日志与兼容性

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_API_TIMEOUT_MS` | `15000` | 单次 `/api` 请求超时阈值，超时重试一次 |
| `DSH_POLL_MS` | `3000` | 状态轮询间隔 |
| `DSH_WATCH_MS` | `40000` | `dsh_launch` / `dsh_send` 内部等待窗口；应小于客户端的工具超时 |
| `DSH_CATALOG_WAIT_MS` | `15000` | 等待模型 provider 加载的时间上限 |
| `DSH_BOOT_TIMEOUT_MS` | `90000` | 等待 `dsh web` 启动的时间上限 |
| `DSH_CHECK_TIMEOUT_MS` | `25000` | `launch.mjs check` 运行 `dsh --profile web --dump-config` 时的超时上限；1 小时内可复用预检缓存 |
| `DSH_LOG_MAX_BYTES` | `2000000` | 审计日志滚动阈值，仅保留一份 `.1` 备份 |
| `DSH_TESTED_VERSION` | `0.2.1-rc.2` | 版本闸门；不一致时发出预检警告，应复核 API 兼容性 |

> `dsh_wait` 单次上限为 **45 秒**，长任务应反复轮询。客户端的 `tool_timeout_sec` 不仅要覆盖 `dsh_wait`，还应考虑 `dsh_launch` / `dsh_send` 的**冷启动、目录等待、内部等待及重试**；工具调用超时也不等于底层任务被取消。

## 长期本地部署

本项目的“部署”是指**受控工作站或开发机上的长期运行**，而非将 MCP 服务或 `dsh web` 公开到互联网。MCP Server 由客户端以 stdio 子进程方式启动；`dsh web` 可以由桥接按需启动，也可以独立管理。

### 推荐方式：独立管理 `dsh web`，桥接仅连接

1. 使用固定版本的 Node.js 和 `@deepseek-ai/dsh`，先执行 `npm test` 与 `node launch.mjs check`。
2. 为桥接准备固定的 `DSH_BRIDGE_STATE` 目录，确保运行用户可写，并限制其他本机账户访问。该目录的 `sessions.json` 会保留**下发任务的原文**，可能包含敏感工作信息。
3. 通过 `start-dsh-web.ps1` 或你自己的进程管理方式启动 `dsh web`，**务必捕获同一个实例的 stdout**。
4. 在 MCP 配置中设置 `DSH_ATTACH_OUTFILE` 指向该捕获文件，并设置 `DSH_NO_SPAWN=1`，避免桥接意外拉起第二个实例。
5. 启动后执行 `node launch.mjs doctor`，再通过客户端调用 `dsh_models` 与只读状态工具验证连通性。

可以在 Codex 的 `[mcp_servers.dsh.env]` 中追加：

```toml
DSH_ATTACH_OUTFILE = '/absolute/path/to/dsh-web.out'
DSH_NO_SPAWN = '1'
```

若希望配置最少，也可以不设置以上两项，改用**按需自动启动**；但此时应确保没有外部程序同时启动另一个 `dsh web` 实例。

### 上线前检查

- [ ] `dsh web` 仅供可信本机程序连接；不对公网暴露 owner 凭据或本机 API。
- [ ] `DSH_BRIDGE_STATE`（含保留完整任务文本的 `sessions.json`）和 stdout 捕获文件只对授权用户可读；Windows 额外检查目录 ACL。
- [ ] 同一状态目录由需要共享别名的客户端共同使用；不同环境使用不同状态目录。
- [ ] 同一个别名不会被两个客户端**同时派发**任务；账本支持并发安全写入，但不保证同一别名多轮并发的语义正确。
- [ ] 所有下发任务使用可写、可回滚的工作区，并由调用方审查结果。
- [ ] 变更 `dsh` 版本、profile 或 MCP 配置后，重新运行预检和连通性验证。

`node launch.mjs stop` **只尝试停止** `instance.json` 中登记的进程，不会停止不属于桥接管理的其他实例。对于外部管理的 `dsh web`，请通过对应的进程管理方式停止。

## 测试与调试

### 日常运维命令

```bash
node launch.mjs resolve     # 解析 Node / dsh 入口 / 版本
node launch.mjs check       # 会运行一次 dsh CLI 配置检查；不启动 dsh web 服务
node launch.mjs doctor      # 体检：端口、token、鉴权、模型目录等
node launch.mjs start       # 已运行则连接，否则预检后启动并捕获 stdout
node launch.mjs stop        # 仅停止桥接记录为自己管理的实例
```

### 契约测试与诊断工具

```bash
npm test                                  # 20 个离线契约 / MCP 子进程测试
node tests/live-check.mjs                 # 已运行实例的只读复验（需能读取当前实例的启动 token）
node tools/probe-api.mjs                  # 探查 /api 端点参数形状
node tools/probe-acp.mjs                  # 检查 ACP 接口
node tools/read-session-log.mjs <file>    # 解码多帧 zstd 会话日志
```

以下选项**不属于零副作用检查**，请只在可测试的环境里使用：

| 命令选项 | 影响 |
| --- | --- |
| `live-check --adopt` | 接管 `DSH_TEST_WS` 中一个空闲会话；不新建会话 |
| `live-check --create` | 并发新建两个 `dryRun` 会话以验证账本；会留下需要在 `dsh` UI 中归档的会话 |
| `live-check --dispatch` | 真正执行一轮任务，消耗模型额度；`DSH_TEST_WS` 必须指向允许写入的测试目录 |
| `probe-api --mutate` | 允许探查时创建会话 |
| `probe-acp --prompt` | 允许发出真实任务 |

GitHub Actions 工作流配置在 Linux / Windows、Node.js 20 / 22 上运行离线测试；**首次 CI 是否通过应以实际运行结果为准**。为兼容 Node.js 20，`package.json` 的 `scripts.test` 应显式列出测试文件，而不是依赖 Test Runner 展开 glob：

```json
{
  "scripts": {
    "test": "node --test tests/contract.test.mjs tests/mcp.test.mjs"
  }
}
```

若当前项目仍使用 `node --test "tests/*.test.mjs"`，请在发布前替换并运行 CI。代码注释中带 `MEASURED:` 的结论来自实际调用验证，不应以未经验证的推断替代。

`live-check` 虽然默认不创建会话或派发任务，但它仍需通过**当前 `dsh web` 实例的启动 token**完成鉴权：请与 MCP 桥接共用 `DSH_BRIDGE_STATE`，或设置 `DSH_ATTACH_OUTFILE` 指向该实例的 stdout 捕获文件。只更换状态目录而不提供 token，可能得到 `no launch token` 错误。

### 日志与排错顺序

优先按照以下顺序检查：

1. `node launch.mjs resolve`：Node 与 `dsh` 指向哪里？
2. `node launch.mjs check`：版本和 profile 是否可用？
3. `node launch.mjs doctor`：端口、token、cookie、模型目录在哪一步失败？
4. `DSH_BRIDGE_STATE/bridge.log.jsonl`：是否有对应 MCP 工具调用和 `/api` 状态？
5. `dsh_result`：任务确实发出后，本轮结束原因、工具记录和产物是什么？

审计日志记录调用端点和 HTTP 状态，不记录启动 token；日志按 `DSH_LOG_MAX_BYTES` 滚动。

## 常见问题

| 现象 | 可能原因 | 处理方式 |
| --- | --- | --- |
| `no launch token in …` | 当前实例的 stdout 未被正确捕获 | 使用 `start-dsh-web.ps1`、设置 `DSH_ATTACH_OUTFILE`，或停掉旧实例后由桥接启动 |
| `/connect -> HTTP … with no auth cookie` | token 属于旧实例，或连接端口不一致 | 执行 `doctor`，检查 `STALE` 提示、当前进程与端口 |
| `did not activate` | `dsh` profile 中存在当前版本不接受的配置 | 先备份 profile，用 `node launch.mjs check` 查看原始错误 |
| `EADDRINUSE` | 端口已被占用 | 查找并停止冲突进程，避免多实例竞争 |
| `UNKNOWN_MODEL` 或 `session/model-unavailable` | provider、模型或推理强度不可用 | 先查 `dsh_models` 的 `routableProviders` 与 `failures` |
| 会话未出现在预期侧边栏 | 创建时未关联正确 workspace | 新建会话并启用自动分栏；已接管会话无法通过桥接改组 |
| MCP 客户端面板未显示工具 | 某些客户端不会展示完整工具列表 | 尝试直接调用 `dsh_models`，查看 `bridge.log.jsonl` 中的 `ev:"tool"` |
| 返回 `idle` 或 `accepted: true` | 还没有可确认的完成记录 | 继续查询状态；绝不据此宣称任务完成 |

## 安全与使用边界

- **token 等同于高权限凭据**：`dsh web` 的 owner cookie 不对每个方法再做独立授权。能读取 stdout 捕获文件的用户，可能取得对本机 `dsh` 实例的 owner 访问能力。不要提交、转发或共享这些文件。
- **保护状态目录及任务原文**：`.state/` 已在 `.gitignore` 中；`sessions.json` 会逐字保存每轮下发的完整任务文本，可能包含路径、需求细节或敏感信息。stdout 捕获文件按 `600` 权限处理，但在 Windows 上还应检查实际 ACL。不要把整个 `.state/` 放在多人共享目录或同步盘中。
- **保持本机边界**：桥接默认连接 `127.0.0.1`，不需要对外提供 HTTP MCP 服务。不要将 `dsh web` 的 API、启动 token 或带凭据的连接代理暴露到不可信网络。
- **工作区操作是真实的**：被委派的 agent 会在 `dsh` 自己的工作区中修改文件。为不可信任务准备独立沙箱、限制可写范围，并检查 diff、测试输出与交付文件。
- **会话账本不是结果缓存**：`sessions.json` 保存会话句柄、请求 ID、每轮基线及任务原文，**不缓存助手输出和执行结果**。写入采用排他锁与临时文件 rename；持久化失败会报错，但不表示对同一别名并发下发是安全的。
- **错误不应被掩盖**：任务失败后保留并上报 `error.code` 和 `error.message`，避免无提示重试、切换模型或把未完成当作成功。

## 兼容性与升级

`dsh web` 的 `/api` 没有向后兼容承诺。本项目将相关逻辑尽量集中在以下文件：

| 文件 | 职责 |
| --- | --- |
| `bridge.mjs` | MCP 传输和工具定义 |
| `launch.mjs` | 启动、进程、凭据、版本检查 |
| `lib/api-contract.mjs` | `/api` 请求与响应的适配 |
| `tests/contract.test.mjs` | 离线契约回归测试 |

升级建议：

1. 记录当前 `dsh` 版本，备份 profile 和必要的本机状态。
2. 执行 `npm test`、`node launch.mjs check` 和 `node launch.mjs doctor`。
3. 若 `/api` 结构改变，按照 [docs/API-CONTRACT.md](docs/API-CONTRACT.md) 的重建步骤重新探查，以实际观测修订契约测试，再修改适配层。
4. 在隔离的测试工作区进行真实任务验证后，再恢复日常使用。

## 贡献与许可

欢迎提交 Issue 和 Pull Request。修改接口行为时，请先用实测结果更新 `tests/contract.test.mjs`，再修改实现；实际验证过的行为用 `MEASURED:` 标注。会启动子进程的测试应在 `finally` 中回收进程，避免测试失败后挂起。

提交前请检查 `git status` 与 `git diff --cached`，确认没有把 `.state/`、`node_modules/`、`*.out`、`*.ndjson` 等本机文件带入仓库，并确认 README 引用的 `docs/API-CONTRACT.md`、`docs/ORCHESTRATION.md` 和 `LICENSE` 已随仓库提交。

本项目基于 **MIT License** 发布，详见 [LICENSE](LICENSE)。
