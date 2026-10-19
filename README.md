# dsh-bridge

**通过 MCP，让 Codex、Claude Desktop、Cursor 等客户端调用本机的 DeepSeek Harness（`dsh web`）。**

`dsh-bridge` 是一个基于 **stdio** 的 MCP Server。它将 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) 的本机 `/api` 封装为 **10 个 MCP 工具**，让 AI 客户端能够创建或接管会话、派发任务、等待执行、查看结果，并保留可审计的任务记录。

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

启动鉴权使用 `dsh web` 写到 **stdout** 的启动 token；桥接通过捕获文件读取 token 并建立本机 API 连接。**它是可重放的 bearer 凭据，不是一次性口令**：实测同一 token 连续两次 `/connect` 会各自签发出**不同**且都有效的 owner cookie，直到实例重启才失效——所以捕获文件的可读性就是这台机器上 dsh 实例的权限边界（见"安全与使用边界"）。相关实现与协议细节见 [docs/API-CONTRACT.md](docs/API-CONTRACT.md)。

## 快速开始

### 1. 安装并检查

前提：已安装并能运行 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)，本机有 Node.js **≥ 18.14**（需要 `headers.getSetCookie()`）。

```bash
git clone https://github.com/controlledentropy/dsh-bridge.git
cd dsh-bridge
npm install
npm test                    # 离线契约及 MCP 子进程测试；不启动 dsh web，不消耗模型额度
node launch.mjs resolve     # 确认 Node / dsh 路径和版本
node launch.mjs check       # 预检版本和 profile；不启动 dsh web 服务
```

>`npm install` 需要正常获取 npm 依赖；`npm test` 会运行测试子进程，但不需要连接 `dsh web` 或消耗模型额度。`node launch.mjs check` **会启动一次短生命周期的 `dsh --profile web --dump-config` 命令**（默认最多等待 25 秒），但不会启动 web 服务；一小时内命中 `check.json` 缓存时可跳过该检查。

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

### 回传什么、不回传什么

桥是**拉取式**的：dsh 执行过程中不向调用方推任何东西，Codex/客户端只在调用工具时读回一份摘要。既然每个字节都要花调用方模型的上下文，默认形状被压到"裁决 + 交付物"：

| 调用 | 默认返回 | 实测体积（真实 1084 事件轮） |
| --- | --- | --- |
| `dsh_wait` / `dsh_status` | 只回裁决块：`state / settled / verdictComplete / pending / waitingOnHuman / asked / error / note` + 心跳级标识 | 178 B（旧版 9974 B） |
| `dsh_result` `only:"final"`（默认） | 最终一条助手文本 + 裁决 + 错误码 + `touchedFiles` + `taskRef` | ~3.5 KB（旧版 16567 B） |
| `dsh_result` `only:"full"` | 本轮**非空**助手文本（旧消息按 `maxTextBytes` 让位，末条只截不丢）+ 工具明细 | 10982 B / 12 条（旧版 138 条里 126 条是空文本） |
| `detail:true` | 上面所有字段的完整形态（window、tokenUsage、tool 尾、turnOutline…） | 按需 |

固定开销一侧要诚实说明：工具定义 + `instructions` 每次会话都被注入，实测 **7776 B**。新增的 `supersedes` / `force` / `detail` 参数带来了约 1.1 KB 的固定成本，换来的是"同一工单两个在途会话"这类事故在派发前就被挡住；单次往返的成本则降了一个数量级。

**超时语义（实测，勿凭直觉）**：客户端 `tool_timeout_sec` 越界只是**这一次 MCP 请求**被丢弃，dsh **继续执行到完成**（实测请求 6 s 超时、轮次 ~14 s 完成、日志里 `session/cancel` 零次）。因此超时后正确动作是**重新 `dsh_wait` 读**，不是重发——若同一别名仍有在跑的同文本轮次，`dsh_send` / `dsh_launch` 会直接拒绝，除非显式 `force:true`。


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

沙箱拒绝**不会**在服务端排队等待审批：它以 `isError` 的工具结果返回，dsh 把"可以提权重试"的提示写在正文里——但在无人值守的派单场景里没有人能点这个确认，那句提示等于不会兑现。因此 `sandboxDenials > 0` 的含义是"任务的写入范围超出了会话工作区"，正确处置是换 `cwd` 重开会话，而不是等待或重试。判定只认 `file access denied` / `escalation available` / `EPERM`：dsh 会给各种失败结果都追加 `File sandbox: <mode>.` 脚注，拿它当判据会把普通报错也算成拒绝（实测 8 条错误里只有 1 条是真拒绝）。

会话的写入边界就是它的 `cwd`。**"提到一个路径"和"要往那个路径写"是两件事**，桥接按路径附近的意图词分级（中文动词后置的写法也算，例如"在 X 里实现"）：只有判定为**写入**工作区外路径的派单会被拒绝下发（错误里列出这些路径），因为那一轮注定被沙箱拒绝、只会白烧额度；只读提及（工单正文在父仓、技能定义在 `~/.agents/skills`、工具在 `Program Files`）只在返回里告警。返回的 `outsideCwd` 是 `{ all, write, read }` 三档，`allowOutsideCwd: true` 越过 write 档。分级是启发式，判错时用这个参数显式放行即可。任务要改动别的仓库时，以那个仓库作为 `cwd` 建会话（侧边栏分栏跟随 `cwd`），不要在 A 工作区的会话里写 B 目录。

一轮可以横跨上千条事件，任何固定大小的窗口都是在猜本轮有多长，所以判决读取是**从本轮 baseline 起沿游标向前走（首页 24 条、之后每页 1000 条、上限 12 页）直到本轮自己的 `turn/end` 落进已读事件，再截断到该事件**：既不会把下一轮的 `completed` 当成本轮结论，也不会因为窗口够不到而把一个已完成的轮次读成 `idle`（即"什么都没发生"）。这两种翻车都实测过。字段各司其职，不要合并理解：`verdictComplete` **只表示本轮自己的 `turn/end` 已读到**（等于 `settled`，正常运行中一定是 `false`）；`windowTruncated:true` 表示**这次读取的快照没覆盖到判决**，此时 `state` 不是判决，要用 `dsh_result` 重读，**不要重发**——实测判决只差 1 个 seq 时旧版本说"派单没被接手"，而 `turn/start` 明明就在 seq 7，那句处方会让编排方重跑一轮已完成的工作。没有判决且本轮**连 `turn/start` 都没读到**时，回复才带 `turnStarted:false`，这才是"派单没被接手"。读页本身失败时不会谎称日志到了末尾，`note` 会直说"本轮什么都没被验证，重读"。曾经还有第三个字段 `logExhausted`，2026-10-19 审计后删掉：对未落定的轮次它恒等于 `!windowTruncated`（`asOfSeq > lastSeq` 与 `asOfSeq <= lastSeq` 互为反面），不携带任何信息，而它的名字承诺了"日志到此为止"——日志是边读边增长的，这个事实桥无法知道。`window.newestSeq` 只报截断后真正读到的位置。中止还会带 `abortReason`（实测 `user` 表示是人中止的，不是 dsh 自己放弃）。

**要求 `git commit` 的任务在 `workspace-write` 下结构性不可行**：git worktree 的索引与对象元数据位于主仓的 `.git/worktrees/<name>/`，在会话工作区之外，因此每次提交都会触发审批。派单里要提交，就必须要么下发前由人把会话提到 `danger-full-access`，要么让执行者只产出改动、提交由会话外的人做。

**`workspace-write` 不等于无人值守可用。** 实测：即便工作目录已授权，`pwsh` / git 这类操作仍会触发 dsh 的审批（`approval/asked`）并**停在人身上**，而 `session/list.running` 依然是 `true`，从外面看只是"跑得慢"。桥接因此把 `approvalPolicy` / `approvalAsked` / `approvals[]` / `pending[]`（尚无 `approval/decided` 的那些）一并返回，`dsh_wait` 一旦发现 `pending` 非空就立即返回而不是耗完窗口——继续等不会有人来点。要真正无人值守，会话需处于 `danger-full-access`（审批策略随之变 `never`）；派单前用 `dsh_status {alias}` 看 `approvalPolicy` 与 `unattended` 两个字段确认。

沙箱档位与提权痕迹用 `dsh_permissions` 只读查看：生效档位、`escalated`、`escalatedBy`、审批策略变化（实测一次人工提权会同时把 `approval/policy` 从 `ask` 改成 `never`）。**提权前后的两轮环境前提不同，不能互相取证。**

## MCP 工具一览

| 工具 | 主要参数 | 作用 |
| --- | --- | --- |
| `dsh_models` | 无 | 返回实时模型目录与允许清单的交集，包含默认模型、可路由 provider、加载失败信息，以及**每个模型自己声明的 `efforts` / `defaultEffort`**（例如 `qoder/qfmodel` 只有 `low/medium/xhigh`，没有 `max`；不声明的如实报 `null`）。选 `reasoningEffort` 前读它，不要用 `selectModel` 试探——那是写操作 |
| `dsh_permissions` | 可选 `alias` | **只读**查看沙箱面：dsh 提供的档位（`read-only` / `workspace-write` / `danger-full-access`）、实例默认档位；给了 `alias` 还会返回该会话的生效档位与变更史（`escalated`、`escalatedBy`、`approvals`）。**运行中的会话改不了沙箱档位**：dsh 随包方法表里没有 per-session 的档位写入口（`permissionPresets/set`、`session/setSandboxMode` 都不存在），只能在 dsh UI 里由人操作。`agentPresets/select` 存在但只对**首轮之前**的会话生效，`terminal/create` 的官方描述明示绕过 Agent 沙箱与审批——桥接刻意都不调用，理由见 [docs/REMOTE-SURFACE.md](docs/REMOTE-SURFACE.md) |
| `dsh_launch` | `alias`, `cwd`, `task`; 可选 `phase`, `group`, `dryRun`, `allowOutsideCwd`, `supersedes`, `model`, `reasoningEffort` | 新建命名会话、设置模型并提交第一轮；`dryRun` 只创建会话，不执行任务。任务被判定为**向工作区外写入**时在下发前拒绝，只读提及外部路径不拦。若账本里另有别名像在做同一件事（同 phase，或工单正文大段相同而 cwd 不同），返回 `siblingWarning`；换会话重发时传 `supersedes:<旧别名>` 把替代关系写进账本 |
| `dsh_send` | `alias`, `task`; 可选 `allowOutsideCwd`, `model`, `reasoningEffort` | 向同一会话提交下一轮（同一阶段返工用它，新阶段用新 `alias`）。若该别名已被 `supersedes` 取代，返回里会明说 `supersededBy` |
| `dsh_adopt` | `alias`, `sessionId`, `cwd`; 可选 `phase` 等 | 接管已存在的 `dsh web` 会话，不改变其分栏 |
| `dsh_wait` | `alias`; 可选 `maxSeconds`（≤ 45） | 在限定时间内等待本轮完成；返回本轮自己的判决（`state` / `verdictComplete`）。**本轮停在人身上时立即返回**（实测 50 ms）：审批看 `pending[]`，待人回答的提问看 `waitingOnHuman` / `asked[]`（含问题与选项） |
| `dsh_status` | `alias` | 返回本轮状态、模型、token 用量、上下文压力、待答问题，以及会话边界信息：`workingDirectory`、`sandbox`（如 `workspace-write`）、`agentPreset`、`approvalPolicy` / `unattended`（能否无人值守）、`sessionStats` |
| `dsh_result` | `alias`; 可选 `only`（`final`/`full`）、`maxTextBytes`、`messages`（首页事件数，≤ 1000）、`round` | 获取某一轮（默认最新一轮）的验收载荷：**该轮全部**助手文本、工具调用、落盘文件、`toolErrors[]`（含失败正文与错误码）、`sandboxDenials`、`window` / `windowTruncated` / `verdictComplete` / `turnStarted`（仅在还没有判决时才出现）。文本被预算裁短时用 `textsNote` 单独说明，**不会**顶掉 `note` 里那条"还没有判决，去重读"的动作指令。`messages` 只影响首页大小，不影响完整性 |
| `dsh_sessions` | 可选 `cwd` | 查看桥接持有的别名（含 `supersedes` / `supersededBy` 替代关系），以及本进程的审计日志状态 `logging`；传入 `cwd` 时额外查询该工作区的活会话 |
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
| `DSH_EXTRA_PATH` | 空 | 追加到**实例进程** PATH 前面的目录（分隔符拼接）。npm 全局 bin 目录已经自动补上；当 `pnpm`/`git` 装在别处、而 dsh 的 UI 要用它们时（安装插件、git 类操作），用这个变量指过去。取值以启动 `launch.mjs start` 的那个环境为准 |

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
- [ ] `DSH_BRIDGE_STATE`（含保留完整任务文本的 `sessions.json`）和 stdout 捕获文件只对授权用户可读；**Windows 上 `chmod` 不生效**，用 `node launch.mjs doctor` 读实际 ACL（`acl.foreignReaders`），必要时 `node launch.mjs lock-acl`。
- [ ] 同一状态目录由需要共享别名的客户端共同使用；不同环境使用不同状态目录。
- [ ] 同一个别名不会被两个客户端**同时派发**任务（一轮只应有一个在途 prompt）。账本每次写入都会"读—改—写—读回确认"，被并发覆盖时自动重试；**任何**写不进的情况（重试仍不确认，或盘本身报错 EACCES/ENOSPC/EPERM）都返回 `ledgerAtRisk:true` + `unrecordedRound{alias,requestId,sinceSeq}`，而不是一个不带句柄的裸错误（见 `docs/ORCHESTRATION.md` §8）——但**不要**把这当作可以并发派同一别名的许可。
- [ ] 所有下发任务使用可写、可回滚的工作区，并由调用方审查结果。
- [ ] 变更 `dsh` 版本、profile 或 MCP 配置后，重新运行预检和连通性验证。

**停止实例只看一件事：谁登记的。** `node launch.mjs stop` 只停止**本状态目录**的 `instance.json` 里登记的进程。两份源码树各有自己的 `.state`，从没启动过它的那一棵执行 `stop`，会明确告诉你"这里没有 instance.json"并给出**当前占用端口的 pid**——它不会替你猜着杀别人的进程。确认那个 pid 就是你的实例后，用 `node launch.mjs stop --pid <pid>` 显式停止；外部用别的方式管理的 `dsh web` 请照原方式停止。`node launch.mjs status` 会一次报出：状态目录、端口是否有人监听、我们登记的 pid 是否还活着、端口占用者是不是它。

**实例能做什么，取决于启动它的那个环境。** `dsh web` 一旦冷启动就活得比那个 shell 久，而 dsh 的 UI 之后是**拿着它自己的 PATH 去外部执行程序**的。实测踩过的坑：安装插件要 `pnpm`（dsh 自己的报错文案是 `pnpm was not found`），`pnpm` 装在 `%APPDATA%\npm`，交互式登录 shell 的 PATH 里有、而代理/Codex 侧那个 shell 里没有——于是这个实例看起来完全健康（`/api` 正常应答、任务正常跑完），只有装插件失败。现在 `launch.mjs` **显式拼子进程 PATH**（补上 npm 全局 bin 目录，可用 `DSH_EXTRA_PATH` 追加），并把实例实际能看到的 `node/npm/pnpm/git` 绝对路径记进 `instance.json`；`status`/`doctor` 会直接说"这个实例看不到 pnpm，装插件会失败"，以及怎么办。旧的 `instance.json` 里没有这项记录时会如实报 unknown，而不是报好。

## 测试与调试

### 日常运维命令

```bash
node launch.mjs resolve     # 解析 Node / dsh 入口 / 版本
node launch.mjs check       # 会运行一次 dsh CLI 配置检查；不启动 dsh web 服务
node launch.mjs doctor      # 体检：端口、token、鉴权、模型目录、实例可见的工具链、token 文件 ACL
node launch.mjs status      # 状态目录 / 端口监听 / 登记的 pid / 占用端口的 pid / 实例工具链
node launch.mjs start       # 已运行则连接，否则预检后启动，显式构造子进程环境并捕获 stdout
node launch.mjs stop        # 停止本状态目录登记的实例；不是自己起的就只报端口占用者
node launch.mjs stop --pid 12345   # 人工确认后的显式停止
```

### 契约测试与诊断工具

```bash
npm test                                  # 46 个离线测试：契约 / 远端面解析 / 账本存储 / 审计日志 / MCP 子进程
node tests/live-check.mjs                 # 已运行实例的只读复验（需能读取当前实例的启动 token）
node tools/remote-surface.mjs             # 从本机 dsh 包重新生成 docs/REMOTE-SURFACE.md（135 个可转发方法）
node tools/remote-surface.mjs --check     # 只比对：升级后方法表与文档是否漂移（退出码非 0 即漂移）
node tools/probe-api.mjs                  # 探查 /api 端点参数形状
node tools/probe-acp.mjs                  # 检查 ACP 接口
node tools/read-session-log.mjs <file>    # 解码多帧 zstd 会话日志
```

`npm test` 显式列出测试文件而不用 glob：`node --test` 对 glob 参数的支持随 Node 版本而异，而本包声明支持 Node 18+， glob 写法可能在受支持版本上直接找不到测试文件（**本机只有 Node 24，未在 Node 20 上实测**，列出文件名对两者都成立）。新增测试文件时记得同时加进 `package.json` 的 `scripts.test`。

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
| 一轮长时间 `running` 却毫无进展，或 `dsh_wait` 返回的 `pending` 非空 | 会话审批策略是 `ask`，某个操作停在人工确认上（实测 `pwsh` / git 会触发），而 `session/list.running` 仍是 `true` | 到 dsh UI 回答该审批，或把会话档位提到 `danger-full-access`（策略随之变 `never`）后重发；继续 `dsh_wait` 不会有人来点。派单前先看 `dsh_status` 的 `unattended` |
| 轮次卡住但 `pending` 是空的、也没有审批事件 | 执行者在等**人回答它的提问**：`ask_user_question` 经 `run_code` 走 PTC 分发，表现为未闭合的 `tool/ptc-dispatch-start`（实测 102 秒），不产生任何审批事件 | 看 `dsh_wait` 返回的 `waitingOnHuman` / `asked[]`（含问题与选项），由人去 UI 回答；或在任务包里显式禁止提问，让执行者按最保守解释继续 |
| `sandboxDenials > 0`、正文出现 `file access denied` / `EPERM` | 任务要写的目录在会话工作区之外 | 以目标目录为 `cwd` 重开会话；不要指望"提权重试"提示，无人值守时没人能批准 |
| `run_code` 报 `ENOENT …\undefined\temp\…` 或写 `%TEMP%` 报 `EPERM` | dsh 的 `run_code` 会清空进程环境，`os.tmpdir()` 因此拼出相对路径；写真实 TEMP 又被沙箱拒绝 | 任务包里显式规定临时文件写在会话工作区内的绝对路径 |
| 子进程"没有输出也没有退出码"（例如 git 明明装了） | 宿主环境 `PATHEXT` 不含 `.EXE`（打包应用的子进程环境可能不是注册表那份），PowerShell 会静默不启动 | `node launch.mjs doctor` 的 `env.problems` 会直接报出来；对比注册表 `Session Manager\Environment` 的值 |
| dsh 设置里 Agent presets 只剩两个 | `ptc` / `minimal` 需要 Developer tools 偏好开启，而该偏好被 profile 补丁写成了 `enabled: false` | 与桥接无关：`agentPresets/list` 仍返回全部档位；在 dsh 设置里打开 Developer tools，或删掉 `profiles/<p>/cordis.patch.yml` 里的 `ui-settings` 覆盖 |
| 任务里的 `git commit` 反复弹审批（工作目录已授权也一样） | git worktree 的索引与对象元数据在主仓 `.git/worktrees/<name>/`，位于会话工作区之外 | 派单前由人把会话提到 `danger-full-access`，或让执行者只产出改动、提交在会话外做；这不是桥能绕开的 |
| 派单被 `outside the session workspace` 拒绝，但你确定那些路径只是读 | 意图分级是启发式，中文写法多样，可能把只读引用判成写入 | 看返回里的 `outsideCwd.write` / `.read` 两档；确属误判就传 `allowOutsideCwd: true` 放行，不要改桥的规则 |
| 源码目录里出现 `.dsh-*-cache/logs/*.log` | 由桥接冷启动的 `dsh web` 会把插件缓存写进自己的启动目录，也就是桥接源码目录 | 与桥接逻辑无关，已在 `.gitignore` 中忽略、不要提交；介意就按"长期本地部署"一节让 `dsh web` 在别处启动，桥接只负责连接 |

## 安全与使用边界

- **token 等同于高权限凭据**：`dsh web` 的 owner cookie 不对每个方法再做独立授权。能读取 stdout 捕获文件的用户，可能取得对本机 `dsh` 实例的 owner 访问能力。不要提交、转发或共享这些文件。
- **保护状态目录及任务原文**：`.state/` 已在 `.gitignore` 中；`sessions.json` 会逐字保存每轮下发的完整任务文本，可能包含路径、需求细节或敏感信息。不要把整个 `.state/` 放在多人共享目录或同步盘中。
- **Windows 上 `chmod` 拦不住 token**：桥接会尝试 `chmod(0o600)`，但实测在 NTFS 上这是空操作（mode 仍是 `666`，文件的 ACE 直接继承所在目录），而捕获文件里那 43 字符的启动 token 就是整个实例的 bearer 凭据。真正的边界是 ACL：`node launch.mjs doctor` 会跑 `icacls` 并把"除当前用户/SYSTEM/Administrators 之外还能读它的主体"列进 `problems`；要收紧就显式执行 `node launch.mjs lock-acl`（它 `/inheritance:r` 后只授当前用户完全控制——会移除继承授权，所以不自动做）。POSIX 平台按 mode 位检查即可。
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
| `lib/remote-surface.mjs` | 解析 dsh 随包的 RPC 方法表（纯函数，可用 fixture 离线测） |
| `docs/REMOTE-SURFACE.md` | **生成物**：本机 dsh 会转发哪些方法，及其官方描述与名称摘要 |
| `tools/ledger-risk-probe.mjs` | **可重跑的取证工具**（仅 Windows，需活实例）：复制状态目录并对副本注入"账本写不进"，验证派发与读取两侧都仍带回轮次句柄、且读到的判决不被记账失败毁掉。不派发任何轮次，不消耗额度 |
| `tests/contract.test.mjs` | 离线契约回归测试 |

升级建议：

1. 记录当前 `dsh` 版本，备份 profile 和必要的本机状态。
2. 执行 `npm test`、`node launch.mjs check` 和 `node launch.mjs doctor`。`check` 会顺带比对**远端面漂移**：方法名摘要变了、或桥接调用的方法在这份 dsh 里不存在，都会进 `problems` 并给出 `node tools/remote-surface.mjs` 的重生成指令。
3. 跑 `node tools/remote-surface.mjs` 重新生成方法表，读一遍 `addedSinceDoc` / `removedSinceDoc`：**新增**意味着可能有新能力（也意味着旧文档里"做不到"的说法可能过期），**移除**意味着有工具会开始报错。
4. 若 `/api` 结构改变，按照 [docs/API-CONTRACT.md](docs/API-CONTRACT.md) 的重建步骤重新探查，以实际观测修订契约测试，再修改适配层。
5. 在隔离的测试工作区进行真实任务验证后，再恢复日常使用。

## 贡献与许可

欢迎提交 Issue 和 Pull Request。修改接口行为时，请先用实测结果更新 `tests/contract.test.mjs`，再修改实现；实际验证过的行为用 `MEASURED:` 标注。会启动子进程的测试应在 `finally` 中回收进程，避免测试失败后挂起。

提交前请检查 `git status` 与 `git diff --cached`，确认没有把 `.state/`、`node_modules/`、`*.out`、`*.ndjson` 等本机文件带入仓库，并确认 README 引用的 `docs/API-CONTRACT.md`、`docs/ORCHESTRATION.md` 和 `LICENSE` 已随仓库提交。

本项目基于 **MIT License** 发布，详见 [LICENSE](LICENSE)。
