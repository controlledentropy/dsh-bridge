#!/usr/bin/env node
// T1.1 acceptance: two ledger defects that let a silent wrong answer look like a successful one.
//
//   node tools/probes/ledger/t1-ledger-defects.mjs
//
// Both defects share a shape: the implementation checked a KEY and reported "idempotent", when the
// question was whether the CONTENT was the same. A key match is necessary for a replay and nowhere
// near sufficient:
//
//   1. dispatch  - (goal_id, client_request_id) matched => old dispatch returned. A caller that
//                  reused its key for a different cwd/task/topic was handed a dispatch it never
//                  made, and the call SUCCEEDED, so nothing upstream could notice.
//   2. events    - (topic, generation, seq) matched => 'duplicate'. A second payload under one seq
//                  was dropped with the row kept, so the ledger claimed a clean prefix over a
//                  sequence that had forked.
//
// The fixes are deliberately asymmetric. A dispatch conflict is REFUSED (the request is not
// serviceable). An event divergence is RECORDED and ESCALATED (both payloads survive, neither is
// chosen). The difference is that the dispatch has not happened yet whereas the events have already
// arrived. These checks assert the refusals, the escalation, and the regressions that must survive.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDispatchLedger, createGoal, authorizeGoal, admitDispatch, getGoal, digest }
  from './dispatch-store.mjs';
import { openLedger, ensureTopic, ingest, topicState, stats, divergences, divergenceCount, eventsAfter }
  from './events-store.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ledger-'));
const out = [];
let pass = 0, fail = 0;
const check = (name, ok, detail) => { out.push({ name, ok, detail }); ok ? pass++ : fail++; };
const WS = 'D:\\ws', WS2 = 'D:\\ws2';

const newGoal = (db, goalId, maxRounds = 3, ws = [WS, WS2]) => {
  createGoal(db, { goalId, maxRounds, allowedWorkspaces: ws });
  authorizeGoal(db, goalId);
};

// ============================================================================================
// Defect 1: an idempotency key reused with a different body
// ============================================================================================
{
  const db = openDispatchLedger(path.join(dir, 'd1.db'));
  newGoal(db, 'g1');
  const first = admitDispatch(db, { goalId: 'g1', cwd: WS, clientRequestId: 'k1', taskId: 't1', topicId: 's:1' });
  check('a first dispatch with a client key is admitted', first.admitted === true && !first.conflict,
    { admitted: first.admitted, conflict: first.conflict, dispatchId: first.dispatchId });

  // --- the case that was already right, and must stay right --------------------------------
  const replay = admitDispatch(db, { goalId: 'g1', cwd: WS, clientRequestId: 'k1', taskId: 't1', topicId: 's:1' });
  check('an identical body under the same key is still a replay, not a conflict',
    replay.duplicate === true && replay.conflict === false && replay.dispatchId === first.dispatchId,
    { duplicate: replay.duplicate, conflict: replay.conflict, sameId: replay.dispatchId === first.dispatchId });
  check('a replay does not spend a second round', getGoal(db, 'g1').rounds_used === 1,
    { roundsUsed: getGoal(db, 'g1').rounds_used });

  // --- the defect: same key, different body ------------------------------------------------
  const otherCwd = admitDispatch(db, { goalId: 'g1', cwd: WS2, clientRequestId: 'k1', taskId: 't1', topicId: 's:1' });
  check('a key reused with a different cwd is a conflict, not a replay',
    otherCwd.admitted === false && otherCwd.conflict === true && otherCwd.reason === 'idempotency-key-conflict',
    { conflict: otherCwd.conflict, reason: otherCwd.reason, differs: otherCwd.differs });
  check('the conflict names the field that differs', JSON.stringify(otherCwd.differs) === JSON.stringify(['cwd']),
    { differs: otherCwd.differs });
  // The dangerous version of this bug returned the old dispatch, so the caller proceeded against a
  // cwd it never named. duplicate:false is what makes that impossible to mistake downstream.
  check('a conflict is never also reported as a duplicate', otherCwd.duplicate === false,
    { duplicate: otherCwd.duplicate });

  const otherTask = admitDispatch(db, { goalId: 'g1', cwd: WS, clientRequestId: 'k1', taskId: 't2', topicId: 's:1' });
  check('a key reused with a different taskId is a conflict', otherTask.conflict === true
    && JSON.stringify(otherTask.differs) === JSON.stringify(['taskId']), { differs: otherTask.differs });

  const otherTopic = admitDispatch(db, { goalId: 'g1', cwd: WS, clientRequestId: 'k1', taskId: 't1', topicId: 's:2' });
  check('a key reused with a different topicId is a conflict', otherTopic.conflict === true
    && JSON.stringify(otherTopic.differs) === JSON.stringify(['topicId']), { differs: otherTopic.differs });

  const both = admitDispatch(db, { goalId: 'g1', cwd: WS2, clientRequestId: 'k1', taskId: null, topicId: 's:2' });
  check('every differing field is reported, not just the first', both.conflict === true
    && JSON.stringify(both.differs.sort()) === JSON.stringify(['cwd', 'taskId', 'topicId']), { differs: both.differs });

  // --- a refusal must leave no trace that looks like work -----------------------------------
  const d = digest(db);
  check('a refused admission creates no dispatch row', d.rows.dispatches === 1, { dispatches: d.rows.dispatches });
  check('a refused admission spends no round', getGoal(db, 'g1').rounds_used === 1,
    { roundsUsed: getGoal(db, 'g1').rounds_used });

  // --- the neighbours that must NOT become conflicts ----------------------------------------
  const fresh = admitDispatch(db, { goalId: 'g1', cwd: WS2, clientRequestId: 'k2', taskId: 't1', topicId: 's:1' });
  check('a different key with the same body is an ordinary new dispatch', fresh.admitted === true,
    { admitted: fresh.admitted, duplicate: fresh.duplicate, conflict: fresh.conflict });

  newGoal(db, 'g2');
  const otherGoal = admitDispatch(db, { goalId: 'g2', cwd: WS, clientRequestId: 'k1', taskId: 't1', topicId: 's:1' });
  check('the same key under a different goal is not a conflict', otherGoal.admitted === true && !otherGoal.conflict,
    { admitted: otherGoal.admitted, conflict: otherGoal.conflict });
  db.close();
}

// ---- absent task/topic must compare as equal, or every replay becomes a conflict -------------
{
  const db = openDispatchLedger(path.join(dir, 'd2.db'));
  newGoal(db, 'g3');
  admitDispatch(db, { goalId: 'g3', cwd: WS, clientRequestId: 'k3' });
  const omitted = admitDispatch(db, { goalId: 'g3', cwd: WS, clientRequestId: 'k3' });
  const explicitNull = admitDispatch(db, { goalId: 'g3', cwd: WS, clientRequestId: 'k3', taskId: null, topicId: null });
  check('an omitted optional field replays without becoming a conflict',
    omitted.duplicate === true && omitted.conflict === false, { duplicate: omitted.duplicate, conflict: omitted.conflict });
  check('explicit null replays against an omitted field', explicitNull.duplicate === true,
    { duplicate: explicitNull.duplicate, conflicts: explicitNull.conflict });
  db.close();
}

// ---- a key collision outranks an exhausted budget --------------------------------------------
{
  const db = openDispatchLedger(path.join(dir, 'd3.db'));
  newGoal(db, 'g4', 1);
  admitDispatch(db, { goalId: 'g4', cwd: WS, clientRequestId: 'k4' });
  check('the single allowed round is spent', getGoal(db, 'g4').rounds_used === 1
    && getGoal(db, 'g4').rounds_used >= getGoal(db, 'g4').max_rounds, { goal: getGoal(db, 'g4') });

  const collision = admitDispatch(db, { goalId: 'g4', cwd: WS2, clientRequestId: 'k4' });
  // "budget-exhausted" reads as "retry later"; the collision will still be there later, so reporting
  // the budget would send the caller away with the wrong diagnosis.
  check('with no budget left, a key collision is still reported as a conflict',
    collision.conflict === true && collision.reason === 'idempotency-key-conflict',
    { reason: collision.reason, conflict: collision.conflict });

  const genuinelyNew = admitDispatch(db, { goalId: 'g4', cwd: WS2, clientRequestId: 'k5' });
  check('with no budget left, a new key is still refused for budget',
    genuinelyNew.admitted === false && genuinelyNew.reason === 'budget-exhausted',
    { reason: genuinelyNew.reason });
  db.close();
}

// ============================================================================================
// Defect 2: one seq, two different payloads
// ============================================================================================
{
  const db = openLedger(path.join(dir, 'e1.db'));
  ensureTopic(db, 's:1');
  const base = { seq: 0, type: 'session', at: 't0', data: { a: 1, b: 2 } };
  const HELD = JSON.stringify({ a: 1, b: 2 });      // what the ledger stores for `base`
  ingest(db, 's:1', 0, base);

  // --- identical content stays a duplicate --------------------------------------------------
  const same = ingest(db, 's:1', 0, { ...base });
  check('an identical event is a duplicate and not a divergence',
    same.duplicate === true && same.divergent === false, { duplicate: same.duplicate, divergent: same.divergent });
  check('a clean replay leaves health live', topicState(db, 's:1').health === 'live',
    { health: topicState(db, 's:1').health });

  // Key order is a property of the serializer, not of the event: same keys, same values, reversed.
  const reordered = ingest(db, 's:1', 0, { seq: 0, type: 'session', at: 't0', data: { b: 2, a: 1 } });
  check('the same data with reordered keys is not a divergence', reordered.duplicate === true && !reordered.divergent,
    { duplicate: reordered.duplicate, divergent: reordered.divergent });
  check('a reordered replay leaves health live', topicState(db, 's:1').health === 'live',
    { health: topicState(db, 's:1').health });

  // --- the defect: same seq, different type -------------------------------------------------
  const forked = ingest(db, 's:1', 0, { seq: 0, type: 'error', at: 't0', data: null });
  check('a different type under one seq is a divergence, not a duplicate',
    forked.divergent === true && forked.duplicate === false,
    { divergent: forked.divergent, duplicate: forked.duplicate });
  check('the divergence reports both payloads and the seq',
    forked.conflict && forked.conflict.seq === 0 && forked.conflict.held.type === 'session'
      && forked.conflict.seen.type === 'error', forked.conflict);
  check('a divergence freezes the topic health', topicState(db, 's:1').health === 'divergent',
    { health: topicState(db, 's:1').health });
  check('a divergence does not move the cursor', topicState(db, 's:1').cursor === 0,
    { cursor: topicState(db, 's:1').cursor });

  // --- the holder keeps first write, and the second version survives as evidence -------------
  const row = eventsAfter(db, 's:1', 0, -1)[0];
  check('the held payload is not overwritten by the fork', row.type === 'session' && row.data === HELD,
    row);
  const evidence = divergences(db, 's:1', 0);
  check('the refused payload is preserved as evidence',
    evidence.length === 1 && evidence[0].seen_type === 'error', { evidence: evidence.length });
  check('stats exposes the divergence count alongside health',
    stats(db, 's:1', 0).divergences === 1 && stats(db, 's:1', 0).health === 'divergent',
    { divergences: stats(db, 's:1', 0).divergences });

  // --- health is sticky: the next clean frame must not declare the topic healthy -------------
  ingest(db, 's:1', 0, { seq: 1, type: 'session', at: 't1', data: null });
  check('a later clean event does not clear the divergent health',
    topicState(db, 's:1').health === 'divergent' && topicState(db, 's:1').cursor === 1,
    { health: topicState(db, 's:1').health, cursor: topicState(db, 's:1').cursor });

  // --- repeated identical fork replay collapses; a third distinct payload does not ------------
  ingest(db, 's:1', 0, { seq: 0, type: 'error', at: 't0', data: null });
  check('replaying the same conflicting payload adds no second evidence row', divergenceCount(db, 's:1', 0) === 1,
    { count: divergenceCount(db, 's:1', 0) });
  const third = ingest(db, 's:1', 0, { seq: 0, type: 'session', at: 't0', data: { a: 9 } });
  check('a third distinct payload under the same seq is its own divergence',
    third.divergent === true && divergenceCount(db, 's:1', 0) === 2, { count: divergenceCount(db, 's:1', 0) });
  check('the third payload also leaves the held row alone',
    eventsAfter(db, 's:1', 0, -1).find((e) => e.seq === 0).data === HELD,
    eventsAfter(db, 's:1', 0, -1).find((e) => e.seq === 0));
  db.close();
}

// ---- a fork above the cursor is staged AND divergent, not one or the other --------------------
{
  const db = openLedger(path.join(dir, 'e2.db'));
  ensureTopic(db, 's:2');
  ingest(db, 's:2', 0, { seq: 0, type: 'a', at: 't0', data: null });
  ingest(db, 's:2', 0, { seq: 5, type: 'a', at: 't0', data: { v: 1 } });
  const fork = ingest(db, 's:2', 0, { seq: 5, type: 'a', at: 't0', data: { v: 2 } });
  check('a staged seq can also be divergent', fork.divergent === true && fork.staged === true && fork.duplicate === false,
    { divergent: fork.divergent, staged: fork.staged });
  check('a staged divergence does not close the hole', topicState(db, 's:2').cursor === 0
    && JSON.stringify(stats(db, 's:2', 0).gaps) === JSON.stringify([[1, 4]]),
    { cursor: topicState(db, 's:2').cursor, gaps: stats(db, 's:2', 0).gaps });
  check('a staged divergence also freezes health', topicState(db, 's:2').health === 'divergent',
    { health: topicState(db, 's:2').health });
  db.close();
}

// ---- a fork in one generation must not taint another ------------------------------------------
{
  const db = openLedger(path.join(dir, 'e3.db'));
  ensureTopic(db, 's:3', { generation: 0 });
  ingest(db, 's:3', 0, { seq: 0, type: 'a', at: 't0', data: { g: 0 } });
  ingest(db, 's:3', 0, { seq: 0, type: 'b', at: 't0', data: { g: 0 } });   // fork in generation 0

  ensureTopic(db, 's:3', { generation: 1 });
  ingest(db, 's:3', 1, { seq: 0, type: 'a', at: 't0', data: { g: 1 } });
  check('a fork is scoped to its own source generation',
    topicState(db, 's:3', 0).health === 'divergent' && topicState(db, 's:3', 1).health === 'live',
    { gen0: topicState(db, 's:3', 0).health, gen1: topicState(db, 's:3', 1).health });
  check('a clean generation reports no divergences', divergenceCount(db, 's:3', 1) === 0,
    { count: divergenceCount(db, 's:3', 1) });
  db.close();
}

console.log(JSON.stringify({ pass, fail, checks: out }, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
