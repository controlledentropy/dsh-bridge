// Offline tests for the remote-surface reader. These never touch an installed dsh: the whole point of
// the module is that a *change in dsh's table format* must be visible as a failed test here, not as a
// mysterious 404 in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteTable, surfaceDigest, diffSurface, usedEndpoints } from '../lib/remote-surface.mjs';

const TABLE = `
const remotes = {
  methods: {
    "session/prompt": {
      service: "sessionController",
      description: "Queue one prompt. A \\"quoted\\" word and an \\u00e9 accent.",
    },
    "userQuestions/answer": {
      service: "userQuestions",
      description: "Answer a continued question, whose pipe | is not a table cell.",
    },
    "agentPresets/select": {
      service: "agentPresets",
      description: "Select a preset before a session starts its first turn.",
    },
    "session/prompt": { service: "dup", description: "a duplicate must not appear twice" },
    "notAnEntry": { service: "x", description: "no slash, so not a method" },
  }
};
`;

test('parseRemoteTable reads the shipped method table and ignores what is not a method', () => {
  const m = parseRemoteTable(TABLE);
  assert.deepEqual(m.map((x) => x.method), ['agentPresets/select', 'session/prompt', 'userQuestions/answer'], 'sorted, deduped');
  assert.equal(m.find((x) => x.method === 'session/prompt').service, 'sessionController', 'first entry wins over the duplicate');
  assert.equal(m.find((x) => x.method === 'session/prompt').description, 'Queue one prompt. A "quoted" word and an é accent.',
    'escapes are decoded, so the doc does not show \\u00e9');
  assert.ok(!m.some((x) => x.method === 'notAnEntry'), 'a service-less or slash-less key is not a method');
  assert.deepEqual(parseRemoteTable(''), [], 'no table reads as zero methods, which the tool refuses to write');
});

test('surfaceDigest ignores wording and catches added or removed methods', () => {
  const a = parseRemoteTable(TABLE);
  const reworded = a.map((m) => ({ ...m, description: m.description + ' (polished)' }));
  assert.equal(surfaceDigest(a), surfaceDigest(reworded), 'a description edit is not a contract change');
  const dropped = a.filter((m) => m.method !== 'agentPresets/select');
  assert.notEqual(surfaceDigest(a), surfaceDigest(dropped), 'a removed method is');
  const d = diffSurface(a, dropped);
  assert.deepEqual(d, { added: [], removed: ['agentPresets/select'] });
  assert.deepEqual(diffSurface(dropped, a).added, ['agentPresets/select']);
});

test('usedEndpoints finds what the bridge calls, so a removed method is reported before a user hits it', () => {
  const src = `await call('session/prompt', ARGS.x()); const v = await call(\n  'session/list', y); call('settings/mutate');`;
  assert.deepEqual(usedEndpoints(src), ['session/list', 'session/prompt', 'settings/mutate']);
  assert.deepEqual(usedEndpoints(''), []);
});
