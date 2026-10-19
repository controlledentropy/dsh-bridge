// Alias hygiene. Aliases are free-form and the bridge happily holds several pointing at sibling
// checkouts of the same piece of work, which is how a real round got lost: a task refused under one cwd
// was re-dispatched under a second alias, both stayed live, and an orchestrator alternating between them
// produced two half-executed histories. Nothing in the bridge could see that relationship.
//
// These are pure functions over the ledger, so the rule is testable without dsh: siblings are only ever
// reported as warnings (legitimate reuse of one cwd across phases is the common case), and `supersedes`
// makes a handover explicit instead of implicit.

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const MIN_TASK_OVERLAP = 60;          // a whole short paragraph of identical brief is not coincidence

export function commonPrefixLength(a, b) {
  const x = norm(a); const y = norm(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

// Find ledger aliases that look like another session working on the same thing under a different name.
// Reasons are stated so the caller can decide, not so the bridge can refuse.
export function findSiblings(ledger, { alias, cwd, phase, task }) {
  const mine = norm(cwd);
  const myPhase = norm(phase);
  const out = [];
  for (const [other, s] of Object.entries(ledger || {})) {
    if (other === alias) continue;
    const otherCwd = norm(s?.cwd);
    if (otherCwd === mine || otherCwd.startsWith(mine + '\\') || mine.startsWith(otherCwd + '\\')) continue;
    const reasons = [];
    if (myPhase && norm(s?.phase) === myPhase) reasons.push('same phase');
    const overlap = Math.max(0, ...(s?.rounds || []).map((r) => commonPrefixLength(task, r?.task)));
    if (overlap >= MIN_TASK_OVERLAP) reasons.push(`task text matches ${overlap} chars`);
    if (reasons.length) out.push({ alias: other, sessionId: s?.sessionId ?? null, cwd: s?.cwd ?? null,
      phase: s?.phase ?? null, reasons, supersededBy: s?.supersededBy ?? null });
  }
  return out;
}

// Mark a replacement explicitly: the new alias records what it takes over, the old one records that it
// has been taken over - and a later dsh_send into the old alias can then say so out loud.
export function applySupersedes(ledger, newAlias, oldAlias) {
  if (!oldAlias || oldAlias === newAlias) return;
  if (!ledger[oldAlias]) throw new Error(`supersedes "${oldAlias}" is not in the ledger`);
  ledger[oldAlias].supersededBy = newAlias;
  ledger[newAlias] = { ...(ledger[newAlias] || {}), supersedes: oldAlias };
}
