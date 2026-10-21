#!/usr/bin/env node
// Child process used by the B4 acceptance to create the two situations a single-process test cannot:
// two writers racing for one budget slot, and a writer that dies between BEGIN and COMMIT.
//
//   node worker.mjs admit <db> <goalId> <cwd> <clientRequestId>
//   node worker.mjs crash-mid-tx <db> <goalId> <cwd>
import { DatabaseSync } from 'node:sqlite';
import { openDispatchLedger, admitDispatch } from './dispatch-store.mjs';

const [mode, file, goalId, cwd, requestId] = process.argv.slice(2);
if (!mode || !file || !goalId || !cwd) {
  console.error('usage: worker.mjs <admit|crash-mid-tx> <db> <goalId> <cwd> [clientRequestId]');
  process.exit(2);
}

if (mode === 'admit') {
  const db = openDispatchLedger(file);
  const r = admitDispatch(db, { goalId, cwd, clientRequestId: requestId || null });
  process.stdout.write(JSON.stringify(r));
  db.close();
  process.exit(0);
}

if (mode === 'crash-mid-tx') {
  // Deliberately not through admitDispatch: this must commit the debit and *not* the dispatch, which
  // is the one state the single-transaction rule forbids. If the ledger can be made to show it, the
  // rule is only a convention.
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE goal SET rounds_used = rounds_used + 1 WHERE goal_id = ?').run(goalId);
  db.prepare(`INSERT INTO dispatch (dispatch_id, goal_id, task_id, topic_id, client_request_id, cwd, state, created_at)
              VALUES ('dsp-crashed', ?, NULL, NULL, NULL, ?, 'admitted', '1970-01-01T00:00:00.000Z')`).run(goalId, cwd);
  process.exit(7);           // no COMMIT, no close: the process is gone mid-transaction
}

console.error('unknown mode ' + mode);
process.exit(2);
