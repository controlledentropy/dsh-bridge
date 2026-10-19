# dsh 的可转发方法表（生成物，勿手改）

由 `node tools/remote-surface.mjs` 从本机安装的 dsh 包生成。它记录的是**网关会转发的方法全集**，
与桥接实际用到的子集（文末）。升级 dsh 后请重跑本工具，并用 `node launch.mjs check` 看漂移。

- 来源包：npm 全局目录下的 `@deepseek-ai/dsh`（本机具体位置随安装而变，故只记版本）
- dsh 版本：`0.2.1-rc.2`
- 方法表文件（相对包根）：`node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js`
- 方法数：**135**
- 名称摘要（只哈希方法名，不哈希描述）：`c161f40cc5f5dbd3`

`launch.mjs check` 比对这个摘要：出现新增或缺失即报漂移，因为这时"某端点 404"可能不再是"没转发"，
而是"上游改名了"——两种情况在桥接日志里长得一模一样。

## 全集

| 方法 | 实现 service | 官方描述 |
| --- | --- | --- |
| `account/ackBonusNotified` | accountController | Record one displayed bonus as notified for the account it belongs to. |
| `account/cancelSignIn` | accountController | Cancel the named local attempt. |
| `account/getBalance` | accountController | Query Platform recharge-wallet balances. |
| `account/getProfile` | accountController | Query display-safe Platform profile data. |
| `account/getState` | accountController | Read the safe account projection. |
| `account/getUnnotifiedBonuses` | accountController | Query the granted bonuses Platform has not yet recorded as displayed. |
| `account/hasRunningAccountTasks` | accountController | Inspect the latest logged request providers of running tasks, including tools and retries. |
| `account/signOut` | accountController | Remove the local account grant and revoke it through Platform in the background, without deleting API keys. |
| `account/startSignIn` | accountController | Begin browser sign-in. |
| `account/watch` | accountController | Stream the safe account projection. |
| `account/watchExpiry` | accountController | Subscribe to credential expiry without replaying prior notifications. |
| `agentPresets/list` | agentPresets | Read the selection roster. |
| `agentPresets/read` | agentPresets | Read one declaration's child plugin list as YAML, for viewing only. |
| `agentPresets/select` | agentPresets | Select a preset before a session starts its first turn. A Session whose log records the preset and whose Agent runs its current revision keeps its composition; nothing is logged or announced. |
| `commands/execute` | commands | Parse and execute a known command without sending it to the model. A resolved command's lifecycle is logged: `command/run` is appended before the handler is invoked and `command/done` after settlement (a thrown or aborted handler settles as `kind: 'error'`). Both are direct log-only appends — no turn wraps them, and persistence drains them at ordinary checkpoints. Admission misses (syntax or unknown name) log nothing — they never entered a handler. A `command/run` append failure fails the execution loud; a `command/done` append failure on the handler-failure path is contained so the handler's own error stays the reported failure. Attachment admission is enforced here, not in the composer: attachments sent to a command that does not declare `input.attachments`, an absent attachment store, and an exceeded image limit each settle as an error result before the handler runs. Validation rejection starts no attachment writes; a storage failure can leave only unreachable content-addressed objects for deferred collection. |
| `commands/list` | commands | List the effective immutable command descriptors for one agent. |
| `credentials/describe` | credentialsController | Describe several references for one configuration surface. Batched because a settings page describes every reference its rows name at once, and one round trip keeps those rows from settling separately. |
| `credentials/set` | credentialsController | Store one value from a configuration surface. The value crosses the wire in this direction only: no read path returns it. |
| `credentials/unset` | credentialsController | Remove one reference from a configuration surface. |
| `directoryPicker/createDirectory` | directoryPickerController | Create one child directory for a Remote caller's in-app browser. |
| `directoryPicker/list` | directoryPickerController | List one directory level for a Remote caller's in-app browser. |
| `directoryPicker/pick` | directoryPickerController | Open the host's OS chooser for a Remote caller. |
| `dynamicCordisRunner/getClientCode` | dynamicCordisRunner | Fetch Client code for the exact active run. |
| `dynamicCordisRunner/inventory` | dynamicCordisRunner | Frame-wide inventory, grouped as one row per stable Plugin. |
| `dynamicCordisRunner/invoke` | dynamicCordisRunner | Invoke an active Host method while rejecting stale Client runs. |
| `dynamicCordisRunner/reportClientGuardFailure` | dynamicCordisRunner | Report a Client guard rejection that happened after the Package completed activation. |
| `dynamicCordisRunner/reportRenderFailure` | dynamicCordisRunner | Record a post-load render failure for the exact active run. |
| `dynamicCordisRunner/resolveInspectQuery` | dynamicCordisRunner | Submit a Client inspect result or failure for a pending query. |
| `dynamicCordisRunner/resolveRequestRun` | dynamicCordisRunner | Resolve one model-driven Client activation request. |
| `dynamicCordisRunner/runHostHalf` | dynamicCordisRunner | Start Host code for an approved request or a direct panel gesture. |
| `dynamicCordisRunner/settleUserRun` | dynamicCordisRunner | Settle a direct panel run after this page loaded or failed its Client half. |
| `dynamicCordisRunner/stopFromPanel` | dynamicCordisRunner | Stop a Plugin from the user panel and queue the resulting state change for the model's next step. |
| `dynamicCordisRunner/syncInspectManifest` | dynamicCordisRunner | Replace the Host mirror of the Client inspect provider directory. |
| `dynamicCordisRunner/undefineFromPanel` | dynamicCordisRunner | Remove a Plugin from the user panel and queue the resulting state change for the model's next step. |
| `fileReferences/list` | sessionFileReferences | List file and directory candidates for one Agent's working directory. |
| `fileUploads/upload` | fileUploads | Persist one encoded upload and stage it under the Agent receiver selected by Typert. |
| `goals/clear` | goals | Clear the current goal while retaining a durable tombstone and history. |
| `goals/complete` | goals | Mark a current non-complete goal complete and disarm it. |
| `goals/create` | goals | Create one Goal through the remote boundary. |
| `goals/edit` | goals | Edit objective and/or round cap without changing phase. |
| `goals/get` | goals | Read the current goal for one exact live agent. |
| `goals/pause` | goals | Pause an active goal and disarm automatic continuation. |
| `goals/resume` | goals | Resume and arm a stopped goal, or rearm an active goal after a session-start edge, while its round budget still has capacity. |
| `job/follow` | jobController | Stream one job's retained output from an absolute byte offset, then its terminal projection once settled and drained. Non-consuming: the model-facing cursor and notice state never observe these reads. The request's session is the fenced read's caller; the registry rejects a job the session cannot see and an unknown job. |
| `job/kill` | jobController | Kill one background job on a human's behalf. The request's session is the fenced read's caller, so the job must be one that session can see: the registry's owner fence is the only access rule, and a child session's own jobs are killable from its list like any other. The kill records `cancelled by the user` as its reason; it is not one the model requested, so the owning agent still receives the completion notice, and a shell tool waiting on that job reads the reason in its own result. |
| `job/list` | jobController | Stream the jobs one session can see — its own plus every unowned job — as whole-set frames: one on open, then one after each coalesced burst of lifecycle commits. The stream has no natural end; the carrier closes it. |
| `llm/discoverModels` | llm | Remote adapter for one draft provider interrogation. |
| `llm/listConfigurableProviders` | llm | List every declared configurable provider, registered or dormant. |
| `llm/listProviders` | llm | Describe provider routes with a registered adapter. |
| `messageFeedback/delete` | messageFeedback | Delete one item after checking its version; absence succeeds without an event. |
| `messageFeedback/list` | messageFeedback | Read current feedback from the canonical log. |
| `messageFeedback/put` | messageFeedback | Create or replace feedback after checking its current version. Matching no-ops retain the version and append no event. |
| `officeToPdf/generation` | officeToPdf | Read the current rendering generation before reusing a Client PDF. |
| `officeToPdf/render` | officeToPdf | Read and convert one Office file using the Session's ordinary filesystem authorization. |
| `permissionPresets/catalog` | permissionPresets | Read the complete process-level catalog exposed to current-session UI. |
| `pluginInventory/list` | pluginInventory | Read the Loader directly on every call. Cordis's internal plugin/status events already maintain Entry.fiber and Fiber.state, so a second cache would only add another lifecycle truth to keep synchronized. When an agent-preset roster is composed, the snapshot also carries each preset's composition rows, because those rows — not the Loader's own entries — are where a deployment that mounts the roster runs its model-facing plugins. |
| `pluginManager/cancelInstall` | pluginManager | Stop an installation this manager owns and wait until its files are back. |
| `pluginManager/inspect` | pluginManager | Read what a spec names before installing it. |
| `pluginManager/installBundle` | pluginManager | Install a package using the same pnpm implementation as dsh plugin. GitHub repositories get a connection check bounded by githubConnectionTimeoutMs before pnpm starts; only network failures or timeouts stop installation, while pnpm owns authentication and transport fallback. A run that fails, is cancelled, or adds a package without a bundle patch restores `package.json` and `pnpm-lock.yaml` as they were; downloaded files can stay. |
| `pluginManager/listBundles` | pluginManager | Read installed, installation-provided, and offline Official catalog bundles, plus selected non-bundle names. A dependency without a bundle patch is listed, as a `not-bundle` problem, only while it is selected. |
| `pluginManager/listPlugins` | pluginManager | Read current plugins, including why a row cannot be changed through the profile patch. |
| `pluginManager/listVersionExemptions` | pluginManager | Read exact plugin-version exemptions saved in this profile. |
| `pluginManager/registries` | pluginManager | Read the registries this manager asks: the configured first one, its fallbacks in order, and what pnpm's own configuration names. |
| `pluginManager/removeBundle` | pluginManager | Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path; a selected name no dependency holds is only deselected. |
| `pluginManager/setBundleEnabled` | pluginManager | Select or remove a bundle layer while retaining installed dependencies. |
| `pluginManager/setPluginEnabled` | pluginManager | Persist a plugin entry's desired enablement and apply it on live profiles. |
| `pluginManager/setVersionExemption` | pluginManager | Grant or revoke one exact plugin/runtime exemption and reevaluate live plugins. |
| `pluginManager/waitForInstall` | pluginManager | Recover the result of an active installation without cancelling it. |
| `pluginMarket/listIndexes` | pluginMarket | List the configured index sources without fetching them. |
| `pluginMarket/search` | pluginMarket | Return one page of the plugins of a configured index that match a query. Concurrent reads of a URL share one fetch; a successful document is reused for `cacheTtlMs` unless `refresh` is set. Matching and ordering read only the document; installation status and compatibility are computed for the returned page on every call. |
| `pluginMarket/setIndexes` | pluginMarket | Replace the configured index sources through Settings, without remounting this service. `plugin-market/changed` announces the committed list. A URL already configured is kept as written, so a client can add or remove sources beside one that `listIndexes` reports as unusable. |
| `pluginRegistryProbe/fastest` | pluginRegistryProbe | Race npm and npmmirror HTTPS ping responses through the Host's fetch proxy. Concurrent readers share a probe; a winner cancels and awaits the other request. |
| `productAnalytics/enabled` | productAnalytics | Read the collection policy. |
| `productAnalytics/report` | productAnalytics | Submit selected Desktop fields with cached static environment and fresh identity. The first intake waits for bounded environment queries; concurrent intakes share them. Missing identity is omitted; failed environment fields carry fixed reasons. |
| `productAnalytics/watchPolicy` | productAnalytics | Stream the effective policy initially and after live configuration edits. |
| `schedule/catalog` | schedule | Read all active and inactive Host reminders with their original Session bindings. A deleted reminder has no row, so it is absent here. Does not activate Sessions or read Session history. |
| `schedule/delete` | schedule | Delete one task belonging to the selected Session, leaving queued messages intact. The row is removed: the task no longer schedules, leaves `list` and `catalog`, and its saved delivery records go with it. A task bound to a Session a delegated child owns stays deletable even though creation and timing edits refuse that binding, so a task stored before that rule existed remains removable. |
| `schedule/history` | schedule | Read saved inbox deliveries without activating or reading the original Session. The task's own row supplies its binding, so its records stay readable through this lookup. |
| `schedule/list` | schedule | Read the selected Session's active tasks without resuming its Agent. |
| `schedule/update` | schedule | Update the name, instruction, and timing of an active task within the original Session binding without activating the Session or changing saved deliveries. Each supplied field replaces its stored value; an omitted field keeps it. A name or instruction change alone does not reset the committed target. A Session a delegated child owns returns the non-mutating `subagent_session` result, so an edit cannot re-arm a task bound to a Session delivery can never reach, and the Web editor can explain the refusal through the ordinary result it already renders. |
| `session/attachment` | sessionController | Read one image proven reachable from the addressed Session log. |
| `session/cancel` | sessionController | Cancel one active Agent turn without dropping its pending inbox. |
| `session/canOpenWorkspacePath` | sessionController | Report whether this deployment can hand a Session workspace path to a native desktop. |
| `session/control` | sessionController | Stream a complete live-control baseline followed by replacement frames. |
| `session/create` | sessionController | Create one ordinary Session for a new conversation, reusing the named blank Session while it is reusable. |
| `session/follow` | sessionController | Follow one Session log from its opening or resume cursor. |
| `session/fork` | sessionController | Fork one cold-readable exact event prefix into a new Session. An omitted boundary selects the latest completed-turn prefix; an open cut receives synthetic fork closers. |
| `session/initializeDefaultModel` | sessionController | Select the first available account model after login when no provider API key is configured. |
| `session/list` | sessionController | Read all visible Session rows without resuming an Agent. |
| `session/modelCatalog` | sessionController | Describe every currently routable model for Host-generation selectors. |
| `session/openWorkspacePath` | sessionController | Verify one path through the composed filesystem and open it on the Host desktop. |
| `session/page` | sessionController | Read one cold-safe, message-aligned Session history page. |
| `session/projections` | sessionController | Read exact projections, returning cached hints only when migration is required. |
| `session/prompt` | sessionController | Admit one prompt after explicitly resuming its Session. |
| `session/rename` | sessionController | Rename one Session after explicitly resuming it. |
| `session/search` | sessionController | Search visible Session content without resuming an Agent. A non-owner receives only the hits whose Session `allows()` admits; `hasMore` describes the bounded result before that filtering. |
| `session/selectModel` | sessionController | Select one Session-local model after explicitly resuming the Session; save the default in the background. |
| `session/updateQueue` | sessionController | Mutate one still-pending queue occurrence, resuming a cold Agent first. |
| `session/workspacePathApplications` | sessionController | Query current file handlers on the serving desktop without activating an Agent. |
| `sessionFeedback/record` | sessionFeedback | Record one remark on a live Session. |
| `sessionReferenceResolver/candidates` | sessionReferenceResolver | Remote face of {@link listCandidates}: the configured candidate limit applies, and every candidate carries the canonical mention a host inserts into the prompt draft. |
| `settings/describe` | settingsController | Describe every registered namespace for a configuration page: redacted layered values plus the serialized schema the page renders its form from. |
| `settings/mutate` | settingsController | Apply path-addressed edits to one namespace's user section, resolved against the section as stored rather than against whatever the caller last read, then answer with that namespace's new redacted view. |
| `settings/openSettingsDocument` | settingsController | Materialize the provider-owned settings document and open it in a native text editor. |
| `settings/replace` | settingsController | Replace one namespace's stored user section wholesale. |
| `settings/update` | settingsController | Merge a patch into one namespace's stored user section. |
| `skills/list` | sessionSkillCatalog | List the user-invocable skills visible to one Session composition. |
| `subagents/interruptByParent` | subagents | Remote face of {@link interrupt} under one durable parent address. No catalog, history, persistence, or parent Agent lookup runs: the core primitive alone authorizes the address against the live Activation, which is what keeps a live child interruptible while its parent Agent is offline. Absent, idle, and already-completed targets are accepted no-ops there. |
| `subagents/prompt` | subagents | Deliver one browser-authored message to a continuable child through the exact live direct parent, retaining the caller-minted request identity and validated browser zone on the accepted message. Success identifies the message the child's inbox accepted; later execution is independent of this call. Queue delivery targets a later turn; steer delivery targets the nearest step and retains the Agent loop's best-effort fallback semantics. Image parts are admitted and persisted through the attachment store before delivery, and the child's model must accept image input. Cold resume at capacity rejects with `subagent/delivery-unavailable`. |
| `terminal/attach` | terminalController | Attach terminal input and output to one physical Remote stream. |
| `terminal/close` | terminalController | Close an identity to future creation and kill its process range; repeated closes succeed. |
| `terminal/create` | terminalController | Allocate a user shell once for a caller-generated identity, without Agent sandbox or approval restrictions. |
| `terminal/environment` | terminalController | Read the Session's current directory and terminal limits without filesystem validation or shell lookup. |
| `terminal/list` | terminalController | List retained terminals without resolving or activating an Agent. |
| `terminal/rename` | terminalController | Rename a terminal without changing its shell. |
| `terminal/retain` | terminalController | Retain an existing terminal for a window without activating its Agent or taking input control. |
| `terminal/shells` | terminalController | Discover installed shells in the Session's execution environment. |
| `userQuestions/answer` | userQuestions | Answer a continued question. The reply is steered into the agent as a user message whose source names the call; that message is also the record that closes the question in the projection. |
| `userQuestions/attachWait` | userQuestions | Let one answer UI hold a live timed wait. Closing the stream releases its claim. |
| `workspace/archiveSession` | workspaceController | Hide one known Session from Workspace grouping surfaces. |
| `workspace/create` | workspaceController | Create or idempotently resolve one Workspace over an existing directory. |
| `workspace/delete` | workspaceController | Remove one Workspace registration while retaining files and Sessions. |
| `workspace/follow` | workspaceController | Stream a complete Workspace baseline followed by ordered increments. A non-owner receives only the Workspaces and Sessions `allows()` admits. When a delivered Workspace is no longer admitted at its next change or the next order change, the stream sends a `replace` frame with the complete filtered state instead of a `remove`, because a Client never resurrects a removed Workspace; a `remove` frame reports a deletion and reaches only a Client that received that Workspace. |
| `workspace/initializeDefault` | workspaceController | Initialize or reuse the default Workspace during first-use startup. The directory name is fixed, so the Host never renames or relocates an existing default; its initial title is that same name, which browser consumers label in the reader's language. |
| `workspace/insertBefore` | workspaceController | Move one Workspace within the registry display order. |
| `workspace/insertSessionBefore` | workspaceController | Move one accounted Session within a Workspace. |
| `workspace/pinSession` | workspaceController | Surface one known unarchived Session ahead of unpinned Sessions. |
| `workspace/rename` | workspaceController | Rename one Workspace to a unique non-blank title. |
| `workspace/unarchiveSession` | workspaceController | Restore one archived Session to Workspace grouping surfaces. |
| `workspace/unpinSession` | workspaceController | Remove one Session's pin without changing its saved Session order. |
| `workspaceFiles/changes` | workspaceFiles | Watch one file or a directory's direct entries in the Session's filesystem. Files use the backend's read authority; directories remain workspace-scoped. |
| `workspaceFiles/list` | workspaceFiles | List the direct children of one directory inside the Session's workspace. |
| `workspaceFiles/read` | workspaceFiles | Read one page of lines from a UTF-8 file readable by the filesystem backend. |
| `workspaceFiles/readBytes` | workspaceFiles | Read a complete regular file or one byte range without text decoding. |
| `workspaceFiles/stat` | workspaceFiles | Report one regular file's identity, version, and size without its content. |

## 桥接实际使用的方法

- `permissionPresets/catalog`
- `session/cancel`
- `session/create`
- `session/list`
- `session/modelCatalog`
- `session/page`
- `session/projections`
- `session/prompt`
- `session/selectModel`
- `workspace/create`

不在此表里的方法一律不会经由 `/api` 到达 dsh：`session/delete`、`session/archive`、`approval/*`、
`permissionPresets/set`、`session/setSandboxMode` 都是这样被排除的（不是探测失误，而是表里就没有）。
桥接刻意不调用表里存在但会绕过会话权限的入口：`terminal/create`（官方描述明示"不受 Agent 沙箱与审批限制"）、
`settings/mutate`、`credentials/set`、`pluginManager/*`、`dynamicCordisRunner/*`。
