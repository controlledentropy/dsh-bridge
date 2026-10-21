#!/usr/bin/env node
// A local stand-in for the model service, so a Codex turn can run with no credentials, no network
// and no billing. Codex's own app-server tests drive it the same way: declare a custom provider in
// config.toml with requires_openai_auth = false, point base_url at 127.0.0.1, speak the Responses
// API, and end the stream with response.completed.
//
// Every request is appended to requests.jsonl, because the queue tests fail or pass on arithmetic:
// how many model calls happened, and in what order. A mock that only returns 200 proves nothing -
// the turn has to actually finish for the lifecycle to be observable.
//
//   node tools/probes/mock-responses-server.mjs --port 0 --log <file> --text <reply>
// Prints one JSON line {"port":N} on startup so the caller never has to guess the port.
//
// --call <substring> makes the FIRST model response a tool call instead of text, for any tool whose
// name contains the substring; the second response is the reply text. This exists because "Codex
// discovered the MCP tool" cannot be shown by a text reply - the model has to actually ask for the
// tool, and the only way to make a mock model do that is to emit a function_call. The name is read
// from the request's own tools array rather than hardcoded, so whatever naming scheme the client
// applies is observed instead of assumed.
import http from 'node:http';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const LOG = flag('--log', '');
const REPLY = flag('--text', 'MOCK-ACK');
const PORT = Number(flag('--port', '0'));
const DELAY_MS = Number(flag('--delay', '0'));
const FULL_LOG = flag('--full-log', '');
const CALL_MATCH = flag('--call', '');
const CALL_ARGS = flag('--call-args', '{}');

const requests = [];
const record = (o) => {
  requests.push(o);
  if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); } catch {} }
};

let seq = 0;
const ev = (type, payload) => { seq++; return 'event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: seq, ...payload }) + '\n\n'; };

let modelCalls = 0;          // one per POST to /responses, which is one model turn segment
const callLog = [];          // what the mock decided, so a failed run explains itself

function sseToolCall(res, responseId, { itemId, callId, name, args }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const item = { id: itemId, type: 'function_call', call_id: callId, name, arguments: args, status: 'completed' };
  res.write(ev('response.created', { response: { id: responseId, object: 'response', status: 'in_progress', output: [] } }));
  res.write(ev('response.in_progress', { response: { id: responseId, status: 'in_progress' } }));
  res.write(ev('response.output_item.added', { output_index: 0,
    item: { id: itemId, type: 'function_call', call_id: callId, name, arguments: '', status: 'in_progress' } }));
  res.write(ev('response.function_call_arguments.delta', { item_id: itemId, output_index: 0, delta: args }));
  res.write(ev('response.function_call_arguments.done', { item_id: itemId, output_index: 0, arguments: args }));
  res.write(ev('response.output_item.done', { output_index: 0, item }));
  res.write(ev('response.completed', { response: { id: responseId, object: 'response', status: 'completed',
    output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
  res.end();
}

function sse(res, responseId, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const itemId = 'msg_mock_' + seq;
  res.write(ev('response.created', { response: { id: responseId, object: 'response', status: 'in_progress', output: [] } }));
  res.write(ev('response.in_progress', { response: { id: responseId, status: 'in_progress' } }));
  res.write(ev('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }));
  res.write(ev('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }));
  res.write(ev('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text }));
  res.write(ev('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: text }));
  res.write(ev('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: text } }));
  res.write(ev('response.output_item.done', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: text }] } }));
  const done = { id: responseId, object: 'response', status: 'completed', output: [{ id: itemId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.write(ev('response.completed', { response: done }));
  res.end();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    const textOf = (() => {
      const input = parsed && parsed.input;
      if (!Array.isArray(input)) return '';
      return input.map((m) => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.map((c) => c.text || '').join('');
        return '';
      }).join(' | ');
    })();
    const toolNames = Array.isArray(parsed && parsed.tools) ? parsed.tools.map((t) => (t && (t.name || (t.function && t.function.name))) || 'unnamed') : [];
    const entry = { at: new Date().toISOString(), path: req.url, method: req.method, model: parsed && parsed.model,
      stream: parsed && parsed.stream, inputChars: textOf.length, inputPreview: textOf.slice(0, 160),
      toolCount: toolNames.length, toolNames: toolNames.slice(0, 40), requestKeys: parsed ? Object.keys(parsed) : [] };
    record(entry);
    // A preview cannot decide which message a turn carried, and "did turn 2 receive the second
    // marker" is exactly what the queue tests have to answer. The full text is written separately
    // so the request log stays small and greppable.
    if (FULL_LOG) { try { fs.appendFileSync(FULL_LOG, JSON.stringify({ at: entry.at, text: textOf, tools: parsed && parsed.tools }) + '\n'); } catch {} }
    if (!String(req.url || '').includes('/responses')) { res.writeHead(404); res.end('{}'); return; }
    const responseId = 'resp_mock_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);

    modelCalls += 1;
    // Tool output travels back to the model as an input item of type function_call_output. Its
    // presence is what "the call actually happened and was answered" looks like from here, so it is
    // recorded rather than inferred from the call counter.
    const sawToolOutput = Array.isArray(parsed && parsed.input)
      && parsed.input.some((m) => m && (m.type === 'function_call_output' || m.type === 'tool_result'));

    if (CALL_MATCH && modelCalls === 1) {
      const match = toolNames.find((n) => n.includes(CALL_MATCH));
      callLog.push({ at: entry.at, decision: match ? 'tool-call' : 'no-matching-tool', wanted: CALL_MATCH, match: match || null, toolNames });
      if (match) {
        sseToolCall(res, responseId, {
          itemId: 'fc_mock_' + seq,
          callId: 'call_mock_' + Date.now().toString(36),
          name: match,
          args: CALL_ARGS,
        });
        return;
      }
      // Falling through to text is deliberate: a run where the tool was never exposed must show the
      // requested name and the offered names, not a timeout.
    } else if (CALL_MATCH) {
      callLog.push({ at: entry.at, decision: 'final-text', modelCalls, sawToolOutput });
    }
    if (DELAY_MS > 0) setTimeout(() => sse(res, responseId, REPLY), DELAY_MS);
    else sse(res, responseId, REPLY);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port, reply: REPLY, delayMs: DELAY_MS, call: CALL_MATCH || null }));
});

// The caller drives this process, so the decision log has to be readable without guessing when to
// stop it: SIGTERM is the normal exit and it prints the log on the way out.
const dump = () => { if (CALL_MATCH) console.log(JSON.stringify({ callLog })); };
process.on('SIGTERM', () => { try { dump(); } catch {} try { server.close(); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { dump(); } catch {} try { server.close(); } catch {} process.exit(0); });