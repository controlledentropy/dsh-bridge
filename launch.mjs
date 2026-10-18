#!/usr/bin/env node
// Single source of truth for "where is dsh, is it healthy, how to start it, where the token lives".
// Both start-dsh-web.ps1 (human) and bridge.mjs (MCP client) go through this file, so an upgrade can
// only break one place. Every path is resolved or overridable; nothing here hardcodes a package's
// internal file layout.
//
//   node launch.mjs resolve | check | status | start | stop | doctor
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.DSH_PORT || 3080);
export const HOST = process.env.DSH_HOST || '127.0.0.1';
export const STATE_DIR = process.env.DSH_BRIDGE_STATE || path.join(HERE, '.state');
export const RUN_DIR = path.join(STATE_DIR, 'run');            // dsh's process cwd: third-party plugins drop caches here, keep them out of the package
export const OUT_FILE = path.join(STATE_DIR, 'dsh-web.out');   // captured stdout, i.e. the only place the launch token exists
export const INSTANCE = path.join(STATE_DIR, 'instance.json');
export const SPAWN_LOCK = path.join(STATE_DIR, 'spawn.lock');
export const CHECK_CACHE = path.join(STATE_DIR, 'check.json');
// The build this bridge was written against. /api carries no compatibility promise, so a mismatch
// must be visible rather than silently mis-parsing responses.
export const TESTED_DSH = process.env.DSH_TESTED_VERSION || '0.2.1-rc.2';

const NPM_ROOT = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : '';

function mkdirs() { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.mkdirSync(RUN_DIR, { recursive: true }); }

// Captured stdout may be UTF-8 or UTF-16 depending on how the redirect was done.
export function readTextSmart(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
    const utf8 = buf.toString('utf8');
    let nul = 0;
    for (let i = 0; i < utf8.length && i < 4096; i++) if (utf8[i] === '\u0000') nul++;
    return nul > 4 ? buf.toString('utf16le') : utf8;
  } catch { return ''; }
}

export function tokenFrom(file) {
  if (!file) return null;
  const m = readTextSmart(file).match(/[?&]token=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function currentToken() {
  return tokenFrom(process.env.DSH_ATTACH_OUTFILE || '') || tokenFrom(OUT_FILE);
}

// The CLI entry is read from the installed package's own manifest, never guessed.
export function resolveDsh() {
  const notes = [];
  const pkgDir = process.env.DSH_PKG_DIR
    || (NPM_ROOT && fs.existsSync(path.join(NPM_ROOT, '@deepseek-ai', 'dsh', 'package.json'))
      ? path.join(NPM_ROOT, '@deepseek-ai', 'dsh') : '');
  let node = process.env.DSH_NODE || '';
  if (node && !fs.existsSync(node)) { notes.push('DSH_NODE did not exist, searched PATH instead'); node = ''; }
  if (!node) {
    const fromPath = (() => {
      for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir.replace(/^"|"$/g, ''), 'node.exe');
        if (fs.existsSync(p)) return p;
      }
      return '';
    })();
    node = fromPath || ['D:\\Program Files\\nodejs', 'C:\\Program Files\\nodejs']
      .map((r) => path.join(r, 'node.exe')).find((p) => fs.existsSync(p)) || '';
    if (node) notes.push('node resolved from PATH');
  }
  let cli = ''; let version = '';
  if (pkgDir) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      version = pkg.version || '';
      const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && (pkg.bin.dsh || Object.values(pkg.bin)[0])) || '';
      if (bin) cli = path.join(pkgDir, String(bin).replace(/\//g, path.sep));
      notes.push('cli from package.json bin=' + JSON.stringify(pkg.bin));
    } catch (e) { notes.push('package.json unreadable: ' + e.message); }
  }
  const shim = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'dsh.cmd') : '';
  if (!cli && shim && fs.existsSync(shim)) { cli = ''; notes.push('falling back to the dsh.cmd shim'); }
  return { node, cli, version, shim: fs.existsSync(shim) ? shim : '', pkgDir, notes };
}

export function portOpen(port = PORT, host = HOST) {
  return new Promise((res) => {
    const s = net.connect(port, host);
    s.setTimeout(1200);
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.on('timeout', () => { s.destroy(); res(false); });
  });
}

function runCapture(node, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = ''; let p;
    try { p = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: RUN_DIR }); }
    catch (e) { return resolve({ code: -1, out: 'spawn failed: ' + e.message }); }
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ code: -1, out: out + '\nTIMEOUT' }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { out += d.toString('utf8'); });
    p.on('exit', (c) => { clearTimeout(timer); resolve({ code: c ?? -1, out }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: 'error: ' + e.message }); });
  });
}

// Composition check without booting. Caches an OK result, because cold-starting several bridge
// processes at once would otherwise each pay for a full dump.
export async function check({ refresh = false } = {}) {
  const r = resolveDsh();
  const problems = [];
  if (!r.node) problems.push('node.exe not found (set DSH_NODE)');
  if (!r.cli) problems.push('dsh CLI entry not resolvable (set DSH_PKG_DIR, or reinstall @deepseek-ai/dsh)');
  if (r.version && r.version !== TESTED_DSH) problems.push(`dsh ${r.version} != tested ${TESTED_DSH}: re-verify the /api envelope and token format (docs/API-CONTRACT.md)`);
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(CHECK_CACHE, 'utf8')); } catch {}
  if (!refresh && cached && cached.ok && cached.version === (r.version || '?') && Date.now() - cached.at < 3600_000) {
    return { ...r, testedVersion: TESTED_DSH, problems: problems.filter((p) => p.includes('!= tested')), cached: true, dumpLines: cached.dumpLines };
  }
  let dumpLines = 0;
  if (r.node && r.cli) {
    mkdirs();
    const d = await runCapture(r.node, [r.cli, '--profile', 'web', '--dump-config'], Number(process.env.DSH_CHECK_TIMEOUT_MS || 25000));
    dumpLines = (d.out || '').split(/\r?\n/).length;
    if (d.code !== 0) problems.push('profile composition failed (exit ' + d.code + '): ' + String(d.out).split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 300));
    for (const line of String(d.out).split(/\r?\n/)) {
      if (/no longer configurable|not found|did not activate/i.test(line)) problems.push('composition note: ' + line.trim().slice(0, 200));
    }
    const fatal = problems.some((p) => p.includes('composition failed'));
    try { fs.writeFileSync(CHECK_CACHE, JSON.stringify({ ok: !fatal, version: r.version, at: Date.now(), dumpLines })); } catch {}
  }
  return { ...r, testedVersion: TESTED_DSH, problems, dumpLines, cached: false };
}

export async function status() {
  const open = await portOpen();
  let mine = null;
  try { mine = JSON.parse(fs.readFileSync(INSTANCE, 'utf8')); } catch {}
  return { port: PORT, host: HOST, listening: open, tokenCaptured: !!currentToken(), captureFile: OUT_FILE, ownedByUs: mine };
}

function takeSpawnLock() {
  mkdirs();
  try { const fd = fs.openSync(SPAWN_LOCK, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
  catch (e) {
    if (e.code !== 'EEXIST') return true;
    let age = Infinity; let holder = '';
    try { const st = fs.statSync(SPAWN_LOCK); age = Date.now() - st.mtimeMs; holder = readTextSmart(SPAWN_LOCK).trim(); } catch { return true; }
    if (age > 120_000) { try { fs.rmSync(SPAWN_LOCK, { force: true }); } catch {} return takeSpawnLock(); }  // stale lock from a killed process
    return { waiting: true, holder };
  }
}

export async function start({ quiet = false } = {}) {
  if (await portOpen()) {
    if (currentToken()) { if (!quiet) console.log('already running on ' + HOST + ':' + PORT + ' and a token is captured; nothing to do'); return { ok: true, attached: true }; }
    return { ok: false, error: 'port ' + PORT + ' is held by an instance whose stdout this bridge cannot read', hint: OUT_FILE };
  }
  const lock = takeSpawnLock();
  if (lock === true) {
    const c = await check();
    const fatal = c.problems.filter((p) => !p.startsWith('composition note') && !p.includes('!= tested'));
    if (fatal.length) return { ok: false, error: 'pre-flight failed: ' + fatal.join(' | ') };
    mkdirs();
    const fd = fs.openSync(OUT_FILE, 'w');
    let pid = 0;
    try {
      const child = spawn(c.node, [c.cli, '--profile', 'web', '--host', HOST, '--port', String(PORT), '--no-open'], {
        cwd: RUN_DIR, detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
      });
      pid = child.pid; child.unref();
    } finally { fs.closeSync(fd); }                       // the child keeps its own handle; don't leak ours
    try { fs.chmodSync(OUT_FILE, 0o600); } catch {}        // captured file holds an owner-level bearer token
    fs.writeFileSync(INSTANCE, JSON.stringify({ pid, port: PORT, version: c.version, startedAt: new Date().toISOString() }, null, 2));
    const deadline = Date.now() + Number(process.env.DSH_BOOT_TIMEOUT_MS || 90000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      if (tokenFrom(OUT_FILE) && (await portOpen())) {
        if (!quiet) console.log('dsh web up: pid ' + pid + ' version ' + c.version + '\nURL with token: ' + OUT_FILE);
        return { ok: true, pid, version: c.version, notes: c.problems.filter((p) => p.startsWith('composition note')) };
      }
    }
    return { ok: false, error: 'instance did not become ready within the boot timeout; see ' + OUT_FILE };
  }
  // Another process is spawning: wait for the shared capture file instead of racing it.
  const deadline = Date.now() + Number(process.env.DSH_BOOT_TIMEOUT_MS || 90000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    if (tokenFrom(OUT_FILE) && (await portOpen())) return { ok: true, attached: true, waitedForLockHolder: true };
    if (!(await portOpen()) && !fs.existsSync(SPAWN_LOCK)) return { ok: false, error: 'lock holder died before the instance was ready' };
  }
  return { ok: false, error: 'timed out waiting for the other process to bring dsh web up (lock held by pid ' + (lock.holder || '?') + ')' };
}

export async function stop() {
  let mine = null;
  try { mine = JSON.parse(fs.readFileSync(INSTANCE, 'utf8')); } catch {}
  if (!mine?.pid) return { ok: false, error: 'no instance.json: we did not start this instance, so we will not kill a process we do not own' };
  try { process.kill(mine.pid); } catch (e) { return { ok: false, error: 'kill failed: ' + e.message }; }
  await new Promise((r) => setTimeout(r, 1500));
  try { fs.rmSync(SPAWN_LOCK, { force: true }); } catch {}
  return { ok: !(await portOpen()), stoppedPid: mine.pid };
}

// One-shot health report with an explicit conclusion.
export async function doctor() {
  const c = await check();
  const st = await status();
  const out = { resolved: { node: c.node, cli: c.cli, version: c.version, shim: c.shim }, testedVersion: c.testedVersion,
    problems: c.problems, listening: st.listening, tokenCaptured: st.tokenCaptured, captureFile: OUT_FILE, ownedByUs: st.ownedByUs,
    api: null, catalog: null };
  out.tokenCapturedNote = out.tokenCaptured
    ? (out.listening ? 'read from the live capture file' : 'STALE: nothing is listening, so this token belongs to a dead process - unusable')
    : 'none captured yet';
  if (st.listening && out.tokenCaptured) {
    try {
      const r = await fetch(`http://${HOST}:${PORT}/connect?token=${currentToken()}&interactions=answer`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const cookie = (r.headers.getSetCookie().find((x) => x.startsWith('dsh-auth-')) || '').split(';')[0];
      out.api = { connectStatus: r.status, authed: !!cookie };
      if (cookie) {
        const res = await fetch(`http://${HOST}:${PORT}/api/session/modelCatalog`, {
          method: 'POST', signal: AbortSignal.timeout(8000),
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ type: 'client-request', rpcId: 'doctor', method: 'session/modelCatalog', payload: { args: {} } }),
        });
        const j = await res.json();
        out.catalog = { ok: j?.result?.ok ?? null, default: j?.result?.value?.default || null,
          routableProviders: j?.result?.value?.routableProviders || null, failures: (j?.result?.value?.failures || []).length };
      }
    } catch (e) { out.api = { error: String(e.message || e) }; }
  }
  const steps = [];
  if (out.resolved.cli) steps.push('dsh CLI resolved');
  if (!c.problems.some((p) => !p.startsWith('composition note') && !p.includes('!= tested'))) steps.push('profile composes');
  if (out.api?.authed) steps.push('token -> cookie');
  if (out.catalog?.ok) steps.push('/api answers (modelCatalog)');
  out.summary = steps.join('  ->  ');
  out.broken = !out.api?.authed
    ? (out.listening ? 'token not readable: restart via start-dsh-web.ps1 so stdout is captured' : 'no instance listening: run start-dsh-web.ps1, or let the bridge self-start it')
    : (out.catalog?.ok ? null : '/api did not answer modelCatalog - suspect dsh version drift, check docs/API-CONTRACT.md');
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('launch.mjs')) {
  const cmd = process.argv[2] || 'resolve';
  const out = cmd === 'check' ? await check({ refresh: true })
    : cmd === 'status' ? await status()
    : cmd === 'doctor' ? await doctor()
    : cmd === 'start' ? await start()
    : cmd === 'stop' ? await stop()
    : resolveDsh();
  console.log(JSON.stringify(out, null, 1));
  process.exit(out && out.ok === false ? 1 : 0);
}
