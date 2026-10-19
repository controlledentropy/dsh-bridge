# 把 dsh 当外派工位来用

这份文档讲**怎么用好**桥接，不讲实现。适用于任何 MCP 客户端。

## 1. 它不是子进程，是第二个工位

`mcp__dsh__*` 驱动的是另一个 agent harness。它与本地 subagent 的区别必须一直记住：

- **不共享上下文**：它只知道你写在 `task` 里的内容。交接必须是书面任务清单。
- **异步**：下发只代表受理。判断完成只能靠 `state` 字段。
- **有身份但没有名字**：一切按 `alias` 寻址，别名由调用方铸造并复用。

## 2. 什么时候外派

同时满足四条才外派，否则用客户端自带的 subagent 或自己做：

1. 任务独立、边界清晰、可书面验收，且不需要与主线程来回澄清；
2. 目标是一个**已存在的目录**（绝对路径）；
3. 允许另一个 agent 修改该目录内的文件；
4. 单轮预算可以接受（一轮约 14k input / 100 output tokens 量级，视任务而定）。

适合的形态：仓库扫描与结构化摘要、批量文件改写、按 spec 实现一个垂直切片、测试补齐、机械性重构、把复现步骤写成脚本。
不适合：需要跨文件全局决策、需要用户中途澄清、需要越过 dsh 自身权限策略的操作（会被审批挂起）。

## 3. 任务清单写法（四段，必需）

```text
目标：<一句话，可判定>
边界：只允许改动 <路径/文件范围>；禁止 <网络访问、越界路径、删除>
验收：<人可复核的判据：命令、文件、断言>；把结论写入 <工作区>/<name>-report.md
交付：<产出清单与路径>
```

要求执行方把结论写成工作区内的报告文件，是把"它自称完成"变成**可独立复核证据**最省事的做法。拿到结果后仍要抽查（读文件、跑命令）——**不接受未经验证的完成声明**。

## 4. 判定规则

- `accepted:true` 只代表受理；`running` 由 true 变 false **不代表成功**。只有 `state:"completed"` 算完成。
- `state:"idle"` 意味着本轮没有记录任何 turn（任务被吞或接管被拒），必须按"未验证"处理。
- `state:"error"` 时读 `error.{code,message}` 原文上报，**不要**擅自降级到别的模型重跑。
- `dsh_result` 里的 `correlated:false` 表示本轮基线是靠游标推断而非按 `requestId` 关联得到的，此时结论可信度下降，验收要叠加磁盘级证据。
- `verdictComplete` 只有一个含义：**本轮自己的 `turn/end` 已经读到**（等价于 `settled`）。它不与窗口覆盖度做或运算——正在正常执行、日志恰好读完的一轮，`verdictComplete` 必须是 `false`。
- 落不到判决时区分两种情况：`windowTruncated:true` = **还没读到日志末尾**，别下结论，用 `dsh_result` 重读；`logExhausted:true` 且 `state:"idle"` = **日志已到末尾而本轮没有 `turn/start`/`turn/end`**，即派单没有被接手，按未验证处理。
- `abortReason:"user"` 表示是人中止的（通常就是编排方自己调了 `dsh_cancel`），不是 dsh 放弃；两者处置完全不同。
- `pending` 非空表示**本轮停在人工审批上**，`dsh_wait` 会立刻返回而不是耗完窗口。无人值守时它不会自己好：要么让人去 dsh UI 回答，要么把会话档位提到 `danger-full-access`（审批策略随之变 `never`）再重发。**不要**继续 `dsh_wait` 空转，也不要把它当成 dsh 卡死。
- 单次 `dsh_wait` 不要超过客户端的 `tool_timeout_sec`（默认建议 45s）；没落定就继续调用，而不是一次拉长。
- `dsh_wait` / `dsh_result` 默认只回本轮内容；历史轮次要显式 `dsh_result {round:N, messages:N}`。

## 5. 模型与推理强度

- 能用哪些模型由 `[mcp_servers.dsh.env] DSH_ALLOWED_MODELS` 预先约束，`dsh_models` 只回显被允许的那些。
- 默认不传 `model` / `reasoningEffort`，用配置里 pin 好的缺省值。只有明确要求换模型时才传参，且必须先 `dsh_models` 取许可集合，从中选，**不要凭记忆编 provider/model 名**。
- 越权请求会在下发之前被拒绝，不会消耗额度。此时如实上报被拒原因与允许清单。
- 验收时把 `pinned` / `dsh_status.model` 一并汇报，证明这一轮实际用的模型与强度。

## 6. 阶段、别名与复用

- **新阶段 = 新别名**（干净上下文）；同一阶段的补漏或返工 = 对同一别名 `dsh_send`。
- 命名建议 `p<阶段>-<主题>`，例如 `p1-recon`、`p2-impl-api`、`p3-tests`。
- **分栏必须在创建时决定**：`dsh_launch` 默认把会话落进该路径对应的项目分栏；事后移动会被 dsh 拒绝，`dsh_adopt` 只能接管不能改组。
- 要接管人类在 web 界面里开的会话：`dsh_sessions {cwd}` 找到 id → `dsh_adopt {alias, sessionId, cwd}`。若该会话正被浏览器持有，可能遇到写入方占用的拒绝——把错误原文上报，不要静默改成新建会话。
- 账本按 `DSH_BRIDGE_STATE` 隔离：要共用账本就必须指向同一个目录。

## 7. 并发

多个别名可以并行下发（一个 dsh 实例支持多会话），但：

- 同一别名不要并行发两轮（一轮只有一个在途任务）；
- 并发数建议 ≤ 3，且各别名的 `cwd` 尽量不同目录，避免同一工作区里互相覆盖；
- 轮询开销随会话总数上升（`running` 判定要扫一次会话表），不要开十几个别名各自空转。

## 8. 失败与中止

- 明确要停：`dsh_cancel {alias}`。它返回的 `accepted` 只是受理，要用 `dsh_wait` 复查是否真的落到 `aborted` / `idle`。
- 桥接连不上（`unreachable` / `no launch token` / `/connect -> HTTP …`）属于**环境问题**：先跑 `node launch.mjs doctor`，把它的 `broken` 与 `problems` 原文带回来再决定处置（多半是"没有实例在跑"或"实例的 stdout 没被捕获"）。不要改成自己做然后声称外派过了，也不要凭猜测改配置。
- 升级 dsh 之后：先 `node launch.mjs check`（不启动进程就能暴露版本不一致与 profile 配置被拒两类问题），再 `doctor`，再 `npm test`，最后**复核 `DSH_ALLOWED_MODELS` 是否仍符合预期**——修复一个配置缺陷可能同时扩大可选模型集。

## 9. 权限与沙箱

- **会话的写入边界就是它的 `cwd`**，档位默认 `workspace-write`。任务要改哪个目录，就用那个目录建会话；侧边栏分栏跟随 `cwd`，不需要事后搬。
- 桥接只**拒绝"要往工作区外面写"的派单**，判定按路径附近的意图词（写入/生成/补测试/实现…，含"在 X 里改"这种动词后置的中文写法）分级，结果在返回里分两档给出：`outsideCwd.write`（会被沙箱拒，硬阻断，需 `allowOutsideCwd:true` 才放行）与 `outsideCwd.read`（只是提到，仅告警）。**"提到路径"不等于"写路径"**：工单正文常在父仓、技能定义在 `~/.agents/skills`、工具在 `Program Files`，把这些也一并拒掉会让"正文只读放主仓、产物写 worktree"这个推荐写法无法下发。分级是启发式：判错方向时用 `allowOutsideCwd` 显式放行，别改桥。
- **`workspace-write` 不等于无人值守可用。** 实测（2026-10-18）：即便工作目录已授权，`pwsh` / git 这类操作仍会触发 `approval/asked` 并停在人身上，`session/list.running` 还是 `true`，看起来只是"跑得慢"。要真正无人值守，需要会话处于 `danger-full-access`（审批策略随之变 `never`）——所以"睡觉或外出时才开 full"是权宜之计，不是配置疏漏。派单前用 `dsh_status {alias}` 看 `approvalPolicy` 与 `unattended`，别等一轮白烧完才发现。
- **要求 `git commit` 的任务在 `workspace-write` 下结构性不可行。** git worktree 的索引与对象元数据不在 checkout 里，而在主仓的 `.git/worktrees/<name>/`（git 自身的目录布局），会话工作区之外 → 每次提交都会弹审批。所以：**凡派单里要求提交，要么下发前由人把会话切到 `danger-full-access`，要么让执行者只产出改动、由会话外的人提交**。把这条写进任务模板的边界段，别让每一轮执行者各自重撞一次。
- **提权是人的动作，不是编排动作。** `/api` 上没有 per-session 的档位写入口（`permissionPresets/set`、`session/setSandboxMode` 均未转发），桥接也刻意不接 `commands/execute`。用 `dsh_permissions {alias}` 只读确认生效档位与提权痕迹（`escalated` / `escalatedBy` / `approvals`）。
- **提权前后两轮不可互相取证**：一轮在 `workspace-write` 下失败、随后人工切到 `danger-full-access` 再跑，后者的"成功"不能证明前者是任务问题。审计时把档位变化写进结论。
- 任务包里要显式规定临时文件位置：`run_code` 的进程环境被 dsh 清空，`os.tmpdir()` 会拼出 `<cwd>\undefined\temp` 而 ENOENT，写真 `%TEMP%` 又被沙箱拒绝。写成"临时文件放在会话工作区内的绝对路径"即可绕开。
- 子进程"静默不执行"（有 exe、无输出、无退出码、无报错）先查宿主 `PATHEXT` 是否含 `.EXE`：`node launch.mjs doctor` 的 `env.problems` 会报。这类环境问题会被误读成"工具没装"，从而浪费好几轮排查。
