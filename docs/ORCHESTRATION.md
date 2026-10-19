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

- **默认回传只有裁决块**（实测 `dsh_status` 一轮已落定时 154 B）：`state / settled / verdictComplete / pending / waitingOnHuman / asked / error / note`，另有两个**只在还没有判决时**才出现的限定字段 `windowTruncated`、`turnStarted`（落定轮次不会看到它们，别当成缺字段）。文本预算裁短另用 `textsNote` 说明，绝不占用 `note`（`note` 里是下一步动作）。任务文本走 `dsh_result`（默认 `only:"final"`，只给最终一条 + 错误码 + 文件线索；要整轮再 `only:"full"`，并按 `maxTextBytes` 封顶）；诊断细节走 `detail:true`。派发与验收之间不要为了"看看进展"去拉全量。
- `accepted:true` 只代表受理；`running` 由 true 变 false **不代表成功**。只有 `state:"completed"` 算完成。
- `state:"idle"` 意味着本轮没有记录任何 turn（任务被吞或接管被拒），必须按"未验证"处理。
- `state:"error"` 时读 `error.{code,message}` 原文上报，**不要**擅自降级到别的模型重跑。
- `dsh_result` 里的 `correlated:false` 表示本轮基线是靠游标推断而非按 `requestId` 关联得到的，此时结论可信度下降，验收要叠加磁盘级证据。
- `verdictComplete` 只有一个含义：**本轮自己的 `turn/end` 已经读到**（等价于 `settled`）。它不与窗口覆盖度做或运算——正在正常执行、日志恰好读完的一轮，`verdictComplete` 必须是 `false`。
- 落不到判决时按 `note` 分诊，不要只看 `state`：`windowTruncated:true` = **本次读取的快照没覆盖到判决**，别下结论，用 `dsh_result` 重读，**不要重发**（实测一轮已完成、只差 1 个 seq 时旧版本说"派单没被接手"，照做就会重跑已完成的工作）；`state:"idle"` 且 `turnStarted:false` = 本轮**连 `turn/start` 都没有**，这才是派单没被接手，按未验证处理；`note` 说"日志读不到"= 页读取失败，本轮一切结论都还没被验证。`logExhausted` 这个字段已删除（它对未落定的轮次恒等于 `!windowTruncated`，名字却承诺"日志到此为止"）。
- `abortReason:"user"` 表示是人中止的（通常就是编排方自己调了 `dsh_cancel`），不是 dsh 放弃；两者处置完全不同。
- `pending` 非空表示**本轮停在人工审批上**，`waitingOnHuman:true` + `asked[]` 表示**停在待人回答的提问上**（`ask_user_question` 走 PTC 分发，不产生审批事件）。两种都不会自己好：`dsh_wait` 一发现就立即返回（实测 50 ms），要么人去 dsh UI 回答，要么提权到 `danger-full-access`（审批策略随之变 `never`）后重发。**不要**继续 `dsh_wait` 空转，也不要把它当成 dsh 卡死。
- 无人值守的任务包里应显式禁止提问（"不要向我提问；有歧义就按最保守解释做，并把假设写进报告"），否则一轮会停在 `ask_user_question` 上等人——实测那次停了 102 秒。
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
- **一个工单只允许一个在途别名。** 发现账本里另有别名像在做同一件事（同 `phase`，或工单正文大段相同而 `cwd` 不同），`dsh_launch` 会返回 `siblingWarning`。这时二选一：把剩余轮次用 `dsh_send` 发给原别名，或者用 `dsh_launch {supersedes:"<旧别名>"}` 明确替代——替代关系写进账本，之后向旧别名 `dsh_send` 会在返回里带 `supersededBy` 警告。**只换 `cwd` 另开一个而不记录替代关系**，就是两个会话被交替调用、历史各半的那次事故。
- 要接管人类在 web 界面里开的会话：`dsh_sessions {cwd}` 找到 id → `dsh_adopt {alias, sessionId, cwd}`。若该会话正被浏览器持有，可能遇到写入方占用的拒绝——把错误原文上报，不要静默改成新建会话。
- 账本按 `DSH_BRIDGE_STATE` 隔离：要共用账本就必须指向同一个目录。

## 7. 并发

多个别名可以并行下发（一个 dsh 实例支持多会话），但：

- 同一别名不要并行发两轮（一轮只有一个在途任务）；
- 并发数建议 ≤ 3，且各别名的 `cwd` 尽量不同目录，避免同一工作区里互相覆盖；
- 轮询开销随会话总数上升（`running` 判定要扫一次会话表），不要开十几个别名各自空转。
- 单次只读调用的实测代价（本机 dsh 0.2.1-rc.2，同一实例 A/B 对照）：`dsh_status` 7 个 `/api` 调用、`dsh_result` 5–6 个（跨 1084 事件的长轮 6 个）。`session/projections` 在一次调用内只读一次并作为游标快照传给整次翻页，所以翻页页数增加时成本接近线性而不是翻倍。

## 8. 失败与中止

- 明确要停**一轮**：`dsh_cancel {alias}`。它返回的 `accepted` 只是受理，要用 `dsh_wait` 复查是否真的落到 `aborted` / `idle`。这只取消这一轮，**不关进程**。
- 明确要停**整个 dsh web 实例**：`dsh_stop`（或 `node launch.mjs stop`）。三个字段分工要说清：`ok` 表示**端口真的空出来了**（不是"信号发出去了"），`stopped` 表示记下的那个 pid 确实消失了，`signalSteps` 是实际做过的动作（`taskkill /T` / `process.kill(SIGTERM)` / `taskkill /T /F`）。
  - 只停本状态目录 `instance.json` 里登记的实例。不是这棵树起的，它**拒绝**并报出端口占用者——杀一个自己没有归属证据的进程是猜，不是停止。确认归属后传 `pid` 显式指定。
  - 登记的是**死 pid** 时，它清掉过期记录并如实说"什么都没停"，不会把一次空操作报成成功。
  - 停的是**整棵进程树**：dsh web 会派生子进程（PTY / pwsh / run_code 层），只杀父进程的话子进程还占着端口，下一次 `start` 会撞上端口占用。Windows 用 `taskkill /T`，先优雅后强制；受限环境拿不到 `taskkill` 时只能发原生信号，此时返回里的 `treeKillUnavailable` 会明说"树可能没杀干净"，而 `stillListeningOnPort` 给出证据。
  - `dryRun:true` 只看不动：报出记下的 pid、它是否活着、端口占用者，不杀任何东西。**"停不下来"和"不知道该停谁"要分开**——前者是真故障，后者是缺信息，处置完全不同。
- 桥接连不上（`unreachable` / `no launch token` / `/connect -> HTTP …`）属于**环境问题**：先跑 `node launch.mjs doctor`，把它的 `broken` 与 `problems` 原文带回来再决定处置（多半是"没有实例在跑"或"实例的 stdout 没被捕获"）。不要改成自己做然后声称外派过了，也不要凭猜测改配置。
- 升级 dsh 之后：先 `node launch.mjs check`（不启动进程就能暴露版本不一致与 profile 配置被拒两类问题），再 `doctor`，再 `npm test`，再 `node tools/remote-surface.mjs --check`（方法表漂移），最后**复核 `DSH_ALLOWED_MODELS` 是否仍符合预期**——修复一个配置缺陷可能同时扩大可选模型集。
- **账本写不进时会明说，不会假装成功。** 每次写 `sessions.json` 都是"读—改—写—读回确认"，被别的进程盖掉就重试。返回 `ledgerAtRisk:true` + `ledgerNote` + `unrecordedRound{alias,requestId,sinceSeq}` 的情况是**任何**写不进：既包括重试仍不确认，也包括盘本身报错（EACCES/ENOSPC/EPERM——2026-10-19 审计实测这类错误原先只抛一句裸错误，句柄拿不到，而派发类调用此时 prompt 已经发出去了）。派发类调用带句柄返回；审计类调用只附带同样字段而**不失败**：`ledgerNote` 会说明两种情况各有哪种含义（"轮次已发出、句柄只有这一份" vs "结论来自 dsh 日志本身、仍然成立，只是账本里那一格的 outcome 旧了"）。看到 `ledgerAtRisk` 就不要把这一轮当作已登记：先把句柄补记，再往下走。
- **审计日志可能变聋，但要看得见。** `bridge.log.jsonl` 超预算会轮转，多进程抢同一次轮转是正常竞态（丢了 rename 的一方继续写新文件，不静默停写）；只有**连续**真实写失败才停用日志，并在 stderr 说一次。状态由 `dsh_sessions` 的 `logging{disabled,failures,rotationRaces,written}` 报出——`disabled:true` 意味着该进程从此没有本地证据，别把它当成"没发生"。

## 9. 权限与沙箱

- **会话的写入边界就是它的 `cwd`**，档位默认 `workspace-write`。任务要改哪个目录，就用那个目录建会话；侧边栏分栏跟随 `cwd`，不需要事后搬。
- 桥接只**拒绝"要往工作区外面写"的派单**。判定读的是**路径所在的那一句**，不是固定字符窗口（2026-10-19 审计实测：`Update the checklist; the spec lives at "D:\…\bin"` 原先因为 25 个字符外另一个从句里的动词被判成写而整单被拒）；`禁止覆盖 X` 是否定而不是计划，按只读处理；`写入 X，格式依据 README` 里"依据"是出处不是只读，**不会**把写降级（原先正是这条把真写放行，白烧一轮）。只有显式只读标注（`只读`/`仅供参考`/`reference only`）才反向降级；中文动词后置（"在 X 里补一节"）仍算写。**未加引号**的路径里，带扩展名的新文件名也算命中——原先要求路径必须已存在才纳入判定，而产物本来就还不存在，于是守卫对最需要它的那种写法完全失明。空格截断出来的目录残片（`D:\Program Files\…` 只匹配到 `D:\Program`）仍被丢弃，否则告警全是噪音。结果分两档：`outsideCwd.write`（会被沙箱拒，硬阻断，需 `allowOutsideCwd:true` 才放行）与 `outsideCwd.read`（只是提到，仅告警）。**"提到路径"不等于"写路径"**：工单正文常在父仓、技能定义在 `~/.agents/skills`、工具在 `Program Files`，把这些也一并拒掉会让"正文只读放主仓、产物写 worktree"这个推荐写法无法下发。分级是启发式：判错方向时用 `allowOutsideCwd` 显式放行，别改桥。
- **`workspace-write` 不等于无人值守可用。** 实测（2026-10-18）：即便工作目录已授权，`pwsh` / git 这类操作仍会触发 `approval/asked` 并停在人身上，`session/list.running` 还是 `true`，看起来只是"跑得慢"。要真正无人值守，需要会话处于 `danger-full-access`（审批策略随之变 `never`）——所以"睡觉或外出时才开 full"是权宜之计，不是配置疏漏。派单前用 `dsh_status {alias}` 看 `approvalPolicy` 与 `unattended`，别等一轮白烧完才发现。
- **要求 `git commit` 的任务在 `workspace-write` 下结构性不可行。** git worktree 的索引与对象元数据不在 checkout 里，而在主仓的 `.git/worktrees/<name>/`（git 自身的目录布局），会话工作区之外 → 每次提交都会弹审批。所以：**凡派单里要求提交，要么下发前由人把会话切到 `danger-full-access`，要么让执行者只产出改动、由会话外的人提交**。把这条写进任务模板的边界段，别让每一轮执行者各自重撞一次。
- **提权是人的动作，不是编排动作。** dsh 随包的方法表（[REMOTE-SURFACE.md](REMOTE-SURFACE.md)）里**没有** per-session 的沙箱写入口（`permissionPresets/set`、`session/setSandboxMode` 均不存在），桥接也不接 `commands/execute`。用 `dsh_permissions {alias}` 只读确认生效档位与提权痕迹（`escalated` / `escalatedBy` / `approvals`）。
- **表里存在、但桥接刻意不调用的三个入口**，写下来是为了让"做不到"和"选择不做"不再混淆：`agentPresets/select` 只在会话**首轮之前**有效（会话已记录 preset 就不再改动），`terminal/create` 的官方描述明说它绕过 Agent 沙箱与审批（接上它等于让编排方替人批准自己），`session/fork` 会从事件前缀分叉出新会话（会话 API 删不掉，见 §9 末尾）。想要其中之一成为能力请显式提出，不要默认打开。
- **提权前后两轮不可互相取证**：一轮在 `workspace-write` 下失败、随后人工切到 `danger-full-access` 再跑，后者的"成功"不能证明前者是任务问题。审计时把档位变化写进结论。
- 任务包里要显式规定临时文件位置：`run_code` 的进程环境被 dsh 清空，`os.tmpdir()` 会拼出 `<cwd>\undefined\temp` 而 ENOENT，写真 `%TEMP%` 又被沙箱拒绝。写成"临时文件放在会话工作区内的绝对路径"即可绕开。
- 子进程"静默不执行"（有 exe、无输出、无退出码、无报错）先查宿主 `PATHEXT` 是否含 `.EXE`：`node launch.mjs doctor` 的 `env.problems` 会报。这类环境问题会被误读成"工具没装"，从而浪费好几轮排查。
