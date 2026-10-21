#!/usr/bin/env node
// B4 acceptance: two writers, one budget slot - and a writer that dies holding the write lock.
//
// Each case is a separate OS process, because the property under test is about transactions and
// contention, and an in-process test would share the connection that is supposed to be the point.
//
//   node tools/probes/ledger/b4-concurrency.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDispatchLedger, createGoal, authorizeGoal, admitDispatch, getGoal, getDispatch } from './dispatch-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'worker.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b4-concurrency-'));
const out = [];
let pass = 0, fail = 0;
const check = (name, ok, detail) => { out.push({ name, ok, detail }); ok ? pass++ : fail++; };

const run = (args) => new Promise((resolve) => {
  const cp = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  cp.stdout.on('data', (d) => { stdout += d; });
  cp.stderr.on('data', (d) => { stderr += d; });
  cp.on('close', (code) => {
    let json = null;
    try { json = JSON.parse(stdout); } catch {}
    resolve({ code, json, stdout, stderr });
  });
});

const countDispatches = (db, goalId) =>
  db.prepare('SELECT COUNT(*) AS n FROM dispatch WHERE goal_id = ?').get(goalId).n;

// ---- five processes race for one round: exactly one may spend it ------------------------------
{
  const file = path.join(dir, 'c1.db');
  const db = openDispatchLedger(file);
  createGoal(db, { goalId: 'g1', maxRounds: 1, allowedWorkspaces: ['D:\\ws'] });
  authorizeGoal(db, 'g1');
  db.close();

  const results = await Promise.all([1, 2, 3, 4, 5].map((i) =>
    run(['admit', file, 'g1', 'D:\\ws', 'req-' + i])));
  const admitted = results.filter((r) => r.json && r.json.admitted === true);
  const refused = results.filter((r) => r.json && r.json.admitted === false);

  check('exactly one of five racers is admitted', admitted.length === 1 && refused.length === 4,
    { admitted: admitted.length, refused: refused.length, errors: results.filter((r) => !r.json).map((r) => r.stderr.trim()) });

  const db2 = openDispatchLedger(file);
  const g = getGoal(db2, 'g1');
  check('the budget reflects one spend, not five', g.rounds_used === 1, { roundsUsed: g.rounds_used });
  check('one dispatch row exists', countDispatches(db2, 'g1') === 1, { dispatches: countDispatches(db2, 'g1') });
  check('the losers were refused for budget, not silently dropped',
    refused.every((r) => r.json.reason === 'budget-exhausted'), refused.map((r) => r.json.reason));
  db2.close();
}

// ---- a retried client request id spends nothing extra ----------------------------------------
{
  const file = path.join(dir, 'c2.db');
  const db = openDispatchLedger(file);
  createGoal(db, { goalId: 'g2', maxRounds: 3, allowedWorkspaces: ['D:\\ws'] });
  authorizeGoal(db, 'g2');
  db.close();

  const first = await run(['admit', file, 'g2', 'D:\\ws', 'same-request']);
  const second = await run(['admit', file, 'g2', 'D:\\ws', 'same-request']);

  check('the first request is admitted', first.json.admitted === true, first.json);
  check('the retry is recognised as the same dispatch',
    second.json.admitted === false && second.json.duplicate === true && second.json.dispatchId === first.json.dispatchId,
    second.json);

  const db2 = openDispatchLedger(file);
  check('a retry spends no second round', getGoal(db2, 'g2').rounds_used === 1, { roundsUsed: getGoal(db2, 'g2').rounds_used });
  check('a retry creates no second dispatch', countDispatches(db2, 'g2') === 1, { dispatches: countDispatches(db2, 'g2') });
  db2.close();
}

// ---- a process that dies between BEGIN and COMMIT leaves nothing ---------------------------------
{
  const file = path.join(dir, 'c3.db');
  const db = openDispatchLedger(file);
  createGoal(db, { goalId: 'g3', maxRounds: 2, allowedWorkspaces: ['D:\\ws'] });
  authorizeGoal(db, 'g3');
  db.close();

  const crashed = await run(['crash-mid-tx', file, 'g3', 'D:\\ws']);
  check('the writer died inside its transaction', crashed.code === 7, { code: crashed.code });
  check('it wrote no dispatch and printed nothing', crashed.stdout === '', { stdout: crashed.stdout });

  const db2 = openDispatchLedger(file);
  check('no partial dispatch survived', getDispatch(db2, 'dsp-crashed') === undefined,
    { found: getDispatch(db2, 'dsp-crashed') });
  check('no round was debited by the dead writer', getGoal(db2, 'g3').rounds_used === 0,
    { roundsUsed: getGoal(db2, 'g3').rounds_used });
  db2.close();
}

// ---- six racers, three rounds: the invariant is budget == dispatches --------------------------
{
  const file = path.join(dir, 'c4.db');
  const db = openDispatchLedger(file);
  createGoal(db, { goalId: 'g4', maxRounds: 3, allowedWorkspaces: ['D:\\ws'] });
  authorizeGoal(db, 'g4');
  db.close();

  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) =>
    run(['admit', file, 'g4', 'D:\\ws', 'r-' + i])));
  const admitted = results.filter((r) => r.json && r.json.admitted === true);

  check('three of six racers are admitted', admitted.length === 3, { admitted: admitted.length });
  const db2 = openDispatchLedger(file);
  const g = getGoal(db2, 'g4');
  check('rounds used equals dispatches created', g.rounds_used === countDispatches(db2, 'g4') && g.rounds_used === 3,
    { roundsUsed: g.rounds_used, dispatches: countDispatches(db2, 'g4') });
  check('a spent goal is not still authorized', g.state === 'running', { state: g.state });
  db2.close();
}

// ---- the seventh request against a finished budget is refused, not queued ---------------------
{
  const file = path.join(dir, 'c5.db');
  const db = openDispatchLedger(file);
  createGoal(db, { goalId: 'g5', maxRounds: 1, allowedWorkspaces: ['D:\\ws'] });
  authorizeGoal(db, 'g5');
  admitDispatch(db, { goalId: 'g5', cwd: 'D:\\ws', clientRequestId: 'only' });
  const r = admitDispatch(db, { goalId: 'g5', cwd: 'D:\\ws', clientRequestId: 'second' });
  check('the over-budget request is refused at admission', r.admitted === false && r.reason === 'budget-exhausted', r);
  check('nothing was written for the refused request', countDispatches(db, 'g5') === 1, { dispatches: countDispatches(db, 'g5') });
  db.close();
}

console.log(JSON.stringify({ pass, fail, checks: out }, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
