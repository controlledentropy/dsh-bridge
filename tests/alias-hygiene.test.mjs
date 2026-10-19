// Offline tests for alias hygiene. The fixture at the end is shaped like the real incident: one brief
// dispatched into a session whose cwd was the wrong checkout, then re-dispatched under a second alias -
// two live aliases for one ticket, which nothing in the bridge could see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { commonPrefixLength, findSiblings, applySupersedes } from '../lib/alias-hygiene.mjs';

const A = 'D:\\work\\project';
const B = 'D:\\work\\project-s2-02f';

test('commonPrefixLength ignores case and whitespace runs', () => {
  assert.equal(commonPrefixLength('目标：修复 NFC。', '目标：修复  NFC。'), '目标：修复 NFC。'.length);
  assert.equal(commonPrefixLength('abc', ''), 0);
  assert.equal(commonPrefixLength(null, null), 0);
});

test('findSiblings reports a second alias doing the same phase elsewhere', () => {
  const ledger = { 'p2-impl': { cwd: A, phase: 'S2-02-F', sessionId: 'dsh-p2-impl', rounds: [{ task: '别的' }] } };
  const s = findSiblings(ledger, { alias: 'p2-impl-r2', cwd: B, phase: 's2-02-f', task: '完全不同的任务文本' });
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].reasons, ['same phase'], 'phase comparison is case/whitespace insensitive');
  assert.equal(s[0].alias, 'p2-impl');
});

test('findSiblings reports a copied brief even when the phase differs', () => {
  const brief = '目标：只读核对 Unicode 16 材料。边界：禁止修改 src/。验收：把结论写入 report.md。交付：materials 与 receipt。'.repeat(3);
  const ledger = { old: { cwd: A, phase: null, rounds: [{ task: brief }] } };
  assert.deepEqual(findSiblings(ledger, { alias: 'new', cwd: B, phase: 'other', task: brief }).length, 1);
  assert.equal(findSiblings(ledger, { alias: 'new', cwd: B, phase: 'other', task: brief.slice(0, 30) }).length, 0,
    'a short shared opening (the four-section template) is not evidence of the same ticket');
});

test('findSiblings stays quiet for the ordinary cases', () => {
  const ledger = {
    same: { cwd: A, phase: 'p1', rounds: [{ task: 'x' }] },
    parent: { cwd: 'D:\\work', phase: 'p1', rounds: [{ task: 'x' }] },
    child: { cwd: `${A}\\sub`, phase: 'p1', rounds: [{ task: 'x' }] },
    unrelated: { cwd: 'C:\\other', phase: 'p9', rounds: [] } };
  assert.deepEqual(findSiblings(ledger, { alias: 'me', cwd: A, phase: 'p1', task: 'x' }), [],
    'one cwd across phases is the normal shape of this workflow, not a warning');
  assert.deepEqual(findSiblings({}, { alias: 'me', cwd: A, phase: 'p1', task: 'x' }), []);
});

test('applySupersedes makes the handover explicit on both sides', () => {
  const l = { a: { cwd: A }, b: { cwd: B } };
  applySupersedes(l, 'b', 'a');
  assert.equal(l.a.supersededBy, 'b');
  assert.equal(l.b.supersedes, 'a');
  assert.equal(Object.keys(l).length, 2);
  applySupersedes(l, 'b', 'b');
  applySupersedes(l, 'b', null);
  assert.equal(l.b.supersedes, 'a', 'a no-op must not erase the recorded handover');
  assert.throws(() => applySupersedes(l, 'b', 'ghost'), /not in the ledger/);
});

test('the 02-F shape is caught: same brief, sibling checkout, second alias', () => {
  const ticket = '目标：为 S2-02-F 固定 Unicode 16 派生产物。\n边界：只允许改动 third_party/unicode 与 tests/fixtures/02-nfc16。\n验收：默认 verify 离线只读通过。\n交付：材料 + 回执。';
  const ledger = { 's2-02f-unicode16': { cwd: A, phase: 'S2-02-F Unicode16 materials', sessionId: 'dsh-s2-02f-unicode16',
    rounds: [{ requestId: 'r1', task: ticket, outcome: 'aborted' }] } };
  const s = findSiblings(ledger, { alias: 's2-02f-r2', cwd: B, phase: 's2-02f-recovery', task: ticket });
  assert.equal(s.length, 1);
  assert.match(s[0].reasons.join(' '), /task text matches/, 'the duplicate brief is the signal that survived the phase rename');
});
