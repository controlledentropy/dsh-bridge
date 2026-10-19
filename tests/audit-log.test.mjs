// Offline tests for the audit logger. The case that matters is #3: two bridge processes racing on the
// same rollover. Losing that race is normal, and the old code treated it as a reason to stop logging -
// which destroyed the evidence trail of exactly the concurrency this bridge expects to face.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuditLog } from '../lib/audit-log.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'bridge.log.jsonl');
}

test('writes one JSON object per line with the process id', (t) => {
  const file = tmp(t);
  const log = createAuditLog({ file, maxBytes: 1_000_000, pid: 4242 });
  assert.equal(log.write({ ev: 'tool', tool: 'dsh_models' }), true);
  log.write({ ev: 'api', endpoint: 'session/list' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.ev), ['tool', 'api']);
  assert.equal(lines[0].pid, 4242);
  assert.ok(lines[0].t);
  assert.equal(log.status().written, 2);
});

test('rotates when the file passes the byte budget', (t) => {
  const file = tmp(t);
  fs.writeFileSync(file, 'x'.repeat(1200));
  const log = createAuditLog({ file, maxBytes: 1000 });
  log.write({ ev: 'after-rotate' });
  assert.ok(fs.existsSync(file + '.1'), 'the previous log is kept, not truncated away');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.ev), ['after-rotate']);
  assert.equal(log.status().disabled, false);
});

test('losing the rotation race is counted, not fatal - logging continues', (t) => {
  const file = tmp(t);
  const raced = { ...fs,
    statSync: () => ({ size: 5000 }),
    renameSync: () => { const e = new Error('ENOENT: no such file or directory'); e.code = 'ENOENT'; throw e; },
    appendFileSync: (f, text) => fs.appendFileSync(f, text) };
  const log = createAuditLog({ file, maxBytes: 1000, fsImpl: raced });
  assert.equal(log.write({ ev: 'still-here' }), true, 'a lost rename must not stop the trail');
  assert.match(fs.readFileSync(file, 'utf8'), /still-here/);
  assert.equal(log.status().disabled, false);
  assert.equal(log.status().rotationRaces, 1);
});

test('only repeated real write failures disable logging, and the disable is announced', (t) => {
  let calls = 0;
  const broken = { ...fs,
    statSync: () => ({ size: 10 }),
    renameSync: () => {},
    appendFileSync: () => { calls++; const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } };
  const said = [];
  const log = createAuditLog({ file: '/nope/bridge.log.jsonl', maxBytes: 1000, fsImpl: broken,
    failuresBeforeDisable: 3, stderr: (m) => said.push(m) });
  assert.equal(log.write({ ev: 'a' }), false);
  assert.equal(log.status().disabled, false, 'one failure is not a reason to go blind');
  log.write({ ev: 'b' });
  assert.equal(log.write({ ev: 'c' }), false);
  assert.equal(log.status().disabled, true);
  assert.equal(calls, 3, 'nothing is attempted after the disable');
  assert.match(said[0], /audit log disabled after 3 consecutive write failures/);
});

test('a transient failure resets once a write succeeds', (t) => {
  const file = tmp(t);
  let boom = true;
  const flaky = { ...fs, appendFileSync: (f, x) => { if (boom) { boom = false; const e = new Error('EIO'); e.code = 'EIO'; throw e; } fs.appendFileSync(f, x); } };
  const log = createAuditLog({ file, maxBytes: 1000, fsImpl: flaky });
  assert.equal(log.write({ ev: 'lost' }), false);
  assert.equal(log.write({ ev: 'kept' }), true);
  assert.equal(log.status().failures, 0, 'the counter must not accumulate across a success');
  assert.equal(log.status().disabled, false);
});
