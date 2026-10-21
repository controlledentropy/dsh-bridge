# P0-b2 · Windows Sandbox Provision 变更影响与恢复风险清单

> 状态：**静态取证结论**。本清单不含任何已执行的系统级变更；所有条目来自固定版本
> `codex-cli 0.160.0` 的二进制字符串、本机既有 setup 日志、以及当前系统状态的只读清点。
>
> 用途：决定 provision 是否/在哪里执行，以及执行前必须准备什么才能回滚。

---

## 1. Provision 会触及什么（证据分级）

| 对象 | 证据 | 级别 |
|---|---|---|
| Windows 本地账户 | setup 二进制含 `NetUserAdd`；日志 `ensuring sandbox users offline=CodexSandboxOffline online=CodexSandboxOnline` | **已观测** |
| 本地组成员 | 二进制含 `NetLocalGroupAddMembers`；本机 `CodexSandboxUsers` 已有两名成员 | **已观测** |
| 防火墙规则 | 日志逐条记录 `firewall rule configured name=codex_sandbox_offline_block_*`（loopback_tcp / loopback_udp / outbound / inbound） | **已观测** |
| WFP 过滤器 | 日志 `WFP setup succeeded for CodexSandboxOffline with 12 installed filters`；二进制含 `FwpmFilterAdd` | **已观测** |
| 文件/目录 ACL | 二进制含 `SetNamedSecurityInfo`（3 次）与 `ACL`（24 次）；日志有 `read-acl-only mode: applying read ACLs` | **已观测（范围未定）** |
| per-HOME 状态目录 | 真实 home 有 `.sandbox` / `.sandbox-secrets` / `.sandbox-bin`；隔离 home 三者皆无 | **已观测** |
| 账户密码材料 | `.sandbox-secrets/sandbox_users.json` 含加密的 `password` 字段 | **已观测（未解密、未读取内容）** |

**关键判断：provision 不是 per-HOME 操作。** 账户、组成员、防火墙、WFP 都是主机级资源；只有
`.sandbox*` 目录跟着 HOME 走。这与审计第 2 点的判断一致，也是本清单存在的理由。

---

## 2. 本机当前状态（只读清点，2026-10-21）

| 项 | 状态 |
|---|---|
| `CodexSandboxOffline` | 存在，Enabled=True，SID …-1004，lastLogon 2026-10-06 |
| `CodexSandboxOnline` | 存在，Enabled=True，SID …-1005，从未登录 |
| `CodexSandboxUsers` | 存在，SID …-1003，含上述两个账户 |
| `~/.codex/.sandbox` `-secrets` `-bin` | 全部存在 |
| 隔离 home 的 `.sandbox*` | **全部缺失**，只有过期的 `.sandbox_migration` |
| `.sandbox-bin` 内的 helper | `codex-command-runner-{0.159.0, 0.159.2, 0.160.0}.exe` |
| 已安装 setup helper | `%LOCALAPPDATA%\OpenAI\Codex\bin\896a0166b774037a\codex-windows-sandbox-setup.exe`，SHA256[:16]=`C4DA812016CBFB92` |
| 我们钉住的 vendor setup helper | 同一文件名，SHA256[:16]=`8F91D62ACA2ACA87`——**二进制内容不同** |

**这个差异只能证明二进制不同，不能证明会安装第二套沙箱。** 两个 helper 完全可能操作同一组固定
账户名、同一批防火墙规则名（`codex_sandbox_offline_block_*`）和同一份凭据文件，做的是原地
修复/迁移/升级。哈希不同不构成"资源命名空间独立"的证据。

准确的结论是：**当前存在两个不同的 setup 二进制，而它们对同一组命名资源的安装、升级、回滚语义
尚未被证明兼容，因此不应在真实主机上混用执行。** 这已足以支持"不在本机 provision"的决定。

---

## 3. 已观测过的失败模式（来自本机日志，非推测）

1. **需要提权才能 spawn setup**
   `setup refresh: failed to spawn … codex-windows-sandbox-setup.exe: The requested operation requires elevation`
   → 非提权路径**不一定**能完成 provision。
2. **锁目录失败**
   `setup error: helper_sandbox_lock_failed: lock sandbox bin dir \\?\C:\Users\MMGA\.codex\.sandbox-bin failed: open directory`
   → provision 会**中途失败并留下部分状态**。
3. **重复 provision 是常态**
   日志中 "ensuring sandbox users" 在数天内出现多次，说明 setup 会被反复刷新；
   每次都改账户/防火墙。

---

## 4. 恢复风险：为什么"账户+防火墙快照"不足以回滚

| 变更 | 能否简单回滚 | 说明 |
|---|---|---|
| 本地账户 | 部分 | 可删账户，但**已产生的 SID 引用**（防火墙授权列表、ACL、凭据缓存）会变成孤儿 SID |
| 本地组成员 | 部分 | 同上 |
| 防火墙规则 | 是 | 按名字删除可行（规则名固定为 `codex_sandbox_offline_block_*`） |
| **WFP 过滤器** | **可以删除，但难以完整回滚** | WFP 提供 `FwpmFilterDeleteById0` / `FwpmFilterDeleteByKey0` 等删除接口。真正的困难不是"没有接口"，而是：是否完整记录了 filter id / key / provider 与所有关联对象；哪些规则本来就存在；失败时是否只完成了一部分操作 |
| **目录 ACL** | **否（困难）** | `SetNamedSecurityInfo` 改的是继承链；上游有报告称 setup 递归改到用户配置目录。**原始 DACL 若不预先导出，无法精确还原** |
| `.sandbox-secrets` 加密材料 | 否 | 删掉即失效，但若已绑进凭据缓存，需重新 provision |
| 已安装 setup helper | 是 | 可删除目录，但已写入的状态文件仍在 home 里 |

**结论：系统提供了局部撤销机制，但当前不存在经过验证的完整事务回滚方案。** 一次 provision 的
可靠回滚需要"事前导出 DACL/WFP/账户 + 事后逐项比对"，而不是事后凭记忆撤销。在没有系统快照的
环境里，失败代价是"机器上留下一套半配置的沙箱"，且可能影响真实 Desktop Codex 的既有沙箱。

---

## 5. 因此本清单的结论

1. **不在承载真实业务的主机上执行 provision。** 理由不是"怕出问题"，而是**回滚成本与其收益不对称**：
   P0-b2 要证明的是"机制可实施"，而本机已经证明机制存在（账户/WFP/ACL 都在）。
2. **优先在可快照的独立 Windows 环境执行**（VM 或可整体还原的测试机）。
3. 若暂无独立环境，**P0-b2 保持阻塞**，同时把不依赖真实 Shell 的部分（Adapter/IPC 合成验证）并行推进。

---

## 6. 前置条件（若将来在任何机器上执行 provision）

执行前必须：

- [ ] 导出目标机器的账户列表、组成员、以及 `%LOCALAPPDATA%\OpenAI\Codex\bin` 的 ACL
- [ ] 导出 `codex_sandbox_*` 防火墙规则与 WFP 过滤器清单
- [ ] 导出沙箱将触及的目录树的 DACL（至少 `~/.codex`、工作区根、`%LOCALAPPDATA%\OpenAI`）
- [ ] 确认可用的系统快照/还原点
- [ ] 记录 pinned helper 的 SHA256，确保与已安装 helper 的关系被显式说明

执行后必须核验：

- [ ] `windowsSandbox/setupCompleted.success`
- [ ] `windowsSandbox/readiness` 变为 `ready`
- [ ] **实际**受限 Shell 能执行一条无害命令（不是仅 readiness 通过）
- [ ] 该 Shell 进程的真实 Windows 身份
- [ ] 越权文件访问被拒、越权网络访问被拒
- [ ] 与事前快照逐项比对，列出所有未预期变更