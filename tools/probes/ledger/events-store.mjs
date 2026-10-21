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
//
// And a fifth: the key (topic, generation, seq) was treated as proof that two arrivals were the same
// event. They are not. A source that renumbers, a proxy that rewrites a frame, or two producers on
// one topic can all deliver DIFFERENT payloads under one seq, and the first version answered
// "duplicate" to the second one - silently choosing a winner and calling the result idempotent.
// Idempotent replay and a forked sequence look identical to a key check and must not: identical
// content is a duplicate, differing content is a DIVERGENCE that freezes the topic's health and goes
// to a human. Neither payload is discarded and neither is silently preferred - the held row keeps
// first-write-wins, and the second version is preserved beside it as evidence.
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

-- One seq, two different payloads. Append-only: the point is that BOTH versions survive, so the
-- table cannot be a column on event (a column can only hold one of them). The primary key makes a
-- repeated identical conflict collapse, while a third distinct payload gets its own row.
CREATE TABLE IF NOT EXISTS event_divergence (
  topic_id          TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  seq               INTEGER NOT NULL,
  held_type         TEXT NOT NULL,            -- what the ledger kept (first write wins)
  held_data         TEXT NOT NULL,
  seen_type         TEXT NOT NULL,            -- what arrived second and was refused the row
  seen_data         TEXT NOT NULL,
  detected_at       TEXT NOT NULL,
  PRIMARY KEY (topic_id, source_generation, seq, seen_type, seen_data)
);
`;

// Canonical JSON, so that {a:1,b:2} and {b:2,a:1} are one payload rather than a divergence. Key
// order is an artefact of whichever serializer produced the frame, not a property of the event.
function stable(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

// Stored data is text; it still has to be canonicalised through the same function or a reordered
// rewrite of an identical event would be reported as a fork.
function canonicalStored(raw) {
  try { return stable(JSON.parse(raw)); } catch { return String(raw); }
}

// type + data are the payload. `at` is deliberately excluded: it is a source-side timestamp that a
// replay may reasonably re-render, and treating a re-rendered timestamp as a fork would freeze
// topics that are merely being replayed.

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
 * Ingest one event. Returns
 *   { added, duplicate, divergent, staged, cursor, gaps, held?, conflict? }.
 *
 *   added      this seq was not held before (whether or not it is part of the prefix)
 *   duplicate  IDENTICAL event already held; ingestion is idempotent by content, not merely by key
 *   divergent  this seq is held with a DIFFERENT payload; the topic's health is frozen and a human
 *              must decide. Neither version is dropped and neither is chosen automatically.
 *   staged     it is held but sits above the cursor, waiting for the hole below it
 *   cursor     the contiguous prefix after this call
 *   gaps       the missing ranges after this call, inclusive and disjoint
 *   conflict   only when divergent: both payloads and the seq they collided on
 *
 * `duplicate` and `divergent` are mutually exclusive by construction: a caller that checks only
 * `duplicate` cannot accidentally treat a fork as a harmless replay.
 */
export function ingest(db, topicId, generation, ev) {
  const t = topicState(db, topicId, generation);
  if (!t) throw new Error('unknown topic/generation ' + topicId + '#' + generation);
  const seq = ev.seq;
  if (!Number.isInteger(seq)) throw new Error('seq must be an integer');

  const seen = { type: String(ev.type || 'unknown'), data: stable(ev.data ?? null) };

  return tx(db, () => {
    const held = db.prepare('SELECT type, data FROM event WHERE topic_id = ? AND source_generation = ? AND seq = ?')
      .get(topicId, generation, seq);

    if (held) {
      const prior = { type: held.type, data: canonicalStored(held.data) };
      if (prior.type !== seen.type || prior.data !== seen.data) {
        return diverge(db, { topicId, generation, seq, prior, seen, cursor: t.cursor,
          staged: seq > t.cursor });
      }
      return { added: false, duplicate: true, divergent: false, staged: seq > t.cursor,
        cursor: t.cursor, gaps: gapRanges(db, topicId, generation) };
    }

    // seq at or below the cursor with no row held cannot happen while the cursor only advances over
    // existing rows; if it does, the ledger is internally inconsistent and must not be guessed at.
    if (seq <= t.cursor) {
      throw new Error('ledger inconsistent: seq ' + seq + ' is inside the prefix (cursor ' + t.cursor + ') but not held');
    }

    db.prepare(`INSERT INTO event (topic_id, source_generation, seq, type, at, data, received_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(topicId, generation, seq, seen.type, String(ev.at || now()), JSON.stringify(ev.data ?? null), now());

    const cursor = advanceCursor(db, topicId, generation, t.cursor);
    const gaps = rebuildGaps(db, topicId, generation, cursor);
    db.prepare('UPDATE topic SET cursor = ?, health = ?, last_frame_at = ? WHERE topic_id = ? AND source_generation = ?')
      .run(cursor, healthFor(db, topicId, generation, gaps.length), now(), topicId, generation);

    return { added: true, duplicate: false, divergent: false, staged: seq > cursor, cursor, gaps };
  });
}

// Health is a function of everything known about the generation, not of this one arrival. Writing
// 'live' on every clean insert is how a divergence would erase itself: the next frame after a fork
// would report the topic healthy again while the fork is still unresolved.
//
// Divergence outranks gap when both are present: a hole means some events are unknown, a fork means
// the events we do hold are not trustworthy - and the second cannot be repaired by waiting.
function healthFor(db, topicId, generation, gapCount) {
  const forked = db.prepare('SELECT 1 AS hit FROM event_divergence WHERE topic_id = ? AND source_generation = ? LIMIT 1')
    .get(topicId, generation);
  if (forked) return 'divergent';
  return gapCount ? 'gap' : 'live';
}

// Keep the held row, keep the newcomer beside it, and refuse to pick a winner. The cursor does not
// move: a forked seq is not confirmed data, and promoting it would hand consumers the version the
// ledger happened to receive first.
function diverge(db, { topicId, generation, seq, prior, seen, cursor, staged }) {
  db.prepare(`INSERT OR IGNORE INTO event_divergence
              (topic_id, source_generation, seq, held_type, held_data, seen_type, seen_data, detected_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(topicId, generation, seq, prior.type, prior.data, seen.type, seen.data, now());
  db.prepare('UPDATE topic SET health = ?, last_frame_at = ? WHERE topic_id = ? AND source_generation = ?')
    .run('divergent', now(), topicId, generation);
  return {
    added: false,
    duplicate: false,
    divergent: true,
    staged,
    cursor,
    gaps: gapRanges(db, topicId, generation),
    conflict: { seq, held: prior, seen },
  };
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

// The evidence behind health='divergent'. A count alone would let a Coordinator report "one fork"
// while being unable to say which seq or what the two payloads were, which is not an escalation a
// human can act on.
export const divergences = (db, topicId, generation) =>
  db.prepare(`SELECT seq, held_type, held_data, seen_type, seen_data, detected_at
              FROM event_divergence WHERE topic_id = ? AND source_generation = ? ORDER BY seq, detected_at`)
    .all(topicId, generation);

export const divergenceCount = (db, topicId, generation) =>
  db.prepare('SELECT COUNT(*) AS n FROM event_divergence WHERE topic_id = ? AND source_generation = ?')
    .get(topicId, generation).n;

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
    // Present so that health='divergent' is explainable from the same snapshot rather than being a
    // flag whose cause has to be looked up separately.
    divergences: divergenceCount(db, topicId, generation),
  };
};
