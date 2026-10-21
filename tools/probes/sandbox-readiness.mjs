#!/usr/bin/env node
// Ask the isolated app-server what it thinks of the Windows sandbox: ready / notConfigured / updateRequired.
//
// This is the layer-separation probe. `blocked by policy` on exec_command proves a command did not run,
// but not why. windowsSandbox/readiness answers the question the sandbox log cannot: is the backend
// the binary would use actually provisioned? It is read-only and involves no model, no turn, no queue.
//
//   node tools/probes/sandbox-readiness.mjs <ws-url> <token-file>
import fs from 'node:fs';
const [url, tokenFile] = process.argv.slice(2);
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const ws = new WebSocket(url, { headers: { authorization: 'Bearer ' + token } });
let nextId = 0; const pending = new Map(); const notes = [];
const log = (o) => console.log(JSON.stringify(o));
const call = (m, p) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: m, params: p || {} }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + m)); } }, 20000); });
ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.rej(Object.assign(new Error(String(m.error.message || 'rpc')), { rpc: m.error })); else p.res(m.result); return; }
  if (m.method) notes.push(m.method); });
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws'))); });
const init = await call('initialize', { clientInfo: { name: 'p0b2', version: '0.1.0' }, capabilities: { experimentalApi: true } });
log({ step: 'initialize', codexHome: init.codexHome, userAgent: init.userAgent });
const readiness = await call('windowsSandbox/readiness', {}).then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, message: e.message, rpc: e.rpc || null }));
log({ step: 'windowsSandbox/readiness', result: readiness });
log({ step: 'notifications', kinds: [...new Set(notes)] });
ws.close(); process.exit(0);