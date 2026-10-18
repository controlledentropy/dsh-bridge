// Read-only verification against a running `dsh web`. This is the script to run after a dsh upgrade:
// it spends no model quota and creates no sessions, so it is safe to run whenever you like.
//
//   DSH_ATTACH_OUTFILE=<file holding the launch token> node tests/live-check.mjs
//   DSH_PORT=3080 DSH_BRIDGE_STATE=<dir with sessions.json> node tests/live-check.mjs
//
// Opt-in steps are flagged in the output and never counted as passing:
//   --adopt     take over an existing idle session in DSH_TEST_WS. Free, creates nothing in dsh;
//               it only adds an alias to the ledger.
//   --create    two concurrent dsh_launch dryRuns, to prove the shared ledger merges under
//               concurrency. This creates sessions, and MEASURED: the API cannot delete a session
//               (session/delete is not forwarded), so they can only be archived.
//   --dispatch  one real round in DSH_TEST_WS. This spends quota on the pinned model.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const want = (flag) => argv.includes(flag);
const STATE = process.env.DSH_BRIDGE_STATE || path.join(os.tmpdir(), 'dsh-bridge-live-check');
const OUTFILE = process.env.DSH_ATTACH_OUTFILE || '';
const TEST_WS = process.env.DSH_TEST_WS || '';

const env = { ...process.env, DSH_BRIDGE_STATE: STATE, ...(OUTFILE ? { DSH_ATTACH_OUTFILE: OUTFILE } : {}) };
fs.mkdirSync(STATE, { recursive: true });

let pass = 0; let fail = 0; let skipped = 0;
const step = async (name, fn) => {
  try {
    const note = await fn();
    pass++;
    console.log(`PASS  ${name}${note ? '  - ' + note : ''}`);
    return true;
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}  - ${String(e.message || e).split('\n')[0]}`);
    return false;
  }
};
const skip = (name, why) => { skipped++; console.log(`SKIP  ${name}  - ${why}`); };

const connect = async () => {
  const c = new Client({ name: 'live-check', version: '0.0.0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(PKG, 'bridge.mjs')], cwd: PKG, env, stderr: 'pipe' }));
  return c;
};
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content || []).map((x) => x.text).join('');
  let j = null; try { j = JSON.parse(text); } catch {}
  if (r.isError) throw new Error((j?.error || text).slice(0, 300));
  return j;
};
const ledger = () => { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'sessions.json'), 'utf8')); } catch { return {}; } };

const client = await connect();
try {
  await step('mcp handshake', async () => 'connected as an MCP child process');
  const { tools } = await client.listTools();
  const expected = ['dsh_models', 'dsh_permissions', 'dsh_launch', 'dsh_send', 'dsh_adopt', 'dsh_wait', 'dsh_status', 'dsh_result', 'dsh_sessions', 'dsh_cancel'];
  await step('tools/list', () => {
    const got = tools.map((t) => t.name).sort();
    if (JSON.stringify(got) !== JSON.stringify([...expected].sort())) throw new Error(`tool surface changed: ${got.join(', ')}`);
    return `${got.length} tools`;
  });

  const cat = await step('dsh_models (live catalog)', async () => {
    const j = await call(client, 'dsh_models', {});
    const permitted = (j.models || []).filter((m) => m.permitted);
    if (!permitted.length) throw new Error(`nothing permitted by policy ${j.policy}; routable: ${(j.routableProviders || []).join(', ') || 'none'}`);
    return `${permitted.length}/${(j.models || []).length} permitted, default ${j.default ? (j.default.provider + '/' + j.default.model) : '?'}`;
  });

  await step('dsh_sessions (owned aliases)', async () => {
    const j = await call(client, 'dsh_sessions', {});
    return `${(j.owned || []).length} aliases in ${STATE}`;
  });

  await step('dsh_permissions (read-only sandbox surface)', async () => {
    const j = await call(client, 'dsh_permissions', {});
    if (!j.presets?.length) throw new Error('catalog came back empty: ' + JSON.stringify(j).slice(0, 200));
    if (j.settableOverApi !== false) throw new Error('the bridge must not claim it can change the sandbox mode over /api');
    return `${j.presets.join('|')} default=${j.defaultPreset}`;
  });

  const aliases = Object.keys(ledger());
  if (aliases.length) {
    for (const name of ['dsh_status', 'dsh_result']) {
      await step(`${name} on ${aliases[0]} (readback of a real round)`, async () => {
        const j = await call(client, name, { alias: aliases[0] });
        if (!['completed', 'error', 'idle', 'running'].includes(j.state)) throw new Error('state missing: ' + JSON.stringify(j).slice(0, 200));
        return `state=${j.state} model=${j.model || '?'} toolCalls=${j.toolCallCount} correlated=${j.correlated ?? 'n/a'}`;
      });
    }
  } else skip('readback', `no aliases in ${STATE}; launch one first`);

  if (want('--adopt')) {
    if (!TEST_WS) skip('--adopt', 'set DSH_TEST_WS to a workspace that already holds dsh sessions');
    else {
      await step('dsh_adopt takes over an existing web session', async () => {
        const list = await call(client, 'dsh_sessions', { cwd: TEST_WS });
        const target = (list.liveInCwd || []).find((s) => !s.running);
        if (!target) throw new Error(`no idle session in ${TEST_WS} to adopt (${(list.liveInCwd || []).length} found)`);
        const j = await call(client, 'dsh_adopt', { alias: 'live-adopt-' + Date.now().toString(36), sessionId: target.sessionId, cwd: TEST_WS });
        if (!j.reused) throw new Error('adopted id does not match the requested session: ' + JSON.stringify(j).slice(0, 200));
        return `${target.sessionId} reused=true state=${j.tail.state}; ${j.sidebarGroup}`;
      });
    }
  } else skip('--adopt', 'opt-in: it needs DSH_TEST_WS with an existing session (free, creates nothing)');

  if (want('--create')) {
    if (!TEST_WS) skip('--create', 'set DSH_TEST_WS to the workspace to land the probe sessions in');
    else {
      await step('ledger merge under concurrent dryRun launches', async () => {
        const stamp = Date.now().toString(36);
        const two = await Promise.all([['merge-a-' + stamp], ['merge-b-' + stamp]].map(async ([alias]) => {
          const c = await connect();
          try { return await call(c, 'dsh_launch', { alias, cwd: TEST_WS, task: 'not dispatched', dryRun: true }); } finally { await c.close(); }
        }));
        const now = ledger();
        for (const r of two) if (!now[r.alias]) throw new Error(`${r.alias} missing from the ledger: a concurrent writer lost it`);
        return two.map((r) => `${r.alias} grouped=${r.grouped}`).join(', ') + ' (left behind: archive them in the web UI, the API cannot delete)';
      });
    }
  } else skip('--create', 'opt-in: it leaves sessions the API cannot delete');

  if (want('--dispatch')) {
    if (!TEST_WS) skip('--dispatch', 'set DSH_TEST_WS to a scratch workspace');
    else {
      await step('one real round (quota spent)', async () => {
        const alias = 'live-check-' + Date.now().toString(36);
        const j = await call(client, 'dsh_launch', { alias, cwd: TEST_WS, task: 'Create the file dsh-bridge-livecheck.txt containing LIVECHECK, then reply DONE and nothing else.' });
        if (j.state !== 'completed') throw new Error('state=' + j.state + ' error=' + JSON.stringify(j.error));
        const marker = path.join(TEST_WS, 'dsh-bridge-livecheck.txt');
        const onDisk = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : 'file NOT written';
        return `state=${j.state} model=${JSON.stringify(j.pinned)} onDisk=${JSON.stringify(onDisk)}`;
      });
    }
  } else skip('--dispatch', 'opt-in: it spends model quota');
} finally {
  await client.close();
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
if (fail) process.exit(1);
if (want('--create') || want('--dispatch')) console.log('side-effecting steps were requested; check the notes above for what was left behind.');
