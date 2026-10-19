// Offline tests for the launcher's pure parts: what environment the instance gets, whether it can see
// the tools the dsh UI shells out to, and who holds the port. None of these boot dsh or touch state.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { childPath, resolveToolchain, toolchainProblems, parseNetstatListeners, parseLsofListeners,
  npmGlobalBinDir, killTree } from '../launch.mjs';

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

test('the port holder is read from lsof on posix, without matching a longer port', () => {
  const text = [
    'dsh     1234 me   20u  IPv4 0x1  0t0  TCP 127.0.0.1:3080 (LISTEN)',
    'dsh     5678 me   21u  IPv6 0x2  0t0  TCP *:3080 (LISTEN)',
    'node    9999 me   22u  IPv4 0x3  0t0  TCP 127.0.0.1:13080 (LISTEN)',
    'node    4321 me   23u  IPv4 0x4  0t0  TCP 127.0.0.1:3080->127.0.0.1:5555 (ESTABLISHED)',
  ].join('\n');
  assert.deepEqual(parseLsofListeners(text, 3080), [1234, 5678], 'only LISTEN rows, and 13080 is a different port');
  assert.deepEqual(parseLsofListeners('', 3080), []);
});

// The stop path had no tests at all, which is how it shipped a kill that never killed anything. These
// pin the behaviour that was measured on this platform, not the behaviour one would like to have.
//
// MEASURED on Windows: taskkill /T without /F answers "This process can only be terminated forcefully
// (with /F option)" and exits 128; a native process.kill leaves the node child running. There is no
// graceful path to preserve, so the first attempt IS the forced tree kill. On posix there is one, and
// it keeps its grace window.
test('killTree forces the tree on Windows, because nothing gentler works there', async () => {
  const steps = [];
  let alive = true;
  const res = await killTree(42, {
    graceMs: 1000, pollMs: 10, platform: 'win32',
    exec: async (file, args) => { steps.push(file + ' ' + args.join(' ')); alive = false; return { code: 0 }; },
    kill: () => { throw new Error('native kill must not be used while taskkill works'); },
    wait: async () => {}, probe: () => alive,
  });
  assert.deepEqual(steps, ['taskkill /pid 42 /T /F'], 'one forced tree kill, not a hopeful SIGTERM first');
  assert.equal(res.killed, true);
  assert.equal(res.hard, true);
  assert.equal(res.treeKill, null, 'taskkill worked, so nothing is reported as unavailable');
});

test('killTree gives posix a real SIGTERM first and only then SIGKILL', async () => {
  const seen = [];
  let alive = true;
  const res = await killTree(43, {
    graceMs: 30, pollMs: 5, platform: 'linux',
    kill: (pid, sig) => { seen.push(sig); if (sig === 'SIGKILL') alive = false; },
    wait: async () => {}, probe: () => alive,
  });
  assert.deepEqual(seen, ['SIGTERM', 'SIGKILL'], 'graceful first, then forced - the posix contract');
  assert.equal(res.killed, true);
  assert.equal(res.hard, true);
});

test('killTree falls back to a native signal when taskkill is unavailable, and says so', async () => {
  // A confined host refuses to start taskkill (measured: EPERM). The parent can still be signalled;
  // the children may not be, and that has to reach the caller rather than look like a clean stop.
  const seen = [];
  let alive = true;
  const res = await killTree(44, {
    graceMs: 20, pollMs: 5, platform: 'win32',
    exec: async () => ({ code: -1, error: 'EPERM' }),
    kill: (pid, sig) => { seen.push(sig); alive = false; },
    wait: async () => {}, probe: () => alive,
  });
  assert.equal(res.treeKill, 'EPERM', 'the tree kill failure is carried out, not swallowed');
  assert.deepEqual(seen, ['SIGKILL'], 'the parent is still signalled natively');
  assert.equal(res.killed, true);
});

test('killTree reports a process it could not kill instead of claiming success', async () => {
  const res = await killTree(46, {
    graceMs: 10, pollMs: 5, platform: 'win32',
    exec: async () => ({ code: -1, error: 'EPERM' }),
    kill: () => {}, wait: async () => {}, probe: () => true,
  });
  assert.equal(res.killed, false, 'a survivor is a failure, not a stop');
  assert.equal(res.treeKill, 'EPERM');
});

test('killTree on an already-dead pid touches nothing', async () => {
  let called = false;
  const res = await killTree(45, { platform: 'win32', exec: async () => { called = true; return { code: 0 }; },
    kill: () => { called = true; }, probe: () => false, wait: async () => {} });
  assert.equal(res.alreadyGone, true);
  assert.equal(res.killed, true);
  assert.equal(called, false, 'no signal is sent to a pid that is gone');
});

