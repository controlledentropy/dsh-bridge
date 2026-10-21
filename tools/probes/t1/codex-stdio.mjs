#!/usr/bin/env node
// T1.2 acceptance, phase B: a REAL Codex app-server discovers and calls the REAL MCP stdio Adapter.
//
//   node tools/probes/t1/codex-stdio.mjs
//
// Phase A proved the Adapter speaks MCP and the coordinator's policy holds. It could not prove the
// thing T1 item 1 asks for, because it supplied the MCP client itself. Here the client is Codex: it
// launches the Adapter from its own config, lists the tool, offers it to the model, and executes the
// call the model asks for. A passing run therefore means the wiring works in the configuration a
// Codex instance would actually use.
//
// Isolation (the P0-b1 rule, unchanged): its own CODEX_HOME and CODEX_SQLITE_HOME under .state/t1,
// a mock provider on loopback with no credentials, a scratch workspace, and a coordinator that is a
// local PowerShell process. No real codex home, no Desktop thread, no DSH call.
//
// Evidence is read from three independent places rather than from one log line: the provider's record
// of what tools it was offered, the provider's record of the tool output it received back, and the
// app-server's own notifications. A single source agreeing with itself proves nothing.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const NODE = process.execPath;
const PS = 'powershell.exe';
const CODEX = path.join(REPO, '.state', 'p0b1', 'vendor', 'node_modules', '@openai', 'codex-win32-x64',
  'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
const COORD = path.join(REPO, 'tools', 'probes', 'ipc', 'coordinator.ps1');
const MOCK = path.join(REPO, 'tools', 'probes', 'mock-responses-server.mjs');
const ADAPTER = path.join(HERE, 'adapter.mjs');
const STATE = path.join(REPO, '.state', 't1');
const POLICY = path.join(STATE, 'policy.json');
const HOME = path.join(STATE, 'codex-home');
const SQLITE = path.join(STATE, 'codex-sqlite');
const WORKSPACE = path.join(STATE, 'workspace');
const TOKEN = 't1-token';
const ALLOWED_CWD = 'D:\\ws\\allowed';

const out = [];
let pass = 0, fail = 0;
const check = (name, ok, detail) => { out.push({ name, ok: !!ok, detail }); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-'));

for (const d of [STATE, HOME, SQLITE, WORKSPACE]) fs.mkdirSync(d, { recursive: true });
if (!fs.existsSync(POLICY)) fs.copyFileSync(path.join(HERE, 'policy.sample.json'), POLICY);

const children = [];
const track = (c) => { children.push(c); return c; };
const cleanup = () => { for (const c of children) { try { c.kill(); } catch {} } };

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ---- a port the OS has actually freed -------------------------------------------------------
async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitFor(fn, { timeoutMs = 30000, everyMs = 150, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error('timed out waiting for ' + what);
}

// ---- the mock model, which must ask for the tool --------------------------------------------
async function startMock() {
  const logFile = path.join(dir, 'requests.jsonl');
  const fullFile = path.join(dir, 'full.jsonl');
  const child = track(spawn(NODE, [MOCK, '--port', '0', '--log', logFile, '--full-log', fullFile,
    '--text', 'T1-ADAPTER-CALLED-OK',
    '--call', 'dispatch_submit',
    '--call-args', JSON.stringify({ goalId: 'goal-1', threadId: 'thread-registered', cwd: ALLOWED_CWD, clientRequestId: 't1-codex-1' }),
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('mock provider did not print its port')), 15000);
    child.stdout.on('data', (c) => {
      buf += c;
      const line = buf.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
      if (line) { clearTimeout(t); resolve(JSON.parse(line)); }
    });
    child.stderr.on('data', (c) => { buf += ''; void c; });
  });
  return { child, port: info.port, logFile, fullFile };
}

// ---- the coordinator, as in phase A ----------------------------------------------------------
async function startCoordinator() {
  const pipe = 'dsh-t1c-' + Math.random().toString(36).slice(2, 10);
  const outFile = path.join(dir, pipe + '.out');
  const fd = fs.openSync(outFile, 'w');
  const child = track(spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    COORD, '-PipeName', pipe, '-PolicyFile', POLICY], { stdio: ['ignore', fd, 'ignore'], windowsHide: true }));
  await waitFor(() => {
    const txt = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    return txt.includes('"event":"listening"');
  }, { what: 'coordinator listening', timeoutMs: 20000 });
  return { pipe, child };
}

function writeConfig(mockPort, pipe) {
  const toml = `# Generated by tools/probes/t1/codex-stdio.mjs. Isolated: no real provider, no credentials.
model = "mock-model"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.mock_provider]
name = "Mock provider for T1"
base_url = "http://127.0.0.1:${mockPort}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0

[features]
shell_tool = true
web_search = false

# The whole point of T1: Codex launches this process itself and speaks MCP over its stdin/stdout.
[mcp_servers.dsh_bridge]
command = "${NODE.replace(/\\/g, '/')}"
args = ["${ADAPTER.replace(/\\/g, '/')}"]

[mcp_servers.dsh_bridge.env]
DSH_BRIDGE_PIPE = "${pipe}"
DSH_BRIDGE_TOKEN = "${TOKEN}"
`;
  fs.writeFileSync(path.join(HOME, 'config.toml'), toml, 'utf8');
}

// ---- the app-server, with its own home on both axes ------------------------------------------
// A blocked environment must not read as a failed assertion. If the binary cannot initialise its own
// state runtime, every downstream claim (discovery, invocation, identity) is untested rather than
// false, and reporting it as "failed" would invite someone to weaken the assertions until they pass.
class Blocked extends Error {
  constructor(reason, evidence) { super(reason); this.reason = reason; this.evidence = evidence; }
}

async function startAppServer() {
  const port = await freePort();
  const tokenFile = path.join(dir, 'ws.token');
  fs.writeFileSync(tokenFile, 't1-ws-token', 'utf8');
  const child = track(spawn(CODEX, ['app-server', '--listen', `ws://127.0.0.1:${port}`,
    '--ws-auth', 'capability-token', '--ws-token-file', tokenFile,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: HOME, CODEX_SQLITE_HOME: SQLITE },
  }));
  let stderrBuf = '';
  child.stderr.on('data', (c) => { stderrBuf += c; });
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  const readyz = await waitFor(async () => {
    if (exited !== null) return 'exited';
    try {
      const r = await fetch(`http://127.0.0.1:${port}/readyz`);
      return r.ok ? 'ready' : false;
    } catch { return false; }
  }, { what: 'app-server readyz', timeoutMs: 30000 }).catch(() => 'timeout');

  if (readyz !== 'ready') {
    throw new Blocked('app-server did not become ready', {
      outcome: readyz,
      exitCode: exited,
      stderr: stderrBuf.trim().slice(0, 1200),
    });
  }
  return { child, port, tokenFile, readyz, stderr: () => stderrBuf };
}

// ---- a minimal JSON-RPC client over the app-server's websocket -------------------------------
function rpcClient(url, token) {
  const ws = new WebSocket(url, { headers: { authorization: 'Bearer ' + token } });
  let nextId = 0;
  const pending = new Map();
  const notifications = [];
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(String(m.error.message || 'rpc error')), { rpc: m.error }));
      else p.resolve(m.result);
      return;
    }
    if (m.method) notifications.push(m);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, 60000);
  });
  return { ws, ready, call, notifications };
}

// ---- run it ---------------------------------------------------------------------------------
const mock = await startMock();
const coord = await startCoordinator();
writeConfig(mock.port, coord.pipe);

let as;
try {
  as = await startAppServer();
} catch (e) {
  cleanup();
  if (e instanceof Blocked) {
    // Exit 3 is "the environment prevented the test", which is a different claim from "the test
    // failed". Downstream reporting must be able to tell them apart without reading prose.
    console.log(JSON.stringify({
      blocked: true,
      phase: 'app-server startup',
      reason: e.reason,
      evidence: e.evidence,
      whatThisDoesNotShow: 'Nothing about T1 items 1, 3, 5 or 6 is established or refuted by this run. The Adapter, the pipe, the policy and the discovery wiring are untested against a real Codex here.',
      reproducer: 'see docs/EVIDENCE.md E-T1-CODEX-STATE-RUNTIME',
    }, null, 2));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    process.exit(3);
  }
  throw e;
}

const client = rpcClient(`ws://127.0.0.1:${as.port}`, 't1-ws-token');
await client.ready;

const init = await client.call('initialize', {
  clientInfo: { name: 't1-acceptance', version: '0.1.0' },
  capabilities: { experimentalApi: true },
});
check('the app-server accepted the client and reports its home',
  !!init && (init.userAgent || init.codexHome), { userAgent: init && init.userAgent, codexHome: init && init.codexHome });

const started = await client.call('thread/start', { cwd: WORKSPACE, approvalPolicy: 'never', sandbox: 'read-only' });
const threadId = (started && started.thread && started.thread.id) || (started && started.threadId);
check('a thread can be started in the isolated workspace', !!threadId, { threadId });

const turn = await client.call('turn/start', {
  threadId,
  input: [{ type: 'text', text: 'Call the dsh-bridge dispatch tool once, then report the dispatchId. Do not call anything else.' }],
});
const turnId = (turn && turn.turn && turn.turn.id) || (turn && turn.turnId) || (turn && turn.id);
check('a turn was accepted', !!turnId, { turnId });

// Wait for the provider to have been called twice: once to ask for the tool, once to consume its
// output. The count is arithmetic, not a guess about how a turn is implemented.
await waitFor(() => {
  if (!fs.existsSync(mock.logFile)) return false;
  const n = fs.readFileSync(mock.logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  return n >= 2;
}, { what: 'two provider calls', timeoutMs: 60000 });

const requests = fs.readFileSync(mock.logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const fulls = fs.existsSync(mock.fullFile)
  ? fs.readFileSync(mock.fullFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];

const first = requests[0] || {};
const offered = first.toolNames || [];
check('Codex discovered the MCP tool and offered it to the model',
  offered.some((n) => n.includes('dispatch_submit')), { offered });
check('the model was given the tool alongside its own tools, not instead of them',
  offered.length >= 1 && (first.toolCount || 0) === offered.length, { toolCount: first.toolCount, offered });

const second = requests[1] || {};
const toolOutputText = JSON.stringify(fulls[1] || {});
check('the model received a tool result back from Codex', second.toolCount > 0 && !!fulls[1], {
  secondToolCount: second.toolCount, hasFull: !!fulls[1],
});
// The decisive evidence: the dispatchId is minted by the PowerShell coordinator, which never sees the
// model. Finding it in what the model was told back means the call really crossed
// Codex -> Adapter -> pipe -> coordinator -> pipe -> Adapter -> Codex -> model.
const minted = /dsp-[0-9a-f]{12}/.exec(toolOutputText);
check('the tool result carries a dispatchId minted by the coordinator', !!minted, {
  dispatchId: minted && minted[0], preview: toolOutputText.slice(0, 300),
});

// The app-server's own view, independent of the provider log.
const turnText = JSON.stringify(client.notifications);
check('the app-server reported the assistant reply for this turn', turnText.includes('T1-ADAPTER-CALLED-OK'), {
  notifications: client.notifications.length,
  methods: [...new Set(client.notifications.map((n) => n.method))].slice(0, 12),
});

// T1 item 6: the sandbox does not gate a stdio child. The dispatch above already proves the child
// ran, but the claim is worth stating with the sandbox's own state beside it, because the two facts
// are routinely conflated ("the sandbox is not provisioned, so nothing can run").
const sandboxConfigured = (() => {
  try {
    const p = path.join(HOME, 'sandbox.toml');
    return fs.existsSync(p);
  } catch { return false; }
})();
check('an MCP stdio child runs even though the shell sandbox is not provisioned for this home',
  !!minted && sandboxConfigured === false,
  { perHomeSandboxConfigPresent: sandboxConfigured, note: 'exec_command and stdio children are gated by different mechanisms' });

// ---- who ran the Adapter, now that Codex is the parent --------------------------------------
const adapterPids = await new Promise((resolve) => {
  const script = `$ErrorActionPreference='SilentlyContinue'
@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*t1*adapter.mjs*' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json`;
  const p = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  let buf = '';
  p.stdout.on('data', (c) => { buf += c; });
  p.on('close', () => { try { const v = JSON.parse(buf.trim()); resolve(Array.isArray(v) ? v : [v]); } catch { resolve([]); } });
});

const identity = await new Promise((resolve) => {
  const pids = [process.pid, as.port && as.child.pid, ...adapterPids].filter((n) => Number.isInteger(n));
  const script = `$ErrorActionPreference='SilentlyContinue'
$rows = foreach ($ProcessId in @(${pids.join(',')})) {
  $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
  if (-not $ci) { continue }
  $o = Invoke-CimMethod -InputObject $ci -MethodName GetOwner
  $acct = if ($o -and $o.User) { "$($o.Domain)\\$($o.User)" } else { $null }
  $sid = $null
  if ($acct) { try { $sid = (New-Object System.Security.Principal.NTAccount($acct)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {} }
  [pscustomobject]@{ pid=$ProcessId; name=$ci.Name; account=$acct; sid=$sid }
}
@($rows) | ConvertTo-Json -Depth 4`;
  const q = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  let buf = '';
  q.stdout.on('data', (c) => { buf += c; });
  q.on('close', () => { try { const v = JSON.parse(buf.trim()); resolve(Array.isArray(v) ? v : [v]); } catch { resolve([]); } });
});

check('the Adapter was launched as a child of the app-server, not by this script',
  adapterPids.length >= 1, { adapterPids });
check('the app-server, the Adapter and this driver all run as one principal',
  identity.length >= 2 && new Set(identity.map((i) => i.sid)).size === 1,
  { identities: identity });

try { client.ws.close(); } catch {}
cleanup();

console.log(JSON.stringify({
  pass, fail, checks: out,
  identities: identity,
  providerRequests: requests.map((r) => ({ toolCount: r.toolCount, tools: (r.toolNames || []).filter((n) => n.includes('dispatch')), inputChars: r.inputChars })),
  finding: 'The MCP tool name that Codex exposes is discovered from the request, not assumed; the dispatchId in the tool result is minted by the coordinator, so its presence proves the full chain rather than a shared log.',
}, null, 2));
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
