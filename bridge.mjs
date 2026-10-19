#!/usr/bin/env node
// dsh-bridge: an MCP stdio server that lets an MCP client drive DeepSeek Harness `dsh web`
// sessions over their /api.
//
// The wire format lives in lib/api-contract.mjs and is documented, with the probes to re-run after a
// dsh upgrade, in docs/API-CONTRACT.md. This file is only: auth, transport, the session ledger, and
// the nine tools. Facts marked MEASURED were established by execution against dsh 0.2.1-rc.2 here.
//
//   auth      The one-time launch token exists only on `dsh web` stdout and is never persisted. It is
//             exchanged at GET /connect?token=&interactions=answer for a signed `dsh-auth-*` cookie =
//             owner principal, which dsh does not re-check per call. Re-/connect recovers a cookie
//             invalidated by a closed peer.
//   traps     {accepted:true} is admission, not completion. session/list.running does not separate
//             success from failure. Old turns stay in the log, so an outcome is only readable from
//             events after the round's baseline seq. Projections for sessions this bridge did not
//             create can omit sessionListMetadata/turnOutline. The provider catalog loads
//             asynchronously after boot, so an early dispatch can fail UNKNOWN_MODEL. A repeated
//             requestId is deduped server-side, so a re-dispatch needs a new one. session/delete is
//             not forwarded: the API can archive a session but never remove it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { HOST as LAUNCH_HOST, PORT as LAUNCH_PORT, STATE_DIR as LAUNCH_STATE, OUT_FILE as LAUNCH_OUT,
  portOpen, tokenFrom, currentToken, start as launchStart } from './launch.mjs';
import { ARGS, envelope, authCookie, pastCursor, parseAllowlist, allowedText, checkPolicy, splitModel,
  checkAlias, checkCwd, normCwd, roundRecord, baselineFrom, interpret, modelLabel,
  unwrapProjections, pathsOutsideCwd, pageWindow as calcWindow, permissionHistory, walkRound,
  approvalState, verdictFields, PAGE_SIZE, MAX_PAGES } from './lib/api-contract.mjs';

const num = (name, value, fallback) => {
  const n = Number(value);
  if (value !== undefined && value !== '' && !Number.isFinite(n)) throw new Error(`${name} must be a number, got "${value}"`);
  return Number.isFinite(n) ? n : fallback;
};

const CFG = {
  host: process.env.DSH_HOST || LAUNCH_HOST,
  port: num('DSH_PORT', process.env.DSH_PORT, LAUNCH_PORT),
  attachOutfile: process.env.DSH_ATTACH_OUTFILE || '',   // attach to an instance someone else supervises
  apiTimeoutMs: num('DSH_API_TIMEOUT_MS', process.env.DSH_API_TIMEOUT_MS, 15000),
  pollMs: num('DSH_POLL_MS', process.env.DSH_POLL_MS, 3000),
  // Wall-clock spent inside dsh_launch/dsh_send watching a round. Kept under the MCP client's tool
  // timeout (45s in the reference config) so a slow round returns state "running" instead of a
  // client-side timeout that hides the handle.
  watchMs: num('DSH_WATCH_MS', process.env.DSH_WATCH_MS, 40000),
  catalogMs: num('DSH_CATALOG_WAIT_MS', process.env.DSH_CATALOG_WAIT_MS, 15000),
  defaultModel: process.env.DSH_DEFAULT_MODEL || '',
  defaultEffort: process.env.DSH_DEFAULT_EFFORT || '',
};

const STATE_DIR = process.env.DSH_BRIDGE_STATE || LAUNCH_STATE;
const OUT_FILE = CFG.attachOutfile || path.join(STATE_DIR, 'dsh-web.out');
const REG_FILE = path.join(STATE_DIR, 'sessions.json');
const LOG_FILE = path.join(STATE_DIR, 'bridge.log.jsonl');
fs.mkdirSync(STATE_DIR, { recursive: true });

const PID = process.pid;
const LOG_MAX_BYTES = num('DSH_LOG_MAX_BYTES', process.env.DSH_LOG_MAX_BYTES, 2_000_000);
let logDisabled = false;
// Diagnostics must never fail a tool call, and never grow without bound: Codex spawns a bridge
// process per tool call, so an unguarded append turns into an unbounded file.
function log(o) {
  if (logDisabled) return;
  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), pid: PID, ...o }) + '\n');
  } catch { logDisabled = true; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An empty allowlist means "no pinning"; one that parses to nothing is a typo, so this throws at
// startup rather than silently turning into deny-everything.
let ALLOW = null;
try { ALLOW = parseAllowlist(process.env.DSH_ALLOWED_MODELS || ''); }
catch (e) { log({ ev: 'config', fatal: String(e.message) }); console.error(e.message); process.exit(1); }
const deny = (provider, model, effort, origin) => {
  const msg = checkPolicy(ALLOW, provider, model, effort);
  return msg && origin ? `${msg} (${origin})` : msg;
};

/* ------------------------------------------------------------------ ledger */
const readLedger = () => { try { return JSON.parse(fs.readFileSync(REG_FILE, 'utf8')); } catch { return {}; } };
function writeLedger(r) {
  const tmp = `${REG_FILE}.${PID}.${Date.now().toString(36)}.tmp`;   // per-process name: no two writers share it
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, REG_FILE);                                      // atomic: a reader never sees a half file
  try { fs.rmSync(tmp, { force: true }); } catch {}
}
// MEASURED: one Codex conversation spawns many short-lived bridge processes sharing this file, so
// read-modify-write runs under an O_EXCL lock. A failed persist throws: losing the handle to a
// session that is now running costs more than an error the caller can see.
async function withLedger(mutate) {
  const lockFile = REG_FILE + '.lock';
  const deadline = Date.now() + 5000;
  let held = false;
  for (;;) {
    try { const fd = fs.openSync(lockFile, 'wx'); fs.writeSync(fd, String(PID)); fs.closeSync(fd); held = true; break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { break; }
      if (age > 15_000) { try { fs.rmSync(lockFile, { force: true }); } catch {} continue; }   // holder died
      if (Date.now() >= deadline) { log({ ev: 'ledger-lock-timeout' }); break; }               // best effort; writes stay atomic
      await sleep(120);
    }
  }
  try { writeLedger(mutate(readLedger())); } finally {
    if (held) { try { fs.rmSync(lockFile, { force: true }); } catch {} }
  }
}
async function upsertAlias(alias, patch) {
  let out = null;
  await withLedger((r) => { r[alias] = { ...(r[alias] || {}), ...patch }; out = r[alias]; return r; });
  return out;
}
async function appendRound(alias, round) {
  let out = null;
  await withLedger((r) => {
    if (!r[alias]) throw new Error(`alias "${alias}" is not in the ledger`);
    r[alias].rounds = r[alias].rounds || [];
    r[alias].rounds.push(round);
    out = r[alias].rounds;
    return r;
  });
  return out;
}
// MEASURED failure mode: a round persisted as "running" stayed that way forever even though its
// turn/end (aborted) was on disk, so the ledger contradicted the log. A later read that does see the
// verdict writes it back.
async function refreshOutcome(alias, requestId, state) {
  if (!requestId || !state) return;
  await withLedger((r) => {
    const round = (r[alias]?.rounds || []).find((x) => x.requestId === requestId);
    if (round && round.outcome !== state) { round.outcome = state; log({ ev: 'outcome-refreshed', alias, requestId, state }); }
    return r;
  });
}
function regGet(alias) {
  const s = readLedger()[alias];
  if (!s) throw new Error(`unknown alias "${alias}" (owned: ${Object.keys(readLedger()).join(', ') || 'none'}; use dsh_launch, or dsh_adopt for a session that already exists)`);
  return s;
}
const lastRound = (s) => (s.rounds || [])[s.rounds?.length - 1] || {};

/* ------------------------------------------------------------------ /api client */
let cookie = '';

async function raw(endpoint, args, retry = 1) {
  const rpcId = `rpc-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  let res, text = '';
  try {
    res = await fetch(`http://${CFG.host}:${CFG.port}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(envelope(endpoint, args, rpcId)),
      signal: AbortSignal.timeout(CFG.apiTimeoutMs),
    });
    text = await res.text();
  } catch (e) {
    // Safe to retry once by construction: mutating calls either carry a requestId (duplicates are
    // deduped server-side) or a sessionId (create against an existing id is reuse, not a second session).
    if (retry > 0) { log({ ev: 'api-retry', endpoint, why: String(e.message || e) }); return raw(endpoint, args, 0); }
    log({ ev: 'api', endpoint, http: 0, err: String(e.message || e) });
    return { http: 0, ok: null, value: null,
      error: { code: 'unreachable', message: e?.name === 'TimeoutError' ? `timed out after ${CFG.apiTimeoutMs}ms` : String(e.message || e) } };
  }
  let j = null; try { j = JSON.parse(text); } catch {}
  const out = { http: res.status, ok: j?.result?.ok ?? null, value: j?.result?.value,
    error: j?.result?.error || (res.status !== 200 ? { code: `http-${res.status}`, message: text.slice(0, 200) } : null) };
  log({ ev: 'api', endpoint, ok: out.ok, http: out.http, ...(out.error ? { err: out.error } : {}) });
  return out;
}

async function call(endpoint, args, allowReauth = true) {
  const r = await raw(endpoint, args);
  if (r.http === 401 && allowReauth) { cookie = ''; await authenticate(); return call(endpoint, args, false); }
  if (!r.ok) {
    const e = r.error || {};
    const err = new Error(`${endpoint}: ${e.code || ''} ${e.message || 'failed'}`.trim());
    err.detail = e;
    err.http = r.http;
    throw err;
  }
  return r.value;
}

// tokenFrom() decodes UTF-8 and UTF-16 defensively, because Windows redirection can produce either.
async function authenticate() {
  const sources = [...new Set([CFG.attachOutfile, OUT_FILE, LAUNCH_OUT].filter(Boolean))];
  const token = sources.map(tokenFrom).find(Boolean) || currentToken();
  if (!token) {
    // Kept on one line: clients and log scrapers often show only the first, and the remedies are the point.
    throw new Error(`no launch token in ${sources.join(' , ')}. Fix: (a) start dsh web via start-dsh-web.ps1 so its stdout is captured there, (b) set DSH_ATTACH_OUTFILE to the capture file of the running instance, (c) stop whatever holds ${CFG.host}:${CFG.port} so this bridge can start and own its own, or (d) run "node launch.mjs doctor"`);
  }
  let res;
  try {
    res = await fetch(`http://${CFG.host}:${CFG.port}/connect?token=${token}&interactions=answer`,
      { redirect: 'manual', signal: AbortSignal.timeout(CFG.apiTimeoutMs) });
  } catch (e) {
    throw new Error(`/connect unreachable on ${CFG.host}:${CFG.port}: ${e.message || e}`);
  }
  const c = authCookie(res.headers.getSetCookie());
  if (!c) throw new Error(`/connect -> HTTP ${res.status} with no auth cookie: the token is stale (that instance was restarted) or belongs to another port`);
  cookie = c;
  log({ ev: 'auth', status: res.status });
}

// Single-flight: a Codex turn can open several tool calls at once, and each would otherwise start
// its own dsh web. launchStart() holds a spawn lock too, so this guards the auth probe as well.
let ensuring = null;
async function doEnsureServer() {
  if (await portOpen(CFG.port, CFG.host)) {
    const probe = await raw('session/projections', ARGS.sessionProjections('__liveness__'));
    if (probe.ok === true || (probe.http !== 401 && probe.http !== 0)) return;
    await authenticate();
    return;
  }
  // Same code path the human launcher uses: pre-flight (version + profile composition), spawn with
  // stdout captured, wait for the token. Cold boot is ~10s, so the first tool call is the slow one.
  if (process.env.DSH_NO_SPAWN === '1') {
    throw new Error(`nothing is listening on ${CFG.host}:${CFG.port} and DSH_NO_SPAWN=1 forbids this bridge from starting it`);
  }
  const r = await launchStart({ quiet: true });
  if (!r.ok) throw new Error(`${r.error}${r.hint ? ` (expected capture file: ${r.hint})` : ''}`);
  log({ ev: 'spawn', via: 'launch.mjs', pid: r.pid || null, attached: !!r.attached, version: r.version || null, notes: r.notes || [] });
  await authenticate();
}
function ensureServer() {
  if (!ensuring) ensuring = doEnsureServer().finally(() => { ensuring = null; });
  return ensuring;
}

// The nested `values` envelope is unwrapped here so every caller sees one flat shape.
const projections = (sessionId) => call('session/projections', ARGS.sessionProjections(sessionId)).then(unwrapProjections);
async function asOf(sessionId) { try { return (await projections(sessionId))?.asOfSeq ?? 0; } catch { return 0; } }

// What the session is actually allowed to touch, and whether it can run unattended at all: with
// approval policy "ask" a single pwsh/git call can park the round on a human decision. The scope
// travels with every dispatch reply, because a task aimed outside it is denied by dsh's sandbox and
// the denial only makes sense once you can see the scope.
// The policy lives only in the log, and a tail window misses the event that set it on a long session
// (measured: policy flipped at seq 706, a 200-event tail started at 884 -> reported null, which reads
// as "ask" and would wrongly rule out unattended dispatch). So scan backwards until one turns up;
// policy changes are rare, and finding none is reported as null rather than guessed.
async function currentApprovalPolicy(sessionId) {
  let asOfSeq = await asOf(sessionId);
  for (let page = 0; page < MAX_PAGES && asOfSeq > 0; page++) {
    const from = Math.max(-1, asOfSeq - PAGE_SIZE);
    const { events } = await pageWindow(sessionId, from, PAGE_SIZE).catch(() => ({ events: [] }));
    const policies = events.filter((e) => e?.type === 'approval/policy');
    if (policies.length) return policies[policies.length - 1].data?.policy ?? null;
    if (from <= 0) break;
    asOfSeq = from;
  }
  return null;
}

async function sessionScope(sessionId) {
  const p = await projections(sessionId).catch(() => null);
  const policy = await currentApprovalPolicy(sessionId).catch(() => null);
  return { workingDirectory: p?.workingDirectory || null, sandbox: p?.permissions?.currentValue || null,
    agentPreset: p?.agentPreset || null, model: modelLabel(p?.modelSelection?.lastUsed),
    approvalPolicy: policy, unattended: policy === 'never' };
}

// Reading asOfSeq first still races a live session, so "past cursor N" corrects the cursor instead
// of failing the call. throughSeq must be <= asOfSeq.
//
// A round is paged from its OWN baseline, never from the tail: session/page returns the newest
// maxMessages events at or below throughSeq, so a tail-anchored read of a long session silently drops
// the round's turn/end - and an aborted round then reports state "idle", i.e. "nothing happened",
// which is the exact false negative the state machine exists to prevent. 'tail' is only for "what is
// this session doing right now" (adoption previews).
async function pageWindow(sessionId, sinceSeq, maxMessages = 20, anchored = 'baseline') {
  let asOfSeq = await asOf(sessionId);
  if (!asOfSeq) return { events: [], window: { sinceSeq: sinceSeq || 0, throughSeq: 0, asOfSeq: 0, anchored, truncated: false },
    note: 'no readable log yet (asOfSeq=0)' };
  let w = calcWindow({ sinceSeq: sinceSeq || 0, asOfSeq, maxMessages, anchored });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const v = await call('session/page', ARGS.sessionPage({ sessionId, throughSeq: w.throughSeq, maxMessages }));
      const events = (v?.records || []).map((r) => r.event || r).filter((e) => e && e.seq > w.sinceSeq);
      return { events, window: { sinceSeq: w.sinceSeq, throughSeq: w.throughSeq, asOfSeq, anchored,
        oldestSeq: events[0]?.seq ?? null, newestSeq: events[events.length - 1]?.seq ?? null,
        truncated: !!v?.hasMore || asOfSeq > w.throughSeq } };
    } catch (e) {
      const corrected = pastCursor(e?.message);
      if (corrected === null || corrected === w.throughSeq) throw e;
      asOfSeq = corrected;
      w = calcWindow({ sinceSeq: sinceSeq || 0, asOfSeq, maxMessages, anchored });
    }
  }
  throw new Error(`session/page never agreed with session/projections for ${sessionId}`);
}
const pageTail = (sessionId, maxMessages) => pageWindow(sessionId, 0, maxMessages, 'tail');

// MEASURED: session/list.running is the only trustworthy "still working" flag. The list spans every
// workspace, so it is cached for one poll interval and shared across aliases in the same tick.
let listCache = { at: 0, items: null };
async function liveRow(sessionId, maxAgeMs = CFG.pollMs) {
  if (!listCache.items || Date.now() - listCache.at > maxAgeMs) {
    try { listCache.items = (await call('session/list', ARGS.sessionList()))?.items || []; listCache.at = Date.now(); }
    catch { if (!listCache.items) return null; }
  }
  const row = listCache.items.find((i) => i.sessionId === sessionId);
  return row ? { running: !!row.running, blank: !!row.blank, cwd: row.cwd } : null;
}
const dropListCache = () => { listCache = { at: 0, items: null }; };

// A round can span more events than one page holds (measured: 1080 events, verdict at seq 1084 while
// a 1000-message window from the baseline stopped at 1004 - a COMPLETED round read back as "idle").
// The walk itself is pure logic in the contract lib and is tested offline; this is only the network
// page reader it walks over. `walk:false` keeps polling cheap: one small window, no verdict guarantee.
const readRoundEvents = (sessionId, sinceSeq, opts) =>
  walkRound((cursor, n) => pageWindow(sessionId, cursor, n), sinceSeq, opts);

async function readRound(s, opts = {}) {
  const sinceSeq = lastRound(s).sinceSeq ?? 0;
  const row = await liveRow(s.sessionId);
  // Cheap first pass while the agent is still working; walk the whole round only when a verdict is
  // actually possible, otherwise every poll re-reads a thousand events.
  const settledHint = row?.running === false;
  const { events, window } = await readRoundEvents(s.sessionId, sinceSeq,
    { walk: opts.walk ?? settledHint, first: opts.first ?? 24 }).catch(() => ({ events: [], window: { sinceSeq, truncated: false } }));
  const p = await projections(s.sessionId).catch(() => null);
  const r = interpret(events, row?.running ?? null);
  const ap = approvalState(events);
  const v = verdictFields(r, window);
  // Waiting on a human outranks every other reading of this round: it explains why nothing is moving
  // and what would unblock it.
  if (!r.settled && ap.pending.length) {
    v.note = `waiting on ${ap.pending.length} unanswered approval(s) - ${ap.pending.map((x) => x.toolName).join(', ')}; an unattended dispatch cannot proceed until a human answers in the dsh UI`;
  }
  return { ...r, ...ap, window, ...v,
    model: modelLabel(p?.modelSelection?.lastUsed || lastRound(s).pinned || s.pinned),
    tokenUsage: p?.tokenUsage || null, contextPressure: p?.contextPressure || null };
}

// A task that WRITES outside the session workspace is denied by dsh's sandbox, and the denial text
// ("escalation available - retry with sandbox_permissions") cannot be honoured by an unattended
// dispatch: nobody is at the UI to approve it, so the round just burns quota and aborts. Refusing up
// front is cheaper than a warning nobody reads - which is exactly what happened on 2026-10-18.
// Merely naming a path is not writing it: the brief lives in the parent repo, the toolchain and the
// skill definitions are outside every cwd, and refusing those would forbid the recommended shape.
// Only the write tier blocks; the read tier travels as an advisory.
function assertInsideCwd(task, dir, allowOutsideCwd) {
  const { all, write, read } = pathsOutsideCwd(task, dir);
  if (!write.length || allowOutsideCwd) return { all, write, read };
  const e = new Error(`task writes to ${write.length} path(s) outside the session workspace ${dir}: ${write.join(' , ')}. dsh's sandbox will deny writes there and an unattended dispatch cannot approve the escalation. Re-launch with cwd set to the directory the task actually changes; paths that are only read (skills, the ticket, another repo) do not need this - pass allowOutsideCwd:true if the classification is wrong.`);
  e.detail = { cwd: dir, outsideCwd: { all, write, read } };
  throw e;
}

// Resolved purely, before anything touches the network: a disallowed model must be refused without
// cold-booting dsh and without creating a session, so a policy mistake has no side effects at all.
function assertModelAllowed(model, effort) {
  const fromArg = !!(model || effort);
  const want = model || CFG.defaultModel;
  const eff = effort || CFG.defaultEffort || '';
  if (!want && !eff) return null;                        // nothing requested and no default configured
  const { provider, model: name } = splitModel(want);
  if (!provider || !name) throw new Error(`model must be "provider/model", got "${want}"`);
  const msg = deny(provider, name, eff || null,
    fromArg ? 'from the tool call' : 'from DSH_DEFAULT_MODEL/DSH_DEFAULT_EFFORT');
  if (msg) throw new Error(`${msg} - dsh_models lists what is selectable right now`);
  return { provider, model: name, effort: eff || null };
}

// MEASURED: model routing is per-profile, and the catalog fills in asynchronously after boot, so a
// dispatch can be admitted and then fail UNKNOWN_MODEL. Waiting for the wanted provider to appear is
// free (modelCatalog makes no model call) and replaces a blind retry.
async function awaitCatalog(provider, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const cat = await call('session/modelCatalog', ARGS.modelCatalog()).catch(() => null);
    const routable = (cat?.routableProviders || []).map(String);
    if (!provider || routable.includes(provider)) return cat;
    if (Date.now() >= deadline) {
      const err = new Error(`provider "${provider}" is not routable in this dsh profile (routable: ${routable.join(', ') || 'none'})`);
      err.detail = { failures: cat?.failures || null, default: cat?.default || null };
      throw err;
    }
    await sleep(1500);
  }
}

// `want` is the already-validated spec from assertModelAllowed, or null when nothing is pinned.
async function pinModel(sessionId, want) {
  if (!want) return null;
  await awaitCatalog(want.provider, CFG.catalogMs);
  const v = await call('session/selectModel', ARGS.sessionSelectModel({
    sessionId, provider: want.provider, model: want.model, reasoningEffort: want.effort }));
  log({ ev: 'pin', sessionId, selected: v?.selected });
  return v?.selected || null;
}

// Sidebar grouping is workspace membership, not display fluff and not cwd: created with `cwd` alone a
// session lands under "Ungrouped", while `workspaceId` puts it in the project group AND records the
// same cwd. workspace/create {path} is idempotent, so it doubles as a resolver. Retro-moving is
// refused ("workspace/move-invalid: the session is not accounted") => grouping is decided at creation.
async function resolveWorkspace(cwd) {
  try {
    const w = (await call('workspace/create', ARGS.workspaceCreate(cwd)))?.workspace || null;
    return w ? { workspaceId: w.workspaceId, title: w.title || null } : null;
  } catch (e) { log({ ev: 'workspace-resolve-failed', cwd, error: String(e.message || e) }); return null; }
}

async function findBaseline(sessionId, preSeq, requestId) {
  const { events } = await pageWindow(sessionId, preSeq, 40).catch(() => ({ events: [] }));
  return baselineFrom(preSeq, events, requestId);
}

async function dispatchRound(sessionId, task, requestId, { watchMs = CFG.watchMs } = {}) {
  const started = Date.now();
  const preSeq = await asOf(sessionId);
  await call('session/prompt', ARGS.sessionPrompt({ requestId, sessionId, text: task }));
  dropListCache();
  const { sinceSeq, correlated } = await findBaseline(sessionId, preSeq, requestId);
  const head = { requestId, sinceSeq, correlated, dispatchedAt: new Date().toISOString() };
  let idlePolls = 0;
  let r = { settled: false, state: 'running' };
  while (Date.now() - started < watchMs) {
    await sleep(CFG.pollMs);
    // Polling reads the TAIL: the in-flight round is the newest activity, so its turn/end (when it
    // lands) is at the end of the log, and walking the whole round on every poll would re-read
    // thousands of events. The tail is then filtered to seq > baseline, because a 40-event tail on a
    // freshly dispatched round still reaches back into the PREVIOUS round - whose turn/end would
    // otherwise be reported as this round's verdict (a false "completed" before the agent even starts).
    const { events } = await pageWindow(sessionId, sinceSeq, 40, 'tail').catch(() => ({ events: [] }));
    r = interpret(events.filter((e) => e.seq > sinceSeq), (await liveRow(sessionId, 0))?.running ?? null);
    if (r.settled) return { ...head, ...r, elapsedMs: Date.now() - started };
    idlePolls = r.state === 'idle' ? idlePolls + 1 : 0;
    if (idlePolls >= 2) {
      return { ...head, ...r, elapsedMs: Date.now() - started,
        note: 'accepted the task but the agent went idle with no turn/end recorded - treat this round as unverified' };
    }
  }
  return { ...head, settled: false, state: 'running', elapsedMs: Date.now() - started,
    note: `watch window (${watchMs}ms) ended; the round belongs to dsh now, keep polling with dsh_wait` };
}

const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 1) }] });
const fail = (e) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message || e),
  ...(e?.detail ? { detail: e.detail } : {}) }, null, 1) }], isError: true });

const server = new McpServer({ name: 'dsh', version: '0.3.0' }, {
  instructions: 'dsh is a second agent harness. Dispatch is asynchronous: dsh_launch/dsh_send return a handle, then call dsh_wait (<=45s per call) or dsh_status until state is completed/error/idle, and dsh_result to audit. Never treat acceptance, or a running->idle flip, as success; trust "state". Models are policy-bound: read dsh_models and pass model/reasoningEffort only from it. Sidebar grouping is fixed at creation: dsh_launch lands a session in the project group for its cwd; dsh_adopt cannot change an existing session\'s group.',
});

// One registration path so the tool count in the serve log cannot drift from the tools that exist.
const TOOL_NAMES = [];
const tool = (name, def, handler) => { TOOL_NAMES.push(name); server.registerTool(name, def, handler); };

const modelParams = {
  model: z.string().optional().describe('provider/model, only values permitted by DSH_ALLOWED_MODELS'),
  reasoningEffort: z.string().optional().describe('one of the efforts the chosen model advertises'),
};

tool('dsh_models', {
  description: 'List the models dsh can use right now (live catalog), narrowed by the DSH_ALLOWED_MODELS policy, with the default selection and any provider failures. Read this before choosing model/reasoningEffort. Makes no model call.',
  inputSchema: {},
}, async () => {
  try {
    log({ ev: 'tool', tool: 'dsh_models' });
    await ensureServer();
    const cat = await call('session/modelCatalog', ARGS.modelCatalog());
    const rows = [];
    for (const g of cat?.groups || []) for (const m of (g.models || [])) {
      const provider = g.provider || g.id || g.name;
      const name = m.id || m.model;
      rows.push({ provider, model: name, label: m.label || m.name || null,
        efforts: m.reasoningEfforts || m.efforts || null, permitted: !checkPolicy(ALLOW, provider, name, null) });
    }
    return json({ ok: true, policy: ALLOW ? allowedText(ALLOW) : '(unrestricted)', default: cat?.default || null,
      configuredDefaults: { model: CFG.defaultModel || null, effort: CFG.defaultEffort || null },
      routableProviders: cat?.routableProviders || null, failures: cat?.failures || null, models: rows });
  } catch (e) { return fail(e); }
});

tool('dsh_permissions', {
  description: 'Read-only view of the sandbox/permission surface: the presets dsh offers, the instance default, and - for an alias - the session\'s effective mode plus its change history (who escalated it and when). Changing the mode is NOT possible over /api; do it in the dsh UI.',
  inputSchema: { alias: z.string().optional().describe('include this session\'s effective mode and permission-event history') },
}, async ({ alias }) => {
  try {
    log({ ev: 'tool', tool: 'dsh_permissions', alias: alias || null });
    await ensureServer();
    const cat = await call('permissionPresets/catalog', ARGS.permissionCatalog()).catch(() => null);
    const out = { ok: true, presets: (cat?.options || []).map((o) => o.value), defaultPreset: cat?.defaultPreset || null,
      settableOverApi: false,
      note: 'permissionPresets/set, permissionPresets/current and session/setSandboxMode are not forwarded by the gateway (404). The only programmatic switch is the in-session /permission command, which this bridge deliberately does not call: raising a sandbox is a human decision.' };
    if (alias) {
      const s = regGet(alias);
      const p = await projections(s.sessionId).catch(() => null);
      const { events } = await pageWindow(s.sessionId, -1, 1000).catch(() => ({ events: [] }));
      out.session = { alias, sessionId: s.sessionId, effective: p?.permissions?.currentValue || null,
        agentPreset: p?.agentPreset || null, workingDirectory: p?.workingDirectory || null,
        ...permissionHistory(events) };
    }
    return json(out);
  } catch (e) { return fail(e); }
});

tool('dsh_launch', {
  description: 'Create a named dsh session bound to a workspace (landed in that path\'s sidebar group), pin its model, and dispatch the first task list. Returns a handle when the round settles or the watch window ends.',
  inputSchema: {
    alias: z.string().describe('caller-chosen name, e.g. p1-recon; becomes the session id "dsh-<alias>"'),
    cwd: z.string().describe('absolute workspace path; on Windows use backslashes'),
    task: z.string().describe('the task list; include acceptance criteria'),
    phase: z.string().optional(),
    group: z.boolean().optional().describe('default true: put the session in the sidebar group for this path; false leaves it Ungrouped'),
    dryRun: z.boolean().optional().describe('create + group + pin, dispatch nothing (spends no quota)'),
    allowOutsideCwd: z.boolean().optional().describe('needed only when the task WRITES outside cwd; such a dispatch is refused without it because dsh will deny the writes and nobody can approve the escalation. Merely naming a path (the ticket, a skill file, another repo read) is not blocked - it is reported in outsideCwd.read'),
    ...modelParams,
  },
}, async ({ alias, cwd, task, phase, model, reasoningEffort, group, dryRun, allowOutsideCwd }) => {
  try {
    log({ ev: 'tool', tool: 'dsh_launch', alias, cwd });
    checkAlias(alias);
    const dir = checkCwd(cwd);
    const want = assertModelAllowed(model, reasoningEffort);
    const outside = assertInsideCwd(task, dir, allowOutsideCwd);
    if (outside.all.length) log({ ev: 'cwd-advisory', alias, outside: outside.all, allowed: true });
    const sessionId = `dsh-${alias}`;
    const existing = readLedger()[alias];
    if (existing && normCwd(existing.cwd) !== normCwd(dir)) {
      return fail(new Error(`alias "${alias}" is bound to ${existing.cwd}, not ${dir}. Use dsh_send for that session, or pick another alias.`));
    }
    await ensureServer();
    let ws = existing?.workspaceId ? { workspaceId: existing.workspaceId, title: existing.workspaceTitle || null } : null;
    if (!existing) {
      if (group !== false && process.env.DSH_AUTO_GROUP !== '0') ws = await resolveWorkspace(dir);
      await call('session/create', ARGS.sessionCreate({ sessionId, ...(ws ? { workspaceId: ws.workspaceId } : { cwd: dir }) }));
    }
    const entry = await upsertAlias(alias, { sessionId, cwd: dir, phase: existing?.phase || phase || null,
      workspaceId: ws?.workspaceId || null, workspaceTitle: ws?.title || null, adopted: false,
      created: existing?.created || new Date().toISOString(), rounds: existing?.rounds || [] });
    const pinned = await pinModel(sessionId, want);
    if (dryRun) {
      return json({ ok: true, alias, sessionId, cwd: dir, grouped: !!ws, workspaceId: ws?.workspaceId || null,
        workspaceTitle: ws?.title || null, pinned, dispatched: false,
        warnings: outside.write.length ? [`dispatched anyway because allowOutsideCwd:true - dsh's sandbox will deny writes to ${outside.write.join(' , ')}`] : [],
        outsideCwd: outside, scope: await sessionScope(sessionId),
        note: 'dry run: session created and grouped, nothing dispatched' });
    }
    const scope = await sessionScope(sessionId);
    const res = await dispatchRound(sessionId, task, `${alias}-r${entry.rounds.length + 1}-${Date.now().toString(36)}`);
    await appendRound(alias, { ...roundRecord(res, pinned), task });
    return json({ ok: true, alias, sessionId, cwd: dir, grouped: !!ws, workspaceTitle: ws?.title || null,
      round: entry.rounds.length + 1, pinned, scope,
      warnings: outside.write.length ? [`allowOutsideCwd:true - writes to ${outside.write.join(' , ')} will be denied by the sandbox`] : [],
      outsideCwd: outside, ...res });
  } catch (e) { return fail(e); }
});

tool('dsh_send', {
  description: 'Dispatch the next task list into an existing alias (a new round of the same conversation). Re-pins only if you pass model/reasoningEffort.',
  inputSchema: { alias: z.string(), task: z.string(),
    allowOutsideCwd: z.boolean().optional().describe('needed only when the task WRITES outside the session workspace; read-only mentions of outside paths are reported, not blocked'),
    ...modelParams },
}, async ({ alias, task, model, reasoningEffort, allowOutsideCwd }) => {
  try {
    log({ ev: 'tool', tool: 'dsh_send', alias });
    const s = regGet(alias);
    const want = assertModelAllowed(model, reasoningEffort);
    const outside = assertInsideCwd(task, s.cwd, allowOutsideCwd);
    if (outside.all.length) log({ ev: 'cwd-advisory', alias, outside: outside.all, allowed: true });
    await ensureServer();
    const pinned = await pinModel(s.sessionId, want) || lastRound(s).pinned || s.pinned || null;
    const scope = await sessionScope(s.sessionId);
    const res = await dispatchRound(s.sessionId, task, `${alias}-r${(s.rounds || []).length + 1}-${Date.now().toString(36)}`);
    const rounds = await appendRound(alias, { ...roundRecord(res, pinned), task });
    return json({ ok: true, alias, sessionId: s.sessionId, round: rounds.length, pinned, scope,
      warnings: outside.write.length ? [`allowOutsideCwd:true - writes to ${outside.write.join(' , ')} will be denied by the sandbox (session workspace is ${s.cwd})`] : [],
      outsideCwd: outside, ...res });
  } catch (e) { return fail(e); }
});

tool('dsh_adopt', {
  description: 'Take over an ALREADY-EXISTING dsh session (e.g. one started in the web UI) under an alias, so later rounds and audits address it by name. Find ids with dsh_sessions {cwd}. Nothing is dispatched.',
  inputSchema: {
    alias: z.string(),
    sessionId: z.string().describe('existing dsh session id, verbatim - ids are opaque'),
    cwd: z.string().describe('the workspace that session was recorded in, in dsh\'s own form'),
    phase: z.string().optional(),
    ...modelParams,
  },
}, async ({ alias, sessionId, cwd, phase, model, reasoningEffort }) => {
  try {
    log({ ev: 'tool', tool: 'dsh_adopt', alias, sessionId });
    checkAlias(alias);
    const dir = checkCwd(cwd);
    const want = assertModelAllowed(model, reasoningEffort);
    const existing = readLedger()[alias];
    if (existing && existing.sessionId !== sessionId) {
      return fail(new Error(`alias "${alias}" already points at ${existing.sessionId}; choose another alias`));
    }
    await ensureServer();
    // MEASURED: over /api, create with an existing sessionId IS the resume/reuse operation.
    const v = await call('session/create', ARGS.sessionCreate({ sessionId, cwd: dir }));
    const effectiveId = v?.sessionId || sessionId;
    const pinned = await pinModel(effectiveId, want);
    const entry = await upsertAlias(alias, { sessionId: effectiveId, cwd: dir, phase: phase || existing?.phase || null,
      adopted: true, pinned, created: existing?.created || new Date().toISOString(), rounds: existing?.rounds || [] });
    dropListCache();
    const { events } = await pageTail(effectiveId, 8).catch(() => ({ events: [] }));   // adoption previews the tail, not the round
    return json({ ok: true, alias, requestedSessionId: sessionId, sessionId: effectiveId,
      agentPreset: v?.agentPreset || null, reused: effectiveId === sessionId, cwd: dir, pinned,
      sidebarGroup: 'not settable after creation; the adopted session keeps whatever group dsh put it in',
      tail: interpret(events, (await liveRow(effectiveId))?.running ?? null), rounds: entry.rounds.length,
      note: 'adopted without dispatching anything; call dsh_send to add a round' });
  } catch (e) { return fail(e); }
});

tool('dsh_wait', {
  description: 'Watch the current round until it settles, parks on a human approval, or maxSeconds elapses. Keep maxSeconds <= 45 to stay under the MCP tool timeout; call again if it returns state "running".',
  inputSchema: { alias: z.string(), maxSeconds: z.number().int().min(1).max(45).default(40) },
}, async ({ alias, maxSeconds }) => {
  try {
    log({ ev: 'tool', tool: 'dsh_wait', alias });
    const s = regGet(alias);                             // a wrong alias is refused without waking dsh
    await ensureServer();
    const started = Date.now();
    // readRound walks the log only once dsh stops reporting the session as running: while the agent
    // works, a poll is one small page; the moment a verdict is possible, the walk guarantees it is
    // this round's own. Forcing the cheap pass here reported a COMPLETED round as "idle" (measured
    // 2026-10-18: verdict at seq 1084, window stopped at 28) - and "idle" reads as "never dispatched".
    let r = await readRound(s);                           // answer at once if it already settled
    // Waiting cannot help while dsh is asking a human something: return the question instead of
    // burning the whole window and reporting "running".
    while (!r.settled && r.state !== 'idle' && !(r.pending || []).length && Date.now() - started + CFG.pollMs < maxSeconds * 1000) {
      await sleep(CFG.pollMs);
      r = await readRound(s);
    }
    if (r.settled) await refreshOutcome(alias, lastRound(s).requestId, r.state);
    return json({ ok: true, alias, round: (s.rounds || []).length, requestId: lastRound(s).requestId || null,
      waitedMs: Date.now() - started, ...r });
  } catch (e) { return fail(e); }
});

tool('dsh_status', {
  description: 'Immediate snapshot: current round state, model actually used, token usage, context pressure, pending plan, open user questions, and whether the session can run unattended at all (approvalPolicy/unattended - policy "ask" parks a round on a human).',
  inputSchema: { alias: z.string() },
}, async ({ alias }) => {
  try {
    log({ ev: 'tool', tool: 'dsh_status', alias });
    const s = regGet(alias);                             // a wrong alias is refused without waking dsh
    await ensureServer();
    const p = await projections(s.sessionId).catch(() => null);
    // The policy in effect NOW, not the one this round's events happen to contain: a human may have
    // escalated after the round ended, and "can I dispatch unattended" is about the present.
    const scope = await sessionScope(s.sessionId).catch(() => null);
    return json({ ok: true, alias, round: (s.rounds || []).length, ...await readRound(s),
      approvalPolicy: scope?.approvalPolicy ?? null, unattended: scope?.unattended ?? null,
      plan: p?.plan, userQuestions: p?.userQuestions, workingDirectory: p?.workingDirectory,
      sandbox: p?.permissions?.currentValue || null, permissions: p?.permissions || null,
      agentPreset: p?.agentPreset || null, sessionStats: p?.sessionStats || null,
      turnOutline: (p?.turnOutline || []).slice(-4),
      phase: s.phase || null, workspaceTitle: s.workspaceTitle || null,
      rounds: (s.rounds || []).map((r) => ({ requestId: r.requestId, outcome: r.outcome, pinned: r.pinned })) });
  } catch (e) { return fail(e); }
});

tool('dsh_result', {
  description: 'Audit payload for one round: every assistant text of that round, the tool calls that produced them, failed tool bodies, files touched, turn outline. Reads the round from its own baseline and walks the cursor forward until the round\'s own turn/end is collected, then cuts there - so a settled round is never reported as idle, and a later round is never mistaken for this one.',
  inputSchema: { alias: z.string(),
    messages: z.number().int().min(1).max(1000).default(24)
      .describe('how many EVENTS the first page reads; the walk keeps paging to this round\'s turn/end regardless, and the answer contains the whole round either way, so raising only this changes cost/latency, not completeness'),
    round: z.number().int().min(1).optional().describe('audit an earlier round instead of the latest') },
}, async ({ alias, messages, round }) => {
  try {
    log({ ev: 'tool', tool: 'dsh_result', alias, round: round || null });
    const s = regGet(alias);                             // a wrong alias is refused without waking dsh
    await ensureServer();
    const rounds = s.rounds || [];
    const target = round ? rounds[round - 1] : rounds[rounds.length - 1];
    if (!target) return fail(new Error(`alias "${alias}" has no rounds yet${round ? ` (asked for round ${round})` : ''}`));
    const { events, window } = await readRoundEvents(s.sessionId, target.sinceSeq ?? 0, { walk: true, first: messages });
    const p = await projections(s.sessionId).catch(() => null);
    const r = interpret(events, (await liveRow(s.sessionId))?.running ?? null);
    if (r.settled && target.outcome !== r.state) await refreshOutcome(alias, target.requestId, r.state);
    return json({ ok: true, alias, round: round || rounds.length, requestId: target.requestId || null,
      correlated: target.correlated ?? null, window, ...verdictFields(r, window),
      model: modelLabel(p?.modelSelection?.lastUsed || target.pinned || s.pinned),
      tokenUsage: p?.tokenUsage || null, ...r,
      assistantTexts: events.filter((e) => e.type === 'assistant/message')
        .map((a) => ({ turn: a.data?.turn, text: (a.data?.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').slice(0, 1200) })),
      turnOutline: (p?.turnOutline || []).slice(-6), task: target.task || null });
  } catch (e) { return fail(e); }
});

tool('dsh_sessions', {
  description: 'List aliases this bridge owns. Live dsh sessions are only returned when a cwd is given: the unfiltered list spans every workspace (90+ here) and must not be inlined.',
  inputSchema: { cwd: z.string().optional() },
}, async ({ cwd }) => {
  try {
    log({ ev: 'tool', tool: 'dsh_sessions', cwd: cwd || null });
    const want = cwd ? normCwd(checkCwd(cwd)) : null;    // a bad path is refused without waking dsh
    await ensureServer();
    const owned = Object.entries(readLedger()).map(([alias, s]) => ({ alias, sessionId: s.sessionId, cwd: s.cwd,
      phase: s.phase || null, workspaceTitle: s.workspaceTitle || null, grouped: !!s.workspaceId,
      pinned: s.pinned || null, rounds: (s.rounds || []).length, lastOutcome: lastRound(s).outcome || null }));
    if (!cwd) return json({ ok: true, owned });
    const v = await call('session/list', ARGS.sessionList());
    return json({ ok: true, owned,
      liveInCwd: (v?.items || []).filter((i) => normCwd(i.cwd) === want)
        .map((i) => ({ sessionId: i.sessionId, running: !!i.running, blank: !!i.blank })),
      note: `total sessions across all workspaces: ${v?.items?.length ?? '?'}` });
  } catch (e) { return fail(e); }
});

tool('dsh_cancel', {
  description: 'Ask dsh to cancel the in-flight round of an alias. Accepted asynchronously: confirm with dsh_wait, which should then report a settled or idle round.',
  inputSchema: { alias: z.string() },
}, async ({ alias }) => {
  try {
    log({ ev: 'tool', tool: 'dsh_cancel', alias });
    const s = regGet(alias);
    await ensureServer();
    const v = await call('session/cancel', ARGS.sessionCancel(s.sessionId));
    dropListCache();
    return json({ ok: true, alias, sessionId: s.sessionId, accepted: v?.accepted ?? null,
      note: 'accepted is not confirmation; poll dsh_wait for the resulting state' });
  } catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
log({ ev: 'serve', tools: TOOL_NAMES.length, toolNames: TOOL_NAMES, host: CFG.host, port: CFG.port, mode: CFG.attachOutfile ? 'attach' : 'spawn-on-demand',
  stateDir: STATE_DIR, policy: ALLOW ? allowedText(ALLOW) : '(unrestricted)',
  defaultModel: CFG.defaultModel || null, defaultEffort: CFG.defaultEffort || null, watchMs: CFG.watchMs });
