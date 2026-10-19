// Offline tests for the launcher's pure parts: what environment the instance gets, whether it can see
// the tools the dsh UI shells out to, and who holds the port. None of these boot dsh or touch state.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { childPath, resolveToolchain, toolchainProblems, parseNetstatListeners, npmGlobalBinDir } from '../launch.mjs';

const D = path.delimiter;

test('the child PATH always carries the npm global bin dir', () => {
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', PATH: ['C:\\Windows', 'C:\\Windows\\System32'].join(D) };
  const r = childPath(env);
  assert.deepEqual(r.added, [path.join(env.APPDATA, 'npm')], 'the shell that started us may not have had it');
  assert.ok(r.path.startsWith(env.APPDATA), 'added in front of the inherited PATH');
  assert.ok(r.path.endsWith('C:\\Windows' + D + 'C:\\Windows\\System32'), 'nothing inherited is dropped');
});

test('adding a PATH entry that is already there is a no-op, however it is spelled', () => {
  const npm = path.join('C:\\Users\\me\\AppData\\Roaming', 'npm');
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', PATH: ['C:\\Windows', npm + '\\'].join(D) };
  assert.deepEqual(childPath(env).added, [], 'a trailing separator is the same directory');
  assert.deepEqual(childPath({ ...env, PATH: ['C:\\WINDOWS', npm.toUpperCase()].join(D) }).added, []);
});

test('DSH_EXTRA_PATH reaches the instance', () => {
  const r = childPath({ APPDATA: '', PATH: 'C:\\Windows' }, ['D:\\tools\\pnpm', '  ']);
  assert.deepEqual(r.added, ['D:\\tools\\pnpm']);
  assert.equal(r.path, 'D:\\tools\\pnpm' + D + 'C:\\Windows');
});

test('the toolchain is resolved against the child PATH, in the order a shell would', () => {
  const files = new Set([
    'C:\\a\\git.exe', 'C:\\b\\pnpm.ps1', 'C:\\b\\pnpm.cmd', 'C:\\Windows\\node.exe',
  ].map((p) => p.toLowerCase()));
  const exists = (p) => files.has(p.toLowerCase());
  const tc = resolveToolchain(['C:\\b', 'C:\\Windows', 'C:\\a'].join(D), exists, 'win32');
  assert.equal(tc.pnpm, path.join('C:\\b', 'pnpm.cmd'), 'the .cmd shim wins over .ps1, as PATHEXT does');
  assert.equal(tc.node, path.join('C:\\Windows', 'node.exe'));
  assert.equal(tc.git, path.join('C:\\a', 'git.exe'));
  assert.equal(tc.npm, null, 'absent stays null rather than becoming a guess');
});

test('a missing pnpm is reported as the failure it actually causes', () => {
  const p = toolchainProblems({ node: 'x', npm: 'y', pnpm: null, git: 'z' });
  assert.equal(p.length, 1);
  assert.match(p[0], /cannot see pnpm/);
  assert.match(p[0], /installing a plugin/i);
  assert.match(p[0], /DSH_EXTRA_PATH/);
  assert.deepEqual(toolchainProblems({ node: 'x', npm: 'y', pnpm: 'z', git: 'w' }), []);
  assert.match(toolchainProblems(null)[0], /predates toolchain reporting/, 'an old instance.json says unknown, not fine');
});

test('the port holder is read from netstat without guessing', () => {
  const text = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3080           0.0.0.0:0              LISTENING       19964',
    '  TCP    127.0.0.1:3080         127.0.0.1:52100        ESTABLISHED     19964',
    '  TCP    127.0.0.1:3081         0.0.0.0:0              LISTENING       4321',
    '  TCP    [::]:3080              [::]:0                 LISTENING       19965',
    '  TCP    127.0.0.1:13080        0.0.0.0:0              LISTENING       777',
  ].join('\r\n');
  assert.deepEqual(parseNetstatListeners(text, 3080), [19964, 19965], 'v4 and v6 listeners, established rows ignored');
  assert.deepEqual(parseNetstatListeners(text, 3081), [4321]);
  assert.deepEqual(parseNetstatListeners(text, 30800), [], 'a port that is a prefix of another is not a match');
  assert.deepEqual(parseNetstatListeners('', 3080), []);
});

test('npmGlobalBinDir stays empty when the platform has no APPDATA', () => {
  assert.equal(npmGlobalBinDir({}), '');
});
