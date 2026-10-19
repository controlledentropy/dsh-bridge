// The session ledger. It is the only place a dispatched round's handle exists - dsh cannot list a
// session's rounds back to us, so a lost write costs more than any error we are willing to print.
//
// Concurrent writers are the normal case here, not an edge: one MCP client conversation spawns many
// short-lived bridge processes that share a single state directory. The old code took an O_EXCL lock and,
// if it could not get it within the deadline, wrote anyway and logged a line - last rename wins, and a
// round could vanish with no signal. This store keeps the lock (so ordinary traffic stays serialised) but
// adds the part that actually makes it safe: **confirm the write by reading it back, and retry from fresh
// content**. A mutation that cannot be confirmed raises a typed error carrying the handle, because
// "dispatched but unrecorded" must reach the caller rather than becoming a quiet success.
import fs from 'node:fs';

export class LedgerUnconfirmed extends Error {
  constructor(detail) {
    const r = detail?.round || detail?.expected?.[detail?.alias];
    super(`ledger write for "${detail?.alias}" (${detail?.label}) was not confirmed after ${detail?.attempts} attempt(s): another process is writing the same file. `
      + `${detail?.requestId ? `The round was dispatched - adopt it manually with requestId ${detail.requestId}. ` : ''}${detail?.error || ''}`);
    this.name = 'LedgerUnconfirmed';
    this.detail = detail;
  }
}

// Pure: append a round exactly once. Re-running it after a detected lost update must not double-append,
// and dsh dedupes a repeated requestId server-side anyway, so the requestId is the identity.
export function pushRound(ledger, alias, round) {
  const s = ledger[alias] || (ledger[alias] = { rounds: [] });
  s.rounds = s.rounds || [];
  if (!s.rounds.some((r) => r && r.requestId && r.requestId === round.requestId)) s.rounds.push(round);
  return s.rounds;
}

export function createLedgerStore({ file, fsImpl = fs, pid = process.pid, sleep = () => Promise.resolve(),
  lockStaleMs = 15000, lockDeadlineMs = 8000, retries = 3, pollMs = 120, onEvent = () => {} } = {}) {
  let writes = 0;
  const readText = () => { try { return fsImpl.readFileSync(file, 'utf8'); } catch { return ''; } };
  const parse = (t) => { if (!t) return {}; try { return JSON.parse(t); } catch { onEvent({ ev: 'ledger-unparsable', bytes: t.length }); return {}; } };
  const read = () => parse(readText());

  // O_EXCL is the lock. A holder older than lockStaleMs is treated as dead (a crashed bridge would
  // otherwise freeze every later one), and a lock we never took does not get removed.
  async function acquire() {
    const lock = file + '.lock';
    const deadline = Date.now() + lockDeadlineMs;
    for (;;) {
      try { const fd = fsImpl.openSync(lock, 'wx'); try { fsImpl.writeSync(fd, String(pid)); } finally { fsImpl.closeSync(fd); } return lock; }
      catch (e) {
        if (e.code !== 'EEXIST') return null;
        let age = Infinity;
        try { age = Date.now() - fsImpl.statSync(lock).mtimeMs; } catch { return null; }
        if (age > lockStaleMs) { try { fsImpl.rmSync(lock, { force: true }); } catch {} continue; }
        if (Date.now() >= deadline) { onEvent({ ev: 'ledger-lock-timeout', pid, ageMs: Math.round(age) }); return null; }
        await sleep(pollMs);
      }
    }
  }
  const release = (lock) => { if (lock) { try { fsImpl.rmSync(lock, { force: true }); } catch {} } };

  function commit(text) {
    writes++;
    const tmp = `${file}.${pid}.${Date.now().toString(36)}.${writes}.tmp`;   // per-process + per-attempt: no two writers share it
    fsImpl.writeFileSync(tmp, text);
    fsImpl.renameSync(tmp, file);                                           // atomic: a reader never sees a half file
    try { fsImpl.rmSync(tmp, { force: true }); } catch {}
  }

  async function transact(mutate, { label = 'write', alias = null, requestId = null } = {}) {
    let last = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const lock = await acquire();
      let text;
      try {
        const before = read();
        const next = structuredClone(before);
        mutate(next);
        text = JSON.stringify(next, null, 2);
        commit(text);
      } finally { release(lock); }
      // Verified after releasing: while we hold the lock nothing else can write, so the only way the file
      // differs from what we committed is a writer that ignored the lock - the case this is designed for.
      const back = readText();
      if (back === text) return parse(text);
      onEvent({ ev: 'ledger-verify-mismatch', attempt, alias, label });
      last = { attempts: attempt, alias, label, requestId, expected: parse(text), actual: parse(back) };
      await sleep(pollMs * attempt);
    }
    throw new LedgerUnconfirmed({ ...(last || { attempts: retries, alias, label, requestId }), error: 'content diverged on every attempt' });
  }

  return { read, transact, file };
}
