// The measured dsh /api contract, as executable code.
//
// This is the only file that has to change when dsh changes its wire format. docs/API-CONTRACT.md
// documents the same surface and lists the probes to re-run after an upgrade. Everything here is
// pure - no sockets, no process state - so tests/contract.test.mjs can pin it without a running dsh.
//
// MEASURED against dsh 0.2.1-rc.2.
import fs from 'node:fs';
import path from 'node:path';

export const TESTED_DSH = '0.2.1-rc.2';

/* ------------------------------------------------------------------ envelope */
// POST /api/<endpoint> with this body; the reply is {type:"server-response",rpcId,result:{ok,value|error}}.
export const envelope = (method, args, rpcId) => ({ type: 'client-request', rpcId, method, payload: { args } });

// The per-endpoint arg wrapper. Note the inconsistency: session/list wants `_request`, session/create
// wants `request`, and session/modelCatalog rejects either - it takes a bare empty object.
export const ARGS = {
  modelCatalog: () => ({}),
  sessionList: () => ({ _request: {} }),
  // MEASURED: cwd and workspaceId are mutually exclusive in session/create, and only workspaceId
  // decides the sidebar group, so it wins when a caller has both.
  sessionCreate: ({ sessionId, cwd, workspaceId, agentPreset }) => ({ request: {
    sessionId, ...(workspaceId ? { workspaceId } : cwd ? { cwd } : {}), ...(agentPreset ? { agentPreset } : {}) } }),
  sessionPrompt: ({ requestId, sessionId, text, mode = 'queue' }) => ({ request: {
    requestId, sessionId, mode, content: [{ type: 'text', text }] } }),
  sessionProjections: (sessionId) => ({ request: { sessionId } }),
  sessionPage: ({ sessionId, throughSeq, maxMessages }) => ({ request: {
    address: { kind: 'session', sessionId }, throughSeq, maxMessages } }),
  sessionSelectModel: ({ sessionId, provider, model, reasoningEffort }) => ({ request: {
    sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } }),
  sessionCancel: (sessionId) => ({ request: { sessionId } }),
  workspaceCreate: (pathValue) => ({ request: { path: pathValue } }),
};

// GET /connect?token=&interactions=answer -> 302 + `dsh-auth-<base64url(sha256(authority))>` = owner
// principal. Only this exact cookie name matters; interactions=answer is what grants replying.
export const authCookie = (setCookieHeaders) =>
  (setCookieHeaders.find((x) => x.startsWith('dsh-auth-')) || '').split(';')[0] || null;

// session/page refuses throughSeq > asOfSeq and says "past cursor N"; N is the real cursor.
export const pastCursor = (message) => {
  const m = /past cursor (\d+)/.exec(String(message || ''));
  return m ? Number(m[1]) : null;
};

/* ------------------------------------------------------------------ model policy */
// "provider/model[:effort|effort](, ...)" - null means unrestricted (dsh's own profile default).
// An entry that ends in ":" or lacks a model is a config typo and must not degrade into a deny-all.
export function parseAllowlist(raw) {
  if (!String(raw || '').trim()) return null;
  const rows = String(raw).split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [pm, eff] = entry.split(':');
    const [provider, ...rest] = String(pm).split('/');
    const efforts = eff === undefined ? null : eff.split('|').map((x) => x.trim()).filter(Boolean);
    return { provider, model: rest.join('/'), efforts };
  });
  const bad = rows.filter((r) => !r.provider || !r.model || (r.efforts && !r.efforts.length));
  if (!rows.length || bad.length) {
    throw new Error(`DSH_ALLOWED_MODELS="${raw}" does not parse. Grammar: provider/model[:effort|effort](, ...)`);
  }
  return rows;
}
export const allowedText = (allow) =>
  (allow || []).map((a) => `${a.provider}/${a.model}${a.efforts ? ':' + a.efforts.join('|') : ''}`).join(', ') || '(empty)';

export function checkPolicy(allow, provider, model, effort) {
  if (!allow) return null;
  const hit = allow.find((a) => a.provider === provider && a.model === model);
  if (!hit) return `"${provider}/${model}" is not permitted by DSH_ALLOWED_MODELS (allowed: ${allowedText(allow)})`;
  if (effort && hit.efforts && !hit.efforts.includes(effort)) {
    return `effort "${effort}" is not permitted for ${provider}/${model} (allowed: ${hit.efforts.join('|')})`;
  }
  return null;
}
export const splitModel = (m) => {
  const [p, ...r] = String(m || '').split('/');
  return r.length ? { provider: p, model: r.join('/') } : { provider: '', model: m };
};

// session/selectModel answers with an object, projections.modelSelection with a string. Tool output
// must read the same either way, or an agent auditing a round sees "[object Object]".
export const modelLabel = (m) => {
  if (!m) return null;
  if (typeof m === 'string') return m;
  const provider = m.provider || m.id || '';
  const model = m.model || m.name || '';
  if (!provider && !model) return null;
  return `${provider ? provider + '/' : ''}${model}${m.reasoningEffort ? ':' + m.reasoningEffort : ''}`;
};

/* ------------------------------------------------------------------ identity checks */
export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function checkAlias(alias) {
  if (!ALIAS_RE.test(String(alias || ''))) {
    throw new Error(`alias "${alias}" must match ${ALIAS_RE} (it becomes the session id "dsh-<alias>" and a ledger key)`);
  }
  return alias;
}
// dsh records cwd verbatim, so "C:/x", "C:\x" and "C:\x\" have to compare equal or session filtering
// silently returns nothing. A drive root keeps its separator so "C:\" does not collapse to "c:".
export const normCwd = (p) => String(p || '').replace(/[\\/]+/g, '\\').toLowerCase().replace(/([^:])\\$/, '$1');
// MEASURED: dsh records cwd verbatim and "C:/x" is not "C:\x", so adoption across surfaces fails with
// `was recorded in "C:/...", not "C:\..."` unless every path is canonicalised the same way.
export function checkCwd(cwd) {
  let p = String(cwd || '');
  if (process.platform === 'win32') p = p.replace(/\//g, '\\');
  p = p.replace(/[\\/]+$/, '');
  if (!path.win32.isAbsolute(p) && !path.posix.isAbsolute(p)) throw new Error(`cwd must be absolute, got "${cwd}"`);
  if (!fs.existsSync(p)) throw new Error(`cwd does not exist: "${p}". Create it, or point at the real workspace.`);
  return p;
}

/* ------------------------------------------------------------------ round handle */
// Only the handle is persisted; the audit payload is always re-read from dsh.
export const roundRecord = (r, pinned) => ({ requestId: r.requestId, sinceSeq: r.sinceSeq,
  correlated: r.correlated, dispatchedAt: r.dispatchedAt, outcome: r.state, pinned: pinned ?? null });

// The pre-dispatch asOfSeq can be overtaken by anything else writing to the session. Correlating on
// the requestId gives the true baseline; without it, another round's turn/end can decide this one.
// Only events strictly after the pre-dispatch cursor can belong to the round, which is also what
// keeps an older message that merely quotes the same requestId out of the baseline.
export function baselineFrom(preSeq, events, requestId) {
  const seqs = (events || []).filter((e) => e && e.seq > preSeq && JSON.stringify(e).includes(requestId)).map((e) => e.seq);
  return seqs.length ? { sinceSeq: Math.min(...seqs) - 1, correlated: true } : { sinceSeq: preSeq, correlated: false };
}

/* ------------------------------------------------------------------ projections envelope */
// MEASURED (2026-10-18): session/projections answers {kind, asOfSeq, values:{...}} - the interesting
// fields (permissions, agentPreset, workingDirectory, tokenUsage, contextPressure, plan,
// userQuestions, turnOutline, modelSelection) are nested under `values`, NOT at the top. Reading them
// off the top level returns undefined for every one of them, which is how a workspace-write sandbox
// denial stayed invisible to the caller. asOfSeq is needed for cursors, so it is lifted back up.
export function unwrapProjections(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.values && typeof v.values === 'object') return { ...v.values, kind: v.kind, asOfSeq: v.asOfSeq };
  return v;
}

/* ------------------------------------------------------------------ dispatch advisory */
// The session's sandbox scope is its cwd, so a task that names paths outside it is a guaranteed
// denial, not a runtime surprise. Absolute-path-looking tokens only: ordinary prose must not warn.
const ABS_PATH_RE = /[A-Za-z]:[\\/][^\s"'`,;)\]]{2,}|(?:^|[\s(])((?:[\\/][^\s"'`,;)\]]{3,}))/g;
export function pathsOutsideCwd(task, cwd) {
  const inside = normCwd(cwd);
  const found = new Set();
  for (const m of String(task || '').matchAll(ABS_PATH_RE)) {
    const raw = (m[1] || m[0]).trim();
    if (!/[\\/]/.test(raw) || raw.length < 4) continue;
    const n = normCwd(raw);
    // keep the path itself, not every file under it
    const dir = n.replace(/[\\/][^\\/]*$/, '');
    if (dir !== inside && !dir.startsWith(inside + '\\') && !n.startsWith(inside + '\\')) found.add(raw.replace(/[\\/]+$/, ''));
  }
  return [...found].slice(0, 8);
}

/* ------------------------------------------------------------------ event reading */
const textOf = (content) => (content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
// dsh double-encodes tool arguments as a JSON string; unwrap until it stops being a string, then
// serialise once, so the audit reads as one layer of quoting instead of a \\-escaped wall.
export function argText(a) {
  if (a == null) return '';
  let v = a;
  if (typeof v === 'string') {
    for (let i = 0; i < 2; i++) { try { v = JSON.parse(v); } catch { break; } }
  }
  return (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 220);
}

// MEASURED (2026-10-18): a denied file operation does NOT raise a server-side approval queue. The
// denial comes back as a tool/result with isError, and dsh appends the escalation hint to its text.
// So the only honest way to surface "this needs the user's approval" is to hand the body through.
const SANDBOX_MARK = /sandbox:\s*file access denied|escalation available|File sandbox:|operation not permitted/i;
const bodyOf = (r) => textOf(r.data?.message?.content) || String(r.data?.error?.message || '');

// Four states, MEASURED: "completed" and an error kind come from turn/end; "running" and "idle" are
// inferred, and a running->idle flip alone proves nothing. session/list.running is the only live flag
// worth trusting, which is why it is passed in rather than derived from the log.
export function interpret(events, running = null) {
  const evs = events || [];
  const turnEnd = evs.filter((e) => e.type === 'turn/end').pop();
  const texts = evs.filter((e) => e.type === 'assistant/message').map((a) => textOf(a.data?.message?.content)).filter(Boolean);
  const toolCalls = evs.filter((e) => e.type === 'tool/call');
  const toolResults = evs.filter((e) => e.type === 'tool/result');
  const touched = new Set();
  for (const r of toolResults) for (const c of (r.data?.message?.content || [])) {
    if (typeof c?.text !== 'string') continue;
    for (const m of c.text.matchAll(/<path>([^<\n]+)<\/path>/g)) touched.add(m[1].trim());
  }
  // A bare error COUNT is useless to an auditor: the bodies are what say whether the round failed on
  // a sandbox denial, a tool bug, or the task itself. tool/result carries no name, so it is joined
  // back to its tool/call by (turn, step) - both are present on each event.
  const stepName = new Map();
  for (const c of toolCalls) stepName.set(`${c.data?.turn}:${c.data?.step}`, { name: c.data?.name || null, callId: c.data?.callId || null });
  const failed = toolResults.filter((r) => r.data?.message?.isError);
  const reason = turnEnd?.data?.reason || {};
  return {
    settled: !!turnEnd,
    running,
    state: turnEnd ? (reason.kind === 'completed' ? 'completed' : String(reason.kind || 'unknown'))
      : running === false ? 'idle' : 'running',
    error: reason.error ? { code: reason.error.code || null, message: String(reason.error.message || '').slice(0, 400) } : null,
    lastAssistantText: texts[texts.length - 1] || '',
    toolCallCount: toolCalls.length,
    toolErrorCount: failed.length,
    toolErrors: failed.slice(-6).map((r) => {
      const j = stepName.get(`${r.data?.turn}:${r.data?.step}`) || {};
      return { seq: r.seq, turn: r.data?.turn, step: r.data?.step ?? null, name: j.name ?? null,
        code: r.data?.error?.code || null,
        body: bodyOf(r).replace(/\s+/g, ' ').trim().slice(0, 400) };
    }),
    sandboxDenials: failed.filter((r) => SANDBOX_MARK.test(bodyOf(r))).length,
    touchedFiles: [...touched].slice(0, 25),
    toolCalls: toolCalls.slice(-8).map((c) => ({ name: c.data?.name, turn: c.data?.turn, args: argText(c.data?.arguments) })),
  };
}
