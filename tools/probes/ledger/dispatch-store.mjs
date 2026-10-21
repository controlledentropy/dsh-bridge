#!/usr/bin/env node
// Dispatch ledger prototype (B3/B4). Where events-store.mjs answers "what did the source say",
// this answers "what did we do about it" - and the two must not be derived from each other.
//
// The rules encoded here come from docs/EVENT-LEDGER-CONTRACT.md, and each one exists because the
// naive version is a specific failure:
//
//   INTENT is written and committed BEFORE the external RPC. A process that dies mid-send therefore
//   leaves evidence that a send may have happened. The alternative - write the outcome after the call
//   returns - cannot distinguish "never sent" from "sent, reply lost", and the safe reading of that
//   ambiguity is the expensive one.
//
//   SENT_UNKNOWN is not retried automatically. A retry after a lost reply is a duplicate execution
//   unless the target is idempotent, and neither dsh's session/prompt nor Codex's queue/add promises
//   that for an arbitrary task body. UNCERTAIN goes to a human.
//
//   The budget debit and the dispatch INSERT share one transaction, so there is no state in which a
//   round was spent without a dispatch or a dispatch exists without a spent round.
//
//   delivered != consumed. A queued item that a cold thread never wakes for is delivered and unseen;
//   reporting it as consumed is how "no progress" looks like "no work".
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS goal (
  goal_id            TEXT PRIMARY KEY,
  state              TEXT NOT NULL,          -- proposed | authorized | running | paused | completed | budget_exhausted | needs_human
  max_rounds         INTEGER NOT NULL,
  rounds_used        INTEGER NOT NULL DEFAULT 0,
  allowed_workspaces TEXT NOT NULL,          -- JSON array
  created_at         TEXT NOT NULL,
  expires_at         TEXT
);

CREATE TABLE IF NOT EXISTS dispatch (
  dispatch_id       TEXT PRIMARY KEY,
  goal_id           TEXT NOT NULL,
  task_id           TEXT,
  topic_id          TEXT,
  client_request_id TEXT,                    -- idempotency key, not authority
  cwd               TEXT NOT NULL,
  state             TEXT NOT NULL,           -- admitted | submitted | settled | rejected
  created_at        TEXT NOT NULL,
  UNIQUE (goal_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS attempt (
  attempt_id  TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  target      TEXT NOT NULL,                 -- dsh:session/prompt | codex:thread/queue/add
  state       TEXT NOT NULL,                 -- INTENT | SENT_ACKED | SENT_REJECTED | SENT_UNKNOWN
  remote_ref  TEXT,
  proof       TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempt_by_dispatch ON attempt (dispatch_id);

CREATE TABLE IF NOT EXISTS delivery (
  delivery_id      TEXT PRIMARY KEY,
  dispatch_id      TEXT NOT NULL,
  codex_instance_id TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  state            TEXT NOT NULL,            -- submitted | delivered | uncertain
  consumption      TEXT NOT NULL DEFAULT 'unseen',   -- unseen | acked
  created_at       TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();
const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

export function openDispatchLedger(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export const getGoal = (db, goalId) => db.prepare('SELECT * FROM goal WHERE goal_id = ?').get(goalId);
export const getDispatch = (db, id) => db.prepare('SELECT * FROM dispatch WHERE dispatch_id = ?').get(id);
export const attemptsOf = (db, dispatchId) =>
  db.prepare('SELECT * FROM attempt WHERE dispatch_id = ? ORDER BY created_at').all(dispatchId);
export const deliveriesOf = (db, dispatchId) =>
  db.prepare('SELECT * FROM delivery WHERE dispatch_id = ? ORDER BY created_at').all(dispatchId);

export function createGoal(db, { goalId, maxRounds, allowedWorkspaces, state = 'proposed' }) {
  db.prepare(`INSERT INTO goal (goal_id, state, max_rounds, rounds_used, allowed_workspaces, created_at)
              VALUES (?, ?, ?, 0, ?, ?)`)
    .run(goalId, state, maxRounds, JSON.stringify(allowedWorkspaces), now());
  return getGoal(db, goalId);
}

// Authorization is a separate act with its own transition. A goal that could be created directly in
// the authorized state would make "the user approved this" indistinguishable from "the model asked".
export function authorizeGoal(db, goalId) {
  return tx(db, () => {
    const g = getGoal(db, goalId);
    if (!g) throw new Error('unknown goal ' + goalId);
    if (g.state !== 'proposed') throw new Error('goal ' + goalId + ' is ' + g.state + ', not proposed');
    db.prepare('UPDATE goal SET state = ? WHERE goal_id = ?').run('authorized', goalId);
    return getGoal(db, goalId);
  });
}

const DISPATCHABLE = new Set(['authorized', 'running']);

/**
 * Admit one dispatch. Returns { admitted, duplicate, dispatchId, roundsUsed, reason? }.
 *
 * All four checks and the debit happen inside one IMMEDIATE transaction: two callers racing for the
 * last round cannot both see "one left".
 */
export function admitDispatch(db, { goalId, cwd, clientRequestId = null, taskId = null, topicId = null }) {
  return tx(db, () => {
    const g = getGoal(db, goalId);
    if (!g) return { admitted: false, reason: 'unknown-goal' };
    if (!DISPATCHABLE.has(g.state)) return { admitted: false, reason: 'goal-not-authorized', state: g.state };

    if (clientRequestId) {
      const prior = db.prepare('SELECT * FROM dispatch WHERE goal_id = ? AND client_request_id = ?').get(goalId, clientRequestId);
      // Idempotency is a read of the ledger, not a hope: the second call must not spend a second round.
      if (prior) return { admitted: false, duplicate: true, dispatchId: prior.dispatch_id, roundsUsed: g.rounds_used };
    }

    if (g.rounds_used >= g.max_rounds) return { admitted: false, reason: 'budget-exhausted', roundsUsed: g.rounds_used, max: g.max_rounds };

    const allowed = JSON.parse(g.allowed_workspaces);
    if (!allowed.includes(cwd)) return { admitted: false, reason: 'cwd-not-allowed', cwd };

    const dispatchId = uid('dsp');
    db.prepare(`INSERT INTO dispatch (dispatch_id, goal_id, task_id, topic_id, client_request_id, cwd, state, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'admitted', ?)`)
      .run(dispatchId, goalId, taskId, topicId, clientRequestId, cwd, now());
    db.prepare('UPDATE goal SET rounds_used = rounds_used + 1, state = ? WHERE goal_id = ?').run('running', goalId);
    return { admitted: true, duplicate: false, dispatchId, roundsUsed: g.rounds_used + 1 };
  });
}

/**
 * Record the intent to call an external target, and commit it. This is deliberately a separate call
 * the caller must make BEFORE its RPC: an intent that is only written afterwards cannot survive the
 * case it exists for.
 */
export function beginAttempt(db, dispatchId, target) {
  return tx(db, () => {
    const d = getDispatch(db, dispatchId);
    if (!d) throw new Error('unknown dispatch ' + dispatchId);
    if (d.state === 'rejected' || d.state === 'settled') throw new Error('dispatch ' + dispatchId + ' is already ' + d.state);
    const attemptId = uid('att');
    db.prepare(`INSERT INTO attempt (attempt_id, dispatch_id, target, state, created_at)
                VALUES (?, ?, ?, 'INTENT', ?)`).run(attemptId, dispatchId, target, now());
    return { attemptId, state: 'INTENT' };
  });
}

export function settleAttempt(db, attemptId, outcome, { remoteRef = null, proof = null } = {}) {
  if (!['SENT_ACKED', 'SENT_REJECTED'].includes(outcome)) throw new Error('outcome must be SENT_ACKED or SENT_REJECTED');
  return tx(db, () => {
    const a = db.prepare('SELECT * FROM attempt WHERE attempt_id = ?').get(attemptId);
    if (!a) throw new Error('unknown attempt ' + attemptId);
    // A settled attempt is evidence of what happened; overwriting it would erase the only proof.
    if (a.state !== 'INTENT') throw new Error('attempt ' + attemptId + ' is already ' + a.state);
    db.prepare('UPDATE attempt SET state = ?, remote_ref = ?, proof = ?, decided_at = ? WHERE attempt_id = ?')
      .run(outcome, remoteRef, proof, now(), attemptId);
    if (outcome === 'SENT_ACKED') {
      db.prepare('UPDATE dispatch SET state = ? WHERE dispatch_id = ? AND state = ?').run('submitted', a.dispatch_id, 'admitted');
    } else {
      db.prepare('UPDATE dispatch SET state = ? WHERE dispatch_id = ?').run('rejected', a.dispatch_id);
    }
    return db.prepare('SELECT * FROM attempt WHERE attempt_id = ?').get(attemptId);
  });
}

export function settleDispatch(db, dispatchId) {
  return tx(db, () => {
    const d = getDispatch(db, dispatchId);
    if (!d) throw new Error('unknown dispatch ' + dispatchId);
    // "settled" without a submitted attempt would be a claim that work finished that was never sent.
    if (d.state !== 'submitted') throw new Error('dispatch ' + dispatchId + ' is ' + d.state + ', cannot settle');
    db.prepare('UPDATE dispatch SET state = ? WHERE dispatch_id = ?').run('settled', dispatchId);
    return getDispatch(db, dispatchId);
  });
}

/**
 * Reconcile after a restart. An attempt still at INTENT means "may have been sent, no reply was
 * recorded". It becomes SENT_UNKNOWN - never "not sent" - and the dispatch needs a human.
 */
export function reconcile(db) {
  return tx(db, () => {
    const stuck = db.prepare(`SELECT a.attempt_id, a.dispatch_id, a.target, d.goal_id
                              FROM attempt a JOIN dispatch d ON d.dispatch_id = a.dispatch_id
                              WHERE a.state = 'INTENT'`).all();
    for (const s of stuck) {
      db.prepare('UPDATE attempt SET state = ?, decided_at = ? WHERE attempt_id = ?').run('SENT_UNKNOWN', now(), s.attempt_id);
    }
    if (stuck.length) {
      const goals = [...new Set(stuck.map((s) => s.goal_id))];
      for (const g of goals) db.prepare('UPDATE goal SET state = ? WHERE goal_id = ?').run('needs_human', g);
    }
    return { uncertain: stuck, needsHuman: stuck.length > 0 };
  });
}

export function recordDelivery(db, { dispatchId, codexInstanceId, threadId, delivered = false }) {
  return tx(db, () => {
    const id = uid('dlv');
    db.prepare(`INSERT INTO delivery (delivery_id, dispatch_id, codex_instance_id, thread_id, state, consumption, created_at)
                VALUES (?, ?, ?, ?, ?, 'unseen', ?)`)
      .run(id, dispatchId, codexInstanceId, threadId, delivered ? 'delivered' : 'submitted', now());
    return db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(id);
  });
}

export function markDelivered(db, deliveryId) {
  db.prepare('UPDATE delivery SET state = ? WHERE delivery_id = ?').run('delivered', deliveryId);
  return db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(deliveryId);
}

// Consumption is a separate fact, observed later (a turn actually started). Writing it here would
// only be a copy of "delivered" with a more confident name.
export function ackConsumption(db, deliveryId) {
  const d = db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(deliveryId);
  if (!d) throw new Error('unknown delivery ' + deliveryId);
  if (d.state !== 'delivered') throw new Error('cannot ack consumption for a ' + d.state + ' delivery');
  db.prepare('UPDATE delivery SET consumption = ? WHERE delivery_id = ?').run('acked', deliveryId);
  return db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(deliveryId);
}

/**
 * Whether a resume may run. Pure, because the point is to be able to test the refusals.
 *
 * MEASURED elsewhere (E-CODEX-COLD-RESUME): thread/resume consumes a persisted queued item and runs
 * a turn. It is an execution trigger, so every condition that gates a dispatch gates it too.
 */
export function mayResume({ goalState, roundsLeft, uncertain = 0, stopActive = false, claimHeld = true }) {
  if (stopActive) return { allow: false, reason: 'stop-active' };
  if (!claimHeld) return { allow: false, reason: 'no-single-executor-claim' };
  // The cause before the symptom: needs_human is what an uncertain attempt *makes* the goal, so
  // reporting the goal state first would tell a human to re-authorise instead of to look at the send.
  if (uncertain > 0) return { allow: false, reason: 'uncertain-attempt-needs-human' };
  if (goalState !== 'authorized' && goalState !== 'running') return { allow: false, reason: 'goal-not-authorized', state: goalState };
  if (roundsLeft <= 0) return { allow: false, reason: 'budget-exhausted' };
  return { allow: true };
}

/**
 * A human's decision about an attempt the ledger could not classify. Kept separate from settleAttempt
 * on purpose: the automated path refuses to move an UNCERTAIN, so the only way out is a call that
 * names itself as the human resolution and records who decided.
 */
export function resolveUncertain(db, attemptId, decision, proof) {
  if (!['SENT_ACKED', 'SENT_REJECTED'].includes(decision)) throw new Error('decision must be SENT_ACKED or SENT_REJECTED');
  if (!proof) throw new Error('a human resolution needs a proof string; "unknown, closed by hand" is not one');
  return tx(db, () => {
    const a = db.prepare('SELECT * FROM attempt WHERE attempt_id = ?').get(attemptId);
    if (!a) throw new Error('unknown attempt ' + attemptId);
    if (a.state !== 'SENT_UNKNOWN') throw new Error('attempt ' + attemptId + ' is ' + a.state + ', not SENT_UNKNOWN');
    db.prepare('UPDATE attempt SET state = ?, proof = ?, decided_at = ? WHERE attempt_id = ?')
      .run(decision, 'human: ' + proof, now(), attemptId);
    db.prepare('UPDATE dispatch SET state = ? WHERE dispatch_id = ?')
      .run(decision === 'SENT_ACKED' ? 'submitted' : 'rejected', a.dispatch_id);
    return db.prepare('SELECT * FROM attempt WHERE attempt_id = ?').get(attemptId);
  });
}

/** Return a goal to service after a human has dealt with its uncertain attempt. */
export function resumeAfterHuman(db, goalId) {
  return tx(db, () => {
    const g = getGoal(db, goalId);
    if (!g) throw new Error('unknown goal ' + goalId);
    if (g.state !== 'needs_human') throw new Error('goal ' + goalId + ' is ' + g.state + ', not needs_human');
    const open = db.prepare(`SELECT COUNT(*) AS n FROM attempt a JOIN dispatch d ON d.dispatch_id = a.dispatch_id
                             WHERE d.goal_id = ? AND a.state IN ('INTENT','SENT_UNKNOWN')`).get(goalId).n;
    if (open > 0) throw new Error('goal ' + goalId + ' still has ' + open + ' unresolved attempt(s)');
    if (g.rounds_used >= g.max_rounds) throw new Error('goal ' + goalId + ' has no rounds left');
    db.prepare('UPDATE goal SET state = ? WHERE goal_id = ?').run('running', goalId);
    return getGoal(db, goalId);
  });
}

export const digest = (db) => {
  const goals = db.prepare('SELECT goal_id, state, rounds_used, max_rounds FROM goal ORDER BY goal_id').all();
  const dispatches = db.prepare('SELECT dispatch_id, state FROM dispatch ORDER BY dispatch_id').all();
  const attempts = db.prepare('SELECT attempt_id, dispatch_id, state FROM attempt ORDER BY attempt_id').all();
  return { goals, dispatches, attempts,
    rows: { goals: goals.length, dispatches: dispatches.length, attempts: attempts.length } };
};
