// Offline contract tests: they pin the measured dsh /api wire format and the pure bridge logic, and
// need no running dsh, no network and no model quota. Run with `npm test`.
//
// These are the assertions that break first after a dsh upgrade, which is the point: a failing test
// here means the contract moved, not that the environment is unhealthy.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARGS, envelope, authCookie, pastCursor, parseAllowlist, allowedText, checkPolicy, splitModel,
  modelLabel, ALIAS_RE, checkAlias, checkCwd, normCwd, roundRecord, baselineFrom, interpret, argText } from '../lib/api-contract.mjs';

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
