#!/usr/bin/env node
// Evidence probe: can a Node process hold a kernel-exclusive single-instance claim on Windows
// without a native addon?
//
// Why this matters: the Coordinator is only safe while exactly one process may issue external RPC.
// A pid file is not that guarantee (a wedged process keeps its pid), and a lease that expires on a
// missed heartbeat is worse than no lease - it manufactures a second writer, which is the E6 class
// of failure with a scheduler attached. What is needed is a claim that is (a) mutually exclusive,
// (b) held by the kernel for the process's whole life, (c) NOT released merely because the holder
// stops responding, and (d) released when the holder dies with no cleanup step.
//
// A Windows named pipe has exactly those properties.
//
//   node tools/probes/single-instance.mjs --hold <name> [holdMs]   # claim and hold, print JSON
//   node tools/probes/single-instance.mjs --try  <name>           # attempt a claim, print JSON, exit
//
// The cross-process assertions are driven from the shell (see docs/EVIDENCE.md): hold in one
// process, --try from another, then kill the holder and --try again. This probe deliberately does
// not spawn children itself - a confined host can refuse child-process spawns, which would make
// the test fail for a reason unrelated to the property under test.
import net from 'node:net';

// Built from a char code on purpose. Writing this path as a literal is where an escaping mistake
// silently produces a name that never collides - and a claim that always succeeds looks like a
// working lock while protecting nothing.
const BS = String.fromCharCode(92);
export const PIPE_ROOT = BS + BS + '.' + BS + 'pipe' + BS;

export function claim(name, options) {
  const holdMs = (options && options.holdMs) || 0;
  return new Promise((resolve) => {
    const path = PIPE_ROOT + name;
    const server = net.createServer((sock) => sock.end());
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(Object.assign({ server: server, path: path }, v)); } };
    server.on('error', (e) => { try { server.close(); } catch {} done({ claimed: false, code: e.code || null, message: String(e.message || e) }); });
    server.listen(path, () => {
      done({ claimed: true, pid: process.pid, name: name });
      if (holdMs > 0) setTimeout(() => { try { server.close(); } catch {} }, holdMs);
    });
  });
}

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : ''; };
if (argv.includes('--hold') || argv.includes('--try')) {
  const name = flag(argv.includes('--hold') ? '--hold' : '--try');
  if (!name) { console.error('usage: --hold <name> [ms] | --try <name>'); process.exit(2); }
  const holdMs = argv.includes('--hold') ? Number(flag('--hold', 2) || argv[argv.indexOf('--hold') + 2] || 0) : 0;
  const r = await claim(name, { holdMs: Number.isFinite(holdMs) ? holdMs : 0 });
  console.log(JSON.stringify({ claimed: r.claimed, pid: r.pid || null, name: name, code: r.code || null }, null, 1));
  if (argv.includes('--try')) process.exit(0);
  setTimeout(() => process.exit(0), 60000);
}