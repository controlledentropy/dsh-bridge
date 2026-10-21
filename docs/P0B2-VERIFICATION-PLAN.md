# P0-b2 · 沙箱 Provision 的最小验证计划

> 配套文档：[P0B2-SANDBOX-PROVISION.md](P0B2-SANDBOX-PROVISION.md)（变更影响与回滚风险）。
> 本文只讲**在哪里、按什么顺序、用什么判据**验证，不重复风险评估。

---

## 0. 三种可选执行环境，按推荐顺序

| 选项 | 是否可回滚 | 推荐度 | 备注 |
|---|---|---|---|
| **A. 独立 Windows VM / 可快照测试机** | 是（整机快照） | **首选** | 唯一能安全拿到"provision 成功后的完整证据"的路径 |
| **B. 当前主机不 provision** | — | 次选 | P0-b2 记阻塞，只做无副作用部分 |
| **C. 当前主机直接 provision** | 否 | **不采用** | 回滚成本 > 收益，且可能影响真实 Desktop 的既有沙箱 |

若选 A，需要你提供或确认一台可用的 Windows 环境。这是本计划唯一的外部依赖。

---

## 1. VM 内的执行顺序（每步都有明确判据）

### 步骤 0 · 基线快照（不可跳过）

```
导出：账户列表、组成员、%LOCALAPPDATA%\OpenAI\Codex\bin ACL、
      codex_sandbox_* 防火墙规则、WFP 过滤器清单、~/.codex 与工作区根的 DACL
建立：VM 快照 / 还原点
记录：pinned helper SHA256
```

**判据**：能把这些导出物与 VM 快照同时指向"回滚点"。做不到就不进入步骤 1。

---

### 步骤 1 · 纯静态，无副作用

- 在 VM 内跑同一份探针：`tools/probes/sandbox-readiness.mjs`
- **期望**：全新 `CODEX_HOME` → `{"status":"notConfigured"}`（与当前主机一致，证明可复现）

**判据**：status 必须是 `notConfigured`。若已是 `ready`，说明该 VM 已有既存配置，基线不可信。

---

### 步骤 2 · Provision（这一步才是有副作用的）

两种调用路径，优先 RPC（可观测）：

```
windowsSandbox/setupStart  { mode: "unelevated" }
    ↓
等待 windowsSandbox/setupCompleted   ← 注意：setupStart 返回 started:true 不代表成功
    ↓
windowsSandbox/readiness
```

**判据（三项全中才算成功，缺一不算）**：

| # | 判据 | 不看什么 |
|---|---|---|
| 2a | `setupCompleted.success === true` | 不看 `setupStart` 的 `started` |
| 2b | `readiness.status === "ready"` | — |
| 2c | 与步骤 0 快照逐项 diff，列出全部未预期变更 | 不能只 diff 账户和防火墙 |

**已知陷阱**：上游有 `success:true` 但部分防火墙规则未启用的案例。所以 2a/2b 都不是充分条件，
必须做步骤 3。

---

### 步骤 3 · 真实受限 Shell（**这是 P0-b2 真正的验收点**）

用 `tools/probes/mock-tool-caller.mjs` 让 mock 模型调用一次 `exec_command`：

| 测试 | 命令 | 期望 |
|---|---|---|
| 正向 | `echo P0B2-SHELL-OK` | 成功，输出可见 |
| 身份 | `whoami` | 返回**沙箱账户**，不是 `mmga` |
| 越权写 | 写入工作区外的合成目录 | 被拒 |
| 越权读 | 读工作区外的合成文件 | 被拒 |
| 网络 | 连 `127.0.0.1:<合成端口>` | 按 offline 规则被拒 |

**判据**：五项全部有明确结果。**"命令被拒绝"在正向用例里是失败，不是安全。**

---

### 步骤 4 · 回滚演练（在 VM 里做，不在生产做）

- 从步骤 0 快照还原
- 确认 `readiness` 回到 `notConfigured`
- 确认账户/防火墙/WFP 无残留

**判据**：能完整还原。这一步的产出是**回滚可行性的证据**，供真实部署时引用。

---

## 2. 无独立环境时的替代范围

若暂时拿不到 VM，**以下工作可以并行且不需要 Shell**：

| 可做 | 不能做 |
|---|---|
| `windowsSandbox/readiness` 只读取证（已做） | 任何 provision |
| Mock Coordinator / Mock DSH 的 Adapter→IPC 合成验证 | 真实 Shell 在沙箱内的行为 |
| 单实例 claim、事件账本、UNCERTAIN 状态机的纯离线测试 | "托管 Codex 能安全跑工具"的结论 |

**明确边界**：Adapter 能启动 ≠ Shell 沙箱通过。两者是**不同的 Windows 身份与不同的执行入口**，
P0-b3 必须分开测量（见下节）。

---

## 3. 必须带入 P0-b3 的一条：Shell 与 MCP Adapter 的网络身份不同

这是审计第 4 点，我确认它会影响架构：

```
CodexSandboxOffline  →  WFP 规则阻断 127.0.0.0/8 的 loopback
```

若 Worker Adapter 由**沙箱内**的 Codex 以 stdio 启动，它可能**连不上**本机 Coordinator 的 IPC；
若 Adapter 由**沙箱外**的高权限进程启动，则必须保证模型侧无法借它的权限越界。

**因此 P0-b3 的首要验证项是**：分别测量
1. `exec_command` 子进程的 Windows 身份与网络能力；
2. MCP stdio 子进程的 Windows 身份与网络能力；
3. 二者与 Coordinator 的 IPC 是否是**同一套**授权规则。

在测出来之前，不能假设 Mock Provider 能连 `127.0.0.1` 就代表受限 Worker 也能连本机服务。

---

## 4. 本计划的产出物

| 产出 | 位置 |
|---|---|
| 变更影响与回滚风险清单 | [P0B2-SANDBOX-PROVISION.md](P0B2-SANDBOX-PROVISION.md) |
| 本验证计划 | 本文 |
| readiness 探针 | `tools/probes/sandbox-readiness.mjs` |
| 工具调用探针（含身份/越权用例） | `tools/probes/mock-tool-caller.mjs` |
| 证据记录 | [EVIDENCE.md](EVIDENCE.md) |
