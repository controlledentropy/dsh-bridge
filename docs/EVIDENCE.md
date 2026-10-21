# Evidence log

Facts this project's design rests on, with the command that re-derives each one. The purpose is the
same as [API-CONTRACT.md](API-CONTRACT.md): an upgrade, or a new hand-over, should rebuild the
evidence in minutes instead of trusting an old assertion.

Every entry records **what was run, on what version, and what it does not prove**. An entry that
cannot state its own limits is a claim, not evidence.

Probes live in `tools/probes/`. None of them calls a model, dispatches work, or writes outside
`.state/`.

---

## E-SEQ · A dsh session log numbers its events densely from 0

```bash
node tools/probes/seq-contiguity.mjs --json
```

**Measured 2026-10-20**, dsh `0.2.1-rc.2`, Node `24.21.0`:

| | |
|---|---|
| logs decoded | **107 / 107** |
| contiguous from seq 0 | **107 / 107** |
| gaps / duplicates | **0 / 0** |
| events | 48,086 |
| distinct event types | 48 |

**What this supports.** Within a session log, `seq` is a dense 0..N numbering, so a missing number
is a genuinely missed frame rather than an unused one. That is what makes a *contiguous prefix*
resume cursor meaningful, and what makes gap detection do any work at all.

**What it does not prove.**

- Nothing about `session/follow`. The WebSocket view may filter, coalesce or renumber, and must be
  measured on its own before a cursor depends on it.
- A snapshot of logs on this machine at this version. Not a compatibility promise.
- Logs being written *concurrently* were not the subject of this run.

---

## E-SINGLE · A named pipe is a real single-instance claim on Windows, released only by process death

```bash
# terminal 1
node tools/probes/single-instance.mjs --hold probe-lock
# terminal 2, while terminal 1 is running
node tools/probes/single-instance.mjs --try probe-lock      # claimed:false, code:EADDRINUSE
# kill the holder, then:
node tools/probes/single-instance.mjs --try probe-lock      # claimed:true, immediately
```

**Measured 2026-10-20**, Node `24.21.0`, Windows 11:

| property | observation |
|---|---|
| mutual exclusion | second `listen()` on the same name fails with `EADDRINUSE` |
| dies with the process | after `taskkill /F` of the holder, the name is re-claimable at once, with no cleanup step |
| **no auto-release while wedged** | with the holder **suspended** (not killed), a second claim still fails `EADDRINUSE` |
| nothing to reap | the holder leaves no file behind, so there is no stale lock to age out |

The third row is the one that decides the design. A lease that expires on a missed heartbeat hands a
second process the right to issue external RPC while the first is merely paused - that turns a
liveness policy into a duplicate-delivery mechanism. A kernel claim cannot do that: a wedged holder
still holds it, so "refuse to start and escalate to a human" is the default rather than something
someone has to remember to implement.

**What it does not prove.**

- **Pipe access control is unverified.** An unrelated same-user process attempting to *connect* was
  denied with `EPERM`, but that probe ran inside a confined agent sandbox which blocks named-pipe
  client connections, so the denial cannot be attributed to the pipe's security descriptor. Treat
  "who may connect to the IPC pipe" as open, and require an explicit authorization handshake rather
  than relying on the default ACL.
- The pipe object's security descriptor was not inspected.
- Session-local versus global namespace behaviour was not exercised (default namespace only).

---

## E-CODESIGN · Codex 0.160.0 still ships the experimental queue methods

```bash
codex app-server generate-json-schema --experimental --out .state/schema
```

**Measured 2026-10-20**, `codex-cli 0.160.0`: 440 schema files, of which **13** are queue-related -
`ThreadQueue{Add,Start,List,Update,Delete,Reorder}{Params,Response}` plus `ThreadQueueChangedNotification`.
A `sqliteHome` setting also appears in the config surface.

**What this does not prove.** Generated schema is a compile-time artifact. It does not show that this
build negotiates `experimentalApi` at runtime, that `queue/add` on an idle thread starts a turn (the
E3/E4 behaviour), or that a busy thread queues without steering. Those are runtime facts and belong
to P0-b1.

---

## E-DSHHOME · Where dsh resolves its user-data root, and what that does not buy

Read from source, `dsh-home-paths/lib/index.js`:

```js
resolveRoot(configured, env, 'DSH_HOME', () => join(homedir(), '.dsh'))
// configured ?? (env non-empty ? env : ~/.dsh)
```

`dsh --profile web --dump-config` records **no** `dshHome` override on this machine, so today
`$DSH_HOME` decides.

**Consequences for test isolation, both of which cost something.**

- `DSH_HOME` alone cannot be claimed as isolation: the resolved root must be shown to be the root
  the running process actually uses, because an explicit config value outranks the environment.
- A fresh root has no `profiles/` tree, and profiles are pnpm-installed plugin bundles (including
  third-party ones) rather than shipped files. An isolated instance therefore needs a bootstrap step,
  and that step is network and disk activity, not a flag.
- Credentials live under the resolved root, so an isolated root has none. That makes a mock provider
  the only zero-cost way to run a model turn there - and "isolated" must not be reported as "free".

---

## E-CODEX-ISO · An isolated Codex instance writes only to its own roots

```bash
# the probe script used here is .state/p0b1-*.ps1 (not promoted: it embeds machine paths).
# The runtime half is tools/probes/codex-isolated-runtime.mjs.
CODEX_HOME=<root>/codex-home CODEX_SQLITE_HOME=<root>/codex-sqlite \
  codex.exe app-server --listen ws://127.0.0.1:PORT --ws-auth capability-token --ws-token-file <tok>
```

**Measured 2026-10-20**, `codex-cli 0.160.0`, Node `24.21.0`, Windows 11.

| observation | result |
|---|---|
| `initialize` echoes the home it actually uses | `codexHome = <root>\codex-home` — **the effective path, not the env var** |
| all five databases created under the isolated sqlite home | `goals_1, logs_2, memories_1, queue_1, state_5` (+ `-shm`/`-wal`), **none elsewhere** |
| `thread/list` on the fresh instance | **0 threads** |
| **positive control: real `~/.codex` file fingerprint** | **identical before / during / after the whole run** |

The positive control is the point. "The isolated home got files" shows a write happened; the
unchanged fingerprint of `~/.codex` shows it did **not** also happen to the Desktop's state.

**Bring-up cost, measured:** a fresh `CODEX_HOME` is not empty-able. On first boot Codex materialises
`skills/.system/*` (imagegen, openai-docs, review-agent, skill-creator, skill-installer), `installation_id`,
`.tmp`, `tmp` — **2.8 MB** of seeded content. So "isolated" is not "free": it has a bootstrap footprint
that must be budgeted in the P0-b setup, and it means the first boot is slower than later ones.

**What it does not prove.**

- `CODEX_SQLITE_HOME` was honoured **with no `sqliteHome` in a config.toml** (the isolated home has no
  config). Whether a `config.toml` value *outranks* the environment variable was **not tested**; the
  startup self-check must therefore read the effective path from `initialize`, never from the env.
- Read-only sandbox / `approvalPolicy: never` were passed on `thread/start` and accepted, but no turn
  was ever started, so "the permission took effect during execution" is **not** verified here.
- The isolated home has **no `auth.json`**, which is exactly why no turn was started: without
  credentials a turn cannot run. The credential question (E5-C) remains **open**.

---

## E-CODEX-QUEUE · The experimental queue surface answers on 0.160.0, and an unknown thread is refused

Runtime, against the isolated instance above (never against the Desktop's):

| call | result |
|---|---|
| `initialize` with `capabilities.experimentalApi: true` | accepted |
| `thread/start` (isolated cwd, read-only, approvalPolicy never) | `01a159a4-…`, model `gpt-6.1-sol` |
| `thread/queue/list` on our own thread | `{"data":[],"nextCursor":null}` |
| `thread/queue/list` on an unknown id | `-32603 "failed to read thread: … no rollout found for thread id"` |
| `thread/loaded/list` | `["01a159a4-…"]` |

Two things this settles:

1. The queue RPCs are not merely present in the schema — they **answer** on this build without a
   turn having been started, so a Coordinator can inspect a queue before doing anything.
2. **An unknown thread id is refused with a typed error**, not silently accepted. That is the exact
   failure mode E6 needed and did not get: in E6 a cross-instance `queue/add` was accepted because
   both processes shared one home. Here the store is per-home, and the refusal is the default.

**What it does not prove.**

- **`thread/queue/add` was deliberately not called.** E4 measured "queue/add on an idle thread starts
  a turn"; that behaviour is still unverified on 0.160.0, because it requires either credentials or a
  mock provider. This remains the first item of P0-b1 proper.
- `thread/list` returned 0 both before and after `thread/start`, while `thread/loaded/list` showed the
  thread. Thread listing and thread loading are different views; a Coordinator must not use
  `thread/list` as a liveness signal until that difference is characterised.
- `seq` density of the *follow stream* is still unmeasured (E-SEQ covers on-disk logs only).

---

## E-CODEX-TRAPS · Three behaviours a Coordinator will trip over

Found while running the probes above; each is a fact about this build, not a preference.

### 1. `--version` writes into `CODEX_HOME`

Without `CODEX_HOME` set, even a version probe emitted
`WARNING: proceeding … could not create PATH aliases … at path "C:\Users\MMGA\.codex\tmp\arg0\codex-arg0…"`.

With `CODEX_HOME` set to an isolated directory, the same command created `<isolated>/tmp` and stayed silent.

**Consequence:** there is no "harmless" Codex invocation. Every probe, including a version check, must
have the isolated `CODEX_HOME` in place *first* — otherwise it reaches into the Desktop's state before
any evidence is collected.

### 2. `thread/list` and `thread/loaded/list` disagree

After `thread/start`, on the isolated instance:

| call | result |
|---|---|
| `thread/list` | `data: []` — still empty |
| `thread/loaded/list` | `["01a159a4-…"]` |

**Consequence:** `thread/list` is not a liveness or existence signal. A Coordinator that polls
`thread/list` to decide "is my thread still there" will read a live thread as missing. The reason for
the divergence is not characterised here and must not be guessed at.

### 3. A custom model provider is configurable, but no mock ships with the build

The binary contains `model_providers`, `base_url`, `env_key`, `requires_openai_auth`, `http_headers`,
`query_params` and `wire_api` (`"responses"` / `"chat"`). It contains **no** `mock_provider` and no
literal `"mock"`.

**Consequence:** "zero-cost model turn" is achievable, but only by standing up a local server and
declaring it as a provider in the isolated `config.toml` with `requires_openai_auth = false`. It is not
a flag. Until that exists, any turn would need credentials — which is why none was started.

---

## E-CODEX-QUEUE-RUNTIME · P0-b1 acceptance, on an isolated 0.160.0 with a local mock provider

**Setup.** Pinned `codex-cli 0.160.0` binary copied into `.state/p0b1/vendor/` (sha256[:16]
`FDDA5FA3CF3FB3D0`); isolated `CODEX_HOME` and `CODEX_SQLITE_HOME`; `config.toml` declares a custom
provider with `requires_openai_auth = false`, `supports_websockets = false`, `request_max_retries = 0`,
`stream_max_retries = 0`; the provider is `tools/probes/mock-responses-server.mjs`, listening on
`127.0.0.1` on a random port and counting every request it serves. **No credential exists in that home
and no request left the machine.**

| id | claim | result |
|---|---|---|
| **A1** | a turn completes against the mock | ✅ one `POST /v1/responses`, SSE stream, `response.completed` |
| **A2** | `queue/add` on an **idle** thread starts a turn **by itself** | ✅ `turn/started` → `turn/completed` → 1 model call, **no `turn/start` ever sent** |
| **A3** | `queue/add` while **busy** queues instead of steering | ✅ 1 pending item while busy; no completion at the moment of add; then **2 distinct turn ids, 2 model calls** |
| **A4** | the queued message becomes its **own** turn carrying its own input | ✅ call #1 has **M1 only**; call #2 has **M1+M2** and **not** a later marker |
| **A5** | which view knows the thread | ✅ `thread/list` = 3 rows under a **separate `vscode` app-server**, 0 under the test instance — see below |
| **A5b** | after an app-server **restart** | ✅ `loaded/list` empty, `thread/list` still 3, `thread/read` → `status: notLoaded`, `queue/list` still readable |
| **A6** | nothing reached the real environment | ✅ real `~/.codex` fingerprint identical before/after |

### What A3 actually rules out, and how

The danger being tested is **steer**: the second input joining the turn already running.

The load-bearing evidence is **two distinct turn ids with complete, separate lifecycles**, plus the
second message not appearing in the first turn's model request, plus queue consumption order
(1 pending while busy → 0 after). Measured: 2 distinct turn ids, each with its own
`turn/started`/`turn/completed`, 1 pending item during the busy window, 0 after.

Model-call count is **auxiliary, not sufficient**: a single turn can legitimately issue more than one
model request, and a steer changes how the running turn continues rather than necessarily collapsing
one request. It happened to be 2 here, and that is reported as an observation, not as the proof.

A second caveat on attribution: the second call carries `M1+M2` because conversation history
accumulates. That does **not** mean the second turn costs only the second message — the whole prior
conversation is re-sent. A one-line completion notification still costs a full-context turn.

### A5 / A5b: thread/list is not an existence signal, and `sourceKinds` does not explain it

Observed on the isolated instance:

| | |
|---|---|
| `thread/list` (default) | **returns rows, but they belong to a different app-server** |
| `thread/list` with `sourceKinds: ['appServer']` | 0 of ours |
| `thread/list` with `sourceKinds: ['vscode']` | **all of them** |
| `thread/loaded/list` | our thread id, while it is open |
| after restart | `loaded/list` empty; `thread/read` → `notLoaded`; `thread/list` unchanged |

Two conclusions, both of which change the Coordinator's design:

1. **`thread/list` and `thread/loaded/list` answer different questions and can disagree in both
   directions.** The list rows are persisted session records; the loaded set is what this process has
   open. A Coordinator must keep its **own** registry of threads it created, and must not infer
   "my thread is gone" or "my thread is running" from `thread/list`.
2. **`notLoaded` is the normal state after a restart, not an error.** `thread/read` still answers, and
   `queue/list` is still readable, so a cold thread is addressable — it simply is not resident.

**This does not prove** that `queue/add` on a cold (not-loaded) thread behaves the same as on a loaded
one. That distinction is measured separately in E-CODEX-COLD-RESUME, and it does **not**: a cold
thread accepts the item without waking.

### Standing rules this established

- **No Codex invocation happens before the isolated roots exist.** `--version` alone writes into
  `CODEX_HOME` (E-CODEX-TRAPS 1). Probe scripts set the environment in a parent scope, first.
- **The mock counts requests; the test asserts on the count.** Any queue claim that cannot be tied to
  a model call is not evidence.
- **The mock's log keeps a 160-char preview and a separate full-input file.** Attribution ("did turn 2
  carry the second message") is undecidable from a preview — this cost one wrong measurement before it
  was fixed.

---

## E-CODEX-COLD-RESUME · A2c: a cold thread is not woken by `queue/add`, but `resume` dispatches

Upstream reports this behaviour (a queued submission persists for an unloaded thread, and resume
dispatches it). **That is upstream, not this binary**, so it was measured here on the pinned
`0.160.0` before any recovery design depended on it.

**Setup.** Seed thread created and settled in one app-server session, then the app-server was
**stopped and restarted** so the thread was genuinely cold (`thread/read` → `notLoaded`,
`thread/loaded/list` without it). Same isolated home, same mock provider.

### A2c-1 · `queue/add` on a cold thread

| observation | result |
|---|---|
| RPC outcome | **accepted** — `queuedSubmission` returned with an id |
| queue length afterwards | **1** — the item is persisted |
| `turn/started` | **0** |
| model calls | **0** |
| thread state afterwards | **still `notLoaded`** |

**A cold thread accepts a queued message and does nothing with it.** This is the single most
important operational fact of P0-b1: a Coordinator that only appends to the queue will silently
accumulate work on any thread that is not currently loaded.

### A2c-2 · `thread/resume` with a persisted queued item

Called on the same cold thread, **without submitting a second message**:

| observation | result |
|---|---|
| `thread/resume` | ok, thread status `idle`, **history loaded** (1 prior turn returned) |
| model calls | **1** |
| `turn/started` | **1** |
| `turn/completed` | **1** |
| queue afterwards | **0** — drained |
| thread state | **now loaded** |

**`thread/resume` is an execution-triggering operation, not a read.** It consumed the persisted
submission and ran a turn, without any further input.

### Consequences for the Coordinator (design constraints, not preferences)

1. **Recovery must resume, and resume must be gated.** Because resume can execute queued work, it has
   to sit behind the same authorization a dispatch does: goal still authorized, budget available,
   single-executor claim held, no stop state active. A blanket "resume every known thread on boot"
   would start model turns as a side effect of a restart.
2. **Queue size is not a measure of delivered work.** An item can sit in a cold thread's queue
   indefinitely. "Accepted" and "executed" are separated by a resume that may never come.
3. **The 0.160.0 behaviour matches the reported upstream behaviour** — useful, but the compatibility
   list has to be re-checked per version, because this is precisely the kind of semantic that can
   change without a protocol change.

**What this does not prove.** Whether a *partially completed* turn survives a restart (rollout replay
vs. resumption) was not tested; only a settled thread was. That belongs to P0-b4.

---

## E-CODEX-SANDBOX · The Windows sandbox exists on this machine, and it blocks the shell

P0-b2 is about whether the managed Codex can be constrained at the OS level. The first finding is that
on this machine the machinery is already present — so the question is not "can we build it" but "does it
actually contain the tool subprocess".

### What is already installed

| object | detail |
|---|---|
| local users | `CodexSandboxOffline` (SID …-1004), `CodexSandboxOnline` (…-1005) |
| group | `CodexSandboxUsers` (…-1003), both accounts are members |
| per-user ACL | the sandbox temp directory grants `LG-G8-LINUXMINT\CodexSandboxUsers: Modify` |
| network isolation | firewall rules `codex_sandbox_offline_block_{loopback_tcp,loopback_udp,outbound,inbound}`, scoped by `LocalUserAuthorizedList` to SID …-1004 |
| WFP | `WFP setup succeeded for CodexSandboxOffline with 12 installed filters` |
| selection mode | `Windows sandbox selection: unelevated`, `MXC availability: false` |

So the design intent is real and OS-enforced: a separate low-privilege identity, a WFP/firewall fence,
and an ACL on the scratch area. This is not environment-variable separation.

### The tool subprocess is refused, not run

A mock model that calls `exec_command` once produced, verbatim:

```
exec_command failed: CreateProcess { message: "Rejected(\"`\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'whoami;'` rejected: blocked by policy\")" }
```

**The command did not execute.** This is the desired direction for isolation, and it is a fact about the
subprocess, not about the config file — which is exactly the distinction the P0-b2 brief asked for.
It also means "the tool surface exists" and "the tool can do things" are different claims; the
`exec_command` schema is advertised to the model regardless.

**Not yet explained:** why it is refused under `workspace-write` with `approval_policy = never`.
Possibilities not yet distinguished: the unelevated sandbox mode cannot launch a shell at all in this
build; the empty isolated home confounds the sandbox's user-materialisation path (the setup log shows a
prior `helper_sandbox_lock_failed` for the *real* home); or an approval path rejects a shell it cannot
sandbox. **This must be resolved before "workspace-write containment is verified" can be claimed** —
a sandbox that simply cannot start a shell proves nothing about containment.

### A real environment-inheritance leak, found by accident

The first attempt at the same probe failed differently and for a more interesting reason:

```
Rejected("\"C:\\Users\\MMGA\\.dsh\\profiles\\web\\node_modules\\@dsh-ops\\pwsh-win32-x64\\bin\\pwsh.exe\" -Command 'whoami;'")
```

The isolated Codex picked **DSH's bundled PowerShell**, not the system one. Cause: this agent process's
`PATH` begins with `C:\Users\MMGA\.dsh\profiles\web\node_modules\@dsh-ops\pwsh-win32-x64\bin`,
and `Codex.exe` was started from that process. Removing that PATH entry changed the chosen shell to
`System32\WindowsPowerShell\v1.0\powershell.exe` — so the parent's environment really does decide
which shell the child tries to run.

**Consequence for P0-b3/P0-b4:** a managed Codex must be started with a **scrubbed environment**
(`DSH_HOME`, `DSH_PROFILE_DIR`, `PSModulePath`, and `PATH` entries pointing at DSH's own bundle), or it
will execute against the Coordinator's toolchain. This is the same class of bug as E6 — a shared
resource was mistaken for an isolated one — caught here before it caused damage.

### What this section does not claim

- It does not show `workspace-write` contains file writes; no command ran.
- It does not show the read path is contained either.
- It does not show the firewall rules are effective for a *managed* instance; they are scoped to a SID
  that a fresh `CODEX_HOME` may not use.

---

## E-CODEX-SANDBOX-ROOT-CAUSE · Why `exec_command` was refused

The previous section recorded the symptom. This one locates the layer.

### The probe that decided it

`windowsSandbox/readiness` is a first-class RPC (schemas `WindowsSandboxReadinessResponse`,
`WindowsSandboxSetupStartParams`), so the backend's state is queryable **without running a command and
without a model**:

```bash
node tools/probes/sandbox-readiness.mjs <ws-url> <token-file>
```

**Measured against the isolated `CODEX_HOME`:**

```json
{"status":"notConfigured"}
```

The enum is `ready | notConfigured | updateRequired`. The isolated home reports **notConfigured**.

### Why that produces `blocked by policy`

The isolated home contains only `.sandbox_migration` (a stale migration marker) and **none of** the
three artefacts the real home has:

| artefact | real `~/.codex` | isolated home |
|---|---|---|
| `.sandbox` (logs, deny-read ACL state) | present | **absent** |
| `.sandbox-secrets` (`sandbox_users.json`) | present | **absent** |
| `.sandbox-bin` (command-runner helpers) | present | **absent** |

The binary contains the strings `CodexSandboxOffline` / `CodexSandboxOnline` (3 occurrences each) and
`sandbox_users.json`, so provisioning is per-`CODEX_HOME`. A fresh home therefore has **no sandbox
accounts to run commands under**, and the execution policy refuses rather than running unsandboxed —
which is the correct fail-closed behaviour, and it surfaces as `Rejected(… blocked by policy)` **before
any process is created**.

### Three layers, now separated

| layer | verdict | evidence |
|---|---|---|
| Windows accounts / WFP / ACL | **provisioned** | `CodexSandboxOffline`/Online, `CodexSandboxUsers`, 12 WFP filters, firewall rules |
| sandbox *backend* for a given home | **not provisioned** | `windowsSandbox/readiness → notConfigured` |
| execution policy | **fail-closed, correct** | command refused pre-creation under `approval_policy = never` |

So the earlier guess ("PowerShell cannot start in the sandbox") was wrong. Nothing was attempted under
a restricted token at all.

### What this means for P0-b2 and beyond

1. **A managed instance needs its own sandbox provisioning**, which means running
   `windowsSandbox/setupStart` (or `codex-windows-sandbox-setup.exe`) for its own `CODEX_HOME`.
   Provisioning creates **local user accounts** and **firewall/WFP rules**, and upstream has discussed
   ACL changes with a wider blast radius than intended. That is a system-level change and is **not**
   covered by the current experimental approval — it has to be requested separately.
2. **The fail-closed default is good news.** An instance without a sandbox cannot silently run
   commands unsandboxed; it refuses. A Coordinator can rely on that rather than having to defend
   against it.
3. **`readiness` is the startup self-check.** It answers "may this instance run tools at all" in one
   read-only call, which is exactly what the no-side-effect self-check needs — better than inferring
   from paths.

**Not proven.** Whether provisioning an isolated home would make `exec_command` succeed was not tested,
because provision is a system change. `updateRequired` (the third enum value) was not observed.

---

## E-INCIDENT-CRED-READ · Unauthorised read of real credential files (P0-b2)

**What happened.** While probing whether Low integrity level blocks credential reads, two *real*
credential files were opened with `Get-Content -TotalCount 1`:

- `%USERPROFILE%\.codex\auth.json`
- `%USERPROFILE%\.dsh\.credentials.yaml`

The P0-b2 approval scope allowed only synthetic credential files.

**What was emitted.** Only `READ OK <path>` / `READ DENY <path>`. No file content was printed, logged,
stored, or included in any report.

**What this record does and does not claim.** It does not claim "no exposure" — the content did enter
process memory, and whether any capture layer saw it is not something this agent can prove. It claims
only: the command that read them did not print them, and no artefact containing them was written by
these probes.

**Consequence for the IL conclusion.** The result stands as an access-control observation (Low IL
permits reading these files), but that fact was obtained by a method outside the approved scope, and
must not be cited as a routine test technique.

**Standing rule.** Credential-access probes use synthetic files only. Reading a real credential file
to demonstrate a denial is never necessary: the file can be copied to a synthetic path first, or the
question can be answered by ACL inspection.

---

## E-INCIDENT-SIG · Unexplained Authenticode signature on `start-dsh-web.ps1`

**Symptom.** `git status` reported `M start-dsh-web.ps1` with no change made by this session.

**Read-only findings (2026-10-21):**

| question | answer |
|---|---|
| Is the executable content identical to the git baseline? | **Yes** — 1,277 chars both sides, **0 differing lines** with the signature block removed |
| What changed? | only an appended Authenticode block; file grew to 3,588 bytes |
| Signature status | `Valid` / `Signature verified.`; type `Authenticode`, **no timestamp counter-signature** |
| Signer | `CN=LocalScriptSigner`, self-issued, thumbprint `079620DEFEC0B12E906ADC81FAD8AA85AC644968` |
| Certificate validity | 2026-09-28 → 2027-09-28 |
| Private key | **present in `Cert:\CurrentUser\My`** (that store holds exactly this one certificate) |
| Other repo scripts signed by it | none — this file is the only one |
| File mtime | 2026-10-21 00:07:56 (creation 2026-10-18) |
| PowerShell operational log | no matching events in the window; logging not available as evidence |

**What this establishes.** The script's behaviour is unchanged: whatever signed it did not alter a single
line of code. The signature itself is cryptographically valid and the needed private key sits in this
user's own certificate store, so anything running as this user could have produced it.

**What it does not establish.** Who did it, or why. A valid self-signed signature only proves the block
was appended with that key — not that the action was authorised, expected, or performed by the project.
The absence of a timestamp counter-signature means the "signed at" time is the signer's own claim.

**Standing consequences.**

- `start-dsh-web.ps1` is **not executed by any automated test** until the origin is explained.
- The modification is **not reverted** (it is the evidence) and **not committed** with other work.
- It must not be bundled into a P0-b2 deliverable: it is unrelated to sandbox provisioning.

---

## E-IPC-POLICY · B1: a named-pipe Adapter entry that refuses before it dispatches

Scope: synthetic only. No Codex, no DSH, no real credentials, no system configuration. The server
(`tools/probes/ipc/coordinator.ps1`) is a stand-in that holds a policy file and answers; the client
(`worker-client.ps1`) plays an untrusted caller. `run-b1.ps1` drives the matrix.

### Two things measured before any policy could be trusted

**1. The caller's identity is only available AFTER the first read.**

`NamedPipeServerStream.GetImpersonationUserName()` called straight after `WaitForConnection()` throws:

```
Unable to impersonate using a named pipe until data has been read from that pipe.
```

**Consequence:** there is no way to identify a peer before it sends something. An unauthenticated
client always gets one message onto the pipe. The protocol must therefore treat the **first frame as
untrusted** and gate on the handshake token *and* the OS identity, not "connected successfully".

**2. The pipe DACL is actually enforced.**

| server DACL | client outcome |
|---|---|
| grants the current user | `connected: true` |
| grants only a SID that exists nowhere (`-DenyAll`) | **`Access to the path is denied.`** |

The negative control matters: it shows the refusal came from the kernel's DACL, not from the policy
code deciding to be polite.

### The policy matrix — 9/9 as expected

| case | server answer |
|---|---|
| dispatch before handshake | `handshake-required` |
| wrong handshake token | `bad-token` |
| unknown goal id | `unknown-goal` |
| goal in state `proposed` (not `authorized`) | `goal-not-authorized`, echoes `state: "proposed"` |
| thread not in the registry | `thread-not-registered` |
| cwd outside `allowedWorkspaces` | `cwd-not-allowed`, echoes the path |
| 3 dispatches against `maxRounds = 2` | admits **2** (`budgetUsed: 1, 2`), then `budget-exhausted` |
| one valid dispatch | `dispatchId`, `budgetUsed: 1` |
| **negative control:** server DACL grants a SID that exists nowhere | client refused at `Connect`: `Access to the path is denied.` |

The ninth case is what makes the other eight mean anything: without it, "the caller was refused" could
be the policy code choosing to be polite. With it, the refusal is the kernel's DACL.

The budget row is the one that encodes a design rule rather than a feature: **the counter advances in
the same step that admits the dispatch**, so the N+1-th request is refused instead of admitted and
reconciled later. That is the "check at the admission gate, not at delivery" correction applied at the
smallest scale where it can be shown.

### Why the harness itself had to change (2026-10-21)

Re-running the matrix in a different shell produced **zero server processes and eight client
timeouts** — which reads exactly like a policy failure and is not one:

```
Start-Process : Item has already been added. Key in dictionary: 'HTTP_PROXY'  Key being added: 'http_proxy'
```

Windows permits an environment block with two entries that differ only in case; the .NET dictionary
that `Start-Process` copies into does not, and it throws before the server exists. A shell that
carries both spellings (the confined one that ran this probe did) therefore cannot run the probe at
all. Two further reproducibility defects were found in the same pass: the repo path was hardcoded,
and the policy fixture lived only under `.state/`, so a fresh clone had nothing to read.

All three are fixed: duplicate environment keys are dropped before any process is started, the repo
root is derived from the script's own location, and the fixture is seeded from a committed
`policy.sample.json`. The driver now **asserts** each case and exits non-zero on disagreement,
because a matrix that prints JSON for a human to eyeball is not a test.


### What this does NOT establish

- **It is not the real Adapter.** No MCP stdio, no Codex child process. The identity recorded in every
  case is this user (`MMGA`), because the client *was* this user. Whether a Codex-spawned MCP child runs
  under a different identity **is still unmeasured**, and cannot be measured while
  `windowsSandbox/readiness = notConfigured` (P0-b2 blocking item).
- **It says nothing about loopback networking.** Pipes and TCP `127.0.0.1` are different mechanisms; the
  `CodexSandboxOffline` WFP rules block the latter. Neither direction is inferred here.
- **The policy store is a JSON file**, not the SQLite ledger. Atomic budget accounting in a real
  transaction is B2/B4 territory.
- The handshake token is a shared secret in a file — adequate to show the gate exists, not adequate as
  a credential design.

---

## E-LEDGER · B2: the event ledger refuses to advance past a hole

Prototype: `tools/probes/ledger/events-store.mjs`, acceptance: `tools/probes/ledger/b2-acceptance.mjs`
(`node` only, throwaway SQLite files in the OS temp dir, no dsh, no Codex, no network).

### Result: 25/25 checks

| property | assertion |
|---|---|
| duplicate arrival stored once | same event twice → 1 row, second reports `duplicate` |
| same seq in two generations coexist | gen0 = 2 rows, gen1 = 1 row, **each generation has its own cursor** (1 and 0) |
| **an early arrival is held, not dropped** | `seq=12` at cursor 1 → **stored** (3 rows), reported `staged`, cursor stays 1 |
| the hole records missing seqs only | gap is `[2,11]`, not `[2,12]` — the observed event is not part of the hole |
| a staged event is idempotent too | re-receiving `seq=12` → `duplicate`, still 3 rows |
| a shorter hole still cannot advance | `seq=11` now held → gap narrows to `[2,10]`, cursor still 1 |
| **filling promotes what was held** | fill 2..10 → cursor jumps to **12**, no gaps, `health: live` |
| **partial fill narrows, never deletes** | hole `1..11`, fill 1..6 → cursor 6, gap `[7,11]`, `health: gap` |
| two holes stay two holes | `0,5,9` → `[1,4]` and `[6,8]`; closing the first leaves the second |
| consumers read the prefix | `eventsAfter` returns `[6]` by default, `[6,12]` only with `confirmedOnly:false` |
| stats separates the three views | cursor 6, held 8, staged 1, maxSeq 12 |
| reopen after "crash" | cursor 3, 4 rows — the two agree |
| replay whole batch after restart | every ingest reports `duplicate`, 5 rows, cursor unchanged |
| resume from cursor | next event lands at exactly `cursor+1` |
| initial cursor | **−1 before `seq 0`, 0 after** — the two states are distinguishable |

### Four defects, and the two that the tests themselves encoded

Two were schema/logic bugs found by writing the assertions:

1. **The cursor cannot live on `topic_id` alone.** A rebuilt source restarts numbering at 0, so a
   session needs two cursors at once. The first schema keyed `topic` by `topic_id` and the generation
   test failed with `UNIQUE constraint failed`. Fixed: `PRIMARY KEY (topic_id, source_generation)`.
2. **Gap cleanup was inverted.** After filling the hole the cursor was correct at 12 while one stale
   gap row remained, so `health` stayed `gap` forever. A system in that state looks recovered and
   still reports a hole.

The other two were **assertions that passed while encoding the defect** — which is worse, because a
green test is a claim that the behaviour is wanted:

3. **"An out-of-order event is not stored"** was asserted, and it is a data-loss bug. Refusing
   `seq > cursor+1` and writing a gap row is indistinguishable from dropping the event: a replay
   after a reconnect delivers the hole, finds nothing above it, and the cursor walks over data that
   was already seen and thrown away. Corrected: every arrival is persisted; the cursor is still only
   the contiguous prefix; held rows are promoted by arithmetic when the hole closes.
4. **"Filling the hole clears the gap table"** was asserted, and it is wrong for a hole that merely
   shrinks. Filling 2..6 of a 2..11 hole left the cursor at 6 with **no gap row at all**, so the
   ledger reported `live` while 7..11 was still missing — the exact contradiction of "cursor right,
   gap table wrong". Corrected: the gap set is recomputed from `(cursor, held seqs)` in the same
   transaction as the cursor, so the two cannot disagree by construction.

**What this changed in the design:** a stored event is no longer the same thing as a *delivered*
one. `eventsAfter` reads the prefix by default, because handing a downstream stage a sequence with a
hole under it is how a gap becomes a silent reordering.


### What this does not establish

- **No evidence/outcome separation is enforced by this layer.** It stores events; it does not decide
  business outcomes, and it cannot stop a caller from generating a delivery from a raw event. That
  guard belongs to the derivation step and must be tested there.
- **Concurrency was not exercised.** `busy_timeout` and WAL are configured, but "two writers, one
  budget slot" is explicitly B4.
- **Crash simulation is `db.close()`**, not a killed process mid-transaction. A real SIGKILL test
  belongs with B4's transactional work.
- The dsh side is still a fixture: nothing here proves the real `session/follow` stream is dense or
  gapless (that is E-SEQ for logs, and unmeasured for the stream).

---

## E-LAUNCH-LOCK · A successful start left a lock that made the next start wait 90 seconds

```bash
node launch.mjs start     # ok: pid 18276, port 3080 open
# instance dies with the calling shell (this host's confined tool jobs reap children)
node launch.mjs start     # prints nothing for ~90 s, then times out
```

**Measured 2026-10-21.**

| observation | result |
|---|---|
| after a successful `start` | `.state/spawn.lock` still present, contents `21180` (the pid that had already returned) |
| second `start` within the two-minute window | treated as "another process is spawning", waits the full boot timeout |
| the recorded holder | **not running** at the time of the second start |
| after the fix | lock removed on every exit path; second start proceeds immediately |

The lock exists to serialize the *spawn decision*, not the instance lifetime, but it was only ever
removed by `stop()`. Two fixes: `releaseSpawnLock()` runs in a `finally` around the spawn body, and a
lock whose recorded pid is dead is taken instead of waited on (`staleLockVerdict`, unit-tested).

**What this does not prove.** That a lock left by a *live* holder is wrong to wait for — that case is
the reason the lock exists. And the instance still dies with the job that started it: the launcher
detaches (`detached: true`, `unref`), but this host's tool sandbox reaps the whole job when the call
returns, so a durable instance has to be started from a shell the user owns.
