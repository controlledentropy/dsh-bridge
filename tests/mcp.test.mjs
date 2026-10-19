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
const TOOLS = ['dsh_models', 'dsh_permissions', 'dsh_launch', 'dsh_send', 'dsh_adopt', 'dsh_wait', 'dsh_status', 'dsh_result', 'dsh_sessions', 'dsh_cancel'];

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
        ['alias', 'allowOutsideCwd', 'cwd', 'dryRun', 'group', 'model', 'phase', 'reasoningEffort', 'task'].sort(),
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
