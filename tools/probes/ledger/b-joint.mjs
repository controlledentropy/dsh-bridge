#!/usr/bin/env node
// Joint acceptance: one synthetic Coordinator run over all four parts, with the failure inserted
// where it is worst - after the send, before the reply.
//
//   B1 gate      the conditions a dispatch must satisfy before it is allowed (cwd, goal state)
//   B2 ledger    the source events behind a dispatch (events-store.mjs, separate file)
//   B3 recovery  what a restart may conclude, and what it must hand to a human
//   B4 spending  the budget debit and the dispatch row in one transaction
//
// No Codex, no DSH, no network, no credentials. The "adapter" is a function whose reply can be lost
// on demand, which is the only failure mode that matters here: a clean error is easy, a missing reply
// is what turns a retry into a duplicate execution.
//
//   node tools/probes/ledger/b-joint.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDispatchLedger, createGoal, authorizeGoal, admitDispatch, beginAttempt, settleAttempt,
  settleDispatch, reconcile, recordDelivery, markDelivered, ackConsumption, resolveUncertain,
  resumeAfterHuman, mayResume, getGoal, getDispatch, attemptsOf, deliveriesOf } from './dispatch-store.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-joint-'));
const out = [];
let pass = 0, fail = 0;
const check = (name, ok, detail) => { out.push({ name, ok, detail }); ok ? pass++ : fail++; };
const WS = 'D:\\ws\\joint';
const file = path.join(dir, 'joint.db');

// The adapter answers unless asked to lose the reply. "Lost" means the caller never learns the
// outcome - not that the call failed, which would be a different (and much easier) case.
function mockAdapter({ loseReply = false } = {}) {
  return {
    send(payload) {
      if (loseReply) { const e = new Error('reply lost after send'); e.lost = true; throw e; }
      return { remoteRef: 'ref-' + payload.attemptId.slice(-6) };
    },
  };
}

const goalId = 'goal-joint';
let db = openDispatchLedger(file);
createGoal(db, { goalId, maxRounds: 3, allowedWorkspaces: [WS] });
authorizeGoal(db, goalId);

// ---- round 1: the honest path -----------------------------------------------------------------
{
  const adm = admitDispatch(db, { goalId, cwd: WS, clientRequestId: 'r1' });
  check('round 1 is admitted', adm.admitted === true, adm);

  const att = beginAttempt(db, adm.dispatchId, 'codex:thread/queue/add');
  const acked = settleAttempt(db, att.attemptId, 'SENT_ACKED', mockAdapter().send(att));
  check('the intent is recorded before the call returns', acked.state === 'SENT_ACKED', { state: acked.state });

  const dlv = recordDelivery(db, { dispatchId: adm.dispatchId, codexInstanceId: 'cx-joint', threadId: 'th-1' });
  check('a delivery starts unseen', dlv.consumption === 'unseen', { consumption: dlv.consumption });
  markDelivered(db, dlv.delivery_id);

  // The settlement rule used here is the conservative one: delivered is not consumed, so the
  // dispatch is not settled until a turn was actually observed.
  check('nothing is settled while consumption is unseen',
    deliveriesOf(db, adm.dispatchId).some((d) => d.consumption === 'unseen') && getDispatch(db, adm.dispatchId).state === 'submitted',
    { state: getDispatch(db, adm.dispatchId).state });

  ackConsumption(db, dlv.delivery_id);
  check('round 1 settles once consumption is acked', settleDispatch(db, adm.dispatchId).state === 'settled',
    { state: getDispatch(db, adm.dispatchId).state });
  check('one round was spent', getGoal(db, goalId).rounds_used === 1, { roundsUsed: getGoal(db, goalId).rounds_used });
}

// ---- round 2: the reply is lost, then the process dies ----------------------------------------
let uncertainDispatch = null;
{
  const adm = admitDispatch(db, { goalId, cwd: WS, clientRequestId: 'r2' });
  uncertainDispatch = adm.dispatchId;
  const att = beginAttempt(db, adm.dispatchId, 'codex:thread/queue/add');
  let lost = null;
  try { mockAdapter({ loseReply: true }).send(att); } catch (e) { lost = e; }
  check('the send raised; the ledger does not know the outcome', lost !== null && lost.lost === true,
    { error: lost && lost.message });
  check('the attempt is still INTENT after the lost reply',
    attemptsOf(db, adm.dispatchId)[0].state === 'INTENT', { state: attemptsOf(db, adm.dispatchId)[0].state });
  db.close();                                        // process death with an unresolved send
}

// ---- restart: reconcile, refuse to resume, hand to a human -----------------------------------
{
  db = openDispatchLedger(file);
  const r = reconcile(db);
  check('reconcile finds exactly the unresolved send', r.uncertain.length === 1 && r.uncertain[0].dispatch_id === uncertainDispatch, r);
  check('it is classified UNKNOWN, not "not sent"',
    attemptsOf(db, uncertainDispatch).some((a) => a.state === 'SENT_UNKNOWN'),
    attemptsOf(db, uncertainDispatch).map((a) => a.state));
  check('the goal needs a human', getGoal(db, goalId).state === 'needs_human', { state: getGoal(db, goalId).state });

  const gate = mayResume({ goalState: getGoal(db, goalId).state, roundsLeft: 1, uncertain: r.uncertain.length, claimHeld: true });
  check('a restart may not resume into an uncertain attempt', gate.allow === false && gate.reason === 'uncertain-attempt-needs-human', gate);

  // The budget is not refunded by a lost reply, and a second dispatch is still possible - the goal
  // has rounds left. What must not happen is an automatic second send for the *same* dispatch.
  const before = attemptsOf(db, uncertainDispatch).length;
  reconcile(db);
  check('a second restart adds no retry', attemptsOf(db, uncertainDispatch).length === before,
    { before, after: attemptsOf(db, uncertainDispatch).length });
  check('the spent round stays spent', getGoal(db, goalId).rounds_used === 2, { roundsUsed: getGoal(db, goalId).rounds_used });
}

// ---- the human closes the unknown, and service resumes ----------------------------------------
{
  const att = attemptsOf(db, uncertainDispatch).find((a) => a.state === 'SENT_UNKNOWN');
  const resolved = resolveUncertain(db, att.attempt_id, 'SENT_REJECTED', 'operator confirmed no turn started');
  check('a human resolution is recorded with its proof', resolved.state === 'SENT_REJECTED' && /^human: /.test(resolved.proof),
    { state: resolved.state, proof: resolved.proof });
  check('the dispatch is rejected, not settled', getDispatch(db, uncertainDispatch).state === 'rejected',
    { state: getDispatch(db, uncertainDispatch).state });

  const resumed = resumeAfterHuman(db, goalId);
  check('the goal returns to service once nothing is unresolved', resumed.state === 'running', { state: resumed.state });
  check('resume is now allowed', mayResume({ goalState: resumed.state, roundsLeft: 1, claimHeld: true }).allow === true, {});
}

// ---- round 3: the last round, then the budget stops it ----------------------------------------
{
  const adm = admitDispatch(db, { goalId, cwd: WS, clientRequestId: 'r3' });
  check('round 3 is admitted', adm.admitted === true, adm);
  const att = beginAttempt(db, adm.dispatchId, 'dsh:session/prompt');
  settleAttempt(db, att.attemptId, 'SENT_ACKED', mockAdapter().send(att));
  const dlv = recordDelivery(db, { dispatchId: adm.dispatchId, codexInstanceId: 'cx-joint', threadId: 'th-1', delivered: true });
  ackConsumption(db, dlv.delivery_id);
  settleDispatch(db, adm.dispatchId);
  check('the goal used all three rounds', getGoal(db, goalId).rounds_used === 3, { roundsUsed: getGoal(db, goalId).rounds_used });

  const over = admitDispatch(db, { goalId, cwd: WS, clientRequestId: 'r4' });
  check('a fourth round is refused at admission', over.admitted === false && over.reason === 'budget-exhausted', over);
  const gate = mayResume({ goalState: getGoal(db, goalId).state, roundsLeft: 0, claimHeld: true });
  check('resume is refused once the budget is gone', gate.allow === false && gate.reason === 'budget-exhausted', gate);
}

// ---- final invariants ------------------------------------------------------------------------
{
  const dispatches = db.prepare('SELECT * FROM dispatch WHERE goal_id = ?').all(goalId);
  const settled = dispatches.filter((d) => d.state === 'settled');
  const allConsumed = settled.every((d) => deliveriesOf(db, d.dispatch_id).every((x) => x.consumption === 'acked'));
  check('every settled dispatch was consumed, not merely delivered', allConsumed, { settled: settled.length });

  const open = db.prepare(`SELECT COUNT(*) AS n FROM attempt WHERE state IN ('INTENT','SENT_UNKNOWN')`).get().n;
  check('no attempt is left unresolved after the run', open === 0, { open });

  const g = getGoal(db, goalId);
  check('rounds used equals dispatches created', g.rounds_used === dispatches.length && g.rounds_used === 3,
    { roundsUsed: g.rounds_used, dispatches: dispatches.length });
  check('one rejected dispatch exists and it is the uncertain one',
    dispatches.filter((d) => d.state === 'rejected').map((d) => d.dispatch_id).join() === uncertainDispatch,
    { rejected: dispatches.filter((d) => d.state === 'rejected').map((d) => d.dispatch_id) });
  db.close();
}

console.log(JSON.stringify({ pass, fail, checks: out }, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
