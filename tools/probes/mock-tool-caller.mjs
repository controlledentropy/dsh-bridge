#!/usr/bin/env node
// A mock model that runs ONE shell command through Codex's own exec_command tool and reports back
// what the tool subprocess actually saw.
//
// The point is not the answer: it is that the command is executed by whatever identity Codex uses for
// tools, inside whatever sandbox the thread declares. Reading the config would only tell us what was
// asked for; this asks the process itself.
//
//   node tools/probes/mock-tool-caller.mjs --port 0 --log <req> --out <tool-output.jsonl> --cmd <cmd>
import http from 'node:http';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const LOG = flag('--log', '');
const OUT = flag('--out', '');
const PORT = Number(flag('--port', '0'));
const CMD = flag('--cmd', 'whoami');

let seq = 0;
const ev = (type, payload) => { seq++; return 'event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: seq, ...payload }) + '\n\n'; };
const calls = [];

// Pull the tool result out of the follow-up request. Its shape is a function_call_output item whose
// output is the tool's own stdout/stderr text - that text is the evidence.
function toolOutputOf(body) {
  const input = body && body.input;
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const it of input) {
    if (it && (it.type === 'function_call_output' || it.type === 'custom_tool_call_output')) {
      out.push({ call_id: it.call_id || null, output: typeof it.output === 'string' ? it.output : JSON.stringify(it.output) });
    }
    if (it && it.type === 'function_call') out.push({ role: 'call', name: it.name, arguments: it.arguments });
  }
  return out.length ? out : null;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = null; try { parsed = JSON.parse(body); } catch {}
    calls.push({ at: new Date().toISOString(), n: calls.length + 1 });
    if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), path: req.url }) + '\n'); } catch {} }
    const outputs = toolOutputOf(parsed);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const responseId = 'resp_' + Date.now().toString(36);
    res.write(ev('response.created', { response: { id: responseId, status: 'in_progress', output: [] } }));

    if (!outputs) {
      // First pass: ask Codex to run the command.
      const itemId = 'fc_' + Date.now().toString(36);
      const args = JSON.stringify({ cmd: CMD });
      res.write(ev('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: itemId, call_id: 'call_' + itemId, name: 'exec_command', arguments: '', status: 'in_progress' } }));
      res.write(ev('response.function_call_arguments.delta', { item_id: itemId, output_index: 0, delta: args }));
      res.write(ev('response.function_call_arguments.done', { item_id: itemId, output_index: 0, arguments: args }));
      res.write(ev('response.output_item.done', { output_index: 0, item: { type: 'function_call', id: itemId, call_id: 'call_' + itemId, name: 'exec_command', arguments: args, status: 'completed' } }));
      res.write(ev('response.completed', { response: { id: responseId, status: 'completed', output: [{ type: 'function_call', id: itemId, call_id: 'call_' + itemId, name: 'exec_command', arguments: args }] } }));
      res.end();
      return;
    }

    // Second pass: the tool has run. Persist what it returned, then close the turn with a short note.
    if (OUT) { try { fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cmd: CMD, outputs }) + '\n'); } catch {} }
    const itemId = 'msg_' + Date.now().toString(36);
    const text = 'DONE-THIS-MESSAGE-DOES-NOT-REPEAT-THE-TOOL-OUTPUT';
    res.write(ev('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }));
    res.write(ev('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text }));
    res.write(ev('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text }));
    res.write(ev('response.output_item.done', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] } }));
    res.write(ev('response.completed', { response: { id: responseId, status: 'completed', output: [{ type: 'message', id: itemId, role: 'assistant', content: [{ type: 'output_text', text }] }] } }));
    res.end();
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, cmd: CMD })));
process.on('SIGTERM', () => { try { server.close(); } catch {} process.exit(0); });