#!/usr/bin/env node
// Evidence probe: does a dsh session log number its events densely from 0?
//
// Why this matters: the Coordinator's resume cursor is only safe as a CONTIGUOUS PREFIX, not
// MAX(seq). If seq can skip, a missing number is not a lost event and the cursor may advance past
// it; if seq is dense from 0, a gap is provably a missed frame and must block the cursor. The
// answer decides whether the recovery code may assume density (docs/EVIDENCE.md).
//
// This probe is READ-ONLY and OFFLINE: it decodes session logs already on disk and calls no model,
// no dsh API, and writes nothing. Its output is deliberately machine-free - counts, booleans and
// session-id basenames only - so the result can live in the repository.
//
//   node tools/probes/seq-contiguity.mjs [--json]
//
// MEASURED 2026-10-20 against dsh 0.2.1-rc.2, Node 24.21.0, 107 logs / 47,944 events:
//   107 contiguous, 0 gaps, 0 duplicates, 48 distinct event types. See docs/EVIDENCE.md.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');

// A session log is a CONCATENATION of zstd frames; decompressing the buffer as one frame returns
// only the first (measured once: 23,351 bytes -> 225 bytes, which reads as "the log is empty").
function frameStarts(buf) {
  const out = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) out.push(i);
  }
  return out;
}

function decode(file) {
  const buf = fs.readFileSync(file);
  const starts = frameStarts(buf);
  let text = '';
  let failedFrames = 0;
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'); }
    catch { failedFrames++; }
  }
  const events = text.split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { events, failedFrames };
}

function findLogs() {
  const root = path.join(HOME, 'sessions');
  const out = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(root); } catch { return out; }
  for (const ws of workspaces) {
    const dir = path.join(root, ws);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const sid of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
      const file = path.join(dir, sid, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) out.push({ file, sid });
    }
  }
  return out;
}

const logs = findLogs();
const report = { checkedAt: new Date().toISOString(), dshHomeResolved: true, logs: logs.length,
  contiguous: 0, nonContiguous: 0, empty: 0, undecodable: 0, failedFrames: 0,
  totalEvents: 0, distinctEventTypes: 0, anomalies: [] };
const types = new Set();

for (const { file, sid } of logs) {
  let decoded;
  try { decoded = decode(file); } catch { report.undecodable++; report.anomalies.push({ sid, problem: 'decode-failed' }); continue; }
  report.failedFrames += decoded.failedFrames;
  const evs = decoded.events;
  if (!evs.length) { report.empty++; continue; }
  report.totalEvents += evs.length;
  for (const e of evs) if (e && e.type) types.add(e.type);
  const seqs = evs.map((e) => e.seq).filter(Number.isInteger);
  const uniq = [...new Set(seqs)].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < uniq.length; i++) if (uniq[i] !== uniq[i - 1] + 1) gaps.push([uniq[i - 1], uniq[i]]);
  const dense = gaps.length === 0 && uniq[0] === 0 && uniq.length === uniq[uniq.length - 1] + 1;
  if (dense) report.contiguous++;
  else { report.nonContiguous++; report.anomalies.push({ sid, gaps: gaps.slice(0, 3), first: uniq[0], last: uniq[uniq.length - 1], distinct: uniq.length }); }
}

report.distinctEventTypes = types.size;
report.eventTypes = [...types].sort();
report.verdict = report.logs === 0 ? 'no-logs'
  : report.nonContiguous === 0 && report.undecodable === 0 && report.empty === 0 ? 'dense-from-zero'
  : 'mixed';

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log('logs=' + report.logs + ' contiguous=' + report.contiguous + ' nonContiguous=' + report.nonContiguous
    + ' undecodable=' + report.undecodable + ' events=' + report.totalEvents + ' types=' + report.distinctEventTypes);
  console.log('verdict: ' + report.verdict);
  for (const a of report.anomalies.slice(0, 10)) console.log('  anomaly: ' + JSON.stringify(a));
}
