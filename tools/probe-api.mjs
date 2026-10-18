// Re-derive the /api contract after a dsh upgrade.
//
// The gateway's own validation errors are the spec: ask for the wrong shape and it names the field
// it wants. That is how every shape in docs/API-CONTRACT.md was obtained (there is no published schema).
//
//   node tools/probe-api.mjs                # read-only probes (no session is created)
//   node tools/probe-api.mjs --mutate       # additionally creates ONE probe session to exercise
//                                           # create/selectModel/page. dsh's API cannot delete sessions
//                                           # (session/delete is not forwarded), so this leaves a row
//                                           # behind in ~/.dsh/sessions and the workspace list. Do it
//                                           # deliberately, not casually.
import { tokenFrom, PORT, HOST, STATE_DIR } from '../launch.mjs';
import path from 'node:path';
import fs from 'node:fs';

const MUTATE = process.argv.includes('--mutate');
const OUT_FILE = path.join(STATE_DIR, 'dsh-web.out');
const attach = process.env.DSH_ATTACH_OUTFILE || '';

async function connect() {
  const token = [attach, OUT_FILE, path.join(process.cwd(), '.state', 'dsh-web.out')].map(tokenFrom).find(Boolean);
  if (!token) throw new Error('no launch token captured; start dsh web via start-dsh-web.ps1 (or launch.mjs start) first');
  const res = await fetch(`http://${HOST}:${PORT}/connect?token=${token}&interactions=answer`, { redirect: 'manual' });
  const cookie = (res.headers.getSetCookie().find((x) => x.startsWith('dsh-auth-')) || '').split(';')[0];
  if (!cookie) throw new Error(`/connect -> HTTP ${res.status} with no cookie (stale token for this instance?)`);
  return cookie;
}

async function main() {
  const cookie = await connect();
  const rpc = async (endpoint, args) => {
    const res = await fetch(`http://${HOST}:${PORT}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe-' + Math.random().toString(36).slice(2), method: endpoint, payload: { args } }),
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    const r = j?.result;
    const brief = r ? (r.ok ? 'ok  ' + JSON.stringify(r.value).slice(0, 150) : 'ERR ' + (r.error?.code || '') + ': ' + String(r.error?.message).slice(0, 150)) : 'HTTP ' + res.status + ' ' + text.slice(0, 80);
    console.log(endpoint.padEnd(28), brief);
    return r;
  };

  console.log('--- read-only surface ---');
  await rpc('session/modelCatalog', {});
  await rpc('session/modelCatalog', { _request: {} });          // expected: rejected; documents the oddity
  const l = await rpc('session/list', { _request: {} });
  console.log('   (session/list returned ' + ((l?.value?.items || []).length) + ' rows across ALL workspaces - always filter by cwd)');

  if (!MUTATE) { console.log('\nread-only pass done. Add --mutate to exercise create/selectModel/page (leaves one session behind).'); return; }

  console.log('--- mutation probes (one throwaway session) ---');
  const sid = 'dsh-contract-probe-' + Date.now().toString(36);
  const cwd = process.env.DSH_PROBE_CWD || process.cwd();
  await rpc('session/create', { request: { sessionId: sid, cwd } });
  await rpc('session/create', { sessionId: sid, cwd });                       // expected: names the request wrapper
  await rpc('session/projections', { request: { sessionId: sid } });
  await rpc('session/selectModel', { request: { sessionId: sid, provider: 'nope', model: 'nope' } });
  const p = await rpc('session/projections', { request: { sessionId: sid } });
  await rpc('session/page', { request: { address: { kind: 'session', sessionId: sid }, throughSeq: (p?.value?.asOfSeq) || 1, maxMessages: 5 } });
  await rpc('session/page', { request: { address: { sessionId: sid }, throughSeq: 1 } });   // expected: rejected; documents `kind`
  console.log('\nleft behind: session ' + sid + ' in ' + cwd + ' (cannot be deleted via API; archive with workspace/archiveSession or remove in the dsh UI)');
}

main().catch((e) => { console.error('probe failed: ' + e.message); process.exit(1); });
