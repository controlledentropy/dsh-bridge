#!/usr/bin/env node
// B2 acceptance: the properties the audit asked for, each an assertion rather than a narrative.
//
//   node tools/probes/ledger/b2-acceptance.mjs
//
// The first version of this file asserted that an out-of-order event was "not stored" and that
// filling the hole cleared the gap table. Both passed, and both encoded the defect: not storing is
// dropping, and clearing on partial fill reports "live" over a hole. The checks below assert the
// properties the Coordinator actually needs - nothing is lost, the prefix never lies, and a gap
// shrinks instead of vanishing.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openLedger, ensureTopic, ingest, ingestMany, topicState, countEvents, gaps, eventsAfter, stats }
  from './events-store.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-ledger-'));
const out = [];
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  out.push({ name, ok, detail });
  ok ? pass++ : fail++;
};
const ev = (seq) => ({ seq, type: 'a', at: 't0', data: null });

// ---- a repeated event is stored once ---------------------------------------------------------
{
  const db = openLedger(path.join(dir, 'p1.db'));
  ensureTopic(db, 's:1');
  const r1 = ingest(db, 's:1', 0, { seq: 0, type: 'session', at: 't0', data: { a: 1 } });
  const r2 = ingest(db, 's:1', 0, { seq: 0, type: 'session', at: 't0', data: { a: 1 } });
  check('duplicate event stored once', r1.added === true && r2.duplicate === true && countEvents(db, 's:1', 0) === 1,
    { r1: r1.added, r2: r2.duplicate, stored: countEvents(db, 's:1', 0) });
  check('a duplicate at or below the cursor is not staged', r2.staged === false, { staged: r2.staged });
  db.close();
}

// ---- same seq, different source generation, must not overwrite -------------------------------
{
  const db = openLedger(path.join(dir, 'p2.db'));
  ensureTopic(db, 's:2', { generation: 0 });
  ingest(db, 's:2', 0, ev(0));
  ingest(db, 's:2', 0, ev(1));
  // A rebuilt source starts its own numbering at 0 again: its own topic row, its own cursor.
  ensureTopic(db, 's:2', { generation: 1 });
  ingest(db, 's:2', 1, ev(0));
  const gen0Cursor = topicState(db, 's:2', 0).cursor;
  const gen1Cursor = topicState(db, 's:2', 1).cursor;
  check('each generation keeps its own cursor', gen0Cursor === 1 && gen1Cursor === 0, { gen0Cursor, gen1Cursor });
  check('same seq in two generations coexist', countEvents(db, 's:2', 0) === 2 && countEvents(db, 's:2', 1) === 1,
    { gen0: countEvents(db, 's:2', 0), gen1: countEvents(db, 's:2', 1) });
  db.close();
}

// ---- an early arrival is HELD, never dropped, and never advances the prefix ------------------
{
  const db = openLedger(path.join(dir, 'p3.db'));
  ensureTopic(db, 's:3');
  ingest(db, 's:3', 0, ev(0));
  ingest(db, 's:3', 0, ev(1));

  const r12 = ingest(db, 's:3', 0, ev(12));
  check('seq=12 arriving at cursor 1 is stored, not dropped', r12.added === true && countEvents(db, 's:3', 0) === 3,
    { added: r12.added, stored: countEvents(db, 's:3', 0) });
  check('seq=12 does not advance the contiguous prefix', r12.cursor === 1 && topicState(db, 's:3').cursor === 1,
    { cursor: r12.cursor });
  check('seq=12 is reported as staged', r12.staged === true, { staged: r12.staged });
  check('the hole is recorded as missing seqs only', JSON.stringify(gaps(db, 's:3', 0).map((g) => [g.from_seq, g.to_seq]))
    === JSON.stringify([[2, 11]]), { gaps: gaps(db, 's:3', 0) });

  const again = ingest(db, 's:3', 0, ev(12));
  check('re-receiving a staged event does not duplicate it', again.duplicate === true && countEvents(db, 's:3', 0) === 3,
    { duplicate: again.duplicate, stored: countEvents(db, 's:3', 0) });

  const r11 = ingest(db, 's:3', 0, ev(11));
  check('seq=11 shortens the hole but still cannot advance', r11.cursor === 1
    && JSON.stringify(gaps(db, 's:3', 0).map((g) => [g.from_seq, g.to_seq])) === JSON.stringify([[2, 10]]),
    { cursor: r11.cursor, gaps: gaps(db, 's:3', 0) });

  // Fill 2..10: the prefix must jump over the two held events, not stop at 10.
  for (let i = 2; i <= 10; i++) ingest(db, 's:3', 0, ev(i));
  const after = topicState(db, 's:3');
  check('filling the hole promotes the held events with it', after.cursor === 12 && gaps(db, 's:3', 0).length === 0,
    { cursor: after.cursor, gaps: gaps(db, 's:3', 0) });
  check('health returns to live only when no hole remains', after.health === 'live', { health: after.health });
  db.close();
}

// ---- a gap that is only PARTLY filled must shrink, not disappear -----------------------------
{
  const db = openLedger(path.join(dir, 'p4.db'));
  ensureTopic(db, 's:4');
  ingest(db, 's:4', 0, ev(0));
  ingest(db, 's:4', 0, ev(12));                       // hole 1..11
  for (let i = 1; i <= 6; i++) ingest(db, 's:4', 0, ev(i));   // fill 1..6 only
  const st = topicState(db, 's:4');
  check('partial fill advances the prefix to 6', st.cursor === 6, { cursor: st.cursor });
  check('partial fill narrows the gap to 7..11 instead of deleting it',
    JSON.stringify(gaps(db, 's:4', 0).map((g) => [g.from_seq, g.to_seq])) === JSON.stringify([[7, 11]]),
    { gaps: gaps(db, 's:4', 0) });
  check('health stays gap while the remainder is missing', st.health === 'gap', { health: st.health });
  check('the held event is still there after the partial fill', countEvents(db, 's:4', 0) === 8,
    { stored: countEvents(db, 's:4', 0) });
  db.close();
}

// ---- two holes stay two holes ----------------------------------------------------------------
{
  const db = openLedger(path.join(dir, 'p5.db'));
  ensureTopic(db, 's:5');
  ingest(db, 's:5', 0, ev(0));
  ingest(db, 's:5', 0, ev(5));
  ingest(db, 's:5', 0, ev(9));
  check('two disjoint holes are recorded as two ranges',
    JSON.stringify(gaps(db, 's:5', 0).map((g) => [g.from_seq, g.to_seq])) === JSON.stringify([[1, 4], [6, 8]]),
    { gaps: gaps(db, 's:5', 0) });
  for (let i = 1; i <= 4; i++) ingest(db, 's:5', 0, ev(i));
  check('closing the first hole leaves the second one open', topicState(db, 's:5').cursor === 5
    && JSON.stringify(gaps(db, 's:5', 0).map((g) => [g.from_seq, g.to_seq])) === JSON.stringify([[6, 8]]),
    { cursor: topicState(db, 's:5').cursor, gaps: gaps(db, 's:5', 0) });
  db.close();
}

// ---- consumers read the prefix, not the holding area ----------------------------------------
{
  const db = openLedger(path.join(dir, 'p6.db'));
  ensureTopic(db, 's:6');
  for (let i = 0; i <= 6; i++) ingest(db, 's:6', 0, ev(i));
  ingest(db, 's:6', 0, ev(12));
  check('eventsAfter defaults to the confirmed prefix', JSON.stringify(eventsAfter(db, 's:6', 0, 5).map((e) => e.seq))
    === JSON.stringify([6]), { got: eventsAfter(db, 's:6', 0, 5).map((e) => e.seq) });
  check('eventsAfter can include held events on explicit request',
    JSON.stringify(eventsAfter(db, 's:6', 0, 5, { confirmedOnly: false }).map((e) => e.seq)) === JSON.stringify([6, 12]),
    { got: eventsAfter(db, 's:6', 0, 5, { confirmedOnly: false }).map((e) => e.seq) });
  const s = stats(db, 's:6', 0);
  check('stats separates cursor, held rows and staged rows', s.cursor === 6 && s.held === 8 && s.staged === 1 && s.maxSeq === 12,
    s);
  db.close();
}

// ---- crash then reopen: cursor and rows agree ------------------------------------------------
{
  const file = path.join(dir, 'p7.db');
  let db = openLedger(file);
  ensureTopic(db, 's:7');
  ingestMany(db, 's:7', 0, [0, 1, 2, 3].map(ev));
  db.close();                                   // simulate process death after confirmed writes
  db = openLedger(file);
  const st = topicState(db, 's:7');
  const n = countEvents(db, 's:7', 0);
  check('reopen: cursor and rows agree', st.cursor === 3 && n === 4, { cursor: st.cursor, rows: n });
  db.close();
}

// ---- replay after restart is idempotent ------------------------------------------------------
{
  const file = path.join(dir, 'p8.db');
  let db = openLedger(file);
  ensureTopic(db, 's:8');
  const batch = [0, 1, 2, 3, 4].map(ev);
  ingestMany(db, 's:8', 0, batch);
  db.close();

  db = openLedger(file);
  const replay = ingestMany(db, 's:8', 0, batch);      // a reconnecting subscriber re-reads from 0
  const st = topicState(db, 's:8');
  check('replay is idempotent', replay.every((r) => r.duplicate) && countEvents(db, 's:8', 0) === 5 && st.cursor === 4,
    { allDuplicate: replay.every((r) => r.duplicate), rows: countEvents(db, 's:8', 0), cursor: st.cursor });
  ingest(db, 's:8', 0, ev(5));
  check('resume continues at cursor+1', topicState(db, 's:8').cursor === 5, { cursor: topicState(db, 's:8').cursor });
  db.close();
}

// ---- initial cursor distinguishes "nothing yet" from "seq 0 received" ------------------------
{
  const db = openLedger(path.join(dir, 'p9.db'));
  ensureTopic(db, 's:9');
  const before = topicState(db, 's:9').cursor;
  ingest(db, 's:9', 0, ev(0));
  const after = topicState(db, 's:9').cursor;
  check('cursor -1 before seq 0, 0 after', before === -1 && after === 0, { before, after });
  db.close();
}

console.log(JSON.stringify({ pass, fail, checks: out }, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
