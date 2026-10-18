// Read a persisted dsh session log losslessly.
// Why this exists: session.v4.jsonl.zstd is a CONCATENATION of zstd frames. Decoding the whole
// buffer as one frame returns only the first (we hit this: 23,351 bytes -> 225 bytes, which looks
// like "the log is empty" but is not).
//
//   node tools/read-session-log.mjs <sessionId> [--workspace <pathContains>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import z from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh');

function frames(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
  }
  return starts;
}

export function decodeSessionLog(file) {
  const buf = fs.readFileSync(file);
  const starts = frames(buf);
  if (!starts.length) throw new Error('no zstd frame found in ' + file);
  let out = '';
  let failed = 0;
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { out += z.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'); }
    catch { failed++; }
  }
  return { events: out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)), rawBytes: buf.length, decodedBytes: out.length, rawFrames: starts.length, failedFrames: failed };
}

function findLogs(sessionId, workspaceHint) {
  const root = path.join(DSH_HOME, 'sessions');
  const hits = [];
  for (const ws of fs.readdirSync(root)) {
    if (workspaceHint && !ws.toLowerCase().includes(workspaceHint.toLowerCase().replace(/[\\/]/g, ''))) continue;
    const p = path.join(root, ws, sessionId, 'session.v4.jsonl.zstd');
    if (fs.existsSync(p)) hits.push(p);
  }
  return hits;
}

if (process.argv[1] && process.argv[1].endsWith('read-session-log.mjs')) {
  const sessionId = process.argv[2];
  if (!sessionId) { console.error('usage: node tools/read-session-log.mjs <sessionId> [--workspace <pathFragment>] [--json]'); process.exit(2); }
  const wi = process.argv.indexOf('--workspace');
  const hint = wi > 0 ? process.argv[wi + 1] : '';
  const logs = findLogs(sessionId, hint);
  if (!logs.length) { console.error('no session log for ' + sessionId + ' under ' + path.join(DSH_HOME, 'sessions') + (hint ? ' (workspace filter: ' + hint + ')' : '')); process.exit(1); }
  for (const log of logs) {
    const d = decodeSessionLog(log);
    const turnEnds = d.events.filter((e) => e.type === 'turn/end');
    const summary = {
      file: log, rawBytes: d.rawBytes, decodedBytes: d.decodedBytes, frames: d.rawFrames, failedFrames: d.failedFrames,
      events: d.events.length, header: d.events[0] && d.events[0].type === 'session' ? { cwd: d.events[0].cwd, preset: d.events[0].agentPreset, version: d.events[0].version } : null,
      turns: turnEnds.map((t) => ({ turn: t.data.turn, kind: t.data.reason && t.data.reason.kind, error: t.data.reason && t.data.reason.error && t.data.reason.error.message })),
      toolCalls: d.events.filter((e) => e.type === 'tool/call').map((c) => ({ turn: c.data.turn, name: c.data.name })),
      approvalEvents: d.events.filter((e) => /approval\/(asked|decided)|user-question/.test(e.type)).map((e) => e.type),
      model: (d.events.find((e) => e.type === 'request/context') || {}).data || null,
      lastAssistant: (() => { const a = d.events.filter((e) => e.type === 'assistant/message').map((x) => (x.data.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')).filter(Boolean); return a[a.length - 1] || ''; })(),
    };
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ...summary, events: d.events }, null, 1));
    else console.log(JSON.stringify(summary, null, 1));
  }
}
