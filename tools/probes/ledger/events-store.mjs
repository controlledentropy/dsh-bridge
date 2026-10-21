#!/usr/bin/env node
// Event ledger prototype (B2). SQLite is the authority for raw events; everything else is derived.
//
// Four things this file is built to make impossible:
//   1. Advancing the cursor past a hole. The cursor is a CONTIGUOUS PREFIX, never MAX(seq).
//   2. Collapsing two source generations into one row. The key carries sourceGeneration.
//   3. Treating "event persisted" as "business outcome known" - this layer stores events and nothing
//      else; deriving a delivery is a later step with its own state.
//   4. LOSING an event because it arrived early. A first version refused any seq beyond cursor+1 and
//      wrote a gap row instead, which is indistinguishable from dropping it: a replay after a
//      reconnect delivered the hole, found nothing above it, and the cursor marched over data that
//      had been seen and thrown away. Out-of-order arrivals are STORED and simply do not count
//      towards the prefix until the hole below them closes.
//
// connectionEpoch is deliberately NOT part of any key: a WebSocket reconnect is a transport event,
// and must not turn one DSH event into two.
//
// The cursor lives on (topic_id, source_generation), not on topic_id: a rebuilt source restarts its
// numbering, so a single per-topic cursor could not describe both generations at once.
//
// Gaps are materialised, but only ever from the events actually held. The second version deleted
// every gap row whose start had been passed, which is right for a hole that closed and wrong for one
// that only shrank: filling 2..6 of a 2..11 hole left the cursor at 6 and no gap row at all, so the
// ledger reported "live" while 7..11 was still missing. Recomputing the interval set from (cursor,
// held seqs) in the same transaction as the cursor makes "cursor is right, gaps are wrong"
// unrepresentable rather than merely tested for.
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

-- One row per (topic, generation): each generation has its own contiguous-prefix cursor.
CREATE TABLE IF NOT EXISTS topic (
  topic_id          TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  cursor            INTEGER NOT NULL DEFAULT -1,   -- -1 = nothing confirmed (dsh starts at seq 0)
  health            TEXT NOT NULL DEFAULT 'live',  -- live | gap
  last_frame_at     TEXT,
  PRIMARY KEY (topic_id, source_generation)
);

-- Every event that was ever received, including ones above the cursor. Rows above the cursor are
-- held (not yet part of the prefix); they are promoted by arithmetic, not by a second write.
CREATE TABLE IF NOT EXISTS event (
  topic_id          TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  seq               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  at                TEXT NOT NULL,
  data              TEXT NOT NULL,
  received_at       TEXT NOT NULL,
  PRIMARY KEY (topic_id, source_generation, seq)
) WITHOUT ROWID;

-- Half-open-in-intent, inclusive in fact: from_seq..to_seq are the MISSING seqs, not the observed one.
CREATE TABLE IF NOT EXISTS gap (
  topic_id          TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  from_seq          INTEGER NOT NULL,
  to_seq            INTEGER NOT NULL,
  discovered_at     TEXT NOT NULL,
  reason            TEXT,
  PRIMARY KEY (topic_id, source_generation, from_seq)
);
`;

const now = () => new Date().toISOString();

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

export function openLedger(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function ensureTopic(db, topicId, { generation = 0 } = {}) {
  db.prepare('INSERT OR IGNORE INTO topic (topic_id, source_generation, cursor, health) VALUES (?, ?, -1, ?)')
    .run(topicId, generation, 'live');
  return topicState(db, topicId, generation);
}

// Walk the prefix one step at a time. Only ever called after an insert, so the loop usually runs
// once; it runs further only when the insert closed a hole with held events behind it.
function advanceCursor(db, topicId, generation, from) {
  const has = db.prepare('SELECT 1 AS hit FROM event WHERE topic_id = ? AND source_generation = ? AND seq = ?');
  let c = from;
  while (has.get(topicId, generation, c + 1)) c += 1;
  return c;
}

// Rebuild the gap set from what is actually held. Disjoint by construction, so the table's primary
// key cannot merge two holes into one.
function rebuildGaps(db, topicId, generation, cursor) {
  const rows = db.prepare(`SELECT seq FROM event WHERE topic_id = ? AND source_generation = ? AND seq > ?
                           ORDER BY seq`).all(topicId, generation, cursor);
  const ranges = [];
  let expect = cursor + 1;
  for (const r of rows) {
    if (r.seq > expect) ranges.push([expect, r.seq - 1]);
    expect = r.seq + 1;
  }
  db.prepare('DELETE FROM gap WHERE topic_id = ? AND source_generation = ?').run(topicId, generation);
  const ins = db.prepare(`INSERT INTO gap (topic_id, source_generation, from_seq, to_seq, discovered_at, reason)
                          VALUES (?, ?, ?, ?, ?, ?)`);
  for (const [a, b] of ranges) ins.run(topicId, generation, a, b, now(), 'missing');
  return ranges;
}

/**
 * Ingest one event. Returns { added, duplicate, staged, cursor, gaps }.
 *
 *   added      this seq was not held before (whether or not it is part of the prefix)
 *   duplicate  it was already held; ingestion is idempotent by (topic, generation, seq)
 *   staged     it is held but sits above the cursor, waiting for the hole below it
 *   cursor     the contiguous prefix after this call
 *   gaps       the missing ranges after this call, inclusive and disjoint
 */
export function ingest(db, topicId, generation, ev) {
  const t = topicState(db, topicId, generation);
  if (!t) throw new Error('unknown topic/generation ' + topicId + '#' + generation);
  const seq = ev.seq;
  if (!Number.isInteger(seq)) throw new Error('seq must be an integer');

  return tx(db, () => {
    if (seq <= t.cursor) return { added: false, duplicate: true, staged: false, cursor: t.cursor, gaps: gapRanges(db, topicId, generation) };

    const held = db.prepare('SELECT 1 AS hit FROM event WHERE topic_id = ? AND source_generation = ? AND seq = ?')
      .get(topicId, generation, seq);
    if (held) return { added: false, duplicate: true, staged: true, cursor: t.cursor, gaps: gapRanges(db, topicId, generation) };

    db.prepare(`INSERT INTO event (topic_id, source_generation, seq, type, at, data, received_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(topicId, generation, seq, String(ev.type || 'unknown'), String(ev.at || now()), JSON.stringify(ev.data ?? null), now());

    const cursor = advanceCursor(db, topicId, generation, t.cursor);
    const gaps = rebuildGaps(db, topicId, generation, cursor);
    db.prepare('UPDATE topic SET cursor = ?, health = ?, last_frame_at = ? WHERE topic_id = ? AND source_generation = ?')
      .run(cursor, gaps.length ? 'gap' : 'live', now(), topicId, generation);

    return { added: true, duplicate: false, staged: seq > cursor, cursor, gaps };
  });
}

export function ingestMany(db, topicId, generation, events) {
  // Arrival order is not trustworthy, so it is not used: every batch is applied in seq order.
  return [...events].sort((a, b) => a.seq - b.seq)
    .map((e) => ({ seq: e.seq, ...ingest(db, topicId, generation, e) }));
}

export const topicState = (db, topicId, generation = 0) =>
  db.prepare('SELECT * FROM topic WHERE topic_id = ? AND source_generation = ?').get(topicId, generation);

export const countEvents = (db, topicId, generation) =>
  db.prepare('SELECT COUNT(*) AS n FROM event WHERE topic_id = ? AND source_generation = ?').get(topicId, generation).n;

export const heldAboveCursor = (db, topicId, generation) => {
  const t = topicState(db, topicId, generation);
  return db.prepare('SELECT COUNT(*) AS n FROM event WHERE topic_id = ? AND source_generation = ? AND seq > ?')
    .get(topicId, generation, t ? t.cursor : -1).n;
};

export const gaps = (db, topicId, generation) =>
  db.prepare('SELECT from_seq, to_seq, reason FROM gap WHERE topic_id = ? AND source_generation = ? ORDER BY from_seq')
    .all(topicId, generation);

export const gapRanges = (db, topicId, generation) =>
  gaps(db, topicId, generation).map((g) => [g.from_seq, g.to_seq]);

// Consumers read the prefix. Held events are readable only on request, because handing a downstream
// stage a sequence with a hole under it is exactly how a "gap" becomes a silent reordering.
export function eventsAfter(db, topicId, generation, afterSeq, { confirmedOnly = true } = {}) {
  const t = topicState(db, topicId, generation);
  const upper = confirmedOnly ? (t ? t.cursor : -1) : Number.MAX_SAFE_INTEGER;
  if (upper <= afterSeq) return [];
  return db.prepare(`SELECT seq, type, at, data FROM event
                     WHERE topic_id = ? AND source_generation = ? AND seq > ? AND seq <= ? ORDER BY seq`)
    .all(topicId, generation, afterSeq, upper);
}

export const stats = (db, topicId, generation) => {
  const t = topicState(db, topicId, generation);
  const row = db.prepare(`SELECT COUNT(*) AS n, MAX(seq) AS maxSeq FROM event WHERE topic_id = ? AND source_generation = ?`)
    .get(topicId, generation);
  return {
    cursor: t ? t.cursor : null,
    health: t ? t.health : null,
    held: row.n,
    maxSeq: row.maxSeq === null ? null : row.maxSeq,
    staged: heldAboveCursor(db, topicId, generation),
    gaps: gapRanges(db, topicId, generation),
  };
};
