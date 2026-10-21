#!/usr/bin/env node
// T1.2 minimal Adapter: the MCP stdio process that Codex discovers, speaking to the coordinator over
// the B1 authenticated pipe.
//
// The whole point of T1 is that this is a REAL stdio MCP server, not a mock: Codex launches it as a
// child process and talks MCP to it over stdin/stdout. Two consequences shape the code:
//
//   1. stdout belongs to the transport. Anything printed there corrupts the MCP framing, so every
//      diagnostic goes to stderr. A server that logs to stdout "works" until the first log line.
//
//   2. The tool surface is a whitelist, not a proxy. The Adapter has exactly one forwarding tool,
//      and the message it sends is ASSEMBLED from validated fields - there is no code path that
//      hands a caller-supplied object to the coordinator. The reason is the threat in T1 item 7: an
//      agent that can ask the Adapter to send "any request" has the coordinator's whole interface,
//      and one that can name an arbitrary pipe has whatever else is on this machine.
//
//   DSH_BRIDGE_PIPE            pipe name (required)
//   DSH_BRIDGE_TOKEN           handshake token (required unless RAW is set)
//   DSH_BRIDGE_RAW_HANDSHAKE   skip hello - ONLY to exercise the coordinator's 'handshake-required'
//                              refusal on this path. It exists so the denial can be proven reachable
//                              through a real stdio call, not so that anything can run without a token.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openIpc, IpcError } from './ipc-client.mjs';

const PIPE = process.env.DSH_BRIDGE_PIPE || '';
const TOKEN = process.env.DSH_BRIDGE_TOKEN || '';
const RAW = process.env.DSH_BRIDGE_RAW_HANDSHAKE === '1';

const log = (o) => { try { process.stderr.write(JSON.stringify({ at: new Date().toISOString(), adapter: process.pid, ...o }) + '\n'); } catch {} };

// One connection, opened on first use. Lazy because a failed connection must be reportable THROUGH
// the tool result: an Adapter that exits on a DACL denial gives the model a dead server instead of a
// refusal it can reason about - and gives the test nothing to assert.
let conn = null;
let connectError = null;

async function ipc() {
  if (conn) return conn;
  if (connectError) throw connectError;
  if (!PIPE) { connectError = new IpcError('adapter-not-configured', { missing: 'DSH_BRIDGE_PIPE' }); throw connectError; }
  try {
    const c = openIpc({ pipeName: PIPE });
    if (!RAW) {
      if (!TOKEN) { c.close(); connectError = new IpcError('adapter-not-configured', { missing: 'DSH_BRIDGE_TOKEN' }); throw connectError; }
      await c.hello(TOKEN);
    }
    conn = c;
    return conn;
  } catch (e) {
    // Cached on purpose: a refusal is a fact about this process's credentials, and retrying it per
    // call would turn one policy decision into an unbounded stream of new connections.
    connectError = e instanceof IpcError ? e : new IpcError('ipc-connect-failed', { message: String(e && e.message || e) });
    throw connectError;
  }
}

const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 1) }] });
const fail = (e) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.code || e?.message || e), detail: e?.detail ?? null }, null, 1) }],
  isError: true,
});

// Identifiers that cross into a message the coordinator will use to look things up. Narrow on
// purpose: no path separators, no whitespace, no JSON punctuation, so a value can never change the
// shape of the line it is embedded in.
const IDENT = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
// A workspace is a drive-absolute Windows path. Traversal is refused here rather than normalised:
// "resolve it and hope" is how an allowed cwd becomes a different cwd after the check.
const CWD = z.string().min(3).max(512).regex(/^[A-Za-z]:\\/).refine((v) => !v.split(/[\\/]/).includes('..'), {
  message: 'cwd must not contain a parent-directory segment',
});

const server = new McpServer({ name: 'dsh-bridge-adapter', version: '0.1.0' }, {
  instructions: 'Adapter over the dsh-bridge coordinator. One tool: dispatch_submit. It admits a dispatch for an already-authorized goal. It cannot create goals, change policy, read files, run commands or forward HTTP - those capabilities are absent, not merely discouraged.',
});

const TOOL_NAMES = [];
const tool = (name, def, handler) => { TOOL_NAMES.push(name); server.registerTool(name, def, handler); };

tool('dispatch_submit', {
  description: 'Admit one dispatch for an authorized goal. Returns the coordinator-issued dispatchId. A refusal (unknown goal, unauthorized goal, unregistered thread, cwd outside the goal, budget exhausted, bad token) comes back as a tool error with a stable error code.',
  inputSchema: {
    goalId: IDENT.describe('the goal being worked, as issued by the coordinator'),
    threadId: IDENT.describe('the Codex thread the work belongs to; must be registered with the coordinator'),
    cwd: CWD.describe('absolute workspace path the work will touch; must be inside the goal'),
    clientRequestId: IDENT.optional().describe('caller-side idempotency key, echoed for correlation'),
  },
}, async (args) => {
  try {
    // Built field by field from the validated arguments. Unknown extra keys cannot reach the wire
    // because nothing here copies them.
    const c = await ipc();
    const r = await c.dispatch({ goalId: args.goalId, threadId: args.threadId, cwd: args.cwd });
    log({ ev: 'dispatch', ok: true, dispatchId: r.dispatchId, goalId: args.goalId });
    return json({
      ok: true,
      dispatchId: r.dispatchId,
      goalId: args.goalId,
      threadId: args.threadId,
      cwd: args.cwd,
      clientRequestId: args.clientRequestId ?? null,
      budget: { used: r.budgetUsed ?? null, max: r.budgetMax ?? null },
    });
  } catch (e) {
    log({ ev: 'dispatch', ok: false, error: String(e?.code || e?.message || e) });
    return fail(e);
  }
});

// Read-only introspection, answered locally. It costs no IPC round trip and cannot change state, so
// it is safe to expose: it tells a diagnosing human which pipe this process would use, not what the
// coordinator contains.
tool('adapter_info', {
  description: 'Describe this Adapter process: its pid, the pipe it targets, whether it authenticates, and its exact tool surface. Read-only, answered locally, no IPC.',
  inputSchema: {},
}, async () => json({
  ok: true,
  pid: process.pid,
  pipe: PIPE || null,
  authenticates: !RAW,
  connected: conn !== null,
  connectError: connectError ? { code: connectError.code, detail: connectError.detail } : null,
  tools: [...TOOL_NAMES],
  capabilities: { filesystem: false, exec: false, http: false, sql: false, coordinatorAdmin: false },
}));

await server.connect(new StdioServerTransport());
log({ ev: 'ready', pipe: PIPE || null, raw: RAW, tools: TOOL_NAMES });

// Keep the process alive until stdin closes: the MCP transport does that, but a process with no
// pending work is allowed to exit, and an Adapter that exits early looks like a crashed server.
process.stdin.resume();
