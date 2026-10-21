#!/usr/bin/env node
// B3 acceptance: what survives a restart, and what a restart is allowed to do.
//
// The load-bearing claim is that "may have been sent" is a state the system can represent. Everything
// else here follows from it: no automatic retry, a resume gate that refuses, and a budget that stays
// spent because a lost reply is not a refund.
//
//   node tools/probes/ledger/b3-recovery.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDispatchLedger, createGoal, authorizeGoal, admitDispatch, beginAttempt, settleAttempt,
  settleDispatch, reconcile, recordDelivery, markDelivered, ackConsumption, mayResume, getGoal,
  getDispatch, attemptsOf, deliveriesOf } from './dispatch-store.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-recovery-'));
const out = [];
let pass = 0, fail = 0;
const check = (name, ok, detail) => { out.push({ name, ok, detail }); ok ? pass++ : fail++; };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// ---- an intent written before the call survives a restart as INTENT ---------------------------
{
  const file = path.join(dir, 'r1.db');
  let db = openDispatchLedger(file);
  createGoal(db, { goalId: 'g1', maxRounds: 3, allowedWorkspaces: ['D:\\ws'] });
  authorizeGoal(db, 'g1');
  const adm = admitDispatch(db, { goalId: 'g1', cwd: 'D:\\ws' });
  const att = beginAttempt(db, adm.dispatchId, 'dsh:session/prompt');
  db.close();                                        // the process dies here, before any reply

  db = openDispatchLedger(file);
  const a = attemptsOf(db, adm.dispatchId)[0];
  check('INTENT persists across a restart', a.state === 'INTENT' && a.attempt_id === att.attemptId, a);
  check('the round stays spent while the outcome is unknown', getGoal(db, 'g1').rounds_used === 1,
    { roundsUsed: getGoal(db, 'g1').rounds_used });
  db.close();
}

// ---- reconcile says "unknown", never "not sent", and never resends ----------------------------
{
  const file = path.join(dir, 'r2.db');
  let db = openDispatchLedger(file);
  createGoal(db, { goalId: 'g2', maxRounds: 3, allowedWorkspaces: ['D:\\ws'] });
  authorizeGoal(db, 'g2');
  const adm = admitDispatch(db, { goalId: 'g2', cwd: 'D:\\ws' });
  beginAttempt(db, adm.dispatchId, 'codex:thread/queue/add');
  db.close();

  db = openDispatchLedger(file);
  const before = attemptsOf(db, adm.dispatchId).length;
  const r = reconcile(db);
  const a = attemptsOf(db, adm.dispatchId)[0];
  check('reconcile turns INTENT into SENT_UNKNOWN', a.state === 'SENT_UNKNOWN' && r.uncertain.length === 1,
    { state: a.state, uncertain: r.uncertain.length });
  check('an uncertain dispatch is escalated, not retried', r.needsHuman === true && getGoal(db, 'g2').state === 'needs_human',
    { needsHuman: r.needsHuman, goalState: getGoal(db, 'g2').state });
  check('reconcile adds no second attempt', attemptsOf(db, adm.dispatchId).length === before,
    { before, after: attemptsOf(db, adm.dispatchId).length });
  const again = reconcile(db);
  check('reconcile is idempotent', again.uncertain.length === 0, { uncertain: again.uncertain.length });
  check('the dispatch is not silently settled or rejected', getDispatch(db, adm.dispatchId).state === 'admitted',
    { state: getDispatch(db, adm.dispatchId).state });
  db.close();
}

// ---- the resume gate: every refusal, and the one path that is allowed -------------------------
{
  const allow = { goalState: 'running', roundsLeft: 1, uncertain: 0, stopActive: false, claimHeld: true };
  check('resume is allowed only when every condition holds', mayResume(allow).allow === true, mayResume(allow));
  check('a stop state blocks resume', mayResume({ ...allow, stopActive: true }).reason === 'stop-active',
    mayResume({ ...allow, stopActive: true }));
  check('an unheld claim blocks resume', mayResume({ ...allow, claimHeld: false }).reason === 'no-single-executor-claim',
    mayResume({ ...allow, claimHeld: false }));
  check('an uncertain attempt blocks resume', mayResume({ ...allow, uncertain: 1 }).reason === 'uncertain-attempt-needs-human',
    mayResume({ ...allow, uncertain: 1 }));
  check('an exhausted budget blocks resume', mayResume({ ...allow, roundsLeft: 0 }).reason === 'budget-exhausted',
    mayResume({ ...allow, roundsLeft: 0 }));
  check('a goal that needs a human cannot be resumed on its own',
    mayResume({ ...allow, goalState: 'needs_human' }).reason === 'goal-not-authorized',
    mayResume({ ...allow, goalState: 'needs_human' }));
}

// ---- delivered is not consumed ---------------------------------------------------------------
{
  const db = openDispatchLedger(path.join(dir, 'r4.db'));
  createGoal(db, { goalId: 'g4', maxRounds: 2, allowedWorkspaces: ['D:\\ws'] });
  authorizeGoal(db, 'g4');
  const adm = admitDispatch(db, { goalId: 'g4', cwd: 'D:\\ws' });
  const d = recordDelivery(db, { dispatchId: adm.dispatchId, codexInstanceId: 'cx-1', threadId: 'th-1', delivered: true });
  check('a delivered item is still unseen', d.state === 'delivered' && d.consumption === 'unseen',
    { state: d.state, consumption: d.consumption });
  const err = throws(() => ackConsumption(db, recordDelivery(db, { dispatchId: adm.dispatchId, codexInstanceId: 'cx-1', threadId: 'th-1' }).delivery_id));
  check('consumption cannot be acked before delivery', err !== null, { error: err });
  const acked = ackConsumption(db, d.delivery_id);
  check('consumption is its own fact, recorded after delivery', acked.consumption === 'acked', { consumption: acked.consumption });
  check('delivery and consumption stay separate columns', Object.hasOwn(d, 'consumption') && acked.state === 'delivered',
    { deliveredState: acked.state });
  db.close();
}

// ---- illegal transitions are refused, not repaired -------------------------------------------
{
  const db = openDispatchLedger(path.join(dir, 'r5.db'));
  createGoal(db, { goalId: 'g5', maxRounds: 2, allowedWorkspaces: ['D:\\ws'] });
  authorizeGoal(db, 'g5');
  const adm = admitDispatch(db, { goalId: 'g5', cwd: 'D:\\ws' });

  check('a dispatch cannot settle before anything was submitted',
    throws(() => settleDispatch(db, adm.dispatchId)) !== null, { state: getDispatch(db, adm.dispatchId).state });

  const att = beginAttempt(db, adm.dispatchId, 'dsh:session/prompt');
  settleAttempt(db, att.attemptId, 'SENT_ACKED', { remoteRef: 'req-1' });
  check('the first attempt settles once', attemptsOf(db, adm.dispatchId)[0].state === 'SENT_ACKED',
    { state: attemptsOf(db, adm.dispatchId)[0].state });
  check('a settled attempt cannot be overwritten',
    throws(() => settleAttempt(db, att.attemptId, 'SENT_REJECTED')) !== null, { attempts: attemptsOf(db, adm.dispatchId).length });
  check('a submitted dispatch settles', settleDispatch(db, adm.dispatchId).state === 'settled', { state: getDispatch(db, adm.dispatchId).state });
  db.close();
}

// ---- a rejected attempt rejects the dispatch, and the budget is not refunded ------------------
{
  const db = openDispatchLedger(path.join(dir, 'r6.db'));
  createGoal(db, { goalId: 'g6', maxRounds: 2, allowedWorkspaces: ['D:\\ws'] });
  authorizeGoal(db, 'g6');
  const adm = admitDispatch(db, { goalId: 'g6', cwd: 'D:\\ws' });
  const att = beginAttempt(db, adm.dispatchId, 'dsh:session/prompt');
  settleAttempt(db, att.attemptId, 'SENT_REJECTED', { proof: 'sandbox refused' });
  check('a rejected send rejects the dispatch', getDispatch(db, adm.dispatchId).state === 'rejected',
    { state: getDispatch(db, adm.dispatchId).state });
  check('a rejected round is not refunded', getGoal(db, 'g6').rounds_used === 1, { roundsUsed: getGoal(db, 'g6').rounds_used });
  check('a rejected dispatch has no delivery', deliveriesOf(db, adm.dispatchId).length === 0,
    { deliveries: deliveriesOf(db, adm.dispatchId).length });
  db.close();
}

console.log(JSON.stringify({ pass, fail, checks: out }, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
