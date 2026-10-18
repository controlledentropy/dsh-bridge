# dsh `/api` 契约（全部由实际执行验证，非文档转录）

dsh 处于 developer preview，`/api` **没有兼容性承诺**。这份文件的用途是：升级后照着它 10 分钟内重建证据，而不是相信旧断言。

对象：`@deepseek-ai/dsh` **0.2.1-rc.2**（`launch.mjs` 里 `DSH_TESTED_VERSION` 默认值即此）。线上格式的代码化镜像在 [../lib/api-contract.mjs](../lib/api-contract.mjs)，`tests/contract.test.mjs` 把它锁成回归测试。

## 鉴权（唯一入口）

| 步骤 | 事实 |
|---|---|
| 1 | `dsh web` 启动时把带 `?token=<43字符>` 的 URL **打印到 stdout**。token 每进程随机、只存内存、**不落任何 dsh 自己的文件**；进程重启即换 |
| 2 | `GET /connect?token=…&interactions=answer` → `302`（`location: ./api/remote.mux`）+ `Set-Cookie: dsh-auth-<base64url(sha256(authority))>=…` |
| 3 | 该 cookie = **owner principal**；owner **不受逐方法权限检查**（dsh 原文：The owner is never checked） |
| 4 | cookie 属性 host-only / `Path=/` / HttpOnly / SameSite=Strict，默认 **30 天**（`cookieMaxAgeDays`），签名密钥持久化在 `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session` → **跨进程重启仍有效** |
| 5 | 未带 cookie 的 `GET /` 与任何 `/api/*` 一律 **401**（实测；不是 404，别误判成"端点不存在"） |
| 6 | peer 的 socket 关闭后其 cookie 被拒 → 用**同一个 token** 再打一次 `/connect` 换新 cookie 即可恢复（桥接在 401 时自动这么做） |
| 7 | 不接受 `Authorization` 头；不存在 `DSH_WEB_PASSWORD`（全树 grep 0 命中，网上教程是讹传） |
| 8 | audience 含 authority：`127.0.0.1:3080` 与 `localhost:3080` 的 cookie **不通用**（cookie 名是 sha256(authority)）→ 端到端只用一种写法 |

## 信封与响应

```jsonc
// 请求
POST /api/<endpoint>
{ "type": "client-request", "rpcId": "<任意唯一串>", "method": "<endpoint>",
  "payload": { "args": { … } } }          // 注意是 args，不是裸参数

// 响应（rpcId 原样回显，可做请求配对）
{ "type": "server-response", "rpcId": "…",
  "result": { "ok": true,  "value": … }
          | { "ok": false, "error": { "code": "…", "message": "…", "details": {…} } } }
```

**参数包装的键名要靠网关的校验错误反推**（文档里没有）：形状不对会回 `gateway/arguments-invalid: … args fields do not match the descriptor: missing "request"` / `unexpected "sessionId"`；缺 `args` 层则回 `gateway/internal: Remote payload must contain exactly one plain-object args field`。**照错误改，两三次就能收敛**——这也是升级后重建契约的标准手法。

## 端点与参数形状（实测通过）

| 端点 | args | 返回/备注 |
|---|---|---|
| `session/list` | `{_request:{}}` | `value.items[]`：`sessionId,cwd,running,blank,updatedAt,projections`。**不带 cwd 过滤会返回全部工作区的会话**（验证环境里 90+ 条），务必按 cwd 过滤 |
| `session/create` | `{request:{sessionId, cwd}}` 或 `{request:{sessionId, workspaceId}}`（二者互斥） | `value:{sessionId,agentPreset}`。**`sessionId` 可自铸 → 这就是"命名会话"** |
| `session/prompt` | `{request:{requestId,sessionId,mode:"queue"\|"steer",content:[{type:"text",text}]}}` | `value:{accepted:true}` —— **只代表受理**。同一 `requestId` 重复提交会被幂等吞掉（重试必须换 id） |
| `session/projections` | `{request:{sessionId}}` | **载荷嵌在 `values` 里**：`{kind, asOfSeq, values:{title,goal,tokenUsage,contextPressure,contextBreakdown,inbox,sessionStats,turnOutline,agentPreset,userQuestions,workingDirectory,subagentCatalog,todos,plan,modelSelection,sessionListMetadata,imageLimits,permissions}}`。在顶层直接读 `plan`/`tokenUsage`/`permissions` 一律得到 `undefined`（本桥 2026-10-18 就是这么漏掉了沙箱模式与工具错误正文）。`asOfSeq` 确实在顶层。**对非本进程建的会话可能整段缺 `turnOutline`/`modelSelection`**；`sessionListMetadata` 只有 `{blank,lastPromptAt}`，**没有 `running`** |
| `session/page` | `{request:{address:{kind:"session",sessionId}, throughSeq, maxMessages}}` | `{records:[{type:"event",event:{type,seq,time,data}}],hasMore}`。**`throughSeq` 必须 ≤ 当前 `asOfSeq`**，否则 `gateway/bad-request: … past cursor <N>`（`lib` 的 `pastCursor()` 取 N 当修正游标，先读 `asOfSeq` 再翻页仍会与活会话抢跑）。**`maxMessages` 只是提示，不是上限**：实测要 12 条返回 74 条、要 14 条返回 84 条；要 1000 条则一次返回整份日志（1445 条、`hasMore:false`）→ 想拿全量就传大值，想省钱就靠 `throughSeq` 收窄范围 |
| `permissionPresets/catalog` | `{}` | `{options:[{value,name}],defaultOptions,defaultPreset}`。实测三档：`read-only` / `workspace-write` / `danger-full-access`，默认 `workspace-write` |
| `permissionPresets/set`、`permissionPresets/current`、`session/setSandboxMode` | — | **全部 404 "not found"（未转发）** → 运行中会话的沙箱档位**无法**经 `/api` 修改；`dsh-permission-presets` 的 `set(session,name)` 是进程内方法，只有 UI/同进程客户端能用 |
| `settings/mutate` | `{ns, ops}`（**裸参数，无 `request` 包装**：套 `request` 会回 `missing "ns", "ops"; unexpected "request"`） | 可写；UI 用它把默认档位写成 `{ns:"permission",ops:[{op:"set",path:["defaultPreset"],value:…}]}` —— 注意这是**实例级默认值**，影响之后所有会话。`settings/read` 未转发（404），写完只能用 `permissionPresets/catalog` 回读 |
| `commands/execute` | `{agentId, line}` | 存在（`commands/list` 回 `["compact","export","feedback","goal","permission","plan"]`），是**唯一**能程序化切档的通道（`line:"/permission <preset>"`）。**桥接刻意不接它**：即使不带参数的只读形式也会往会话日志写一对 `command/run`+`command/done`；提权应当是人的决定 |
| `session/modelCatalog` | `{}`（**套 `_request` 会被拒**） | `{default,routableProviders,groups[{provider,models[]}],failures}`。模型条目**不声明支持哪些 reasoning effort** |
| `session/selectModel` | `{request:{sessionId,provider,model,reasoningEffort}}` | `value:{selected:{…}}`；非法值 → `session/model-unavailable` 并说明原因（**这就是 effort 的探测手段，零消耗**） |
| `session/cancel` | `{request:{sessionId}}` | `value:{accepted:true}` —— 同样只是受理，取消结果要再读 `turn/end`（`reason.kind:"aborted"`） |
| `workspace/create` | `{request:{path}}` | **幂等**：路径已存在则返回既有 workspace → 可当 path→workspaceId 解析器 |
| `workspace/insertSessionBefore` | `{request:{workspaceId,sessionId,beforeSessionId?}}` | 对**已存在**会话回 `workspace/move-invalid: the session is not accounted` → **分组只能在创建时定** |
| `workspace/pinSession` / `archiveSession` | `{request:{sessionId}}` / `{request:{workspaceId,sessionId}}` | archive 可用；**`session/delete`、`session/archive` 未转发（404）** → API 侧删不掉会话 |
| `session/search` | — | 默认禁用：`session search is disabled: session-query index openAt "never"` |
| `session/follow`、`workspace/follow` | — | 流式方法必须走 `/api/remote.mux` WebSocket：`gateway/signature-invalid: stream Remote methods must be opened through the stream carrier` |

会话事件的权威词汇（从 `session/page` 实测取到）：`session`、`permission/preset`、`sandbox/mode`、`approval/policy`、`subagent/model-selection-policy`、`model/selection`、`agent/inbox/spliced`、`turn/start`、`step/start`、`system/message`、`user/message`、`request/header`、`request/context`、`session/title`、`session/title-llm-request`、`assistant/message`、`tool/call`、`tool/ptc-dispatch-start`、`tool/ptc-dispatch`、`tool/result`、`step/end`、`job/registered`、`job/settled`、`workspace/changes`（**只带 `{turn}`，不带路径**）、`turn/end`。PTC 预设的会话才会出现 `tool/ptc-dispatch*` 与 `job/*`。

**工具调用的两个事件形状不同，必须按 `(turn, step)` 关联**：`tool/call` 带 `{turn,step,callId,name,arguments}`，而 `tool/result` 带 `{turn,step,message{isError,content},error{name,code}}` —— **结果里没有 name**。只读 `tool/result` 会得到"有 3 个错误但不知道是哪个工具"，这是审计最容易漏的地方（`CODE_RUN_FAILED` 即 `run_code`）。沙箱拒绝也**不是**服务端审批队列：它以 `isError` 的工具结果返回，dsh 把"可提权重试"的提示写在正文里（`sandbox: file access denied … escalation available …`）。

**`File sandbox: <mode>.` 是脚注，不是拒绝信号**：dsh 会给各种失败的工具结果都追加这一行（实测一个会话里 8 条 `isError` 结果**全部**带它，其中真正的拒绝只有 1 条）。判拒绝只认 `file access denied` / `escalation available` / `EPERM` / `operation not permitted`。

**判决必须取自本轮自己的 `turn/end`**：`turn/end.data.reason` 是 `{kind}`，中止时还带嵌套来源 —— 实测 `{"kind":"aborted","reason":{"kind":"user"}}`，据此能区分"操作者中止"与"dsh 自己放弃"。而一轮可以横跨上千条事件，任何**固定**窗口都是在猜本轮有多长，两种猜法都实测翻过车：按 `throughSeq=asOfSeq` 的**尾部**窗口读会把**下一轮**的 `completed` 当成本轮结论（实测尾部窗口读到 seq 1444 的 completed）；从 baseline 起的单个 1000 条窗口又**够不到**本轮判决（实测本轮 baseline=4、`turn/end` 在 seq 1084，而窗口 `throughSeq` 只到 1004 → 一个 `completed` 的轮次被读成 `idle`，即"本轮什么都没发生"）。正确做法是**从本轮 baseline 起沿游标向前走**（`walkRound`：首页 24 条，之后每页 1000 条，上限 12 页），直到本轮的 `turn/end` 落进已收集事件，再截断到该 `turn/end`（`sliceRound`）。轮询时传 `walk:false` 只读一小页省钱，但此时**不得**把 `state` 当判决；桥接用 `windowTruncated` 与 `verdictComplete` 两个字段显式区分"没看到结束"与"没有结束"，并在 `window.newestSeq` 里只报**截断后**真正读到的位置。

**提权痕迹可读**：`permission/preset {preset}`、`sandbox/mode {mode,source?}`、`approval/policy {policy}`、`command/run {commandId,name,args?,source:{kind}}`。实测一次人工提权留下：seq 0 `workspace-write` → seq 207 `command/run name:"permission" args:" danger-full-access" source:{kind:"user"}` → seq 208 `danger-full-access`、seq 210 `approval/policy: never`。**提权前后两轮的环境前提不同，不能互相取证。**

**审批会让一轮"停在人身上"，而日志看起来只是 running**：`approval/policy: ask`（`workspace-write` 档位的默认策略）下，dsh 不肯静默执行的操作会发 `approval/asked {id,toolName,callId,reason}` 并**等人回答**，`approval/decided {id,outcome}` 才关闭它（实测 outcome 有 `allowed-once`、`cancelled`）。此时 `session/list.running` 仍是 `true`，所以**光靠轮询无法区分"在干活"和"在等人"**——2026-10-18 实测：即使已授予工作目录写权限，`pwsh` / git 操作仍会弹审批，无人值守的一轮就此挂死。把档位提到 `danger-full-access` 会连带把策略翻成 `never`（实测 seq 703 `command/run` → 704 preset → 706 policy），这也是"睡觉/外出时才开 full"的技术原因。桥接因此把 `approvalPolicy` / `approvalAsked` / `approvals[]` / `pending[]`（asked 里没有对应 decided 的那些）一并回给调用方，`dsh_wait` 一旦发现 `pending` 非空就**立即返回**而不是耗完窗口。

**成败判定**：只有 `turn/end.data.reason.kind`（`completed` / `error` / `aborted` …）。`accepted:true` 与 `running` 由 true→false 都**不能**判成败；失败轮的 `reason.error.{code,message}` 里才有真因。

## 分组（侧边栏）

分组 = workspace 记录里的 `sessionIds` 成员关系，**与 cwd 是两套机制**：`{cwd}` 建的会话不进任何列表 → 落 Ungrouped；`{workspaceId}` 建的进对应分栏且 cwd 仍为该 workspace 的 path（实测 `request/context` 的 cwd 不变、`session/list` 仍可见）。分组**不可事后修改**。

## 其它 profile（若 `/api` 被上游改动打断）

`dsh` 自带三条官方自动化面，都在同一安装内：

- `dsh --profile headless [--session-id <id>] --json "<task>"`：一次一任务，NDJSON 事件（`session/status/text/thinking/tool_call/tool_result/final`），失败退出码 1；但**不能接管 web 建的会话**（`agentPreset:"ptc"` 不在其组合内），且该 profile 默认禁用托管凭据。
- `dsh --profile acp`：标准 ACP v1 over stdio，**无鉴权**，`initialize/session/new|list|resume|close/prompt/cancel`；实测能接管 web 建的会话。`session/new` 的 `mcpServers` 是**必填**（哪怕空数组）；stdout 可能混入非协议日志行，客户端必须容忍。
- `dsh --profile sdk`：私有 JSON-RPC stdio，另有 `session/wait`（整棵任务树静默）与全量 `session.event`。

## 模型路由是 per-profile 的（容易忽略）

模型路由是 **per-profile** 的：manifest 里声明 `dsh.client.platform="web"` 的 provider 插件只会被组合进 web profile。把这类插件搬进 `acp`/`headless` 的结果是"provider 注册上了但模型目录为空"。非 web profile 要用模型，只能靠它原生支持的凭据键（例如 `DEEPSEEK_API_KEY`）。

`profile` 组合的排查命令（不启动进程）：`dsh --profile web --dump-config`；实测启动约 **10 秒**，所以 `startup_timeout_sec` 要留余量。

## 磁盘上的会话（兜底读法）

`~/.dsh/sessions/<cwd 的 slug>/session-<uuid>|<自铸 id>/session.v4.jsonl.zstd`。

⚠ **多帧 zstd**：整块 `zlib.zstdDecompressSync(整个文件)` 只会解出**第一帧**（实测一例：23,351 字节只解出 225 字节，很容易被误判成"日志是空的"）。必须按 magic `28 B5 2F FD` 切帧逐帧解压再拼接——见 `tools/read-session-log.mjs`。

## 升级后重建证据（顺序）

```
npm test                       # 离线契约回归：线上格式一改就先红（零额度、无需 dsh）
node launch.mjs check          # 版本 + profile 组合（不启动）；组合失败会复述 dsh 原文
node launch.mjs doctor         # 解析→组合→端口→token→鉴权→modelCatalog
node tools/probe-api.mjs       # 重新推导各端点的 args 形状（只读 + 只建探针会话）
node tools/probe-acp.mjs       # ACP 面是否仍可用（无鉴权、方法表）
node tests/live-check.mjs      # 对着活实例只读复验（--create / --dispatch 才产生代价）
```
