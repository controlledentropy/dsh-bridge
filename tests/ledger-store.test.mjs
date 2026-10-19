// Offline tests for the ledger store. A rival writer is simulated by an fs wrapper that clobbers the file
// right after our rename - the exact failure the confirm-after-write exists to catch. Nothing here needs a
// running dsh or a second process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedgerStore, pushRound, LedgerUnconfirmed } from '../lib/ledger-store.mjs';

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sessions.json');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms > 2 ? 1 : ms));

// A rival that renames its own content over ours, `times` consecutive attempts.
function withRival(file, rivalText, times) {
  let hits = 0;
  const fsImpl = { ...fs,
    renameSync: (from, to) => {
      fs.renameSync(from, to);
      if (to === file && hits++ < times) {
        const tmp = file + '.rival.tmp';
        fs.writeFileSync(tmp, typeof rivalText === 'function' ? rivalText(fs.readFileSync(file, 'utf8')) : rivalText);
        fs.renameSync(tmp, file);
      }
    } };
  return fsImpl;
}

test('transact writes, confirms, and keeps the other alias intact', async (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ keep: { sessionId: 'dsh-keep', rounds: [] } }));
  const store = createLedgerStore({ file, sleep });
  await store.transact((r) => { r.mine = { sessionId: 'dsh-mine', rounds: [] }; }, { label: 'upsert', alias: 'mine' });
  const led = store.read();
  assert.deepEqual(Object.keys(led).sort(), ['keep', 'mine'], 'a read-modify-write must not drop neighbours');
  assert.equal(led.keep.sessionId, 'dsh-keep');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(file + '.lock'), false, 'the lock is released');
});

test('a rival that clobbers our write is detected and the mutation is retried from fresh content', async (t) => {
  const file = tmpFile(t);
  // The rival adds a different alias on top of our write, on the first attempt only.
  const store = createLedgerStore({ file, sleep, retries: 3,
    fsImpl: withRival(file, (current) => JSON.stringify({ ...JSON.parse(current), rival: { sessionId: 'dsh-rival' } }), 1) });
  await store.transact((r) => pushRound(r, 'mine', { requestId: 'r1' }), { label: 'append', alias: 'mine' });
  const led = store.read();
  assert.deepEqual(led.mine.rounds.map((r) => r.requestId), ['r1'], 'our round survived the clobber');
  assert.equal(led.rival.sessionId, 'dsh-rival', 'and the retry re-applied onto the rival content instead of overwriting it');
});

test('an unconfirmable write is an error with the handle, not a quiet success', async (t) => {
  const file = tmpFile(t);
  const store = createLedgerStore({ file, sleep, retries: 2, pollMs: 1,
    fsImpl: withRival(file, '{"other":true}', 10) });
  await assert.rejects(
    store.transact((r) => pushRound(r, 'mine', { requestId: 'r9' }), { label: 'append', alias: 'mine', requestId: 'r9' }),
    (e) => {
      assert.ok(e instanceof LedgerUnconfirmed, 'typed so the caller can distinguish it');
      assert.equal(e.detail.requestId, 'r9', 'the handle must reach the caller - the round really went out');
      assert.equal(e.detail.attempts, 2);
      assert.match(e.message, /was not confirmed/);
      assert.match(e.message, /requestId r9/);
      return true;
    });
});

test('pushRound is idempotent by requestId, so a retry cannot double-append', () => {
  const l = {};
  assert.equal(pushRound(l, 'a', { requestId: 'r1' }).length, 1);
  assert.equal(pushRound(l, 'a', { requestId: 'r1' }).length, 1, 'a re-run after a lost-update retry is not a second round');
  assert.equal(pushRound(l, 'a', { requestId: 'r2' }).length, 2);
  assert.equal(pushRound({}, 'b', {}).length, 1, 'a round without a requestId still records');
});

test('a stale lock is taken over, a live one is waited out and the write is still verified', async (t) => {
  const file = tmpFile(t);
  const lock = file + '.lock';
  fs.writeFileSync(lock, '999999');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const store = createLedgerStore({ file, sleep });
  await store.transact((r) => { r.got = 1; }, { label: 'upsert' });
  assert.equal(store.read().got, 1, 'a dead holder must not freeze the ledger forever');
  assert.equal(fs.existsSync(lock), false);

  fs.writeFileSync(lock, '999999');                                     // fresh mtime: someone is working
  const events = [];
  const s2 = createLedgerStore({ file, sleep, lockDeadlineMs: 1, pollMs: 1, onEvent: (e) => events.push(e) });
  await s2.transact((r) => { r.second = 1; }, { label: 'upsert' });
  assert.equal(s2.read().second, 1, 'we still write, but confirmed');
  assert.ok(events.some((e) => e.ev === 'ledger-lock-timeout'));
  assert.equal(fs.existsSync(lock), true, 'a lock we did not take is not removed');
});
