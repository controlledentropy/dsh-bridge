# dsh-bridge

把本机的 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh web`）包装成一个 MCP stdio server，让 Codex、Claude Desktop、Cursor 这类 MCP 客户端可以直接创建会话、派发任务、读取结果。

桥接不改 `dsh`，也不往客户端里装插件：它只把 dsh 的本地 `/api` 封装成 11 个工具，并在本地维护一份"派发过什么"的账本。

```text
MCP client ──stdio──▶ dsh-bridge ──HTTP /api (127.0.0.1)──▶ dsh web ──▶ 会话 / 工具 / 工作区
```

## 环境要求

- Node.js ≥ 18.14（用到 `headers.getSetCookie()`）
- 已安装 `@deepseek-ai/dsh`（`npm i -g @deepseek-ai/dsh`）
- 在 dsh 0.2.1-rc.2 / Windows 11 / Node 24 上验证

dsh 的 `/api` 不是稳定公开契约。升级 dsh 之后请按下面的[升级检查](#升级检查)重新验证一遍。

## 安装

```bash
git clone https://github.com/controlledentropy/dsh-bridge.git
cd dsh-bridge
npm install
npm test

node launch.mjs resolve   # 检查 Node、dsh 入口与版本
node launch.mjs check     # 预检，不启动服务
```

### 配置 MCP 客户端

Codex（`~/.codex/config.toml`，路径换成本机绝对路径）：

```toml
[mcp_servers.dsh]
command = 'node'
args = ['C:\\path\\to\\dsh-bridge\\bridge.mjs']
startup_timeout_sec = 120
tool_timeout_sec = 180

[mcp_servers.dsh.env]
DSH_PORT = '3080'
DSH_BRIDGE_STATE = 'C:\\path\\to\\dsh-bridge\\.state'
```

其他客户端用同样的 `command` / `args` / `env` 三要素，JSON 里反斜杠写成 `\\`。

两点值得注意：

- 改过 `bridge.mjs` 或 MCP 配置后要**重启客户端**——stdio 子进程加载的是启动那一刻的代码。
- `tool_timeout_sec` 建议 ≥ 180：首次调用可能包含启动 `dsh web`（≤ 90 s）、等待模型目录加载（≤ 15 s）和内部等待（≤ 40 s）。

## 使用

`dsh web` 的生命周期由桥接自己管：端口空闲时它会冷启动一个实例，也可以提前用 `node launch.mjs start`（或 `start-dsh-web.ps1`）起好。一台机器跑一个实例就够了。

一轮典型调用：

```text
dsh_models → dsh_launch{alias,cwd,task} → dsh_wait{alias} 循环 → dsh_result{alias}
```

`alias` 是调用方起的名字，匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，对应会话 ID `dsh-<alias>`。`cwd` 必须是已存在的绝对路径，它就是该会话的写入边界。

### 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `dsh_models` | — | 当前可选模型，含每个模型自己声明的 `efforts` 与默认值 |
| `dsh_permissions` | `alias?` | 只读查看沙箱档位、生效档位与提权历史 |
| `dsh_launch` | `alias`, `cwd`, `task`, `phase?`, `group?`, `dryRun?`, `allowOutsideCwd?`, `supersedes?`, `force?`, `detail?`, `model?`, `reasoningEffort?` | 建会话并派发首轮 |
| `dsh_send` | `alias`, `task`, `allowOutsideCwd?`, `force?`, `model?`, `reasoningEffort?` | 向同一会话派发下一轮 |
| `dsh_adopt` | `alias`, `sessionId`, `cwd`, `phase?`, `model?`, `reasoningEffort?` | 接管一个已存在的会话 |
| `dsh_wait` | `alias`, `maxSeconds?`(1–45), `detail?` | 等待本轮结束；停在人身上时立即返回 |
| `dsh_status` | `alias`, `detail?` | 只看当前状态，立即返回 |
| `dsh_result` | `alias`, `only?`(`final`/`full`), `maxTextBytes?`, `round?`, `messages?` | 读取某一轮的产出 |
| `dsh_sessions` | `cwd?`, `detail?` | 列出本桥持有的别名 |
| `dsh_cancel` | `alias` | 取消当前轮（不影响进程） |
| `dsh_stop` | `pid?`, `dryRun?` | 停掉 dsh web 进程 |

`dsh_launch` / `dsh_send` 只返回一个简短的回执（状态、是否已结束、错误、下一步提示），完整产出用 `dsh_result` 读。需要诊断信息时加 `detail: true`。

### 停止实例

```bash
node launch.mjs stop              # 停掉本状态目录启动的实例
node launch.mjs stop --pid 1234   # 停掉别处启动、你确认过归属的实例
node launch.mjs restart
```

也可以调用 MCP 工具 `dsh_stop`（`dryRun: true` 只报告不动手）。

stop 会杀掉整棵进程树，因为 `dsh web` 会派生子进程，只杀父进程的话子进程还会占着端口。成功的判据是**端口真的空出来**，不是"信号发出去了"——返回里的 `stillListeningOnPort` 就是证据。桥接不会去杀一个自己没有归属证据的进程，那种情况它只把端口占用者报给你。

### 生命周期命令

| 命令 | 说明 |
| --- | --- |
| `node launch.mjs resolve` | 解析 Node、dsh 入口与版本 |
| `node launch.mjs check` | 版本、profile 组合、方法表漂移，不启动服务 |
| `node launch.mjs status` | 端口、登记的 pid、端口占用者、实例的工具链 |
| `node launch.mjs doctor` | 逐级体检，最后给出结论 |
| `node launch.mjs start` / `stop` / `restart` | 启动 / 停止 / 重启实例 |
| `node launch.mjs lock-acl` | 把 token 捕获文件的 ACL 收紧为仅当前用户（Windows） |

## 返回值

`state` 是唯一该据以分支的字段：

| state | 含义 |
| --- | --- |
| `completed` | 本轮正常结束（`turn/end.reason.kind == completed`） |
| `error` | 本轮以错误结束 |
| `running` | 仍在执行 |
| `idle` | 没有读到本轮的 `turn/end`，按**未验证**处理 |
| `aborted` | 被中止，`abortReason` 区分人工中止与 dsh 放弃 |

`accepted: true` 只表示受理，`session/list.running` 从 true 变 false 也不区分成功与失败。另外两条容易踩的：

- 客户端超时**不会**取消 dsh 的执行。超时后应该重读同一轮，而不是重发同一段工单——同别名有在途同文本轮次时，`dsh_send` 会直接拒绝，除非显式 `force: true`。
- `dsh_wait` 在发现本轮停在人工审批或待人回答的提问时会立即返回，而不是耗完整个等待窗口。看 `pending[]` 与 `waitingOnHuman` / `asked[]`。

## 配置

全部通过 MCP server 的环境变量传入。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HOST` / `DSH_PORT` | `127.0.0.1` / `3080` | 注意 `localhost` 与 `127.0.0.1` 的 cookie audience 不同，全程用同一种 |
| `DSH_BRIDGE_STATE` | `<包目录>/.state` | token 捕获、账本、审计日志、子进程工作目录 |
| `DSH_NO_SPAWN` | 空 | `1` = 不允许桥接自动启动 dsh web |
| `DSH_ATTACH_OUTFILE` | 空 | 从外部捕获文件读 token |
| `DSH_AUTO_GROUP` | 空 | `0` = 建会话时不自动分栏 |
| `DSH_NODE` / `DSH_PKG_DIR` | 自动探测 | 覆盖 Node 与 dsh 包目录 |
| `DSH_EXTRA_PATH` | 空 | 追加到实例进程 PATH 的目录 |
| `DSH_API_TIMEOUT_MS` | `15000` | 单次 `/api` 超时 |
| `DSH_POLL_MS` | `3000` | 轮询间隔 |
| `DSH_WATCH_MS` | `40000` | `dsh_launch` / `dsh_send` 的内部等待窗口 |
| `DSH_BOOT_TIMEOUT_MS` | `90000` | 等待实例就绪的上限 |
| `DSH_LOG_MAX_BYTES` | `2000000` | 审计日志滚动阈值 |
| `DSH_ALLOWED_MODELS` | 空（不限制） | `provider/model[:effort|effort][, ...]`，写错会在启动时失败 |
| `DSH_DEFAULT_MODEL` / `DSH_DEFAULT_EFFORT` | 空 | 调用方未指定时的默认值 |

模型策略在请求发出前判定，越权不会消耗额度。推理强度是否合法看 `dsh_models` 回显的模型声明。

## 状态目录与凭据

- `dsh web` 的启动 token 只出现在它的 stdout 里，是 bearer 凭据：同一个 token 可以多次换取有效 cookie，直到实例重启。**捕获文件的可读性就是这个实例在本机上的权限边界。**
- Windows 上 `chmod` 对 NTFS 无效，ACE 直接继承目录。`doctor` 会用 `icacls` 列出除本人、SYSTEM、Administrators 之外还能读的主体；要收紧就显式跑 `lock-acl`。
- `sessions.json` 逐字保存每轮下发的任务原文（可能含路径与需求细节），但不缓存助手输出——结果一律从 dsh 重新读取。按敏感文件对待，不要把 `.state/` 放到共享目录或同步盘。

## 已知限制

- **cwd 守卫只扫一种路径风格。** 会话 cwd 是盘符/UNC 路径时只认 Windows 绝对路径，是 posix 路径时只认 `/…`。相对路径、`file://` URL、以及 POSIX 上不带前导斜杠的写法都不在识别范围内。分级是启发式的，误判时用 `allowOutsideCwd: true` 放行。
- **`/api` 删不掉会话。** 方法表里没有 `session/delete`，`workspace/archiveSession` 之后 id 仍在列表里，只能由人在 UI 清理。
- **分栏在创建时确定**，接管已有会话不能改组。
- **运行中会话的沙箱档位不可编程修改**，提权是人的动作。
- **`ask_user_question` 不能直接调用**，它经 `run_code` 以 PTC 分发形式出现；桥接只能报告"停在人身上"，不能替人回答。
- **`workspace-write` 不等于无人值守可用。** 该档位下 `pwsh`、git 等操作仍会触发审批并停在那里，而 `running` 保持 true。要真正无人值守需要会话处于 `danger-full-access`。派单前用 `dsh_status` 看 `unattended`。
- **要求 `git commit` 的任务在 `workspace-write` 下不可行**：worktree 的索引与对象在主仓 `.git/worktrees/` 下，属会话工作区之外，每次提交都会弹审批。

## 开发

```bash
npm test                                  # 离线用例，不起服务、不联网、不耗额度
node tools/remote-surface.mjs --check     # 方法表漂移检查
node tests/live-check.mjs                 # 对运行中的实例做只读复验
```

测试是离线的：用 fixture 驱动判读逻辑，用 MCP 子进程方式跑拒绝路径。CI 只跑 Windows（Node 20 / 22），因为部分 fixture 与断言依赖 Windows 的路径与 PATHEXT 语义。

### 升级检查

升级 dsh 之后按顺序执行：

```bash
node launch.mjs check      # 版本与 profile
node launch.mjs doctor     # 端到端体检
npm test
node tools/remote-surface.mjs --check
node tests/live-check.mjs
```

最后确认 `DSH_ALLOWED_MODELS` 是否仍表达本意。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `bridge.mjs` | MCP 传输、工具注册、策略与账本装配 |
| `launch.mjs` | 解析、预检、启动、停止、子进程环境、token 与 ACL |
| `lib/api-contract.mjs` | `/api` 信封与判读逻辑（纯函数，离线可测） |
| `lib/ledger-store.mjs` | 账本：锁、写后确认、按 requestId 合并 |
| `lib/audit-log.mjs` | 审计日志与滚动 |
| `lib/alias-hygiene.mjs` | 别名相似度与 supersedes 关系 |
| `lib/remote-surface.mjs` | 解析 dsh 随包方法表 |
| `docs/HANDOFF.md` | **当前状态与下一任务入口（滚动覆盖，新会话从这里开始）** |
| `docs/` | 协议细节、编排规范、方法表（生成物）、证据日志 |

## 许可

MIT，见 [LICENSE](LICENSE)。
