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
  unwrapProjections, pathsOutsideCwd, pageWindow, sliceRound, permissionHistory } from '../lib/api-contract.mjs';

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

test('pathsOutsideCwd flags the dispatch that the sandbox will deny', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cwd-test-'));
  const WS = path.join(root, 'research');
  const TARGET = path.join(root, 'checkout-x');
  fs.mkdirSync(WS); fs.mkdirSync(TARGET);
  try {
    assert.deepEqual(pathsOutsideCwd(`在 ${TARGET} 里实现并跑测试`, WS), [TARGET]);
    assert.deepEqual(pathsOutsideCwd(`把 "${TARGET}" 里的 docs/a.md 补测试`, WS), [TARGET], 'a quoted path keeps its spaces');
    assert.deepEqual(pathsOutsideCwd(`读取 ${path.join(WS, 'notes.md')} 后总结`, WS), [], 'inside the workspace is not a warning');
    assert.deepEqual(pathsOutsideCwd('普通中文任务，没有路径', WS), [], 'prose must not warn');
    assert.deepEqual(pathsOutsideCwd('see https://www.unicode.org/reports/tr15/ for details', WS), [], 'a URL is not a path');
    // The false positive that made the advisory ignorable: an unquoted Windows path containing a space
    // matches only its first token. "…\Program Files" is not a real directory, so it must be dropped.
    const withSpace = path.join(root, 'Program Files', 'nodejs');
    assert.deepEqual(pathsOutsideCwd(`run ${withSpace}\\node.exe --version`, WS), [], 'a fragment cut at a space is not reported');
    fs.mkdirSync(withSpace, { recursive: true });
    assert.deepEqual(pathsOutsideCwd(`run "${withSpace}\\node.exe" --version`, WS), [`${withSpace}\\node.exe`], 'the same path quoted is reported in full, as written');
    assert.deepEqual(pathsOutsideCwd(`work in ${root}`, WS), [], 'an ancestor of the workspace is not outside it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
