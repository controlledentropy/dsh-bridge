// Offline MCP tests: spawn bridge.mjs exactly as an MCP client (Codex) does, then exercise only the
// paths that must fail before any side effect. DSH_NO_SPAWN=1 plus a closed port means a mistake here
// surfaces as an error instead of cold-booting dsh, and the bridge log is asserted to hold no api,
// auth or spawn entries - proof that a refused call touched nothing.
//
// Every test closes the child in a finally: an assertion failure must never orphan a bridge process,
// which would hang the runner instead of reporting the failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = ['dsh_models', 'dsh_permissions', 'dsh_launch', 'dsh_send', 'dsh_adopt', 'dsh_wait', 'dsh_status', 'dsh_result', 'dsh_sessions', 'dsh_cancel', 'dsh_stop'];

// A Codex-shaped minimal environment: only what the bridge actually needs, in a throwaway state dir.
function bridgeEnv(stateDir, extra) {
  const env = { DSH_NO_SPAWN: '1', DSH_PORT: '3999', DSH_HOST: '127.0.0.1', DSH_BRIDGE_STATE: stateDir, ...extra };
  for (const k of ['PATH', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'COMSPEC', 'HOME', 'NODE_PATH']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-test-'));
  const cwd = path.join(dir, 'ws');
  const sibling = path.join(dir, 'other-repo');
  fs.mkdirSync(cwd);                                   // checkCwd requires a real directory
  fs.mkdirSync(sibling);                               // a real directory outside the session workspace
  return { dir, state: path.join(dir, 'state'), cwd, sibling, missing: path.join(cwd, 'not-created'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withBridge(env, fn) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(PKG, 'bridge.mjs')], cwd: PKG, env, stderr: 'pipe' }));
  try { return await fn(client); } finally { await client.close(); }
}

const parsed = (r) => { try { return JSON.parse((r.content || []).map((c) => c.text).join('')); } catch { return { raw: (r.content || []).map((c) => c.text).join('') }; } };

function assertNoSideEffects(stateDir) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(stateDir, 'bridge.log.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return; }
  const bad = lines.filter((l) => ['api', 'api-retry', 'auth', 'spawn', 'pin'].includes(l.ev) || l.endpoint);
  assert.deepEqual(bad, [], 'a refused call must not reach dsh: ' + JSON.stringify(bad));
}

test('handshake, instructions and the full tool surface', async (t) => {
  const ws = workspace();
  try {
    await withBridge(bridgeEnv(ws.state, { DSH_ALLOWED_MODELS: 'deepseek-account/deepseek-flash:low|high' }), async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((x) => x.name).sort(), [...TOOLS].sort());
      for (const x of tools) {
        assert.ok(x.description && x.description.length > 30, `${x.name} needs a description an agent can act on`);
        assert.equal(x.inputSchema.type, 'object');
        assert.ok(!('inputSchema' in (x.inputSchema.properties || {})), 'no nested inputSchema key (a duplicate would silently drop fields)');
      }
      const launch = tools.find((x) => x.name === 'dsh_launch');
      assert.deepEqual(Object.keys(launch.inputSchema.properties).sort(),
        ['alias', 'allowOutsideCwd', 'cwd', 'detail', 'dryRun', 'force', 'group', 'model', 'phase', 'reasoningEffort', 'supersedes', 'task'].sort(),
        'dsh_launch keeps every declared parameter');
      assert.ok((launch.inputSchema.required || []).includes('alias'));
      assert.match(client.getInstructions(), /trust "state"/, 'instructions state that acceptance is not completion');
    });
    assertNoSideEffects(ws.state);
  } finally { ws.cleanup(); }
});

test('every pre-flight refusal happens before dsh is touched', async () => {
  const ws = workspace();
  try {
    await withBridge(bridgeEnv(ws.state, {
      DSH_ALLOWED_MODELS: 'deepseek-account/deepseek-flash:low|high',
      DSH_DEFAULT_MODEL: 'deepseek-account/deepseek-flash', DSH_DEFAULT_EFFORT: 'low',
    }), async (client) => {
      const cases = [
        ['dsh_launch', { alias: 'bad alias!', cwd: ws.cwd, task: 'x' }, /must match/],
        ['dsh_launch', { alias: 'ok', cwd: 'relative/dir', task: 'x' }, /must be absolute/],
        ['dsh_launch', { alias: 'ok', cwd: ws.missing, task: 'x' }, /does not exist/],
        ['dsh_launch', { alias: 'ok', cwd: ws.cwd, task: 'x', model: 'deepseek-account/deepseek-v4-pro' }, /not permitted by DSH_ALLOWED_MODELS/],
        ['dsh_launch', { alias: 'ok', cwd: ws.cwd, task: 'x', model: 'deepseek-account/deepseek-flash', reasoningEffort: 'max' }, /effort "max"/],
        ['dsh_launch', { alias: 'ok', cwd: ws.cwd, task: 'x', model: 'no-slash' }, /provider\/model/],
        // The 2026-10-18 incident: a task aimed at another repository, dispatched into a session bound
        // to a different workspace, is denied by dsh's sandbox and burns a whole round. Refuse it here.
        ['dsh_launch', { alias: 'ok', cwd: ws.cwd, task: `在 ${ws.sibling} 里实现并跑测试` }, /outside the session workspace/],
        // supersedes names an alias, so a typo is refused before any side effect - not after a session exists
        ['dsh_launch', { alias: 'ok', cwd: ws.cwd, task: 'x', supersedes: 'never-existed' }, /not in the ledger/],
        ['dsh_send', { alias: 'never-created', task: 'x' }, /unknown alias/],
        ['dsh_adopt', { alias: 'ok', sessionId: 's', cwd: ws.cwd, model: 'deepseek-account/deepseek-v4-pro' }, /not permitted/],
        ['dsh_adopt', { alias: 'bad alias!', sessionId: 's', cwd: ws.cwd }, /must match/],
        ['dsh_wait', { alias: 'never-created' }, /unknown alias/],
        ['dsh_status', { alias: 'never-created' }, /unknown alias/],
        ['dsh_result', { alias: 'never-created' }, /unknown alias/],
        ['dsh_cancel', { alias: 'never-created' }, /unknown alias/],
        ['dsh_sessions', { cwd: ws.missing }, /does not exist/],
      ];
      for (const [name, args, re] of cases) {
        const r = await client.callTool({ name, arguments: args });
        assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} must fail`);
        const body = parsed(r);
        assert.ok(!('raw' in body), `${name} error payload must be JSON, got ${JSON.stringify(body).slice(0, 200)}`);
        assert.match(String(body.error), re, `${name} should explain itself, got ${JSON.stringify(body)}`);
      }
      // ...and the tiering must not swallow the recommended shape: naming an outside path that the task
      // only reads is not a write, so it has to get past this check and fail further down instead.
      const readOnly = await client.callTool({ name: 'dsh_launch', arguments: { alias: 'ok', cwd: ws.cwd,
        task: `任务正文：${path.join(ws.sibling, 'ticket.md')}（只读引用）。把结论写入 ${path.join(ws.cwd, 'report.md')}` } });
      const body = parsed(readOnly);
      assert.ok(!/outside the session workspace/.test(String(body.error || '')),
        `a read-only reference must not be refused by the path check, got ${JSON.stringify(body).slice(0, 240)}`);
    });
    assertNoSideEffects(ws.state);
  } finally { ws.cleanup(); }
});

test('a parameter the schema rejects never reaches the handler', async () => {
  // dsh_stop takes a number for pid because a pid is a number. A string is refused by the SDK's own
  // validation, before any of this code runs - so there is no bridge log entry and no ledger write to
  // look for. That is the contract: schema errors are protocol errors, not tool failures.
  const ws = workspace();
  try {
    await withBridge(bridgeEnv(ws.state, {}), async (client) => {
      const r = await client.callTool({ name: 'dsh_stop', arguments: { pid: 'not-a-pid' } });
      assert.equal(r.isError, true);
      const text = (r.content || []).map((c) => c.text).join('');
      assert.match(text, /validation error/i, 'the SDK says what was wrong');
      // The process start is logged; a tool invocation is not, because none happened.
      const lines = fs.readFileSync(path.join(ws.state, 'bridge.log.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      assert.deepEqual(lines.filter((l) => l.ev === 'tool'), [], 'the handler never ran, so no tool event was logged');
      assert.ok(lines.some((l) => l.ev === 'serve'), 'the bridge was up - this is a refusal, not a dead process');
    });
    assertNoSideEffects(ws.state);
  } finally { ws.cleanup(); }
});

test('a bad default in the config is reported as the config, not as the caller', async () => {
  const ws = workspace();
  try {
    await withBridge(bridgeEnv(ws.state, {
      DSH_ALLOWED_MODELS: 'deepseek-account/deepseek-flash:high',
      DSH_DEFAULT_MODEL: 'deepseek-account/deepseek-flash', DSH_DEFAULT_EFFORT: 'max',
    }), async (client) => {
      const r = await client.callTool({ name: 'dsh_launch', arguments: { alias: 'ok', cwd: ws.cwd, task: 'x' } });
      assert.equal(r.isError, true);
      assert.match(parsed(r).error, /from DSH_DEFAULT_MODEL\/DSH_DEFAULT_EFFORT/,
        'the operator must be able to tell a config conflict from an agent mistake');
    });
    assertNoSideEffects(ws.state);
  } finally { ws.cleanup(); }
});

test('an allowlist that does not parse stops the bridge at startup', async () => {
  const ws = workspace();
  try {
    await assert.rejects(
      withBridge(bridgeEnv(ws.state, { DSH_ALLOWED_MODELS: 'deepseek-account/deepseek-flash:' }), async () => 'connected'),
      /Connection closed|does not parse|EOF/m,
      'a typo in the policy must never become a silent deny-all');
  } finally { ws.cleanup(); }
});

test('nothing is written to the ledger by a refused call', async () => {
  const ws = workspace();
  try {
    await withBridge(bridgeEnv(ws.state, { DSH_ALLOWED_MODELS: 'deepseek-account/deepseek-flash:low' }), async (client) => {
      const r = await client.callTool({ name: 'dsh_launch', arguments: { alias: 'ghost', cwd: ws.cwd, task: 'x', model: 'nope/nope' } });
      assert.equal(r.isError, true);
      assert.equal(fs.existsSync(path.join(ws.state, 'sessions.json')), false, 'a refused dispatch must not leave an alias behind');
      const owned = parsed(await client.callTool({ name: 'dsh_sessions', arguments: {} }));
      assert.equal(owned.ok, false, 'dsh_sessions still needs dsh, so it fails rather than pretending to be empty');
      assert.match(String(owned.error), /DSH_NO_SPAWN/);
    });
    assertNoSideEffects(ws.state);
  } finally { ws.cleanup(); }
});

test('a re-dispatch of a brief that is still running is refused, and nothing is touched', async () => {
  // Measured behaviour this guards: the MCP request timed out at 6 s while dsh finished the round at
  // ~14 s and never received a cancel. The dangerous client reaction is dispatching the same brief again
  // and paying twice, so the bridge refuses until told otherwise.
  const ws = workspace();
  const brief = '目标：为 S2-02-F 固定 Unicode 16 派生产物。\n边界：只允许改动 third_party/unicode。\n验收：默认 verify 离线只读通过。\n交付：材料与回执。';
  fs.mkdirSync(ws.state, { recursive: true });
  fs.writeFileSync(path.join(ws.state, 'sessions.json'), JSON.stringify({
    busy: { sessionId: 'dsh-busy', cwd: ws.cwd, rounds: [{ requestId: 'busy-r1', sinceSeq: 4, outcome: 'running',
      dispatchedAt: new Date().toISOString(), task: brief }] } }));
  try {
    await withBridge(bridgeEnv(ws.state, {}), async (client) => {
      const same = await client.callTool({ name: 'dsh_send', arguments: { alias: 'busy', task: brief } });
      assert.equal(same.isError, true, 'the same brief must not be dispatched twice');
      assert.match(String(parsed(same).error), /still in flight/);
      assert.match(String(parsed(same).error), /busy-r1/, 'the answer must name the round to go read instead');
      const other = await client.callTool({ name: 'dsh_send', arguments: { alias: 'busy', task: '换一个完全不同的任务：只读列出目录。' } });
      assert.ok(!/still in flight/.test(String(parsed(other).error || '')), 'a different brief on the same alias is a normal next round');
    });
    assertNoSideEffects(ws.state);
  } finally { ws.cleanup(); }
});

test('dsh_stop refuses to kill an instance this state directory did not start', async () => {
  // The whole point of the tool is that it CAN end the instance, so the dangerous half is the default:
  // with nothing recorded and a closed port there is nothing of ours to stop, and it must say that
  // rather than guess a pid. dryRun must report the same thing without killing anything.
  const ws = workspace();
  fs.mkdirSync(ws.state, { recursive: true });
  try {
    await withBridge(bridgeEnv(ws.state, {}), async (client) => {
      const dry = parsed(await client.callTool({ name: 'dsh_stop', arguments: { dryRun: true } }));
      assert.equal(dry.ok, true);
      assert.equal(dry.dryRun, true);
      assert.equal(dry.listening, false);
      assert.equal(dry.recordedPid, null);
      assert.equal(dry.wouldStop, null, 'nothing to stop, and it says so instead of picking a pid');

      const real = await client.callTool({ name: 'dsh_stop', arguments: {} });
      const body = parsed(real);
      assert.equal(body.ok, false, 'a stop that stopped nothing is not a success');
      assert.equal(body.stopped, false);
      assert.match(String(body.error), /no instance\.json/);
      assert.equal(fs.existsSync(path.join(ws.state, 'instance.json')), false, 'and it does not invent a record');
    });
    assertNoSideEffects(ws.state);
  } finally { ws.cleanup(); }
});

test('dsh_stop will not take a recorded-but-dead pid as a stop', async () => {
  const ws = workspace();
  fs.mkdirSync(ws.state, { recursive: true });
  // pid 999999 is not in use on any supported platform; the record is what a crashed boot leaves behind.
  fs.writeFileSync(path.join(ws.state, 'instance.json'), JSON.stringify({ pid: 999999, port: 3999, version: 'x' }));
  try {
    await withBridge(bridgeEnv(ws.state, {}), async (client) => {
      const body = parsed(await client.callTool({ name: 'dsh_stop', arguments: {} }));
      assert.equal(body.ok, false);
      assert.equal(body.stopped, false);
      assert.match(String(body.error), /process is gone/, 'a dead pid is reported, not reported as stopped');
      assert.equal(fs.existsSync(path.join(ws.state, 'instance.json')), false, 'the stale record is cleared');
    });
    assertNoSideEffects(ws.state);
  } finally { ws.cleanup(); }
});

