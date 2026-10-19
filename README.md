# dsh-bridge

**MCP stdio server：让 MCP 客户端（Codex、Claude Desktop、Cursor 等）调用本机的 DeepSeek Harness（`dsh web`）。**

把 `@deepseek-ai/dsh` 的本机 `/api` 封装成 10 个工具：建会话、接管会话、派发任务、轮询判决、验收产物、留下可审计的任务记录。不修改 `dsh`，不在客户端里装插件。

- 已实机验证：`@deepseek-ai/dsh@0.2.1-rc.2`、Windows 11、Node.js 24。要求 Node.js **≥ 18.14**（`headers.getSetCookie()`）。
- CI：`.github/workflows/ci.yml`，Windows × Node 20/22，纯离线（不起 `dsh web`、不消耗模型额度）。
- `/api` 不是稳定公开契约。升级 `dsh` 后先跑[兼容性检查](#升级与兼容性检查)。

## 目录

- [它解决什么](#它解决什么)
- [接入](#接入)
- [生命周期命令](#生命周期命令)
- [工具一览](#工具一览)
- [返回契约](#返回契约)
- [状态与处置](#状态与处置)
- [写入边界与无人值守](#写入边界与无人值守)
- [配置](#配置)
- [状态目录与凭据](#状态目录与凭据)
- [代码结构](#代码结构)
- [验证与自测](#验证与自测)
- [已知限制](#已知限制)
- [排错](#排错)

## 它解决什么

一个客户端负责规划与验收，`dsh` 负责落地执行。三条硬约定：

1. **书面交接**：`task` 里写清目标、边界、验收判据、交付物路径。`dsh` 不继承客户端上下文。
2. **按轮验收**：`accepted: true` 只是受理。只有 `state: "completed"` 是本轮正常结束，且仍要抽查产物。
3. **先预检后调用**：别名格式、目录存在性、模型与推理强度策略在发出任何 `/api` 请求之前判定，越权与越界在派发前被拒绝。

```text
MCP client ──stdio──▶ dsh-bridge ──HTTP /api (127.0.0.1)──▶ dsh web ──▶ 会话 / 工具 / 工作区
```

## 接入

```bash
git clone https://github.com/controlledentropy/dsh-bridge.git
cd dsh-bridge && npm install && npm test
node launch.mjs resolve          # Node / dsh 入口 / 版本
node launch.mjs check            # 版本闸门 + profile 组合 + 方法表漂移，不启动服务
```

**Codex**（`~/.codex/config.toml`，路径换成本机绝对路径）：

```toml
[mcp_servers.dsh]
command = 'node'
args = ['C:\\absolute\\path\\to\\dsh-bridge\\bridge.mjs']
startup_timeout_sec = 120
tool_timeout_sec = 180

[mcp_servers.dsh.env]
DSH_PORT = '3080'
DSH_BRIDGE_STATE = 'C:\\absolute\\path\\to\\dsh-bridge\\.state'
```

**其他客户端**：同样的 `command` / `args` / `env` 三要素，JSON 里反斜杠写成 `\\`。

> 改过 `bridge.mjs` 或 MCP 配置后必须**重启客户端**：stdio 子进程加载的是启动那一刻的代码。
>
> `tool_timeout_sec` 建议 ≥ 180：首次调用可能串起 web 启动（≤ 90 s）、模型目录加载（≤ 15 s）、内部等待（≤ 40 s）。客户端超时**不会**取消 `dsh` 的执行——超时后先重读，不要重发。

启动 `dsh web` 有两种方式：`node launch.mjs start`（或 `powershell -File start-dsh-web.ps1`）由外部管理生命周期；或什么都不做，端口空闲时桥接自行冷启动。建议一台机器只跑一个实例。

## 生命周期命令

| 命令 | 作用 |
| --- | --- |
| `node launch.mjs resolve` | 解析 Node、dsh 入口与版本 |
| `node launch.mjs check` | 版本闸门、profile 组合、方法表漂移；1 小时内复用 `check.json` |
| `node launch.mjs status` | 状态目录、端口监听、登记的 pid、端口占用者、实例可见的工具链 |
| `node launch.mjs doctor` | 逐级体检：路径 → 版本 → profile → 端口 → token → cookie → 模型目录 → 实例工具链 → token 文件 ACL |
| `node launch.mjs start` | 已运行则连接；否则预检后启动，并**显式构造子进程环境** |
| `node launch.mjs stop` | 停止**本状态目录**登记的实例；不是自己起的就只报端口占用者，不猜着杀 |
| `node launch.mjs stop --pid <n>` | 人工确认归属后的显式停止 |
| `node launch.mjs lock-acl` | 把 token 捕获文件的 ACL 收紧为仅当前用户（会移除继承授权，故不自动执行） |

`stop` 只看 `instance.json` 里有没有我们登记的 pid。**源码树与状态目录成对**：从没启动过它的那棵树执行 `stop`，会得到"这里没有 instance.json"以及端口占用者的 pid。

## 工具一览

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `dsh_models` | 无 | 实时目录 ∩ `DSH_ALLOWED_MODELS`，含默认模型、`routableProviders`、`failures`，以及**每个模型自己声明的** `efforts` / `defaultEffort`（未声明报 `null`） |
| `dsh_permissions` | `alias?` | 只读查看沙箱档位、生效档位与提权史（`escalated` / `escalatedBy` / 审批策略变化） |
| `dsh_launch` | `alias`, `cwd`, `task`, `phase?`, `group?`, `dryRun?`, `allowOutsideCwd?`, `supersedes?`, `force?`, `detail?`, `model?`, `reasoningEffort?` | 建会话并派发首轮；`dryRun` 只建会话不派发；自动落到该路径的侧边栏分栏（`group:false` 留 Ungrouped）；疑似重复劳动返回 `siblingWarning` |
| `dsh_send` | `alias`, `task`, `allowOutsideCwd?`, `force?`, `model?`, `reasoningEffort?` | 同一会话的下一轮（返工用同一别名，新阶段用新别名） |
| `dsh_adopt` | `alias`, `sessionId`, `cwd`, `phase?`, `model?`, `reasoningEffort?` | 接管已存在的会话（含人在 UI 里开的），不派发任何东西；不能替它改分栏 |
| `dsh_wait` | `alias`, `maxSeconds?`(1–45, 默认 40), `detail?` | 轮询到本轮落定；**停在人身上时立即返回** |
| `dsh_status` | `alias`, `detail?` | 心跳与能否无人值守：默认 `ok / alias / round / requestId / unattended` + 裁决块。档位、审批策略、模型、token 用量、window、plan、待答问题、工具尾**都要 `detail:true`** 才回 |
| `dsh_result` | `alias`, `only?`(`final`默认/`full`), `maxTextBytes?`(2 KB–200 KB, 默认 24 KB), `round?`, `messages?`(1–1000, 默认 24) | 验收载荷：助手文本、`toolCalls`、`toolErrors[]`、`touchedFiles`、`sandboxDenials`、`window`。`round:N` 审历史轮次 |
| `dsh_sessions` | `cwd?`, `detail?` | 本桥持有的别名（含 `supersedes`/`supersededBy`）；给了 `cwd` 才查该工作区的活会话 |
| `dsh_cancel` | `alias` | 请求取消当前轮。`accepted` 只是受理，需再 `dsh_wait` 确认落到 `aborted`/`idle` |

标识约定：`alias` 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，会话 ID 为 `dsh-<alias>`；`cwd` 必须是**已存在的绝对路径**（Windows 用反斜杠，桥接会统一分隔符）。

一轮标准动作：

```text
dsh_models → dsh_launch{alias,cwd,task} → dsh_wait{alias} 循环 → dsh_result{alias} →（需要时）dsh_status{alias,detail:true}
```

## 返回契约

桥是**拉取式**的：`dsh` 执行期间不向客户端推送任何内容。默认返回只含"分支所需 + 交付物"，诊断信息一律 `detail:true` 才给。下面这组数字是对**同一个真实轮次**现测的（约 320 个事件、8 次工具调用、8 条非空助手文本、已结束），换轮次请用 `node tools/measure-reply-sizes.mjs <alias>` 重测，别引用文档里的旧值：

| 调用 | 字节 |
| --- | --- |
| `dsh_status` 默认 | 153 B |
| `dsh_status` `detail:true` | 9789 B |
| `dsh_wait` 默认 | 150 B |
| `dsh_result` `only:"final"` | 4110 B |
| `dsh_result` `only:"full"`（预算 200 KB） | 9899 B |
| 工具定义 + `instructions`（每次会话固定注入） | 7797 B |

可变的一侧压到 ~150 B，不可变的一侧是每次会话都要付的 7797 B——新增参数（`supersedes` / `force` / `detail`）就记在这里，别把它当成免费。

| 字段 | 出现条件 | 含义 |
| --- | --- | --- |
| `state` | 总是 | `completed` / `error` / `running` / `idle`（中止时为 `aborted`） |
| `settled` / `verdictComplete` | 总是 | 本轮自己的 `turn/end` 是否已在手。二者等价；正常执行中恒为 `false` |
| `windowTruncated` | 仅当还没有判决 | 本次读取的快照没覆盖到判决 → **重读，不要重发** |
| `turnStarted` | 仅当还没有判决且为 `false` | 本轮没记录任何 `turn/start`，即派单未被接手 |
| `pending[]` | 非空时 | 未回答的审批（`approval/asked` 无对应 `approval/decided`） |
| `waitingOnHuman` / `asked[]` | 真值时 | 执行者在等人回答提问（`ask_user_question` 经 `run_code` 走 PTC 分发，不产生审批事件） |
| `note` | 有下一步动作时 | 该动作本身（重读 / 去 UI 回答 / 视为未验证）。文本预算裁剪不写这里 |
| `textsNote` | 文本被预算裁短时 | 只说明裁剪了多少条，不覆盖 `note` |
| `abortReason` | 中止时 | `{kind:"aborted",reason:{kind:"user"}}`，可区分人工中止与 dsh 放弃 |
| `taskRef` | `dsh_result` | `{bytes, sha256-16}`：任务原文由调用方写的，不再回传全文 |
| `correlated` | 派发/读取 | `false` = 本轮 baseline 是按快照推断而非按 `requestId` 关联，验收需叠加文件级证据 |

判决读取是**游标向前walk**（首页 24 条、之后每页 1000 条、上限 12 页）直到本轮自己的 `turn/end`，再截断到该事件；`window.newestSeq` 只报截断后真正交回的位置。

账本写不进时不静默：`ledgerAtRisk:true` + `ledgerNote` + `unrecordedRound{alias,requestId,sinceSeq}`。派发类调用带回句柄（prompt 已发出，句柄是唯一副本）；读取类调用保留已读到的结论，只说明账本那一格旧了。

## 状态与处置

| `state` | 含义 | 动作 |
| --- | --- | --- |
| `completed` | 本轮 `turn/end.reason.kind == completed` | 读 `dsh_result`，抽查文件与命令输出 |
| `error` | 本轮以错误结束 | 原样上报 `error.code` / `error.message`，不要静默换模型重跑 |
| `running` | 仍在执行 | 继续 `dsh_wait`（单次 ≤ 45 s） |
| `idle` | 本轮没有可确认的 turn | 视为**未验证**，绝不能报完成 |

`session/list.running` 由 `true` 变 `false` **不能**区分成功与失败。客户端超时也不代表任务被取消：重读同一轮，而不是重发同一段工单（同别名有在途同文本轮次时，`dsh_send`/`dsh_launch` 会直接拒绝，除非 `force:true`）。

## 写入边界与无人值守

- **会话的写入边界就是它的 `cwd`。** 要改哪个仓库，就以那个仓库为 `cwd` 建会话。
- 桥接只拦**判定为写入工作区外**的派单，判定读的是路径所在那一句（含"在 X 里改"这类动词后置中文），结果分两档返回：`outsideCwd.write`（拒绝下发，因为那一轮注定被沙箱拒、白烧额度）与 `outsideCwd.read`（只告警）。显式只读标注优先；`禁止覆盖 X` 按否定处理。分级是启发式，误判时用 `allowOutsideCwd: true` 放行，不要改规则。
- **`workspace-write` ≠ 无人值守可用。** 该档位下 `pwsh` / git 等操作仍会发 `approval/asked` 并停在人身上，而 `running` 保持 `true`，从外面看只是"跑得慢"。`dsh_wait` 发现 `pending` 或提问等待会立刻返回。要真正无人值守需会话处于 `danger-full-access`（审批策略随之变 `never`）。派单前用 `dsh_status` 看 `approvalPolicy` 与 `unattended`。
- **提权前后不是同一个环境前提**，两轮的结论不能互相取证。运行中的会话无法通过 `/api` 改档位：dsh 随包方法表里没有 per-session 档位写入口，只能由人在 UI 操作。
- **要求 `git commit` 的任务在 `workspace-write` 下结构性不可行**：worktree 的索引与对象在主仓 `.git/worktrees/<name>/`，属会话工作区之外，每次提交都会弹审批。要么下发前由人提档，要么执行者只产出改动、提交在会话外做。

## 配置

全部通过 MCP server 的环境变量传入，未用的保持默认。

**连接与运行**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HOST` / `DSH_PORT` | `127.0.0.1` / `3080` | `localhost` 与 `127.0.0.1` 的 cookie audience 不同，全程统一一种 |
| `DSH_BRIDGE_STATE` | `<包目录>/.state` | token 捕获、`instance.json`、会话账本、审计日志、子进程工作目录 `run/` |
| `DSH_ATTACH_OUTFILE` | 空 | 从外部捕获文件读 token；**不**隐含禁止自动启动，禁止请另设 `DSH_NO_SPAWN=1` |
| `DSH_NO_SPAWN` | 空 | `1` = 禁止桥接自动启动 `dsh web` |
| `DSH_AUTO_GROUP` | 空 | `0` = 默认不自动分栏（单次调用仍可用 `group:false`） |
| `DSH_NODE` / `DSH_PKG_DIR` | 自动探测 | 覆盖 Node 可执行文件与 `@deepseek-ai/dsh` 包目录 |
| `DSH_EXTRA_PATH` | 空 | 追加到**实例进程** PATH 之前的目录。npm 全局 bin 与所用 Node 所在目录已自动补入 |
| `DSH_API_TIMEOUT_MS` | `15000` | 单次 `/api` 超时，超时重试一次 |
| `DSH_POLL_MS` | `3000` | 轮询间隔 |
| `DSH_WATCH_MS` | `40000` | `dsh_launch` / `dsh_send` 内部等待窗口，应小于客户端工具超时 |
| `DSH_CATALOG_WAIT_MS` | `15000` | 等待 provider 进入模型目录的上限 |
| `DSH_BOOT_TIMEOUT_MS` | `90000` | 等待 `dsh web` 就绪的上限 |
| `DSH_CHECK_TIMEOUT_MS` | `25000` | `--dump-config` 预检超时 |
| `DSH_LOG_MAX_BYTES` | `2000000` | 审计日志滚动阈值，保留一份 `.1` |
| `DSH_TESTED_VERSION` | `0.2.1-rc.2` | 版本闸门，不一致时报漂移 |

**模型策略**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_ALLOWED_MODELS` | 空（不限制） | `provider/model[:effort|effort][, ...]`；解析不出任何条目视为写错，启动即失败而不是放行一切 |
| `DSH_DEFAULT_MODEL` / `DSH_DEFAULT_EFFORT` | 空 | 调用方未指定时使用；与允许清单冲突会明确报错 |

策略在请求发出前判定，越权不会烧额度。推理强度是否合法由 `dsh_models` 回显的**该模型声明**决定，不要用 `session/selectModel` 试探——那是写操作。

## 状态目录与凭据

- **token 是 bearer 凭据，可重放**：`dsh web` 的启动 token 只出现在它的 stdout；同一个 token 多次 `/connect` 会各自签发有效 cookie，直到实例重启。所以**捕获文件的可读性就是这台机器上该实例的权限边界**。
- **Windows 上 `chmod` 拦不住它**：`chmod(0o600)` 在 NTFS 是空操作，ACE 直接继承目录。`doctor` 会跑 `icacls` 并把"除本人/SYSTEM/Administrators 之外还能读的主体"列进 `problems`；要收紧就显式 `lock-acl`。
- **账本按敏感文件对待**：`sessions.json` 逐字保存每轮下发的任务原文（路径、需求细节），但**不缓存助手输出或结果**——结果一律从 `dsh` 重读。写入是"锁 + 临时文件 + rename + 读回确认"。
- 别把 `.state/` 放进多人共享目录或同步盘；`dsh_sessions` 的 `logging` 与本进程的审计状态可在 `detail:true` 里看到。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `bridge.mjs` | MCP 传输、10 个工具、策略与账本装配 |
| `launch.mjs` | 解析/预检/启动/停止、子进程环境、token 与 ACL |
| `lib/api-contract.mjs` | `/api` 信封与**判读逻辑**（纯函数，离线可测） |
| `lib/ledger-store.mjs` | 账本：锁、写后确认、按 `requestId` 合并轮次 |
| `lib/audit-log.mjs` | 审计日志与滚动竞态处理 |
| `lib/alias-hygiene.mjs` | 别名相似度与 `supersedes` 关系 |
| `lib/remote-surface.mjs` | 解析 dsh 随包方法表 |
| `docs/API-CONTRACT.md` | 协议细节与重建步骤（升级后按它复测） |
| `docs/ORCHESTRATION.md` | 编排方操作规范 |
| `docs/REMOTE-SURFACE.md` | **生成物**：网关会转发的 135 个方法与桥接用到的子集 |
| `tests/*.test.mjs` | 离线回归（含以 MCP 子进程方式跑的拒绝路径） |
| `tools/` | 方法表生成与校验、账本故障注入取证、回传体积复测 |

## 验证与自测

```bash
npm test                                  # 70 个离线用例，不起服务、不联网、不耗额度
node tests/live-check.mjs                 # 对运行中的实例做只读复验（需能读到它的 token）
node tools/remote-surface.mjs             # 重新生成方法表文档
node tools/remote-surface.mjs --check     # 只比对漂移，非 0 即有新增/移除
node tools/ledger-risk-probe.mjs --from .state --alias <有别名的轮次>   # 账本写不进的取证（只读，不派发）
node tools/measure-reply-sizes.mjs <alias>                              # 复测回传体积，验证"默认形状仍然小"
```

`live-check` 的 `--adopt` / `--create` / `--dispatch` 是**有副作用**的：会接管、建会话或真跑一轮，只在可回收的测试工作区使用。

升级 `dsh` 之后按序执行：`check` → `doctor` → `npm test` → `remote-surface --check` → `live-check`，然后**重新确认 `DSH_ALLOWED_MODELS` 是否仍表达你的本意**（修好一个配置缺陷可能顺带扩大可选模型集）。

## 已知限制

- **cwd 守卫只识别盘符路径。** posix 绝对路径（`/etc/x` 一类）不在识别范围内，因此 Linux/macOS 上"越界写"不会被预检拦下（沙箱仍会拒，只是要烧一轮才知道）。这是未做的功能，不是配置项。
- **`/api` 删不掉会话。** 方法表里没有 `session/delete` / `session/archive`；`workspace/archiveSession` 可用但 id 仍留在列表里。测试留下的空会话只能由人在 UI 清理。
- **分栏只能在创建时确定**，接管已有会话不能改组。
- **运行中会话的沙箱档位不可编程修改**，提权是人的动作。
- **`ask_user_question` 不能直接调用**，它经 `run_code` 以 PTC 分发形式出现；桥接只能报"停在人身上"，不能替人回答。
- 客户端超时不等于任务取消；`accepted` 不等于完成。

## 排错

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `no launch token in …` | 当前实例的 stdout 没被这个状态目录捕获 | 用 `start-dsh-web.ps1` / `launch.mjs start`，或设 `DSH_ATTACH_OUTFILE` 指向真正的捕获文件 |
| `/connect -> HTTP … with no auth cookie` | token 属于旧实例，或端口写错（`localhost` vs `127.0.0.1`） | `doctor` 看 STALE 提示与端口 |
| `did not activate` / profile 报错 | profile 里有当前版本不接受的配置键 | 先备份 profile，再按 `check` 的原文错误修改（不要凭猜改） |
| `UNKNOWN_MODEL` / `session/model-unavailable` | provider/模型/强度不可用 | 查 `dsh_models` 的 `routableProviders` 与 `failures`；桥接已在派发前等过目录热加载 |
| 长时间 `running` 无进展、`pending` 非空 | 停在人工审批 | 去 UI 回答，或由人提档 `danger-full-access` 后重发；继续等不会有人来点 |
| 轮次卡住但 `pending` 为空 | 等人回答提问（PTC 分发未闭合） | 看 `waitingOnHuman` / `asked[]`，或把"不许中途提问"写进任务包 |
| `sandboxDenials > 0` | 任务要写目录在工作区外 | 以目标目录为 `cwd` 重开会话 |
| `outside the session workspace` 但你确定只是读 | 启发式误判 | 看 `outsideCwd.write/.read`，确属误判传 `allowOutsideCwd: true` |
| 返回 `idle` | 本轮没有可确认的 turn | 按未验证处理，别报完成 |
| 源码树里出现 `.dsh-*-cache/logs/*.log` | 被桥接冷启动的 `dsh web` 把插件缓存写进它的启动目录 | 已被 `.gitignore` 忽略；介意就改为外部启动 + 桥接只连接 |

## 许可

MIT，见 [LICENSE](LICENSE)。修改接口行为时，先让 `tests/` 里的用例描述事实，再改实现；注释里的 `MEASURED:` 指由实际调用得出的结论。
