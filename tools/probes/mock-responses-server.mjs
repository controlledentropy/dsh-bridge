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
import http from 'node:http';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const LOG = flag('--log', '');
const REPLY = flag('--text', 'MOCK-ACK');
const PORT = Number(flag('--port', '0'));
const DELAY_MS = Number(flag('--delay', '0'));
const FULL_LOG = flag('--full-log', '');

const requests = [];
const record = (o) => {
  requests.push(o);
  if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); } catch {} }
};

let seq = 0;
const ev = (type, payload) => { seq++; return 'event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: seq, ...payload }) + '\n\n'; };

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
    if (DELAY_MS > 0) setTimeout(() => sse(res, responseId, REPLY), DELAY_MS);
    else sse(res, responseId, REPLY);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port, reply: REPLY, delayMs: DELAY_MS }));
});

process.on('SIGTERM', () => { try { server.close(); } catch {} process.exit(0); });