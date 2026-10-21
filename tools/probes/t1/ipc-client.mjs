// Client half of the B1 IPC protocol, in node.
//
// B1 proved the policy (9/9: eight refusals plus a DACL negative control) with a PowerShell client.
// This is the same wire protocol spoken from the process that will actually speak it - the Adapter -
// so that T1 tests the real caller rather than a second implementation of the caller.
//
// The protocol is line-delimited JSON over a named pipe:
//
//   -> {"type":"hello","token":"..."}         <- {"ok":true,"hello":"coordinator","clientUser":...}
//   -> {"type":"dispatch","goalId":...}       <- {"ok":true,"dispatchId":...} | {"ok":false,"error":...}
//
// Two details are load-bearing and were measured, not assumed:
//
//   BOM. The coordinator writes with [System.Text.Encoding]::UTF8, and a .NET StreamWriter emits the
//   preamble on the first write. JSON.parse("\uFEFF{...}") throws, which would look like "the
//   coordinator sent garbage" while it sent a perfectly good line.
//
//   Accept is not authorise. Connecting successfully proves the DACL let us in; it proves nothing
//   about the token, and the coordinator answers 'handshake-required' to anything that is not a
//   hello. The Adapter therefore cannot treat "pipe connected" as "authenticated".
import net from 'node:net';

const LINE = /\r?\n/;

export class IpcError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail || null;
  }
}

// A pipe name is a kernel object name, not a path. Restricting the alphabet keeps it impossible for
// a caller-supplied value in a tool argument to redirect the connection somewhere else.
const PIPE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function openIpc({ pipeName, timeoutMs = 5000 }) {
  if (!PIPE_NAME.test(String(pipeName || ''))) {
    throw new IpcError('invalid-pipe-name', { pipeName: String(pipeName || '') });
  }

  const path = '\\\\.\\pipe\\' + pipeName;
  const socket = net.connect(path);
  let buffer = '';
  const ready = [];        // lines that arrived before anyone asked
  const waiting = [];      // resolvers waiting for a line
  let closed = null;       // null while open; a value once the peer went away

  const settle = (value) => {
    const w = waiting.shift();
    if (w) w(value); else ready.push(value);
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let m;
    while ((m = LINE.exec(buffer))) {
      const raw = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      const line = raw.replace(/^\uFEFF/, '').trim();
      if (line) settle(line);
    }
  });
  socket.on('error', (e) => {
    closed = new IpcError('ipc-' + String(e.code || 'error').toLowerCase(), { message: e.message, path });
    while (waiting.length) waiting.shift()(closed);
  });
  socket.on('close', () => {
    closed = closed || new IpcError('ipc-closed', { path });
    while (waiting.length) waiting.shift()(closed);
  });

  const nextLine = () => new Promise((resolve, reject) => {
    const taken = ready.shift();
    if (taken !== undefined) return resolve(taken);
    if (closed) return reject(closed);
    const timer = setTimeout(() => reject(new IpcError('ipc-timeout', { afterMs: timeoutMs })), timeoutMs);
    waiting.push((v) => {
      clearTimeout(timer);
      if (v instanceof IpcError) reject(v); else resolve(v);
    });
  });

  const write = (obj) => new Promise((resolve, reject) => {
    if (closed) return reject(closed);
    // One write per line: the coordinator's ReadLine blocks until it sees a terminator.
    socket.write(JSON.stringify(obj) + '\n', (err) => err ? reject(err) : resolve());
  });

  const ask = async (msg) => {
    await write(msg);
    const line = await nextLine();
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { throw new IpcError('ipc-bad-json', { line: String(line).slice(0, 200) }); }
    return parsed;
  };

  const api = {
    // Authentication is its own step with its own failure. A caller that skips it does not get a
    // weaker session; it gets refusals for every subsequent request.
    hello: async (token) => {
      const r = await ask({ type: 'hello', token });
      if (!r.ok) throw new IpcError(r.error || 'handshake-refused', r);
      return r;
    },
    // The message is BUILT here from named fields. There is no shape in which a caller passes a
    // request object through, so no tool argument can reach the coordinator as an arbitrary method.
    dispatch: async ({ goalId, threadId, cwd }) => {
      const r = await ask({ type: 'dispatch', goalId, threadId, cwd });
      // A refusal is an error, not a result with ok:false: callers that only check for a dispatchId
      // must not be able to read a refusal as success.
      if (!r.ok) throw new IpcError(r.error || 'dispatch-refused', r);
      return r;
    },
    close: () => { try { socket.end(); } catch {} },
    get isClosed() { return closed !== null; },
  };
  return api;
}
