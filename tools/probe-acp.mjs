// Verify dsh's ACP surface after an upgrade — the fallback control plane if /api drifts.
// Measures (all without spending tokens): initialize handshake, advertised capabilities,
// session/list, and session/new. Pass --prompt to additionally run ONE real turn (spends quota
// and lets the agent act in --cwd, so only do that on purpose).
//
//   node tools/probe-acp.mjs --cwd C:\\path\\to\\throwaway
//   node tools/probe-acp.mjs --cwd ... --prompt "reply with PONG only, touch no files"
//
// It closes the session it opens, but MEASURED: closing is not deleting - a session record can still
// appear under ~/.dsh/sessions/<cwd slug>/, so point --cwd at a throwaway directory, not at a real one.
import { spawn } from 'node:child_process';
import { resolveDsh } from '../launch.mjs';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : ''; };
const wantPrompt = argv.includes('--prompt');
const cwd = flag('cwd') || process.cwd();

const { node, cli, version } = resolveDsh();
if (!node || !cli) { console.error('dsh CLI not resolved; set DSH_NODE / DSH_PKG_DIR'); process.exit(1); }

const child = spawn(node, [cli, '--profile', 'acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = ''; const pending = new Map(); const noise = []; let nextId = 0;
const notifications = [];

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { noise.push(line.slice(0, 120)); continue; }   // ACP stdout DOES carry non-protocol log lines here
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(p.name + ' -> ' + JSON.stringify(m.error).slice(0, 300))) : p.res(m.result);
      continue;
    }
    if (m.method) {
      notifications.push(m.method + (m.params?.update ? ':' + m.params.update.sessionUpdate : ''));
      if (m.id !== undefined) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n');
    }
  }
});
child.stderr.on('data', (d) => noise.push('stderr ' + d.toString('utf8').trim().slice(0, 120)));

const call = (name, method, params, ms = 60000) => new Promise((res, rej) => {
  const id = ++nextId; pending.set(id, { res, rej, name });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('TIMEOUT ' + method)); } }, ms);
});

const show = (label, obj) => console.log(label.padEnd(22), JSON.stringify(obj).slice(0, 240));

try {
  const init = await call('init', 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  show('agentInfo', init.agentInfo);
  show('capabilities', init.agentCapabilities);
  show('authMethods', init.authMethods);

  const listed = await call('list', 'session/list', { cwd });
  console.log('session/list'.padEnd(22), (listed.sessions || []).length + ' sessions for ' + cwd);

  const created = await call('new-missing-mcpServers', 'session/new', { cwd });
  show('session/new (no mcpServers)', created);
} catch (e) {
  // The rejection we EXPECT on a spec-conformant build: mcpServers is required.
  console.log('session/new (no mcpServers)'.padEnd(22), 'rejected as expected -> ' + e.message.slice(0, 140));
}

try {
  const s = await call('new', 'session/new', { cwd, mcpServers: [] });
  console.log('session/new'.padEnd(22), 'sessionId=' + s.sessionId + '  configOptions=' + (s.configOptions || []).map((c) => c.id).join(','));
  if (wantPrompt) {
    const text = flag('prompt') || 'Reply with exactly PONG. Do not read or write files, do not run commands.';
    console.log('prompting (this spends quota and lets the agent act in --cwd)…');
    const r = await call('prompt', 'session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text }] }, 240000);
    show('stopReason', r);
  } else {
    await call('close', 'session/close', { sessionId: s.sessionId }).catch(() => {});
  }
} catch (e) { console.log('session/new'.padEnd(22), 'FAILED ' + e.message); }

console.log('notifications'.padEnd(22), notifications.length ? [...new Set(notifications)].join(', ') : '(none)');
console.log('non-JSON stdout'.padEnd(22), noise.length ? noise.length + ' line(s), e.g. ' + JSON.stringify(noise[0] || '') : 'none');
console.log('dsh version'.padEnd(22), version);
child.kill(); process.exit(0);
