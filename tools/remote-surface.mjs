#!/usr/bin/env node
// Regenerate docs/REMOTE-SURFACE.md from the dsh package installed on this machine.
//
//   node tools/remote-surface.mjs            # write the doc
//   node tools/remote-surface.mjs --check    # fail if the installed surface differs from the doc
//
// Run this after every `npm i -g @deepseek-ai/dsh@...` upgrade. It exists because the bridge's view of
// "what /api can do" was assembled by probing method names and reading 404s, which cannot tell a
// method that is not forwarded apart from a name that was guessed wrong - and both ended up in prose.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDsh } from '../launch.mjs';
import { parseRemoteTable, findRemoteTable, surfaceDigest, diffSurface, usedEndpoints } from '../lib/remote-surface.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(PKG, 'docs', 'REMOTE-SURFACE.md');
const check = process.argv.includes('--check');

const r = resolveDsh();
const tableFile = findRemoteTable(r.pkgDir);
if (!tableFile) {
  console.error(JSON.stringify({ ok: false, error: `no dsh-api-remotes table under ${r.pkgDir}`, hint: 'set DSH_PKG_DIR to the installed @deepseek-ai/dsh package' }, null, 1));
  process.exit(1);
}
const methods = parseRemoteTable(fs.readFileSync(tableFile, 'utf8'));
if (methods.length < 20) {
  console.error(JSON.stringify({ ok: false, error: `parsed only ${methods.length} methods from ${tableFile}`,
    hint: 'the table format changed - fix lib/remote-surface.mjs before trusting any of this' }, null, 1));
  process.exit(1);
}
const digest = surfaceDigest(methods);
const used = usedEndpoints(fs.readFileSync(path.join(PKG, 'bridge.mjs'), 'utf8'));

if (check) {
  if (!fs.existsSync(DOC)) { console.log(JSON.stringify({ ok: false, error: `${DOC} missing - run without --check first` }, null, 1)); process.exit(1); }
  const doc = fs.readFileSync(DOC, 'utf8');
  const recordedDigest = (doc.match(/名称摘要[^`]*`([0-9a-f]{16})`/) || [])[1] || null;
  const recorded = [...new Set([...doc.matchAll(/^\| `([a-zA-Z0-9/]+)` \|/gm)].map((m) => m[1]))];
  const d = diffSurface(recorded.map((method) => ({ method })), methods);
  const usedButAbsent = used.filter((m) => !methods.some((x) => x.method === m));
  const ok = recordedDigest === digest && d.removed.length === 0 && usedButAbsent.length === 0;
  console.log(JSON.stringify({ ok, installed: { version: r.version, methods: methods.length, digest },
    recordedDigest, addedSinceDoc: d.added, removedSinceDoc: d.removed, usedButAbsent,
    action: ok ? 'none' : 'node tools/remote-surface.mjs   # regenerate, then re-read docs/API-CONTRACT.md' }, null, 1));
  process.exit(ok ? 0 : 1);
}

const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const body = `# dsh 的可转发方法表（生成物，勿手改）

由 \`node tools/remote-surface.mjs\` 从本机安装的 dsh 包生成。它记录的是**网关会转发的方法全集**，
与桥接实际用到的子集（文末）。升级 dsh 后请重跑本工具，并用 \`node launch.mjs check\` 看漂移。

- 来源包：npm 全局目录下的 \`@deepseek-ai/dsh\`（本机具体位置随安装而变，故只记版本）
- dsh 版本：\`${r.version}\`
- 方法表文件（相对包根）：\`node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js\`
- 方法数：**${methods.length}**
- 名称摘要（只哈希方法名，不哈希描述）：\`${digest}\`

\`launch.mjs check\` 比对这个摘要：出现新增或缺失即报漂移，因为这时"某端点 404"可能不再是"没转发"，
而是"上游改名了"——两种情况在桥接日志里长得一模一样。

## 全集

| 方法 | 实现 service | 官方描述 |
| --- | --- | --- |
${methods.map((m) => `| \`${m.method}\` | ${esc(m.service)} | ${esc(m.description)} |`).join('\n')}

## 桥接实际使用的方法

${used.map((m) => `- \`${m}\`${methods.some((x) => x.method === m) ? '' : '  **(本机安装的 dsh 里没有这个方法 → 升级后先查这里)'}`).join('\n')}

不在此表里的方法一律不会经由 \`/api\` 到达 dsh：\`session/delete\`、\`session/archive\`、\`approval/*\`、
\`permissionPresets/set\`、\`session/setSandboxMode\` 都是这样被排除的（不是探测失误，而是表里就没有）。
桥接刻意不调用表里存在但会绕过会话权限的入口：\`terminal/create\`（官方描述明示"不受 Agent 沙箱与审批限制"）、
\`settings/mutate\`、\`credentials/set\`、\`pluginManager/*\`、\`dynamicCordisRunner/*\`。
`;
fs.writeFileSync(DOC, body);
console.log(JSON.stringify({ ok: true, wrote: DOC, methods: methods.length, digest, used: used.length,
  usedButAbsent: used.filter((m) => !methods.some((x) => x.method === m)) }, null, 1));
