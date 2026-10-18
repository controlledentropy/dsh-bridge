# dsh-bridge

让 MCP 客户端（Codex、Claude Desktop、Cursor 等任何标准 MCP client）驱动本机 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 的 `dsh web` 会话：创建或接管命名会话、下发任务清单、异步轮询、按轮取回可审计的执行结果。

`dsh web` 自带一个本机 `/api`，但没有 MCP 接口；`dsh` 也不需要在 Codex 里装插件。这个仓库补的就是中间那一层：**一个 stdio MCP server，把 `/api` 翻译成 9 个 agent 好用的工具**。

验证环境：`@deepseek-ai/dsh@0.2.1-rc.2`、Windows 11、Node 24。接口约定与被版本升级打断后的重建步骤见 [docs/API-CONTRACT.md](docs/API-CONTRACT.md)。

## 为什么需要它

把 `dsh` 当成**第二个执行工位**而不是自己的子上下文：它不共享你的对话历史，只看到你写给它的那段任务文本；它是异步的，"已接受"不等于"已完成"；它改的是它自己工作区里的文件。所以这个桥接把三件事固化成接口：

1. **书面交接**：任务必须以清单形式下发（目标 / 边界 / 验收标准 / 交付物）。
2. **可复核的完成判据**：只有 `state:"completed"` 算完成，见 [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md)。
3. **边界约束**：可选模型集合由配置预先限定，越权请求在下发之前就被拒绝。

## 安装

要求 Node **>= 18.14**（`headers.getSetCookie()`）。

```bash
git clone <this-repo>
cd dsh-bridge
npm install
npm test                 # 离线契约测试：无需 dsh、无网络、不消耗任何额度
```

## 接到 MCP 客户端

以 Codex 为例，写入 `~/.codex/config.toml`：

```toml
[mcp_servers.dsh]
command = 'node'
args = ['/absolute/path/to/dsh-bridge/bridge.mjs']
startup_timeout_sec = 60     # 桥接可能会自己拉起 dsh web，冷启动约 10s
tool_timeout_sec = 45        # 与 dsh_wait 的 maxSeconds 对齐

[mcp_servers.dsh.env]
DSH_PORT = '3080'
DSH_BRIDGE_STATE = '/absolute/path/to/dsh-bridge/.state'
```

Claude Desktop 等设备上同一段配置的 JSON 形式（`mcpServers.dsh.command/args/env`）即可。

**改完 `bridge.mjs` 要重启客户端**：MCP 子进程加载的是启动时的代码，编辑不会热更新。

## 先让 dsh web 跑起来

桥接需要一次性启动 token，而它**只出现在 `dsh web` 的 stdout**，不落进 dsh 自己的任何文件。两种做法：

```bash
# A. 人工启动，并把 stdout 落到桥接读得到的位置（生命周期自己掌握）
powershell -File start-dsh-web.ps1

# B. 什么都不做：端口空闲时桥接会自己启动实例，stdout 写到同一个捕获文件
```

`DSH_BRIDGE_STATE` 目录下的 `dsh-web.out` 是唯一的 token 来源，`.state/` 已在 `.gitignore` 里。

拓扑上**建议只跑一个 `dsh web` 实例**：两个实例并发写同一个 `~/.dsh/storages/workspace.json` 的行为未经验证。

## 一轮标准动作

```text
dsh_models                       # 需要指定模型时先看它：只列被策略允许的选项
dsh_sessions {cwd}               # 该工作区已有哪些会话
dsh_launch  {alias, cwd, task}   # 新阶段 → 新别名，立即返回句柄
   或 dsh_send {alias, task}     # 同一阶段追加一轮（复用同一会话）
dsh_wait   {alias, maxSeconds: 45}   # 反复调用直到落定
dsh_result {alias}               # 验收载荷：助手文本 + 产生它的工具调用 + 落盘文件
dsh_status {alias}               # 模型、token 用量、上下文压力、待答问题
dsh_cancel {alias}               # 取消在跑的一轮
dsh_adopt  {alias, sessionId, cwd}   # 接管 web UI 里已经开着的会话
```

`state` 只有四个取值：

| 值 | 含义 | 该怎么处理 |
|---|---|---|
| `completed` | 本轮 `turn/end.reason.kind == completed` | 可以验收，仍建议抽查产物 |
| `error` | 本轮以错误结束，真因在 `error.{code,message}` | 原文上报，不要静默换模型重跑 |
| `running` | 还在跑 | 继续 `dsh_wait`，不要拉长单次调用 |
| `idle` | 任务已被接受，但本轮没有记录任何 turn | **按"未验证"处理**，不能报完成 |

两个反复出现的陷阱已经做进实现里：`session/prompt` 返回的 `accepted:true` 只是受理；`session/list.running` 由 true 变 false 不区分成败。

## 工具参考

| 工具 | 参数 | 说明 |
|---|---|---|
| `dsh_models` | — | 实时模型目录 ∩ 允许清单，含 default / routableProviders / failures。不发模型请求 |
| `dsh_launch` | `alias, cwd, task, phase?, group?, dryRun?, model?, reasoningEffort?` | 建会话（默认落进该路径对应的侧边栏分栏）、pin 模型、下发首轮。`dryRun` 只建会话不发任务 |
| `dsh_send` | `alias, task, model?, reasoningEffort?` | 同一会话的下一轮 |
| `dsh_adopt` | `alias, sessionId, cwd, phase?, ...` | 接管已存在的会话；**不能改它所在的分栏** |
| `dsh_wait` | `alias, maxSeconds<=45` | 盯到本轮落定或时间窗结束 |
| `dsh_status` | `alias` | 立即快照，含 token 用量与上下文压力 |
| `dsh_result` | `alias, messages<=40` | 本轮验收载荷（默认只看本轮） |
| `dsh_sessions` | `cwd?` | 列出桥接拥有的别名；给了 `cwd` 才返回该工作区的活会话（全量列表有 90+ 条） |
| `dsh_cancel` | `alias` | 请求取消，返回 `{accepted}`；结果要用 `dsh_wait` 复查 |

别名规则：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，会话 id 是 `dsh-<alias>`。`cwd` 必须是**存在的绝对路径**；Windows 上桥接会把正斜杠统一成反斜杠，因为 dsh 逐字登记路径，`C:/x` 与 `C:\x` 会被当成两个工作区。

## 模型策略

模型可选集合由配置预先约束，桥接是唯一同时看得见"调用方要什么"和"dsh 允许什么"的位置。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_ALLOWED_MODELS` | 空＝不限制 | 文法 `provider/model[:effort\|effort][, ...]`。**写了但解析不出条目会在启动时直接失败**，不会退化成全部拒绝或全部放行 |
| `DSH_DEFAULT_MODEL` | 空 | 调用方不传 `model` 时 pin 的 `provider/model` |
| `DSH_DEFAULT_EFFORT` | 空 | 与上一行配套的推理强度 |

行为要点：

- 校验是**纯预检**：别名、路径、模型、推理强度任何一项不合规，请求在发出任何 `/api` 调用之前就被拒绝 —— 不冷启动 dsh、不建会话、不写账本。
- 缺省值与允许清单冲突时，错误信息会标明冲突来自 `DSH_DEFAULT_MODEL/DSH_DEFAULT_EFFORT`，而不是让人误以为是调用方写错。
- 模型目录在 dsh 启动后异步加载。桥接在 pin 之前会等目标 provider 出现（这个等待不消耗额度），因此自启动路径不会因为目录尚未加载完成而空耗一轮。
- dsh 的目录条目**不声明**各模型支持哪些推理强度，所以强度合法性只能由 dsh 判定（非法值报 `session/model-unavailable`）。

## 其余环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOST` / `DSH_PORT` | `127.0.0.1` / `3080` | `localhost` 与 `127.0.0.1` 是两个不同的 audience，cookie 不通用，全程只用一种写法 |
| `DSH_BRIDGE_STATE` | `<包目录>/.state` | 会话账本、token 捕获、审计日志，以及 dsh 子进程的 cwd（`run/`，第三方插件的缓存会落在那里） |
| `DSH_ATTACH_OUTFILE` | 空 | 指向"已由别处捕获的 dsh web stdout"，进入 attach 模式，不再自己启动实例 |
| `DSH_API_TIMEOUT_MS` | `15000` | 单次 `/api` 调用上限，超时重试一次 |
| `DSH_POLL_MS` | `3000` | 轮询间隔 |
| `DSH_WATCH_MS` | `40000` | `dsh_launch`/`dsh_send` 内部盯轮时间，必须小于客户端的 `tool_timeout_sec` |
| `DSH_CATALOG_WAIT_MS` | `15000` | 等待 provider 进入模型目录的上限 |
| `DSH_BOOT_TIMEOUT_MS` | `90000` | 实例启动等待上限 |
| `DSH_LOG_MAX_BYTES` | `2000000` | 审计日志滚动阈值（保留一份 `.1`） |
| `DSH_NO_SPAWN` | 空 | `1` 时若端口无人监听就直接报错，绝不启动实例 |
| `DSH_AUTO_GROUP` | 空 | `0` 关闭自动分栏（单次调用也可传 `group:false`） |
| `DSH_NODE` / `DSH_PKG_DIR` | 自动探测 | 覆盖 node.exe 与 `@deepseek-ai/dsh` 的安装位置；CLI 入口读该包 `package.json` 的 `bin` 字段 |
| `DSH_TESTED_VERSION` | `0.2.1-rc.2` | 版本闸门，不一致时预检报警 |

## 会话账本

`DSH_BRIDGE_STATE/sessions.json` 记录每个别名的会话 id、工作区、分栏、每轮的 `requestId` 与基线序号。它是"下发过一次"的可审计记录，也是跨进程共享的：一个客户端会话会拉起很多短生命周期的桥接进程，因此写入走 `O_EXCL` 锁 + 临时文件 rename，持久化失败会抛出错误而不是静默。

- 账本按 `DSH_BRIDGE_STATE` 隔离：不同目录的别名互不可见。
- 只存句柄，不存执行结果 —— 审计载荷一律回 dsh 重新读取。
- 一个别名一个归属：并发写提供原子性，不提供跨进程的合并语义，同一别名不要并行发两轮。

## 侧边栏分栏

分栏由 workspace 的 `sessionIds` 成员关系决定，与 cwd 是两套独立机制：用 `cwd` 建的会话落在 Ungrouped，用 `workspaceId` 建的会进对应项目分栏且 cwd 不变。`workspace/create {path}` 是幂等的，因此兼作 path → workspaceId 的解析器，桥接据此自动分栏。

**分栏只能在创建时决定**：把已存在的会话移进 workspace 会被 dsh 拒绝（`the session is not accounted`）。`dsh_adopt` 因此只能接管，不能改组。

## 运维命令

```bash
node launch.mjs resolve    # 解析到哪个 node / dsh 入口 / 版本
node launch.mjs check      # 预检：不启动进程，验证版本一致与 profile 能否组合
node launch.mjs doctor     # 体检：解析 → 组合 → 端口 → token → 鉴权 → modelCatalog，并给出 broken 结论
node launch.mjs start      # 已在跑就 attach；没跑就预检后自启并捕获 stdout
node launch.mjs stop       # 只停 instance.json 里记录的 pid，不杀不属于自己的进程
```

## 测试与验证

```bash
npm test                    # 离线：契约 + MCP 子进程，20 个用例，零额度
node tests/live-check.mjs   # 对着活实例只读复验，不建会话、不消耗额度
node tools/probe-api.mjs    # 重新推导各端点的 args 形状（--mutate 才会建会话）
node tools/probe-acp.mjs    # ACP 面是否仍可用（--prompt 才会下发）
node tools/read-session-log.mjs <session.v4.jsonl.zstd>   # 多帧 zstd 会话日志解码
```

`live-check` 有三个显式开启的、有代价的步骤，被跳过的步骤不计入通过：

- `--adopt`：接管 `DSH_TEST_WS` 里一个空闲会话。不创建任何东西。
- `--create`：两个并发 `dryRun` 启动，验证共享账本在并发下的合并。**会留下会话，而 API 删不掉它们**（`session/delete` 未转发），只能在 dsh 界面归档。
- `--dispatch`：真实一轮任务，消耗模型额度，需要 `DSH_TEST_WS` 指向一个可随便写的目录。

代码注释里的 `MEASURED:` 标记表示该行为由实际执行验证过，而不是从文档推断。

`.github/workflows/ci.yml` 在 Linux 与 Windows、Node 20 与 22 上跑同一套离线用例，所以贡献者本地不需要 dsh 也能验证改动。

## 安全说明

- 捕获文件里的启动 token 换来的 cookie 是 **owner 权限**，dsh 对 owner 不做逐方法鉴权 —— 读到该文件等于读到那台机器上的 dsh。文件权限 `600`，目录已 gitignore。
- 桥接只访问 `127.0.0.1`，不外发数据；审计日志记录端点名与 HTTP 状态，不记录 token。
- `/api` 没有向后兼容承诺，因此每次 dsh 升级后先跑 `npm test`，再看 `docs/API-CONTRACT.md` 末节的重建步骤。
- 把外派任务交给另一个 agent 意味着它会在它的工作区里改文件。下发前确认 `cwd` 是可写的沙箱目录，验收时按 `docs/ORCHESTRATION.md` 抽查产物。

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `no launch token in …` | 端口上那个实例的 stdout 没被捕获到桥接能读的位置（不是 token 过期） | 用 `start-dsh-web.ps1`；或设 `DSH_ATTACH_OUTFILE`；或停掉它让桥接自启 |
| `/connect -> HTTP … with no auth cookie` | token 属于另一个实例（它被重启过），或端口不对 | `node launch.mjs doctor`，它会标出 `STALE: token belongs to a dead process` |
| `dsh web` 启动即失败，提示某插件 `did not activate` | profile patch 里有新版本拒绝的配置键 | `node launch.mjs check` 会在不启动进程的情况下复述 dsh 原文；改 profile 前先备份 |
| `EADDRINUSE` | 端口已被占用 | 查占用进程并停掉旧实例 |
| `state:"error"` + `UNKNOWN_MODEL` | 该 profile 没有这个 provider，或目录尚未加载完 | `dsh_models` 看 `routableProviders` 与 `failures` |
| 会话不在预期的侧边栏分栏 | 分栏在创建时决定，接管无法更改 | 用 `dsh_launch` 新建并让它自动分栏，或在 dsh 界面手工归组 |
| 客户端的 MCP 面板看不到工具列表 | 部分客户端不展示 tools | 调一次 `dsh_models`，看 `.state/bridge.log.jsonl` 是否出现 `ev:"tool"` |

## 版本支持策略

`launch.mjs`（进程与凭据）+ `lib/api-contract.mjs`（线上格式）是两条唯一路径，`bridge.mjs` 只做传输与工具。升级 dsh 时最多坏这两处，而 `tests/contract.test.mjs` 会第一时间变红。

支持的 dsh 版本记录在 `launch.mjs` 的 `DSH_TESTED_VERSION`。如果你的版本不同且 `/api` 应答异常，先跑 `docs/API-CONTRACT.md` 末节的命令重新推导契约，再决定是否需要改 `lib/api-contract.mjs`。

## 贡献方式

- 改动接口形状时，先让 `tests/contract.test.mjs` 反映实测结果，再改实现。
- 任何新增断言必须来自实际执行；注释里用 `MEASURED:` 标注，并避免写入与某台机器绑定的路径、进程号或账户名。
- 测试用例若拉起子进程，必须在 `finally` 里关闭 —— 否则断言失败会变成挂起，而不是失败。
- 提交前确认 `.state/`、`node_modules/`、任何 `*.out` / `*.ndjson` 捕获都没进入暂存区（`git status` 看一眼，`git diff --cached` 再核一遍）。

## 许可

MIT，见 [LICENSE](LICENSE)。
