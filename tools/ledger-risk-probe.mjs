#!/usr/bin/env node
// Re-runnable evidence for one claim in AUDIT-2026-10-19: a ledger write failure must never cost the
// caller either its handle or an answer it already read.
//
// It sabotages a COPY of a state directory, then asks a real bridge (any tree's bridge.mjs) for
// `dsh_result` on a round that is settled in dsh's log but marked stale in the copy. The old code caught
// only LedgerUnconfirmed and rethrew anything else, so the tool call failed outright and the verdict was
// lost; the fixed code keeps the answer and reports ledgerAtRisk with the full handle.
//
// Nothing is dispatched, so no model quota is spent and the real instance is only read.
//
//   node tools/ledger-risk-probe.mjs --from .state --alias <alias-with-a-settled-round> [--bridge <path>]
//
// Windows only (it uses icacls). Requires a running `dsh web` the source state dir can already reach.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const SRC = path.resolve(arg('from', path.join(PKG, '.state')));
const ALIAS = arg('alias', '');
const BRIDGE = path.resolve(arg('bridge', path.join(PKG, 'bridge.mjs')));
const STATE = path.resolve(arg('into', path.join(PKG, '.state-ledger-risk')));
const LEDGER = path.join(SRC, 'sessions.json');
if (!ALIAS) { console.error('need --alias <alias with a settled round>'); process.exit(2); }
if (!fs.existsSync(LEDGER)) { console.error(`no ledger to copy at ${LEDGER}`); process.exit(2); }

fs.mkdirSync(STATE, { recursive: true });
// The bridge needs the instance record and the stdout capture to find a token; only the ledger is
// sabotaged, so nothing else differs between the two runs.
for (const f of ['instance.json', 'check.json', 'dsh-web.out', 'dsh-web.err']) {
  if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(STATE, f));
}
fs.copyFileSync(LEDGER, path.join(STATE, 'sessions.json'));

// Force the write to be attempted: dsh_result only refreshes an outcome that disagrees with the log, and
// MEASURED the stored outcome usually already matches, so nothing would be committed. Setting the last
// round back to "running" reproduces the recorded failure mode (a round stuck at running while its
// turn/end is on disk) and guarantees the commit path runs.
{
  const l = JSON.parse(fs.readFileSync(path.join(STATE, 'sessions.json'), 'utf8'));
  const last = (l[ALIAS]?.rounds || []).at(-1);
  if (!last) { console.error(`no rounds stored for ${ALIAS}`); process.exit(2); }
  last.outcome = 'running';
  fs.writeFileSync(path.join(STATE, 'sessions.json'), JSON.stringify(l, null, 2));
}

// MEASURED trap: denying (W) on the FILE also blocks reading it (readFileSync -> EPERM), and the bridge
// then reports "unknown alias", which proves nothing about the write path. Deny create/append on the
// DIRECTORY instead: the ledger stays readable and only the commit fails, with the raw EPERM/EACCES the
// audit was about.
const icacls = (target, args) => execFileSync('icacls', [target, ...args], { encoding: 'utf8' });
const USER = process.env.USERNAME;
icacls(STATE, ['/deny', `${USER}:(WD,AD)`]);

let reply = null, crash = null;
const client = new Client({ name: 'ledger-risk-probe', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [BRIDGE], env: { ...process.env, DSH_BRIDGE_STATE: STATE },
});
try {
  await client.connect(transport);
  const r = await client.callTool({ name: 'dsh_result', arguments: { alias: ALIAS } }, undefined, { timeout: 60000 });
  reply = JSON.parse(r.content[0].text);
} catch (e) {
  crash = String(e?.message ?? e);
} finally {
  await transport.close().catch(() => {});
  icacls(STATE, ['/remove:d', USER]);
}

const after = JSON.parse(fs.readFileSync(path.join(STATE, 'sessions.json'), 'utf8'));
console.log(JSON.stringify({
  bridge: BRIDGE,
  stateDir: STATE,
  // The ledger still says "running": the commit really did fail, so this run is about the failure path.
  commitFailed: (after[ALIAS]?.rounds || []).at(-1)?.outcome === 'running',
  connectError: crash,
  reply: reply && { ok: reply.ok, state: reply.state, settled: reply.settled, verdictComplete: reply.verdictComplete,
    ledgerAtRisk: reply.ledgerAtRisk, ledgerNote: reply.ledgerNote, unrecordedRound: reply.unrecordedRound,
    error: reply.error, finalTextBytes: Buffer.byteLength(reply.finalText || '', 'utf8') },
}, null, 1));
fs.rmSync(STATE, { recursive: true, force: true });
