// dsh ships the table of RPC methods its HTTP gateway will actually forward, inside its own package:
// every entry carries the service that implements it and a one-line description. Reading that file
// beats the only other option - guessing a method name and reading the 404 - because "the gateway does
// not forward it" and "I guessed the name wrong" are indistinguishable from outside, and the two lead
// to opposite documentation. This module is pure: it takes text and returns structure, so it can be
// tested offline against a fixture and reused by both the generator tool and `launch.mjs check`.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ENTRY_RE = /"([a-zA-Z][a-zA-Z0-9]*(?:\/[a-zA-Z][a-zA-Z0-9]*)+)":\s*\{\s*service:\s*"([^"]+)",\s*description:\s*"((?:[^"\\]|\\.)*)"/g;
// The bridge's own calls are all literal `call('method/name', ...)`, so its dependency on the surface
// is readable without running anything.
const USED_RE = /call\(\s*'([a-zA-Z][a-zA-Z0-9]*\/[a-zA-Z][a-zA-Z0-9]*)'/g;

// Returns [{ method, service, description }] sorted by method name. Entries that do not match the
// shape are skipped rather than guessed at: a partial read must look like a partial read.
export function parseRemoteTable(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(ENTRY_RE)) {
    if (out.has(m[1])) continue;
    let description = m[3];
    try { description = JSON.parse(`"${m[3]}"`); } catch {}
    out.set(m[1], { method: m[1], service: m[2], description });
  }
  return [...out.values()].sort((a, b) => a.method.localeCompare(b.method));
}

export const usedEndpoints = (bridgeSource) =>
  [...new Set([...String(bridgeSource || '').matchAll(USED_RE)].map((m) => m[1]))].sort();

// The digest covers method names only, never descriptions: an upgrade that rewords a description is
// not a contract change, while an added or removed method always is.
export const surfaceDigest = (methods) =>
  createHash('sha256').update([...methods].map((m) => m.method).sort().join('\n')).digest('hex').slice(0, 16);

export const diffSurface = (before, after) => {
  const a = new Set([...before].map((m) => m.method));
  const b = new Set([...after].map((m) => m.method));
  return { added: [...b].filter((m) => !a.has(m)).sort(), removed: [...a].filter((m) => !b.has(m)).sort() };
};

// Where dsh keeps its remotes package. It is a dependency of the CLI, so it is normally under
// node_modules of the installed package, but a hoisted install puts it one level up.
export function findRemoteTable(pkgDir) {
  if (!pkgDir) return '';
  const rel = path.join('node_modules', '@deepseek-ai', 'dsh-api-remotes', 'lib', 'client.js');
  const candidates = [
    path.join(pkgDir, rel),
    path.join(path.dirname(pkgDir), 'dsh-api-remotes', 'lib', 'client.js'),
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || '';
}
