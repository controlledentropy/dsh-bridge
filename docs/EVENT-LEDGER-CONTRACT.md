# 最小数据契约（B2 编码前固定）

> 状态：**草案，仅够 B2 建表**。不实现 Coordinator 行为，只固定 ID 归属、状态与关联字段。
> 目的：避免 SQLite 账本写完之后，被 B3 的恢复语义和 B4 的授权模型推翻主键。

---

## 0. 两条贯穿全局的规则

**规则 1 · 三种进度不可互相推导。**
`源游标已落盘` ≠ `派单已提交` ≠ `Codex 已消费`。三者各自有独立字段，任何"由 A 推出 B"的写法都是缺陷。

**规则 2 · 事件主键必须含源代际。**
`eventKey = (topicId, sourceGeneration, seq)`。
`connectionEpoch`（第几次连上 WS）**不参与**主键——重连不等于源数据重建，同一事件不能因重连变成两条。

---

## 1. 实体与 ID 归属

| 实体 | ID 由谁生成 | 说明 |
|---|---|---|
| `goal` | **Coordinator** | 用户经可信入口授权后生成；模型只能提交 `goalRequest`，不得传权威 ID |
| `task` | Codex | 规划产物，可自由；不与权限挂钩 |
| `dispatch` | **Coordinator** | 权威派单标识；模型给的 `requestId` 仅作客户端幂等键 |
| `attempt` | Coordinator | 每次外部 RPC 尝试一行，只追加 |
| `event` | dsh（`seq`） | 补 `topicId` + `sourceGeneration` |
| `delivery` | Coordinator | 投递给 Codex 的通知记录 |
| `codexTurn` | Codex | 被唤醒的 turn；与 `delivery` 关联 |

---

## 2. 状态机（最小集）

```
goal:      proposed → authorized → running → paused | completed | budget_exhausted
                          └──────────────┴──────────────→ needs_human
dispatch:  pending → admitted → submitted → settled
                          └────→ rejected
attempt:   INTENT → SENT_ACKED | SENT_REJECTED | SENT_UNKNOWN
delivery:  pending → submitted → delivered
                        └────→ uncertain
consumption: unseen → acked
```

**硬规则**：

- 只有 `goal.state = authorized`（及其后续执行态）允许新 dispatch。
- `maxRounds` 的扣减与 `dispatch` 的 INSERT **在同一事务**内完成。
- `attempt` 一旦进入 `INTENT`，**不存在"未发送"的推断**；没有决定性证据一律 `SENT_UNKNOWN`，转 `UNCERTAIN`。
- `delivery.delivered` **不能**推出 `consumption.acked`。

---

## 3. 表结构（SQLite，仅关键列）

```sql
-- 游标属于「代际」，不属于「会话」。
-- B2 实测暴露的缺陷：若 topic_id 单列做主键，一个会话无法同时保存两个代际的游标，
-- 源重建后旧代际的恢复位置会被覆盖。主键改为 (topic_id, source_generation)。
CREATE TABLE topic (
  topic_id           TEXT NOT NULL,         -- 'session:<sessionId>'
  source_generation  INTEGER NOT NULL,      -- 源代际；重建/重置时 +1
  cursor             INTEGER NOT NULL,      -- 连续已确认前缀（不是 MAX(seq)）
  health             TEXT NOT NULL,         -- live | stalled | gap | down
  last_frame_at      TEXT,
  PRIMARY KEY (topic_id, source_generation)
);

-- 原始事件：主键含源代际
CREATE TABLE event (
  topic_id           TEXT NOT NULL,
  source_generation  INTEGER NOT NULL,
  seq                INTEGER NOT NULL,
  type               TEXT NOT NULL,
  at                 TEXT NOT NULL,
  turn               INTEGER,
  step               INTEGER,
  data               TEXT NOT NULL,         -- 原样 JSON
  PRIMARY KEY (topic_id, source_generation, seq)
) WITHOUT ROWID;

-- 缺口：缺失的 seq 闭区间。出现时必须可见，不得静默推进 cursor。
CREATE TABLE gap (
  topic_id TEXT NOT NULL, source_generation INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL,   -- 缺失区间，不含已观测到的高位 seq
  discovered_at TEXT NOT NULL, reason TEXT,
  PRIMARY KEY (topic_id, source_generation, from_seq)
);

CREATE TABLE goal (
  goal_id TEXT PRIMARY KEY, state TEXT NOT NULL,
  max_rounds INTEGER NOT NULL, rounds_used INTEGER NOT NULL DEFAULT 0,
  allowed_workspaces TEXT NOT NULL,        -- JSON array
  created_at TEXT NOT NULL, expires_at TEXT
);

CREATE TABLE dispatch (
  dispatch_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL, task_id TEXT, topic_id TEXT,
  client_request_id TEXT,                  -- 幂等键，非权威
  cwd TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE attempt (
  attempt_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL,
  target TEXT NOT NULL,                    -- 'dsh:session/prompt' | 'codex:thread/queue/add'
  state TEXT NOT NULL,                     -- INTENT | SENT_ACKED | SENT_REJECTED | SENT_UNKNOWN
  remote_ref TEXT, proof TEXT, decided_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE delivery (
  delivery_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL,
  codex_instance_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  state TEXT NOT NULL, consumption TEXT NOT NULL DEFAULT 'unseen',
  created_at TEXT NOT NULL
);

CREATE TABLE codex_turn (
  turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
  delivery_id TEXT, started_at TEXT, status TEXT
);
```

---

## 4. 游标语义（B2 必须验证）

`cursor` = **连续已确认前缀的最后一个 seq**，不是 `MAX(seq)`。

| 情形 | 行为 |
|---|---|
| 收到 `seq = cursor + 1` | 落盘并推进 cursor；若洞已被填平，继续沿已持有事件向前推进 |
| 收到 `seq > cursor + 1` | **落盘保存，但计入 held，不推进 cursor**；记录缺失区间，等下方洞补齐后自动晋升 |
| 收到 `seq <= cursor` | 幂等丢弃（同代际） |
| 重复收到已 held 的 seq | 幂等丢弃，仍计入 held |
| 收到不同 `source_generation` | 新行，不覆盖旧代际 |
| 初始 cursor | `-1`（表示"尚未收到任何事件"），因为 dsh 首个事件是 `seq = 0` |

**乱序不等于丢弃。** 拒绝入库与丢弃在观测上是同一件事：重连后的重放会把洞补齐，却再也看不到那条曾经抵达过的事件，cursor 便从数据上碾过去了。因此：

- `event` 表保存**所有**抵达过的事件；`cursor` 只表达**连续已确认前缀**。
- `held`（`seq > cursor`）是暂存区，不是待办：洞一闭合，它们由算术自动并入前缀，无需二次写入。
- `gap` 记录的是**缺失的 seq 区间**（`from_seq..to_seq` 闭区间），不是"观察到的高位 seq"。
- 缺口被**部分**填补时必须**收窄**，不得整行删除；只有区间为空才允许 `health` 回到 `live`。


**注意**：`-1` 而不是 `0`。若用 `0`，则"还没收到 seq=0"与"已收到 seq=0"无法区分——
这正是审计要求的"初始 cursor 定义必须与 DSH 实际序号规则一致"。

---

## 5. 本契约明确不做的事

- 不实现 Coordinator 调度逻辑（B3/B4）。
- 不实现重试策略（`UNCERTAIN` 一律转人工，见 B3）。
- 不定义跨机部署（单机 Mutex/管道范围）。
- 不定义 DSH 侧写入协议（那是 `session/prompt` 的既有契约）。

---

## 6. 实测对契约的修订（2026-10-21）

跑实现与补测时暴露了四处契约缺陷，已修。前两处由写断言时发现，后两处更危险——它们最初被**写成通过的断言**，等于把缺陷声明成了期望行为：

| 缺陷 | 现象 | 修正 |
|---|---|---|
| 游标挂在 `topic_id` 上 | 同一会话两个源代际只能保存一个 cursor；测试直接撞 `UNIQUE constraint failed` | 主键改为 `(topic_id, source_generation)` |
| 缺口清理条件写反 | 填洞后 cursor 已到 12，但 gap 表仍残留 1 行；`health` 永远停在 `gap` | 由 `(cursor, 已持事件)` 重算区间；无剩余缺口才复位 `live` |
| **乱序事件被丢弃** | 原实现拒绝 `seq > cursor+1` 且不落盘，并断言"未存储"。重连重放补洞后，该事件永久消失，cursor 越过已抵达过的数据 | 所有抵达事件落盘；仅 cursor 表示前缀；held 由算术晋升 |
| **缺口部分填补被整行删除** | 2..11 的洞填到 6 时，gap 行被删空，`health` 报 `live`，而 7..11 仍缺失 | 区间按实际持有重算，部分填补只收窄 |

第三、四处值得单独记下：**cursor 正确、gap 表错误的组合会让系统看起来"恢复了"，实际仍在报告缺口。** 两者必须由同一次写入更新，否则进度视图与账本会互相矛盾——现在的实现让这种不一致无法表达，而不是靠断言去追。

