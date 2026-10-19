// Offline contract tests: they pin the measured dsh /api wire format and the pure bridge logic, and
// need no running dsh, no network and no model quota. Run with `npm test`.
//
// These are the assertions that break first after a dsh upgrade, which is the point: a failing test
// here means the contract moved, not that the environment is unhealthy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARGS, envelope, authCookie, pastCursor, parseAllowlist, allowedText, checkPolicy, splitModel,
  modelLabel, ALIAS_RE, checkAlias, checkCwd, normCwd, roundRecord, baselineFrom, interpret, argText,
  unwrapProjections, pathsOutsideCwd, pathFlavor, pageWindow, sliceRound, permissionHistory, approvalState,
  walkRound, verdictFields, humanWaits, modelEfforts, pickVerdict, capTexts, inFlightRound } from '../lib/api-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

test('envelope matches the measured POST /api body', () => {
  assert.deepEqual(envelope('session/list', { _request: {} }, 'rpc-1'),
    { type: 'client-request', rpcId: 'rpc-1', method: 'session/list', payload: { args: { _request: {} } } });
});

test('arg wrappers keep each endpoint\'s own (inconsistent) shape', () => {
  // MEASURED: session/list wants `_request`, most others want `request`, modelCatalog wants neither.
  assert.deepEqual(ARGS.sessionList(), { _request: {} });
  assert.deepEqual(ARGS.modelCatalog(), {});
  assert.deepEqual(ARGS.sessionCreate({ sessionId: 's', cwd: 'C:\\w' }), { request: { sessionId: 's', cwd: 'C:\\w' } });
  assert.deepEqual(ARGS.sessionCreate({ sessionId: 's', workspaceId: 'w1' }), { request: { sessionId: 's', workspaceId: 'w1' } });
  assert.deepEqual(ARGS.sessionCreate({ sessionId: 's', cwd: 'C:\\w', workspaceId: 'w1' }),
    { request: { sessionId: 's', workspaceId: 'w1' } }, 'workspaceId wins: it is what decides the sidebar group');
  assert.deepEqual(ARGS.sessionPrompt({ requestId: 'r', sessionId: 's', text: 'hi' }),
    { request: { requestId: 'r', sessionId: 's', mode: 'queue', content: [{ type: 'text', text: 'hi' }] } });
  assert.deepEqual(ARGS.sessionPage({ sessionId: 's', throughSeq: 9, maxMessages: 3 }),
    { request: { address: { kind: 'session', sessionId: 's' }, throughSeq: 9, maxMessages: 3 } });
  assert.deepEqual(ARGS.sessionSelectModel({ sessionId: 's', provider: 'p', model: 'm', reasoningEffort: '' }),
    { request: { sessionId: 's', provider: 'p', model: 'm' } });
  assert.deepEqual(ARGS.sessionCancel('s'), { request: { sessionId: 's' } });
  assert.deepEqual(ARGS.workspaceCreate('C:\\w'), { request: { path: 'C:\\w' } });
});

test('authCookie picks only the owner cookie and drops attributes', () => {
  assert.equal(authCookie(['other=1; Path=/']), null);
  assert.equal(authCookie(['sid=2; Path=/', 'dsh-auth-YWJj..sig; HttpOnly; SameSite=Lax']), 'dsh-auth-YWJj..sig');
});

test('pastCursor recovers the real cursor from session/page', () => {
  assert.equal(pastCursor('page/past-cursor: past cursor 41'), 41);
  assert.equal(pastCursor('page/blank'), null);
  assert.equal(pastCursor(undefined), null);
});

test('allowlist: empty means unrestricted, a typo means a hard failure', () => {
  assert.equal(parseAllowlist(''), null);
  assert.equal(parseAllowlist('   '), null);
  assert.deepEqual(parseAllowlist('deepseek-account/deepseek-flash'),
    [{ provider: 'deepseek-account', model: 'deepseek-flash', efforts: null }]);
  assert.deepEqual(parseAllowlist('a/b:low|high,c/d').map((r) => r.efforts), [['low', 'high'], null]);
  assert.equal(allowedText([{ provider: 'a', model: 'b', efforts: ['low'] }]), 'a/b:low');
  for (const bad of ['a/b:', ',', ':', 'a/b:|']) assert.throws(() => parseAllowlist(bad), /does not parse/, `"${bad}" must not degrade into a deny-all`);
});

test('splitModel tolerates a missing or doubled slash', () => {
  assert.deepEqual(splitModel('a/b/c'), { provider: 'a', model: 'b/c' });
  assert.deepEqual(splitModel('b'), { provider: '', model: 'b' });
  assert.deepEqual(splitModel('a/'), { provider: 'a', model: '' });
});

test('modelLabel renders selectModel objects and projection strings alike', () => {
  assert.equal(modelLabel({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }), 'deepseek-account/deepseek-flash:max');
  assert.equal(modelLabel({ provider: 'p', model: 'm' }), 'p/m');
  assert.equal(modelLabel('deepseek-account/deepseek-flash'), 'deepseek-account/deepseek-flash');
  assert.equal(modelLabel(null), null, 'no model must read as null, never "[object Object]" or ""');
});

test('checkPolicy refuses the model and the effort separately', () => {
  const allow = parseAllowlist('deepseek-account/deepseek-flash:low|high');
  assert.equal(checkPolicy(null, 'anything', 'at-all', 'max'), null, 'unrestricted allows everything');
  assert.equal(checkPolicy(allow, 'deepseek-account', 'deepseek-flash', 'low'), null);
  assert.match(checkPolicy(allow, 'deepseek-account', 'deepseek-flash', 'max'), /effort "max"/);
  assert.match(checkPolicy(allow, 'deepseek-account', 'deepseek-v4-pro', null), /not permitted by DSH_ALLOWED_MODELS/);
  assert.equal(checkPolicy(allow, 'deepseek-account', 'deepseek-flash', null), null, 'omitted effort is allowed');
});

test('alias is a safe session id and ledger key', () => {
  assert.ok(ALIAS_RE.test('p1-recon') && ALIAS_RE.test('a') && ALIAS_RE.test('A.b_c-1'));
  for (const bad of ['', '-lead', '.lead', 'has space', 'a'.repeat(65), '../etc', 'a\\b', 'a/b']) {
    assert.throws(() => checkAlias(bad), /must match/, `"${bad}" must be rejected`);
  }
});

test('checkCwd canonicalises, requires absolute, requires existing', () => {
  assert.throws(() => checkCwd('relative/dir'), /must be absolute/);
  assert.throws(() => checkCwd(path.join(PKG, 'definitely-not-here')), /does not exist/);
  const fixed = checkCwd(PKG + path.sep);
  assert.ok(!/[\\/]$/.test(fixed), 'trailing separator stripped');
  if (process.platform === 'win32') {
    assert.equal(checkCwd(PKG.replace(/\\/g, '/')), PKG.replace(/\\/g, '\\'), 'forward slashes become native, or adoption fails');
  }
});

test('normCwd makes the recorded-path comparison it does in dsh', () => {
  assert.equal(normCwd('C:/Users/X/probe'), normCwd('c:\\users\\x\\probe\\\\'), 'slashes, case and a trailing separator all compare equal');
  assert.equal(normCwd('C:\\'), 'c:\\', 'a drive root keeps its separator instead of collapsing to "c:"');
  assert.notEqual(normCwd('C:/a'), normCwd('C:/ab'));
  assert.equal(normCwd(''), '');
});

test('baselineFrom correlates a round to its own requestId', () => {
  // preSeq is session/projections asOfSeq read *before* dispatch, so this round starts at preSeq+1.
  const events = [{ seq: 10, type: 'user/message', data: { requestId: 'r1' } }, { seq: 12, type: 'turn/end' }];
  assert.deepEqual(baselineFrom(9, events, 'r1'), { sinceSeq: 9, correlated: true });
  const interleaved = [{ seq: 10, type: 'assistant/message', data: {} }, { seq: 11, type: 'user/message', data: { requestId: 'r1' } }, { seq: 12, type: 'turn/end' }];
  assert.deepEqual(baselineFrom(9, interleaved, 'r1'), { sinceSeq: 10, correlated: true },
    'the event another writer slipped in at seq 10 is excluded from this round');
  assert.deepEqual(baselineFrom(10, events, 'r1'), { sinceSeq: 10, correlated: false },
    'an event at or before the pre-dispatch cursor predates the round, even if it names the requestId');
  assert.deepEqual(baselineFrom(9, events, 'other-round'), { sinceSeq: 9, correlated: false });
  assert.deepEqual(baselineFrom(9, [], 'r1'), { sinceSeq: 9, correlated: false });
});

test('interpret reports the four states and nothing optimistic', () => {
  const done = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'DONE' }] } } },
    { type: 'tool/call', data: { name: 'write', turn: 1, arguments: '{"path":"a.txt"}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '<path>a.txt</path>' }] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } }];
  const r = interpret(done, false);
  assert.equal(r.state, 'completed');
  assert.equal(r.settled, true);
  assert.equal(r.lastAssistantText, 'DONE');
  assert.deepEqual(r.touchedFiles, ['a.txt'], 'files are lifted out of tool results; workspace/changes only carries {turn}');
  assert.equal(r.toolErrorCount, 0);
  assert.equal(r.error, null);

  const failed = [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'UNKNOWN_MODEL', message: 'no configured model' } } } }];
  assert.equal(interpret(failed, false).state, 'error');
  assert.equal(interpret(failed, false).error.code, 'UNKNOWN_MODEL');

  assert.equal(interpret([], false).state, 'idle', 'a session that is not running is idle, never "completed"');
  assert.equal(interpret([], true).state, 'running');
  assert.equal(interpret([], null).state, 'running', 'unknown live status must not read as idle');
  assert.equal(interpret([{ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'boom' }], isError: true } } }], true).toolErrorCount, 1);
});

test('argText un-doubles JSON-encoded tool arguments', () => {
  assert.equal(argText('{"path":"a.txt"}'), '{"path":"a.txt"}');
  assert.equal(argText('"{\\"path\\":\\"a.txt\\"}"'), '{"path":"a.txt"}');
  assert.equal(argText({ path: 'a.txt' }), '{"path":"a.txt"}');
  assert.equal(argText(null), '');
  assert.equal(argText('not json'), 'not json');
});

test('roundRecord persists the handle, never the audit payload', () => {
  const rec = roundRecord({ requestId: 'r1', sinceSeq: 9, correlated: true, dispatchedAt: 't', state: 'completed', lastAssistantText: 'x'.repeat(999) }, 'p/m');
  assert.deepEqual(rec, { requestId: 'r1', sinceSeq: 9, correlated: true, dispatchedAt: 't', outcome: 'completed', pinned: 'p/m' });
  assert.equal(roundRecord({ requestId: 'r' }, undefined).pinned, null);
});

// Regression for the 2026-10-18 incident: the bridge reported "3 tool errors" with no bodies and
// null permissions, so the caller could not tell a sandbox denial from a tool bug.
test('unwrapProjections lifts the nested values envelope (as dsh actually answers)', () => {
  // MEASURED shape of session/projections: kind + asOfSeq at the top, everything else under values.
  const wire = { kind: 'session', asOfSeq: 206, values: {
    permissions: { currentValue: 'workspace-write' }, agentPreset: 'ptc',
    workingDirectory: 'D:\\repo\\research', tokenUsage: { outputTokens: 18280 },
    modelSelection: { lastUsed: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' } },
    userQuestions: { active: [], settled: [] }, plan: { active: false, pending: false } } };
  const p = unwrapProjections(wire);
  assert.equal(p.asOfSeq, 206, 'cursor stays readable after unwrapping');
  assert.equal(p.permissions.currentValue, 'workspace-write');
  assert.equal(p.agentPreset, 'ptc');
  assert.equal(p.tokenUsage.outputTokens, 18280);
  assert.equal(modelLabel(p.modelSelection.lastUsed), 'workbuddy/deepseek-v4.1-flash:max');
  assert.deepEqual(unwrapProjections({ a: 1 }), { a: 1 }, 'a flat payload still passes through');
  assert.equal(unwrapProjections(null), null);
});

test('interpret hands back the failing tool bodies, not just a count', () => {
  // MEASURED shapes: tool/call carries {turn,step,callId,name,arguments}; tool/result carries
  // {turn,step,message,isError,error{name,code}} and NO name - so they must be joined on (turn,step).
  const events = [
    { seq: 127, type: 'tool/call', data: { turn: 1, step: 12, callId: 'call_a', name: 'run_code', arguments: '{"code":"import x"}' } },
    { seq: 137, type: 'tool/result', data: { turn: 1, step: 12, error: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' }, message: { isError: true, content: [{ type: 'text', text: "Error: code run failed (exception): 'import', and 'export' cannot be used outside of module code File sandbox: workspace-write." }] } } },
    { seq: 138, type: 'tool/call', data: { turn: 1, step: 13, callId: 'call_b', name: 'run_code', arguments: '{}' } },
    { seq: 147, type: 'tool/result', data: { turn: 1, step: 13, error: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' }, message: { isError: true, content: [{ type: 'text', text: 'Error: EPERM: operation not permitted, open \'C:\\Users\\x\\AppData\\Local\\Temp\\rc-1.out\'' }] } } },
    { seq: 150, type: 'tool/result', data: { turn: 1, step: 14, message: { content: [{ type: 'text', text: 'ok' }] } } },
    { seq: 151, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
  const r = interpret(events, false);
  assert.equal(r.toolErrorCount, 2);
  assert.equal(r.sandboxDenials, 1, 'only the EPERM body is a denial; the SyntaxError merely carries the sandbox footnote');
  assert.deepEqual(r.toolErrors.map((e) => e.seq), [137, 147]);
  assert.deepEqual(r.toolErrors.map((e) => e.name), ['run_code', 'run_code'], 'name is recovered from the matching tool/call');
  assert.deepEqual(r.toolErrors.map((e) => e.code), ['CODE_RUN_FAILED', 'CODE_RUN_FAILED']);
  assert.match(r.toolErrors[0].body, /cannot be used outside of module code/);
  assert.ok(r.toolErrors.every((e) => e.body.length <= 400), 'bodies are truncated, never dumped whole');
  // a clean round must report nothing
  const clean = interpret([{ seq: 2, type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'fine' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } }], false);
  assert.deepEqual(clean.toolErrors, []);
  assert.equal(clean.sandboxDenials, 0);
});

test('pathsOutsideCwd blocks writes outside the workspace and only those', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cwd-test-'));
  const WS = path.join(root, 'research');
  const TARGET = path.join(root, 'checkout-x');
  fs.mkdirSync(WS); fs.mkdirSync(TARGET);
  const tiers = (task, cwd) => pathsOutsideCwd(task, cwd);
  try {
    assert.deepEqual(tiers(`在 ${TARGET} 里实现并跑测试`, WS), { all: [TARGET], write: [TARGET], read: [] });
    assert.deepEqual(tiers(`把 "${TARGET}" 里的 docs/a.md 补测试`, WS), { all: [TARGET], write: [TARGET], read: [] }, 'a quoted path keeps its spaces');
    assert.deepEqual(tiers(`读取 ${path.join(WS, 'notes.md')} 后总结`, WS), { all: [], write: [], read: [] }, 'inside the workspace is never listed');
    assert.deepEqual(tiers('普通中文任务，没有路径', WS), { all: [], write: [], read: [] }, 'prose must not warn');
    assert.deepEqual(tiers('see https://www.unicode.org/reports/tr15/ for details', WS), { all: [], write: [], read: [] }, 'a URL is not a path');
    // The false positive that made the advisory ignorable: an unquoted Windows path containing a space
    // matches only its first token. "…\Program Files" is not a real directory, so it must be dropped.
    const withSpace = path.join(root, 'Program Files', 'nodejs');
    assert.deepEqual(tiers(`run ${withSpace}\\node.exe --version`, WS).all, [], 'a fragment cut at a space is not reported');
    fs.mkdirSync(withSpace, { recursive: true });
    assert.deepEqual(tiers(`run "${withSpace}\\node.exe" --version`, WS).all, [`${withSpace}\\node.exe`], 'the same path quoted is reported in full, as written');
    assert.deepEqual(tiers(`work in ${root}`, WS), { all: [], write: [], read: [] }, 'an ancestor of the workspace is not outside it');

    // The tiering is what makes the recommended shape usable: the ticket lives in the parent repo and
    // is read-only; the deliverable is written into the worktree. Refusing that was the reported defect.
    const TICKET = path.join(root, 'dispatch', '02f.md');
    const SKILL = path.join(root, 'skills', 'tdd', 'SKILL.md');
    fs.mkdirSync(path.dirname(TICKET), { recursive: true }); fs.writeFileSync(TICKET, 'x');
    fs.mkdirSync(path.dirname(SKILL), { recursive: true }); fs.writeFileSync(SKILL, 'x');
    const brief = `目标：修复 NFC。\n任务正文：${TICKET}（只读引用）\n技能约定 ${SKILL}\n边界：只允许改动 ${TARGET}\n验收：把结论写入 ${TARGET}\\report.md`;
    const t = tiers(brief, WS);
    assert.deepEqual(t.write, [TARGET], 'the write target alone is what the sandbox will deny');
    assert.deepEqual(t.read, [TICKET, SKILL], 'read-only references are advisory, not a refusal');
    // A read-only annotation *after* the path wins over an earlier verb, and a later verb must not
    // condemn an earlier path: this asymmetry is the whole classification.
    assert.deepEqual(tiers(`把 ${TARGET}\\a.md 的结论抄到 ${path.join(root, 'other', 'b.md')}，${TARGET} 只读`, WS).read,
      [TARGET], 'the annotation demotes the path it follows');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The gap this closes was documented as "未做的功能": the guard only recognised drive-letter paths, so on
// Linux/macOS a brief that writes outside the session refused nothing and the sandbox denied it a round
// later. These cases are pure - the existence probe is injected, so they run on any host.
test('pathsOutsideCwd understands posix absolute paths, not just drive letters', () => {
  const WS = '/home/me/ws';
  const nothingExists = () => false;
  const t = (task, cwd = WS) => pathsOutsideCwd(task, cwd, { exists: nothingExists });
  assert.equal(pathFlavor('/etc/x'), 'posix');
  assert.equal(pathFlavor('D:\\x'), 'win', 'a drive path is not a posix path');
  assert.equal(pathFlavor('relative/x'), '');

  assert.deepEqual(t('把结论写入 /etc/dsh/report.md').write, ['/etc/dsh/report.md'], 'a Chinese brief naming a posix write target is refused');
  assert.deepEqual(t('write the summary to /srv/out/report.md').write, ['/srv/out/report.md']);
  assert.deepEqual(t('把结论写入 "/srv/out/report.md"').all, ['/srv/out/report.md'], 'quoted works too');
  assert.deepEqual(t('edit /home/me/ws/report.md'), { all: [], write: [], read: [] }, 'inside the workspace is never listed');
  assert.deepEqual(t('write /home/me/ws-other/x.md').write, ['/home/me/ws-other/x.md'], 'a sibling directory sharing a prefix is outside');
  assert.deepEqual(t('任务正文：/srv/tickets/02f.md（只读引用）').read, ['/srv/tickets/02f.md'], 'the read-only tier still applies');
  assert.deepEqual(t('see https://www.unicode.org/reports/ for details'), { all: [], write: [], read: [] }, 'a URL is still not a path');
  assert.deepEqual(t('no paths at all, 全是中文').all, []);
  // A Windows brief handed to a posix session names nothing this guard can act on, and vice versa.
  assert.deepEqual(t('write D:\\tmp\\a.md'), { all: [], write: [], read: [] }, 'the other flavour is not scanned');
  assert.deepEqual(pathsOutsideCwd('把结论写入 /etc/x.md', 'D:\\work').all, [], 'a posix path under a Windows cwd is not a target');
  // The root cwd is the one case where "everything is inside it" is true.
  assert.deepEqual(t('/tmp/x.md', '/'), { all: [], write: [], read: [] }, 'nothing is outside /');
});

test('verdictFields never claims a verdict the round has not produced', () => {
  const running = { settled: false, state: 'running', turnStarted: true };
  const window = { sinceSeq: 4, newestSeq: 28, asOfSeq: 1084, truncated: true };
  // The reported defect: a still-running round whose log happened to be fully read must not report
  // verdictComplete:true just because nothing was truncated.
  const fully = { sinceSeq: 4, newestSeq: 28, asOfSeq: 28, truncated: false };
  assert.deepEqual(verdictFields(running, window), { windowTruncated: true, verdictComplete: false, turnStarted: true,
    note: 'no turn/end within seq 4..28 of 1084; state is not a verdict - re-read with dsh_result' });
  const still = verdictFields(running, fully);
  assert.equal(still.verdictComplete, false, 'running is running, whatever the window says');
  assert.equal(still.logExhausted, undefined, 'logExhausted is gone: for an unsettled round it was exactly !windowTruncated');
  // "The log is at its end and this round never started" is the unverified-dispatch case, told apart from
  // "still in flight" by whether dsh recorded a turn/start - not by a claim about the log's end.
  const idle = verdictFields({ settled: false, state: 'idle', turnStarted: false }, fully);
  assert.equal(idle.verdictComplete, false);
  assert.equal(idle.turnStarted, false);
  assert.match(idle.note, /dispatch was not picked up/);
  // The audit's worst reading: the round DID start and its turn/end sits one seq past the snapshot.
  const late = verdictFields({ settled: false, state: 'idle', turnStarted: true }, fully);
  assert.match(late.note, /this round started \(first event seq 4\)/);
  assert.doesNotMatch(late.note, /not picked up/);
  const done = verdictFields({ settled: true, state: 'completed', turnStarted: true }, fully);
  assert.deepEqual(done, { windowTruncated: false, verdictComplete: true }, 'a settled round gets no note and no qualifiers');
  assert.deepEqual(verdictFields({ settled: false, state: 'running' }, null),
    { windowTruncated: false, verdictComplete: false }, 'no window is never a verdict');
});

test('a failed page read is not reported as the end of the log', () => {
  // MEASURED shape: the catch in readRound hands back a degraded window, and the old idle branch printed
  // "the log ends at seq undefined" as a diagnosis - a false claim about dsh's log, with no action in it.
  const f = verdictFields({ settled: false, state: 'idle', turnStarted: false }, { sinceSeq: 4, truncated: false, readFailed: true });
  assert.equal(f.windowTruncated, false);
  assert.equal(f.verdictComplete, false);
  assert.match(f.note, /could not be read/);
  assert.doesNotMatch(f.note, /the log ends at seq/);
  assert.doesNotMatch(f.note, /undefined/);
});

test('sliceRound keeps a verdict inside its own round', () => {
  // MEASURED shape of the 2026-10-18 incident: round 1 aborted at seq 206, round 2 completed at 1444.
  // A window wide enough to reach the tail would otherwise hand round 2's "completed" to round 1.
  const events = [
    { seq: 7, type: 'turn/start', data: { turn: 1 } },
    { seq: 137, type: 'tool/result', data: { turn: 1, step: 12, message: { isError: true, content: [{ type: 'text', text: 'boom' }] } } },
    { seq: 206, type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    { seq: 213, type: 'turn/start', data: { turn: 2 } },
    { seq: 1444, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
  const sliced = sliceRound(events);
  assert.equal(sliced.length, 3, 'stops at the round\'s own turn/end');
  assert.equal(interpret(sliced, false).state, 'aborted');
  assert.equal(interpret(sliced, false).abortReason, 'user', 'an operator abort is distinguishable from dsh giving up');
  assert.equal(interpret(events, false).state, 'completed', 'unsliced, the next round decides - which is the bug');
  assert.deepEqual(sliceRound(events.slice(0, 2)).map((e) => e.seq), [7, 137], 'an unfinished round keeps every event');
});

test('pageWindow anchors a round at its baseline, not at the tail', () => {
  assert.deepEqual(pageWindow({ sinceSeq: 5, asOfSeq: 1444, maxMessages: 40 }), { throughSeq: 45, sinceSeq: 5, anchored: 'baseline' });
  assert.deepEqual(pageWindow({ sinceSeq: 5, asOfSeq: 20, maxMessages: 40 }), { throughSeq: 20, sinceSeq: 5, anchored: 'baseline' }, 'never pages past asOfSeq');
  assert.deepEqual(pageWindow({ sinceSeq: 0, asOfSeq: 1444, maxMessages: 12, anchored: 'tail' }), { throughSeq: 1444, sinceSeq: 1432, anchored: 'tail' });
  assert.deepEqual(pageWindow({ sinceSeq: -1, asOfSeq: 9, maxMessages: 1000 }).sinceSeq, -1, 'a negative baseline includes seq 0, where the first permission/preset lives');
  assert.equal(pageWindow({ sinceSeq: 0, asOfSeq: 0, maxMessages: 10 }).throughSeq, 0);
});

test('permissionHistory shows whether a human raised the sandbox mid-session', () => {
  // Real event data from the incident session.
  const events = [
    { seq: 0, type: 'permission/preset', data: { preset: 'workspace-write' } },
    { seq: 1, type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { seq: 2, type: 'approval/policy', data: { policy: 'ask' } },
    { seq: 207, type: 'command/run', data: { commandId: 'c1', name: 'permission', args: ' danger-full-access', source: { kind: 'user' } } },
    { seq: 208, type: 'permission/preset', data: { preset: 'danger-full-access' } },
    { seq: 209, type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
    { seq: 210, type: 'approval/policy', data: { policy: 'never' } },
    { seq: 212, type: 'command/done', data: {} }];
  const h = permissionHistory(events);
  assert.equal(h.firstPreset, 'workspace-write');
  assert.equal(h.lastPreset, 'danger-full-access');
  assert.equal(h.escalated, true, 'a round before the escalation is not comparable with one after it');
  assert.equal(h.escalatedBy, 'user');
  assert.deepEqual(h.commands.map((c) => c.command), ['permission danger-full-access'], 'command text is name+args, not a "line" field');
  assert.deepEqual(h.approvals.map((a) => a.policy), ['ask', 'never']);
  assert.deepEqual(h.modes.map((m) => m.mode), ['workspace-write', 'danger-full-access']);
  assert.equal(permissionHistory([{ seq: 0, type: 'permission/preset', data: { preset: 'workspace-write' } }]).escalated, false);
});

test('sandboxDenials counts denials, not every error dsh annotates', () => {
  // MEASURED: dsh appends "File sandbox: <mode>." to tool failures of any kind, so matching that
  // footnote counted 10 "denials" where only 1 was a denial.
  const err = (seq, text) => ({ seq, type: 'tool/result', data: { turn: 1, step: seq, message: { isError: true, content: [{ type: 'text', text }] } } });
  const events = [
    err(137, "Error: code run failed (exception): 'import', and 'export' cannot be used outside of module code File sandbox: workspace-write."),
    err(142, 'Error: ENOENT: no such file or directory, open \'C:\\w\\undefined\\temp\\rc-1.out\' File sandbox: workspace-write.'),
    err(147, 'Error: EPERM: operation not permitted, open \'C:\\Users\\x\\AppData\\Local\\Temp\\rc-2.out\' File sandbox: workspace-write.'),
    err(150, 'Error: [sandbox: file access denied under workspace-write mode] escalation available - retry with sandbox_permissions'),
    { seq: 151, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'X', message: 'm' } } } }];
  const r = interpret(events, false);
  assert.equal(r.toolErrorCount, 4);
  assert.equal(r.sandboxDenials, 2, 'only the EPERM and the explicit access-denied bodies are denials');
  assert.equal(r.state, 'error');
});

test('approvalState separates "working" from "waiting for a human"', () => {
  // MEASURED 2026-10-18: under approval policy "ask" a pwsh/git operation emits approval/asked and the
  // round just sits there. session/list still says running:true, so polling alone cannot tell an
  // unattended dispatch that it will never finish without somebody at the dsh UI.
  const events = [
    { seq: 2, type: 'approval/policy', data: { policy: 'ask' } },
    { seq: 651, type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh', callId: 'c1', reason: 'command  writes   outside the workspace' } },
    { seq: 652, type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } },
    { seq: 678, type: 'approval/asked', data: { id: 'a2', toolName: 'git', callId: 'c2', reason: 'push needs network' } },
    { seq: 679, type: 'approval/decided', data: { id: 'a2', outcome: 'cancelled' } },
    { seq: 702, type: 'approval/asked', data: { id: 'a3', toolName: 'pwsh', callId: 'c3', reason: 'rm -rf needs confirmation' } }];
  const a = approvalState(events);
  assert.equal(a.approvalPolicy, 'ask');
  assert.equal(a.approvalAsked, 3);
  assert.deepEqual(a.pending.map((p) => p.id), ['a3'], 'only the unanswered one blocks');
  assert.deepEqual(a.approvals.map((x) => x.outcome), ['allowed-once', 'cancelled', null]);
  assert.equal(a.approvals[0].reason, 'command writes outside the workspace', 'reason is normalised, not truncated mid-word');
  assert.equal(interpret(events, true).state, 'running', 'the log alone says "running" - that is the trap');
  assert.deepEqual(approvalState([{ seq: 2, type: 'approval/policy', data: { policy: 'never' } }]),
    { approvalPolicy: 'never', approvalAsked: 0, approvals: [], pending: [] }, 'a full-access session never blocks');
  assert.deepEqual(approvalState([{ seq: 9, type: 'approval/asked', data: { toolName: 'pwsh' } }]).pending.length, 1,
    'an ask with no id cannot be matched to a decision, so it stays pending');
  assert.deepEqual(approvalState([]).approvalPolicy, null);
});

test('walkRound pages to a verdict that one window cannot reach', () => {
  // The measured incident: baseline seq 4, verdict at 1084, log at 1445, next round's verdict at 1444.
  const log = [];
  for (let s = 5; s <= 1200; s++) log.push({ seq: s, type: 'step/start', data: { turn: 1, step: s } });
  log.push({ seq: 1084, type: 'turn/end', data: { reason: { kind: 'completed' } } });
  log.push({ seq: 1444, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'NEXT', message: 'a later round' } } } });
  log.sort((x, y) => x.seq - y.seq);
  const asOfSeq = 1445;
  const calls = [];
  const page = (cursor, n) => {
    const w = pageWindow({ sinceSeq: cursor, asOfSeq, maxMessages: n });
    const events = log.filter((e) => e.seq > w.sinceSeq && e.seq <= w.throughSeq);
    calls.push({ cursor, n, throughSeq: w.throughSeq });
    return { events, window: { ...w, asOfSeq, oldestSeq: events[0]?.seq ?? null,
      newestSeq: events[events.length - 1]?.seq ?? null, truncated: asOfSeq > w.throughSeq } };
  };

  // What the old single-window read did, kept as the regression it is.
  const oneShot = page(4, 1000);
  assert.equal(oneShot.window.throughSeq, 1004, 'a 1000-message window from the baseline stops short of seq 1084');
  assert.equal(interpret(oneShot.events, false).state, 'idle', 'and a completed round then reads as "nothing happened"');

  return walkRound(page, 4, { walk: true, first: 24 }).then((r) => {
    assert.equal(interpret(r.events, false).state, 'completed', 'the walk reaches the round\'s own verdict');
    assert.equal(r.events[r.events.length - 1].seq, 1084, 'and stops there - seq 1444 belongs to the next round');
    assert.equal(r.window.pages, 3);
    assert.equal(r.window.truncated, false);
    assert.equal(r.window.newestSeq, 1084);
    assert.ok(!('reachedLogEnd' in r.window) && !('logExhausted' in r.window),
      'the round was cut at 1084 while the log runs to 1445 - nothing here may claim the log ended');
    assert.deepEqual(calls.slice(1).map((c) => c.n), [24, 1000, 1000], 'polling stays cheap until a verdict is wanted');
  });
});

test('walkRound honours walk:false and the page cap', async () => {
  const log = [];
  for (let s = 1; s <= 5000; s++) log.push({ seq: s, type: 'step/start', data: {} });
  const asOfSeq = 5000;
  const page = (cursor, n) => {
    const w = pageWindow({ sinceSeq: cursor, asOfSeq, maxMessages: n });
    const events = log.filter((e) => e.seq > w.sinceSeq && e.seq <= w.throughSeq);
    return { events, window: { ...w, asOfSeq, oldestSeq: events[0]?.seq ?? null,
      newestSeq: events[events.length - 1]?.seq ?? null, truncated: asOfSeq > w.throughSeq } };
  };
  const cheap = await walkRound(page, 0, { walk: false, first: 24 });
  assert.equal(cheap.window.pages, 1, 'a poll reads one small page');
  assert.equal(cheap.window.newestSeq, 24);
  assert.equal(cheap.window.truncated, true, 'and says so, instead of implying a verdict');

  const capped = await walkRound(page, 0, { walk: true, first: 24, maxPages: 2 });
  assert.equal(capped.window.pages, 2, 'an unsettled round cannot page forever');
  assert.equal(capped.window.truncated, true);
  assert.equal(interpret(capped.events, false).state, 'idle', 'no turn/end means no verdict, whatever the flag says');
});

test('humanWaits sees the question wait that approvals do not', () => {
  // MEASURED shapes from a live ptc session: ask_user_question is not directly callable (UNKNOWN_TOOL),
  // run_code dispatches it, and the human wait is the gap between these two events.
  const start = { seq: 32, type: 'tool/ptc-dispatch-start', time: 1000, data: {
    rootCallId: 'c1', parentCallId: 'c1', subCallId: 'c1:ptc:1', name: 'ask_user_question',
    arguments: { questions: [{ id: 'probe_choice', header: '探针选择', question: '跑 A 还是 B？',
      options: [{ label: 'A（只读目录列表）' }, { label: 'B（跳过）' }] }] } } };
  const done = { seq: 33, type: 'tool/ptc-dispatch', time: 102000, data: { subCallId: 'c1:ptc:1', name: 'ask_user_question',
    isError: false, content: [{ type: 'text', text: '{"answers":[{"id":"probe_choice","selected":["A（只读目录列表）"]}]}' }] } };
  assert.deepEqual(humanWaits([start, done]).waitingOnHuman, false, 'answered question is not a wait');
  const open = humanWaits([start]);
  assert.equal(open.waitingOnHuman, true, 'unanswered question IS a wait, and approvals never show it');
  assert.equal(open.asked[0].questions[0].header, '探针选择', 'the note can name what is being asked');
  assert.deepEqual(open.asked[0].questions[0].options, ['A（只读目录列表）', 'B（跳过）']);
  // A long-running shell dispatch is work in progress, not a blocked round.
  assert.equal(humanWaits([{ seq: 5, type: 'tool/ptc-dispatch-start', data: { subCallId: 's:ptc:1', name: 'shell', arguments: {} } }]).waitingOnHuman, false);
  assert.equal(humanWaits([], [{ id: 'q1', question: 'which one?', options: [{ label: 'x' }] }]).waitingOnHuman, true,
    'the userQuestions projection path counts too');
  assert.deepEqual(humanWaits(null, null).humanWaits, []);
});

test('modelEfforts reads the declared efforts instead of probing selectModel', () => {
  // MEASURED: groups are {id,name,models[]}; each model declares reasoning.efforts[] + defaultEffort.
  const flash = { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: [
    { id: 'off', name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
    { id: 'low', name: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
    { id: 'max', name: 'Max', description: 'Reserve for the hardest quality-first tasks.' }], defaultEffort: 'high' } };
  const e = modelEfforts(flash);
  assert.deepEqual(e.efforts, ['off', 'low', 'max']);
  assert.equal(e.defaultEffort, 'high');
  assert.equal(e.descriptions.low, 'Prefer for routine or latency-sensitive tasks.');
  assert.deepEqual(modelEfforts({ id: 'x' }), { efforts: null, defaultEffort: null, descriptions: null },
    'an undeclared list stays unknown rather than becoming "anything goes"');
  assert.deepEqual(modelEfforts({ id: 'y', reasoning: { efforts: ['low', 'max'] }, })
    .efforts, ['low', 'max'], 'a bare string list is accepted too');
  assert.equal(modelEfforts(null).efforts, null);
});

test('the default reply carries the verdict and nothing else', () => {
  const full = { alias: 'a', state: 'completed', settled: true, running: false, verdictComplete: true,
    windowTruncated: false, logExhausted: true, approvalPolicy: 'ask', pending: [], waitingOnHuman: false,
    asked: [], note: undefined, lastAssistantText: 'x'.repeat(3000), toolCalls: [1, 2, 3], tokenUsage: { a: 1 },
    sessionStats: { b: 2 }, window: { pages: 3 }, rounds: [{ requestId: 'r1' }], task: 'y'.repeat(2000) };
  const slim = pickVerdict(full);
  assert.deepEqual(Object.keys(slim).sort(), ['settled', 'state', 'verdictComplete'], 'falsy/empty bookkeeping is not a verdict; qualifiers appear only without one');
  assert.ok(!('lastAssistantText' in slim) && !('task' in slim) && !('tokenUsage' in slim));
  assert.ok(Buffer.byteLength(JSON.stringify(slim)) < 200, 'the branch-on payload stays tiny');
  const parked = pickVerdict({ alias: 'a', state: 'running', settled: false, verdictComplete: false,
    waitingOnHuman: true, asked: [{ name: 'ask_user_question', questions: [{ header: 'H', options: ['A', 'B'] }] }],
    note: 'waiting on a human', lastAssistantText: 'noise' });
  assert.deepEqual(Object.keys(parked).sort(), ['asked', 'note', 'settled', 'state', 'verdictComplete', 'waitingOnHuman'],
    'settled:false and verdictComplete:false are the answer, not an absence of one');
  // turnStarted rides only in the case that changes what the caller should do next: no verdict AND no
  // turn/start. An ordinary running poll keeps its old size.
  assert.deepEqual(pickVerdict({ state: 'idle', settled: false, verdictComplete: false, turnStarted: false }),
    { settled: false, verdictComplete: false, state: 'idle', turnStarted: false });
  assert.ok(!('turnStarted' in pickVerdict({ state: 'running', settled: false, verdictComplete: false, turnStarted: true })));
  assert.ok(!('turnStarted' in pickVerdict({ state: 'completed', settled: true, turnStarted: false })),
    'a settled round is a verdict; the qualifier goes away with the absence it qualified');
});

test('capTexts keeps the tail and reports what it dropped', () => {
  const items = [{ turn: 1, text: 'a'.repeat(100) }, { turn: 2, text: 'b'.repeat(100) }, { turn: 3, text: 'c'.repeat(100) }];
  const all = capTexts(items, 1000);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.kept.map((x) => x.turn), [1, 2, 3]);
  const cut = capTexts(items, 210);
  assert.deepEqual(cut.kept.map((x) => x.turn), [2, 3], 'the final answer is worth more than the oldest step narration');
  assert.equal(cut.droppedCount, 1);
  assert.equal(cut.truncated, true);
  assert.match(cut.note, /1 earlier assistant message\(s\) omitted/);
  assert.deepEqual(capTexts([], 10), { kept: [], droppedCount: 0, truncated: false, note: undefined });
  const one = capTexts([{ turn: 9, text: 'x'.repeat(500) }], 100);
  assert.equal(one.kept.length, 1, 'the final text is never dropped whole');
  assert.equal(Buffer.byteLength(one.kept[0].text, 'utf8') <= 100, true);
  assert.equal(one.kept[0].textTruncated, true);
  assert.equal(one.truncated, true);
});

test('inFlightRound is the guard against paying twice for a timed-out call', () => {
  const s = { rounds: [{ requestId: 'r1', outcome: 'completed' }, { requestId: 'r2', outcome: 'running' }] };
  assert.equal(inFlightRound(s).requestId, 'r2');
  assert.equal(inFlightRound({ rounds: [{ requestId: 'r1', outcome: 'aborted' }] }), null);
  assert.equal(inFlightRound({}), null, 'no rounds at all is not in flight');
});

test('the classifier reads the clause, not the whole brief (audit regressions)', () => {
  const WS = 'D:\\AI\\Coding-Workspaces\\dsh-bridge';
  // "Update the checklist" is about the checklist; the path 25 chars later, in another clause, is only
  // where the spec lives. A fixed character window used to call that a write and refuse the dispatch.
  assert.deepEqual(pathsOutsideCwd('Update the checklist; the spec lives at "D:\\CyberE\\Mingw\\bin".', WS).write, [],
    'a verb in a different clause is not intent for this path');
  // Polarity survives: a prohibition is not a plan. These briefs are full of 禁止修改.
  assert.deepEqual(pathsOutsideCwd('禁止覆盖 "D:\\CyberE\\Mingw\\x.conf"，只在仓库内改代码。', WS).write, []);
  // The dangerous direction: 写入 X + 依据 README. Provenance words are not read-only markers, and the
  // old table shared one regex for both, which demoted a real write and let a doomed round through.
  const u1 = pathsOutsideCwd('把审计报告写入 "D:\\CyberE\\Mingw\\out.md"，格式依据 README。', WS);
  assert.deepEqual(u1.write, ['D:\\CyberE\\Mingw\\out.md'], 'a write stays a write when a source is cited after it');
  assert.deepEqual(u1.read, []);
  // Explicit read-only annotation still wins, and the normal shapes are unaffected.
  assert.deepEqual(pathsOutsideCwd('任务正文：D:\\x\\ticket.md（只读引用）', WS).write, []);
  assert.deepEqual(pathsOutsideCwd('把结论写入 D:\\x\\report.md', WS).write, ['D:\\x\\report.md']);
  // The locative shape must stay a write - "在 X 里实现" puts the verb after the path.
  assert.deepEqual(pathsOutsideCwd('在 D:\\x\\notes.md 里补充一节', WS).write, ['D:\\x\\notes.md']);
  // MEASURED blind spot: an unquoted path was only scanned if it already existed, so the guard was
  // invisible exactly when the brief names the deliverable it has not written yet.
  assert.deepEqual(pathsOutsideCwd('把结论写入 D:\\x\\brand-new-report.md', WS).write, ['D:\\x\\brand-new-report.md'],
    'a bare path with an extension counts even though nothing is on disk yet');
  assert.deepEqual(pathsOutsideCwd('工具在 D:\\Program 下', WS).all, [],
    'a space-truncated directory fragment still stays out of the advisory');
});

test('a verdict one seq past the snapshot is never called "never dispatched"', async () => {
  const log = [{ seq: 7, type: 'turn/start', data: {} }];
  for (let s = 8; s <= 300; s++) log.push({ seq: s, type: 'step/start', data: {} });
  log.push({ seq: 301, type: 'turn/end', data: { reason: { kind: 'completed' } } });
  const asOf = 300;
  const page = (cursor, n) => {
    const through = Math.min(asOf, cursor + n);
    const evs = log.filter((e) => e.seq > cursor && e.seq <= through);
    return { events: evs, window: { asOfSeq: asOf, sinceSeq: cursor, oldestSeq: evs[0]?.seq ?? null,
      newestSeq: evs[evs.length - 1]?.seq ?? null, truncated: asOf > through } };
  };
  const r = await walkRound(page, 4, { walk: true, first: 24 });
  const i = interpret(r.events, false);
  const f = verdictFields(i, r.window);
  assert.equal(i.turnStarted, true, 'the round plainly started at seq 7');
  assert.doesNotMatch(String(f.note || ''), /not picked up/, 'the wrong prescription is what made an orchestrator re-run finished work');
  assert.match(String(f.note || ''), /do NOT re-dispatch/);
  assert.ok(!/undefined/.test(String(f.note || '')), 'a diagnostic never prints undefined to a caller');
});

test('a settled round is never reported as parked on a human', () => {
  // A cancelled ask_user_question leaves its dispatch unclosed forever; without the settled gate the
  // next read of any round whose window still holds that seq claims "waiting on a human".
  const start = { seq: 700, type: 'tool/ptc-dispatch-start', data: { subCallId: 'c:ptc:1', name: 'ask_user_question',
    arguments: { questions: [{ header: 'H', question: 'A or B?' }] } } };
  const events = [start, { seq: 731, type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }];
  assert.equal(humanWaits(events).waitingOnHuman, true, 'unfinished: the wait is real');
  assert.equal(humanWaits(events, [], { settled: true }).waitingOnHuman, false, 'settled: it is history');
  assert.equal(humanWaits(events, [], { settled: true }).asked.length, 1, 'the evidence stays, only the claim is withdrawn');
});

test('capTexts cuts on a character boundary, not through one', () => {
  const r = capTexts([{ turn: 1, text: '中'.repeat(50) }], 100);
  assert.ok(Buffer.byteLength(r.kept[0].text, 'utf8') <= 100, 'the budget is a byte budget');
  assert.ok(!r.kept[0].text.includes(String.fromCharCode(0xFFFD)), 'no half character at the cut');
  assert.equal(r.kept[0].textTruncated, true);
});
