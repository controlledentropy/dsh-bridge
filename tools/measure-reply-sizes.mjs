// Re-measures the reply sizes the README quotes, against a real round on the running instance.
// Read-only: no dispatch, no model tokens. Usage: node tools/measure-reply-sizes.mjs <alias>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

const PKG = process.cwd();
const ALIAS = process.argv[2] || 'p0-warmup';
const client = new Client({ name: 'size-measure', version: '0.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(PKG, 'bridge.mjs')], env: { ...process.env } });
await client.connect(transport);
const B = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
  return { bytes: B(JSON.parse(r.content[0].text)), obj: JSON.parse(r.content[0].text) };
};
try {
  const listed = await client.listTools();
  const fixed = B(listed);
  const out = { alias: ALIAS, fixedToolDefinitionsBytes: fixed, tools: listed.tools.length };
  out.status = await call('dsh_status', { alias: ALIAS });
  out.statusDetail = await call('dsh_status', { alias: ALIAS, detail: true });
  out.wait = await call('dsh_wait', { alias: ALIAS, maxSeconds: 5 });
  out.resultFinal = await call('dsh_result', { alias: ALIAS });
  out.resultFull = await call('dsh_result', { alias: ALIAS, only: 'full', maxTextBytes: 200000 });
  out.report = {
    fixed: out.fixedToolDefinitionsBytes,
    status_slim: out.status.bytes, status_detail: out.statusDetail.bytes,
    wait_slim: out.wait.bytes,
    result_final: out.resultFinal.bytes, result_full: out.resultFull.bytes,
    round: { state: out.resultFinal.obj.state, toolCalls: out.resultFull.obj.toolCalls?.length ?? null,
      toolErrors: out.resultFinal.obj.toolErrorCount ?? null, assistantMessages: out.resultFull.obj.assistantMessages ?? null,
      window: out.resultFull.obj.window ?? null },
    status_keys: Object.keys(out.status.obj).join(','),
    result_keys: Object.keys(out.resultFinal.obj).join(','),
  };
  console.log(JSON.stringify(out.report, null, 1));
} finally {
  await transport.close().catch(() => {});
}
