#!/usr/bin/env node
// T1.2 acceptance, phase A: the Adapter as a REAL MCP stdio server, over the REAL authenticated pipe.
//
//   node tools/probes/t1/acceptance.mjs
//
// What makes this a test rather than a demonstration: the client below is an MCP client that LAUNCHES
// the Adapter as a child process and speaks MCP over its stdin/stdout. Nothing is imported from the
// Adapter's implementation, so a passing run means the wire worked, not that two modules agreed with
// each other. The coordinator is the B1 PowerShell server, unmodified, so the refusals asserted here
// are the same kernel-enforced ones B1 measured.
//
// Scope: no Codex, no model, no network, no DSH. Phase B (Codex-driven discovery and invocation) is a
// separate script because it needs a model turn and therefore a mock provider.
//
// Every case gets its own coordinator process and its own pipe, because the coordinator's budget
// counter is per-connection. Sharing one would make "budget-exhausted" depend on test order.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const NODE = process.execPath;
const PS = 'powershell.exe';
const COORD = path.join(REPO, 'tools', 'probes', 'ipc', 'coordinator.ps1');
const ADAPTER = path.join(HERE, 'adapter.mjs');
const STATE = path.join(REPO, '.state', 't1');
const POLICY = path.join(STATE, 'policy.json');
const TOKEN = 't1-token';

const out = [];
let pass = 0, fail = 0;
const check = (name, ok, detail) => { out.push({ name, ok: !!ok, detail }); ok ? pass++ : fail++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-stdio-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let identities = [];       // filled while the processes are alive, asserted at the end

if (!fs.existsSync(STATE)) fs.mkdirSync(STATE, { recursive: true });
if (!fs.existsSync(POLICY)) fs.copyFileSync(path.join(HERE, 'policy.sample.json'), POLICY);

// ---- coordinator lifecycle ------------------------------------------------------------------
// Readiness is the line the server prints, not a sleep. A fixed wait is a guess about machine speed
// and turns a slow start into an assertion about policy.
async function startCoordinator({ denyAll = false } = {}) {
  const pipe = 'dsh-t1-' + Math.random().toString(36).slice(2, 10);
  const outFile = path.join(dir, pipe + '.out');
  const errFile = path.join(dir, pipe + '.err');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', COORD,
    '-PipeName', pipe, '-PolicyFile', POLICY];
  if (denyAll) args.push('-DenyAll');
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  const child = spawn(PS, args, { stdio: ['ignore', fdOut, fdErr], windowsHide: true });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const txt = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    if (txt.includes('"event":"listening"')) {
      const line = txt.split(/\r?\n/).find((l) => l.includes('"event":"listening"'));
      const info = JSON.parse(line);
      return { pipe, child, outFile, pid: info.pid };
    }
    if (txt.includes('"event":"connect-failed"')) break;
    await sleep(100);
  }
  try { child.kill(); } catch {}
  throw new Error('coordinator did not reach listening: ' + (fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8').slice(0, 400) : ''));
}

async function stopCoordinator(h) {
  try { h.child.kill(); } catch {}
  await sleep(80);
  try { fs.rmSync(h.outFile, { force: true }); } catch {}
}

// ---- an MCP client that launches the Adapter as a child process ------------------------------
async function openAdapter({ pipe, token = TOKEN, raw = false } = {}) {
  const env = {
    ...process.env,
    DSH_BRIDGE_PIPE: pipe,
    DSH_BRIDGE_TOKEN: token,
    ...(raw ? { DSH_BRIDGE_RAW_HANDSHAKE: '1' } : { DSH_BRIDGE_RAW_HANDSHAKE: '' }),
  };
  const transport = new StdioClientTransport({
    command: NODE,
    args: [ADAPTER],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 't1-harness', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

// A tool refusal is a tool RESULT with isError, so "the tool did not throw" proves nothing. Every
// assertion goes through this: it reads the structured error code the Adapter emits.
const errorCode = (res) => {
  if (!res || !res.isError) return null;
  const text = (res.content || []).map((c) => c.text || '').join('');
  try { return JSON.parse(text).error || null; } catch { return text.slice(0, 120); }
};
const payload = (res) => {
  const text = (res.content || []).map((c) => c.text || '').join('');
  try { return JSON.parse(text); } catch { return null; }
};

// ---- who is running, asked while the processes are still alive -------------------------------
// Attribution has to happen before teardown: a dead pid has no owner, and "the process exited" reads
// exactly like "the process was never attributable". Windows PowerShell 5.1 has no -AsArray, so the
// array is forced by wrapping the pipeline in @().
async function captureIdentity(pids) {
  const wanted = pids.filter((n) => Number.isInteger(n));
  if (!wanted.length) return [];
  const script = `
$ErrorActionPreference='SilentlyContinue'
$rows = foreach ($ProcessId in @(${wanted.join(',')})) {
  $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
  if (-not $ci) { [pscustomobject]@{ pid=$ProcessId; account=$null; sid=$null; name=$null }; continue }
  $o = Invoke-CimMethod -InputObject $ci -MethodName GetOwner
  $acct = if ($o -and $o.User) { "$($o.Domain)\\$($o.User)" } else { $null }
  $sid = $null
  if ($acct) { try { $sid = (New-Object System.Security.Principal.NTAccount($acct)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {} }
  [pscustomobject]@{ pid=$ProcessId; account=$acct; sid=$sid; name=$ci.Name }
}
@($rows) | ConvertTo-Json -Depth 4
`;
  return await new Promise((resolve) => {
    const p = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let buf = '';
    p.stdout.on('data', (c) => { buf += c; });
    p.on('close', () => {
      try {
        const parsed = JSON.parse(buf.trim());
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch { resolve([]); }
    });
  });
}

// ============================================================================================
// 1. Discovery: what the Adapter offers, and what it deliberately does not
// ============================================================================================
{
  const h = await startCoordinator();
  const { client } = await openAdapter({ pipe: h.pipe });
  try {
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    check('an MCP client discovers the Adapter tool surface over stdio',
      JSON.stringify(names) === JSON.stringify(['adapter_info', 'dispatch_submit']), { tools: names });

    const before = payload(await client.callTool({ name: 'adapter_info', arguments: {} }));
    check('the Adapter reports the pipe it targets and that it authenticates',
      before && before.pipe === h.pipe && before.authenticates === true, before);
    // Laziness is a property, not an implementation detail: a server that connects at startup cannot
    // report a refusal through a tool result, because it has already died.
    check('the Adapter does not connect to the pipe before it is asked to do work',
      before && before.connected === false, before && { connected: before.connected });
    // T1 item 7, asserted rather than promised: the capabilities an agent must not reach are
    // reported absent by the process itself.
    check('the Adapter has no filesystem, exec, http, sql or admin capability',
      before && Object.values(before.capabilities).every((v) => v === false), before && before.capabilities);
    check('no tool name suggests a forwarding surface',
      !names.some((n) => /http|exec|sql|shell|admin|proxy|forward|eval/i.test(n)), { tools: names });
    check('the Adapter process is a real separate process',
      before && Number.isInteger(before.pid) && before.pid !== process.pid, { adapterPid: before && before.pid, harnessPid: process.pid });

    // Now make it connect, then ask again: one dispatch is enough to prove the pipe is live.
    await client.callTool({ name: 'dispatch_submit', arguments: { goalId: 'goal-1', threadId: 'thread-registered', cwd: 'D:\\ws\\allowed' } });
    const after = payload(await client.callTool({ name: 'adapter_info', arguments: {} }));
    check('after one dispatch the Adapter reports a live authenticated connection',
      after && after.connected === true && after.connectError === null, after && { connected: after.connected });

    identities = await captureIdentity([process.pid, before && before.pid, h.pid]);  } finally {
    try { await client.close(); } catch {}
    await stopCoordinator(h);
  }
}

// ============================================================================================
// 2. The one path that must succeed
// ============================================================================================
{
  const h = await startCoordinator();
  const { client } = await openAdapter({ pipe: h.pipe });
  try {
    const res = await client.callTool({
      name: 'dispatch_submit',
      arguments: {
        goalId: 'goal-1', threadId: 'thread-registered', cwd: 'D:\\ws\\allowed',
        clientRequestId: 'req-t1-ok',
      },
    });
    const p = payload(res);
    check('a legal read-only dispatch succeeds end to end', !res.isError && p && p.ok === true, p || res);
    check('the success carries a coordinator-issued dispatchId',
      p && /^dsp-[0-9a-f]{12}$/.test(String(p.dispatchId || '')), { dispatchId: p && p.dispatchId });
    check('the success carries the budget the coordinator applied',
      p && p.budget && p.budget.used === 1 && p.budget.max === 2, p && p.budget);
    check('the adapter echoes the correlation id it was given',
      p && p.clientRequestId === 'req-t1-ok', { clientRequestId: p && p.clientRequestId });
  } finally {
    try { await client.close(); } catch {}
    await stopCoordinator(h);
  }
}

// ============================================================================================
// 3. The refusals, replayed on the real stdio path (B1's matrix, now through a tool call)
// ============================================================================================
async function refusal(name, args, expected, opts = {}) {
  const h = await startCoordinator({ denyAll: opts.denyAll });
  const { client } = await openAdapter({ pipe: h.pipe, token: opts.token, raw: opts.raw });
  try {
    const res = await client.callTool({ name: 'dispatch_submit', arguments: args });
    const got = errorCode(res) || (opts.denyAll ? String(errorCode(res) || '') : null);
    check(name, String(got) === expected || String(got).startsWith(expected), { expected, got, payload: payload(res) });
    return got;
  } finally {
    try { await client.close(); } catch {}
    await stopCoordinator(h);
  }
}

const OK_ARGS = { goalId: 'goal-1', threadId: 'thread-registered', cwd: 'D:\\ws\\allowed' };

await refusal('an unknown goal is refused', { ...OK_ARGS, goalId: 'goal-absent' }, 'unknown-goal');
await refusal('a proposed (unauthorized) goal is refused', { ...OK_ARGS, goalId: 'goal-proposed' }, 'goal-not-authorized');
await refusal('a revoked goal is refused', { ...OK_ARGS, goalId: 'goal-revoked' }, 'goal-not-authorized');
await refusal('an unregistered thread is refused', { ...OK_ARGS, threadId: 'thread-forged' }, 'thread-not-registered');
await refusal('a cwd outside the goal is refused', { ...OK_ARGS, cwd: 'D:\\ws\\forbidden' }, 'cwd-not-allowed');
await refusal('a bad token is refused', OK_ARGS, 'bad-token', { token: 'wrong-token' });
// The coordinator treats "connected" as "not yet authenticated"; this proves the Adapter cannot
// obtain a weaker session by simply not performing the handshake.
await refusal('skipping the handshake is refused, not tolerated', OK_ARGS, 'handshake-required', { raw: true });
await refusal('a DACL that denies this caller refuses the connection itself', OK_ARGS, 'ipc-', { denyAll: true });

// ---- budget: two admitted, the third refused, on one connection -----------------------------
{
  const h = await startCoordinator();
  const { client } = await openAdapter({ pipe: h.pipe });
  try {
    const a = await client.callTool({ name: 'dispatch_submit', arguments: OK_ARGS });
    const b = await client.callTool({ name: 'dispatch_submit', arguments: OK_ARGS });
    const c = await client.callTool({ name: 'dispatch_submit', arguments: OK_ARGS });
    const pa = payload(a), pb = payload(b), pc = payload(c);
    check('the budget admits the rounds it allows',
      !a.isError && !b.isError && pa.budget.used === 1 && pb.budget.used === 2, { used: [pa && pa.budget, pb && pb.budget] });
    check('the round after the budget is refused, not silently admitted',
      errorCode(c) === 'budget-exhausted', { error: errorCode(c), detail: pc });
    check('a refused round issues no dispatchId', pc && pc.ok === false, pc);
  } finally {
    try { await client.close(); } catch {}
    await stopCoordinator(h);
  }
}

// ============================================================================================
// 4. The Adapter is not a proxy: inputs are narrowed before anything reaches the wire
// ============================================================================================
{
  const h = await startCoordinator();
  const { client } = await openAdapter({ pipe: h.pipe });
  try {
    const traversal = await client.callTool({ name: 'dispatch_submit', arguments: { ...OK_ARGS, cwd: 'D:\\ws\\allowed\\..\\forbidden' } })
      .catch((e) => ({ isError: true, content: [{ text: String(e.message || e) }] }));
    check('a cwd containing a parent segment never reaches the coordinator',
      traversal.isError && !/dsp-/.test(JSON.stringify(traversal.content || '')), { content: traversal.content });

    const notAbsolute = await client.callTool({ name: 'dispatch_submit', arguments: { ...OK_ARGS, cwd: 'ws\\allowed' } })
      .catch((e) => ({ isError: true, content: [{ text: String(e.message || e) }] }));
    check('a relative cwd is refused by schema, not resolved', notAbsolute.isError, { content: notAbsolute.content });

    // Extra keys are not forwarded: the outbound message is assembled field by field, so a caller
    // cannot smuggle a method name or a second target through the argument object.
    const smuggled = await client.callTool({
      name: 'dispatch_submit',
      arguments: { ...OK_ARGS, type: 'admin', method: 'shutdown', pipe: 'other-pipe' },
    });
    const ps = payload(smuggled);
    check('unknown fields are dropped rather than forwarded', !smuggled.isError && ps && /^dsp-/.test(String(ps.dispatchId || '')),
      ps || smuggled);
  } finally {
    try { await client.close(); } catch {}
    await stopCoordinator(h);
  }
}

// ---- a refused connection is a fact, not a retry loop --------------------------------------
{
  const h = await startCoordinator({ denyAll: true });
  const { client } = await openAdapter({ pipe: h.pipe });
  try {
    const first = await client.callTool({ name: 'dispatch_submit', arguments: OK_ARGS });
    const second = await client.callTool({ name: 'dispatch_submit', arguments: OK_ARGS });
    const info = payload(await client.callTool({ name: 'adapter_info', arguments: {} }));
    check('a connection refusal is reported on every call, without opening new connections',
      errorCode(first) === errorCode(second) && errorCode(first) !== null,
      { first: errorCode(first), second: errorCode(second) });
    check('the Adapter records the refusal as the reason it is disconnected',
      info && info.connected === false && info.connectError, info && { connected: info.connected, connectError: info.connectError });
  } finally {
    try { await client.close(); } catch {}
    await stopCoordinator(h);
  }
}

// ============================================================================================
// 5. Who actually ran what (T1 item 5). Measured while alive, asserted here.
// ============================================================================================
{
  const nonNull = identities.filter((i) => i && i.sid);
  const distinctSids = [...new Set(nonNull.map((i) => i.sid))];
  const distinctNames = [...new Set(nonNull.map((i) => i.name))];
  check('every process in the chain was attributed to an account and a SID',
    identities.length >= 2 && nonNull.length === identities.length, identities);
  // The finding T1 item 5 exists to produce: an MCP stdio child is NOT a separate security principal.
  // Stated as a measurement so that a future change (a service account, a container) is visible here
  // as a changed number rather than as an unexamined assumption.
  check('the Adapter and the coordinator run as the same principal as the caller',
    distinctSids.length === 1, { distinctSids });
  check('they are nevertheless distinct processes',
    distinctNames.length >= 2, { names: distinctNames, identities });
}

console.log(JSON.stringify({
  pass, fail, checks: out,
  identities,
  finding: 'MCP stdio child and the IPC coordinator share the caller\'s SID: the process boundary is not a security boundary. Any isolation claim must come from the pipe DACL, the token, and the policy - not from "it is a different process".',
}, null, 2));
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
