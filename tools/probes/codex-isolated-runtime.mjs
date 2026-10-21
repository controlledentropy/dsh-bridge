#!/usr/bin/env node
// Evidence probe: ask an ISOLATED app-server whether this Codex build still behaves the way E3/E4 measured.
//
// Scope discipline: this probe only ever creates and reads threads inside its own CODEX_HOME. It
// never names a Desktop thread id, never sends queue/add to a thread it did not create, and never
// starts a turn (no model call, no credentials are present in the isolated home).
//
//   node tools/probes/codex-isolated-runtime.mjs <ws-url> <token-file> <workspace>
import fs from 'node:fs';

const [url, tokenFile, workspace] = process.argv.slice(2);
if (!url) { console.error('usage: p0b1-runtime.mjs <ws-url> <token-file> <workspace>'); process.exit(2); }
const token = fs.readFileSync(tokenFile, 'utf8').trim();

const ws = new WebSocket(url, { headers: { authorization: 'Bearer ' + token } });
let nextId = 0;
const pending = new Map();
const notifications = [];
const log = (o) => console.log(JSON.stringify(o));

const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject, method });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, 20000);
});

ws.addEventListener('message', (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.reject(Object.assign(new Error(String(msg.error.message || 'rpc error')), { rpc: msg.error }));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method) notifications.push({ method: msg.method, params: msg.params });
});

const open = () => new Promise((res, rej) => {
  ws.addEventListener('open', () => res());
  ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message || 'unknown'))));
});

await open();
log({ step: 'connected', url });

// 1. Experimental negotiation: without capabilities.experimentalApi the queue methods are refused.
const init = await call('initialize', {
  clientInfo: { name: 'dsh-bridge-p0b1', version: '0.1.0' },
  capabilities: { experimentalApi: true },
});
log({ step: 'initialize', userAgent: init && init.userAgent, codexHome: init && init.codexHome, protocolVersion: init && init.protocolVersion });

// 2. Thread namespace: an isolated instance must not see threads it did not create.
const before = await call('thread/list', {});
const beforeIds = (before && before.data ? before.data : []).map((t) => t.id);
log({ step: 'thread/list before', count: beforeIds.length, ids: beforeIds.slice(0, 5) });

// 3. Create one thread of our own, inside the isolated workspace.
const started = await call('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only' });
const threadId = (started && started.thread && started.thread.id) || (started && started.threadId);
log({ step: 'thread/start', threadId, model: started && started.thread && started.thread.model });

// 4. Queue methods under experimentalApi.
const q = await call('thread/queue/list', { threadId });
log({ step: 'thread/queue/list', value: q });

const after = await call('thread/list', {});
log({ step: 'thread/list after', count: (after && after.data ? after.data : []).length });

const loaded = await call('thread/loaded/list', {});
log({ step: 'thread/loaded/list', value: loaded });

// 5. Does queue/list refuse an id that is not in this home? This is the read-only half of the E5-A
//    isolation claim: a thread this home has never seen must not be addressable at all.
const bogus = await call('thread/queue/list', { threadId: '00000000-0000-0000-0000-000000000000' })
  .then((v) => ({ ok: true, value: v }))
  .catch((e) => ({ ok: false, code: e.rpc && e.rpc.code, message: e.rpc && e.rpc.message }));
log({ step: 'thread/queue/list unknown id', result: bogus });

log({ step: 'notifications', count: notifications.length, kinds: [...new Set(notifications.map((n) => n.method))].slice(0, 12) });
ws.close();
process.exit(0);