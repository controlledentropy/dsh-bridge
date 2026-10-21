# 交接 · dsh-bridge（滚动文档）

> 读取顺序：本文件 → `README.md` → `docs/API-CONTRACT.md` → `docs/EVENT-LEDGER-CONTRACT.md`
> → `docs/EVIDENCE.md` 的相关章节 → 代码。
> 本文件每次交接**整体覆盖**，只描述"现在"。历史结论一律在 `docs/EVIDENCE.md`（只追加）。
> 禁止写入真实凭据、Cookie、会话内容或大段原始日志。

---

## 0. 一屏摘要

`dsh-bridge` 把本机 `dsh web` 的本地 `/api` 封装成 MCP stdio server（11 个工具 + 本地账本），
不改 dsh、不装插件。目标形态是**托管 Codex app-server ↔ DSH** 的可恢复、可审计、有授权边界的
自动开发系统（路线 B；不是唤醒用户的 Codex Desktop，见 E6 事故）。

| 阶段 | 状态 |
|---|---|
| P0-b1 Codex 队列 / 冷线程恢复 | 已通过（pinned `codex-cli 0.160.0` + 本地 mock provider） |
| B1 IPC 准入原型 | 已通过 9/9（命名管道，合成环境） |
| B2 事件账本 | 已通过 25/25（临时 SQLite） |
| B3 不确定状态 / B4 并发预算 | 已通过 24/24、17/17 |
| B1–B4 联合验收 | 已通过 26/26（进程内合成） |
| **T1 真实 MCP stdio Adapter 接线** | **未开始 ← 当前任务** |
| P0-b2 Windows Shell Sandbox provision | **阻塞**（缺可快照的独立 Windows 环境） |

**第一条操作**

```bash
git switch feat/t1-mcp-adapter
"$NODE" --test tests/alias-hygiene.test.mjs tests/audit-log.test.mjs tests/contract.test.mjs \
  tests/launch.test.mjs tests/ledger-store.test.mjs tests/mcp.test.mjs tests/remote-surface.test.mjs   # 81 passed
"$NODE" tools/probes/ledger/b-joint.mjs                                                              # 26/26
```

`$NODE` 见 §6：**`node` 与 `git` 不在默认 PATH**。

---

## 1. 仓库状态（2026-10-21 18:20）

| 项 | 值 |
|---|---|
| 基线分支 | `main` @ `ae9473c`，与 `origin/main` 同步，无待推/待拉 |
| 本文件所在分支 | `feat/t1-mcp-adapter`（T1 交付分支；**不合并 main**，见 §4） |
| 上一批提交链 | `770d7b5..ae9473c`，7 个提交（启动锁、live-check、B1 探针、账本语义、证据、B3/B4 原型、契约） |
| 工作树 | `M start-dsh-web.ps1`（+33/−1，**纯 Authenticode 签名块**，保留、不提交）；`?? HANDOFF-dsh-events.md`（本地事故记录，不入库） |
| `.gitignore` | 含 `.state/`、`node_modules/`、`.workbuddy/`；`HANDOFF-dsh-events.md` **有意未忽略**，靠习惯不提交 |

`.state/` 不入库意味着：pinned Codex、隔离 Home、策略夹具**都不在克隆里**，新环境需重建（§6）。

---

## 2. 已完成模块与可复核命令

| 模块 | 入口 | 命令 | 结果 |
|---|---|---|---|
| 离线回归 | `tests/*.test.mjs` | `npm test` | **81 passed / 0 failed**，不联网、不耗额度 |
| B1 IPC 准入 | `tools/probes/ipc/run-b1.ps1` | `npm run prove:ipc` | **9/9**（8 策略 + 1 DACL 负对照） |
| B2 事件账本 | `tools/probes/ledger/events-store.mjs` | `node …/b2-acceptance.mjs` | **25/25** |
| B3 恢复语义 | `tools/probes/ledger/dispatch-store.mjs` | `node …/b3-recovery.mjs` | **24/24** |
| B4 并发预算 | 同上 | `node …/b4-concurrency.mjs` | **17/17** |
| 联合验收 | 同上 | `node …/b-joint.mjs` | **26/26** |
| 运行实例只读体检 | `tests/live-check.mjs` | `npm run check:live`（需 `DSH_ATTACH_OUTFILE`、`DSH_PORT`） | 5/5 |

一键：`npm run prove:ledger`（四项串行）。证据与"未证明什么"见 `docs/EVIDENCE.md`：
`E-IPC-POLICY`、`E-LEDGER`、`E-DISPATCH-RECOVERY`、`E-DISPATCH-ADMISSION`、`E-JOINT`、`E-LAUNCH-LOCK`。

---

## 3. T1 剩余工作

### 3.1 T1.1 审计：已核实的三处缺陷（**未修，留给 T1 首步**）

1. **幂等键复用不比内容** — `dispatch-store.mjs` 的 `admitDispatch()` 按
   `(goal_id, client_request_id)` 查旧行，命中即返回旧 dispatch。**同一 `clientRequestId` 携带不同
   `cwd` / `taskId` / `topicId` 时被静默当成重放**，调用方拿到的是一份它没发过的请求。正确行为是判为
   `conflict` 并拒绝，而不是返回旧单。
2. **事件同序号不同载荷被当作 duplicate** — `events-store.mjs` 的 `ingest()` 只查
   `(topic_id, source_generation, seq)` 是否存在，存在即返回 `duplicate`，**从不比对 `type`/`data`**。
   同一 seq 的两个不同事件会有一个被无声吞掉；账本"幂等"与"分叉"必须可区分（建议 `health='divergent'`
   + 转人工，不自动择一）。
3. **启动锁**（已修，复核点）— `releaseSpawnLock()` 在 spawn 的 `finally` 中执行；`staleLockVerdict()`
   按记录 pid 是否存活判定接管；单测在 `tests/launch.test.mjs`。仍需人工确认的边界：持锁进程**存活但卡住**
   时仍会等满 90 s 启动超时（设计如此，不要"顺手"放宽）。

其余审计项（预算扣减与插入同事务、`UNCERTAIN` 不自动重发）在 B3/B4 已有断言，T1 只需**复核断言是否
真的覆盖了实现的失败路径**，不要重开架构讨论。

### 3.2 T1.2 最小真实 MCP 调用链

目标：`隔离 Codex app-server → MCP stdio Adapter → 认证 IPC → Mock Coordinator`

必须：固定版本 Codex、独立 `CODEX_HOME`/`CODEX_SQLITE_HOME`、本地 Mock Responses Provider、
合成 Goal/线程/目录/凭据、**零真实 DSH 写入**。

| 验收项 | 落点 |
|---|---|
| 1 Codex 能发现并调用真实 MCP stdio 工具 | app-server 的 MCP 配置指向 Adapter，工具列表可见 |
| 2 Adapter 经 IPC 请求 Mock Coordinator | 复用 `tools/probes/ipc/` 的管道 + 令牌模型 |
| 3 合法只读请求成功 | 端到端一次成功调用，带 `dispatchId` |
| 4 未认证 / 伪造 Goal / 伪造线程 / 越界目录 / 已撤销授权均拒绝 | B1 的 8 个拒绝理由在真实 stdio 路径上重放 |
| 5 记录三方实际执行身份 | app-server、Adapter、Coordinator 各自的账户/SID/完整性级别 |
| 6 不得因 Shell 沙箱未 provision 就断言 MCP 子进程起不来 | 沙箱只拦 `exec_command`；stdio 子进程须**实测**，见 `E-CODEX-SANDBOX-ROOT-CAUSE` |
| 7 Agent 不得获得任意 HTTP 转发 / SQL / Coordinator 管理接口 | Adapter 的工具面只有白名单方法，参数经校验 |

交付物：最小 Adapter、Mock Coordinator、可复现测试、进程身份证据、**未通过的权限边界**（如实写）。

---

## 4. 架构不变量与安全边界（不得触碰）

1. **路线 A 已否决**：不向用户 Desktop 的 Codex 线程投递（E6：共用 `CODEX_HOME`/`queue_1.sqlite`，
   跨实例 `queue/add` 被真实执行且投递方不可观测）。隔离必须落在**数据面**，不是"独立进程"。
2. **6 条硬前置**：独立 `CODEX_HOME`、独立 `CODEX_SQLITE_HOME`、显式注入认证、显式权限、
   worktree 隔离、验收要求"向真实 threadId 投递必须失败"。
3. **单执行者**：本机不得有两个同时拥有外部投递权的 Coordinator；不靠 heartbeat 超时自动接管
   （Windows 命名管道是真实单实例 claim，见 `E-SINGLE`）。
4. **结果未知即暂停**：`INTENT → SENT_UNKNOWN → needs_human`，**不重发**；队列查询为空、历史查不到
   都不构成"没执行"的证据。失败**不退款**。
5. **预算在入口生效**：`queue/add`、`thread/resume`、`launch/send` 三条路径共用同一门禁。
6. **`resume` 是执行动作**：冷线程 `queue/add` 只持久排队，`resume` 会消费排队项并起 turn
   （`E-CODEX-COLD-RESUME`）。开机**不得**批量 resume。
7. **`thread/list` 不是存在性信号**，与 `thread/loaded/list` 可双向矛盾；Coordinator 自持线程注册表。
8. **不改 dsh、不装客户端插件**；不写真实业务会话；真实 3080 实例不得作为写入型测试对象。
9. **签名**：`start-dsh-web.ps1` 的 Authenticode 块保留，`git restore` 禁止；本机签名不入库。
10. **P0-b2 未解决** ⇒ 任何"安全已解决"的表述都是错的；T1 通过只证明 Adapter 链路，不证明无人值守。

---

## 5. 已知故障、未解决假设、下一步

| 项 | 现状 |
|---|---|
| Shell 沙箱 | 系统级 provisioned，per-HOME 为 `notConfigured`，执行**fail-closed**；P0-b2 缺可快照环境 |
| E-INCIDENT-CRED-READ | 曾越界读取真实凭据（未打印），**轮换决策仍在项目所有者**，不得代做 |
| 子进程被回收 | 本机工具沙箱在调用结束时回收整个作业对象，`detached` 也一并回收 → 长期实例须由用户自己的 shell 启动 |
| P0-b4 | 部分完成的 turn 跨重启行为**未测** |
| 新增待办（本次审计） | §3.1 的 (1)(2) 两处账本缺陷 |

**未解决假设**：MCP stdio 子进程与 `exec_command` 不共享身份/网络策略——这正是 T1 验收项 5、6 要测的
东西，**不要当成已知**。

**下一步第一条操作**：

```bash
git switch feat/t1-mcp-adapter && "$NODE" --test tests/*.test.mjs
```

然后按 §3.1 → §3.2 顺序：先修两处账本缺陷并补断言（这是 T1 的前置，因为 Adapter 的幂等与事件关联都
依赖它们），再接真实 stdio。

---

## 6. 测试环境与复现

```bash
NODE="C:/Users/MMGA/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"   # node 22.22.2
```

- **node/git 不在默认 PATH**；`launch.mjs` 会自行解析绝对路径并注入子进程 PATH，手工跑请用绝对路径。
- **pinned Codex**：`.state/p0b1/vendor/`（`@openai/codex` 0.160.0，`bin/codex.js`），已验证
  `codex-cli 0.160.0`。`.state/` 不入库 ⇒ 新环境需在该目录 `npm i @openai/codex@0.160.0` 重建。
- **Mock Provider**：`tools/probes/mock-responses-server.mjs --port 0 --log <file> --text <reply>`，
  启动后打印 `{"port":N}`。Codex 侧用 `.state/p0b1/config.template.toml`（`PORT_PLACEHOLDER` 替换，
  `requires_openai_auth=false`、`request_max_retries=0`）。
- **隔离根**：`.state/p0b1/{codex-home,codex-home-ver,codex-sqlite}`。**任何** Codex 调用（含 `--version`）
  都必须先设 `CODEX_HOME`/`CODEX_SQLITE_HOME` 指向隔离目录，否则污染真实 Home。
- **B1 夹具**：`tools/probes/ipc/policy.sample.json` 自动种子到 `.state/b1/policy.json`，可从零复现；
  `npm run prove:ipc` 走 `powershell -NoProfile -File`。
- **账本**：全部用临时 SQLite，脚本自清，不留 `.db` 到工作树。

**踩过的坑（会再次踩）**

1. PowerShell 环境块可能同时存在 `HTTP_PROXY` 与 `http_proxy`：`Start-Process` 在参数绑定阶段抛
   "Item has already been added"，症状是"客户端全部超时"，**看起来像策略失败**。新脚手架须先规范化环境。
2. 隔离 HOME 下 Codex 会打印 `could not create PATH aliases: OS Error 5`，无害，不是失败。
3. 探针一律不得使用真实业务线程；启动前自证隔离。

---

## 7. DSH Web 运行状态（**交接时需重新确认，不得沿用本行**）

| 项 | 值（2026-10-21 18:20 实测） |
|---|---|
| 端口 | `127.0.0.1:3080` **LISTENING** |
| pid / 版本 | 20312 / `0.2.1-rc.2` |
| `startedAt` | `2026-10-21T06:40:59Z` |
| 维持方式 | **由上一执行会话的后台任务维持** → 该会话结束后可能被回收 |

只读确认：

```powershell
Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object OwningProcess
Get-Content .state\instance.json
```

若已停：由**用户自己的 PowerShell** 执行 `.\start-dsh-web.ps1 start`（签名有效，执行策略
`CurrentUser=RemoteSigned`）。`launch.mjs start` 在工具沙箱里起的实例会随调用结束而死。

**禁止**：把该实例用于 T1/T2/P0-b3 的写入型测试。

---

## 8. 上一会话做了什么 / 下一会话开场

**上一会话（2026-10-21）**：修 `spawn.lock` 泄漏（成因：成功启动后不释放，第二次 start 空等 90 s）；
修 `live-check` 工具面漂移（漏 `dsh_stop`）；B1 探针改为可复现并逐项断言（9/9，新增 DACL 负对照）；
B2 改为"乱序入库、只把连续前缀计入 cursor、gap 由 `(cursor, 已持事件)` 重算"（25/25，反转两条
把 bug 当期望的旧断言）；实现 `dispatch-store.mjs` 并完成 B3/B4/联合验收；7 个提交推送 `main`。

**下一会话开场三步**

1. 读本文件 + `docs/EVENT-LEDGER-CONTRACT.md`，**不要**依赖上一会话的对话记忆。
2. 跑 §0 的两条命令，确认 81 + 26 全绿；HEAD 应为 `feat/t1-mcp-adapter` 上含本文件的提交。
3. 先做 §3.1（两处账本缺陷 + 断言），再做 §3.2；每步给可复核命令，失败退非零。

**上下文预算**：本会话在 ~79% 时交接。新会话若再次接近 150k，优先完成当前切片并提交，再交接。
