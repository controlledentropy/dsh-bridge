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
  // MEASURED: only the catalog is forwarded over HTTP. permissionPresets/set, permissionPresets/current
  // and session/setSandboxMode all answer 404 "not found", so the sandbox mode of a running session
  // cannot be changed through /api - it is a UI/in-process capability.
  permissionCatalog: () => ({}),
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

// MEASURED (0.2.1-rc.2): session/modelCatalog groups are {id, name, models[]}, and each model declares
// its own efforts at `reasoning.efforts[].id` plus `reasoning.defaultEffort`. The efforts differ per
// model - qoder/qfmodel accepts low|medium and rejects minimal|high|max, while
// workbuddy/deepseek-v4.1-flash accepts low and max. So the catalog is the authority and nobody has to
// discover effort legality by calling selectModel, which is a WRITE (it sets modelSelection.next).
// Returns { efforts: [..]|null, defaultEffort, effortDescriptions } - efforts stay null when the build
// does not declare them, so a missing list is reported as unknown, never as "anything goes".
export function modelEfforts(m) {
  const r = m?.reasoning ?? m?.reasoningEfforts ?? null;
  const list = Array.isArray(r?.efforts) ? r.efforts : (Array.isArray(r) ? r : null);
  if (!list) return { efforts: null, defaultEffort: r?.defaultEffort ?? m?.defaultEffort ?? null, descriptions: null };
  const efforts = list.map((e) => (typeof e === 'string' ? e : e?.id ?? e?.name ?? null)).filter(Boolean);
  const descriptions = {};
  for (const e of list) {
    const id = typeof e === 'string' ? e : e?.id;
    if (id) descriptions[id] = String(e?.description || e?.name || '').slice(0, 120);
  }
  return { efforts: efforts.length ? efforts : null, defaultEffort: r?.defaultEffort ?? null,
    descriptions: Object.keys(descriptions).length ? descriptions : null };
}

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
// The session's sandbox scope IS its cwd, so a task that names paths outside it is a guaranteed
// denial rather than a runtime surprise. Two false-positive classes must be excluded or the advisory
// becomes noise that gets ignored: URLs (a "://" leaves a drive-letter-shaped fragment behind, e.g.
// "s:/www.unicode.org/..." out of "https://www.unicode.org/...") and Windows paths containing spaces,
// where only the first token would match ("D:/Program" out of "D:/Program Files/nodejs").
const QUOTED_PATH_RE = /["'`]([A-Za-z]:[\\/][^"'`\n]+)["'`]/g;
// CJK punctuation is excluded as well: task text is Chinese, and without it "…\02f.md（只读引用）" was
// matched as one token, failed the existence check with the punctuation glued on, and vanished from
// the scan - which silently disabled the guard on exactly the briefs it exists for.
const BARE_PATH_RE = /(?<![:/\w])[A-Za-z]:[\\/][^\s"'`<>,;|)\]（）｛｝【】《》「」『』。、，；：！？]+/g;
const stripTrailing = (s) => s.replace(/[.,;:)\]]+$/, '').replace(/[\\/]+$/, '');
// A path a task *mentions* is not a path a task *writes*, and only the second one is denied by the
// sandbox. Treating every mention as a write refused the pattern this project recommends (read the
// ticket from the parent repo, write the deliverable into the worktree).
//
// MEASURED misclassifications this replaced, and the rules that fix them:
//  - "Update the checklist; the spec lives at \"D:\\…\\bin\"" was a write because a verb 25 chars away
//    in a DIFFERENT clause matched. So intent is read from the clause the path sits in, not a fixed
//    character window.
//  - "把报告写入 X，格式依据 README" was demoted to read because 依据 (provenance) shared a table with
//    只读 (access mode). Provenance words are gone from the read list; only an explicit read-only
//    annotation counts.
//  - "禁止覆盖 X" was a write because polarity was thrown away. Negation now wins.
const WRITE_INTENT_RE = /写入|写到|落盘|生成|创建|新建|保存|追加|覆盖|修改|改动|编辑|删除|清理|补齐|补充|补测试|[抄复制搬移转贴存导出]到|输出到|提交|更新|实现|重构|部署|安装|\b(write|wrote|creat|save|generat|append|overwrit|edit|modif|delet|remov|move|copy|commit|produc|updat|rework|refactor|deploy|implement)\w*/i;
const READ_MARK_RE = /只读|readonly|read[-\s]?only|仅供参考|不写入|不要写入|reference\s+only|for\s+reference/i;
const NEGATION_RE = /禁止|不要|不得|切勿|不可|别|无需|do\s+not|don'?t|never|avoid|no\s+need/i;
const CLAUSE_MAX_BEFORE = 80;
const CLAUSE_SPLIT_RE = /[\n。；;！!？?]/;
// Chinese states a location before the action - "在 X 里实现并跑测试" puts the verb AFTER the path.
const LOCATIVE_RE = /^\s*(?:里|中|内|下面|目录下|目录|文件夹|下)/;
const clauseStart = (text, at) => {
  const from = Math.max(0, at - CLAUSE_MAX_BEFORE);
  for (let i = at - 1; i >= from; i--) if (CLAUSE_SPLIT_RE.test(text[i])) return i + 1;
  return from;
};
function isWriteTarget(text, at, length) {
  const clause = text.slice(clauseStart(text, at), at);
  const after = text.slice(at + length, at + length + 40);
  if (READ_MARK_RE.test(after) || READ_MARK_RE.test(clause)) return false;
  if (NEGATION_RE.test(clause.slice(-14))) return false;   // "禁止覆盖 X" is a prohibition, not a plan
  if (WRITE_INTENT_RE.test(clause)) return true;
  return LOCATIVE_RE.test(after.slice(0, 12)) && WRITE_INTENT_RE.test(after) && !NEGATION_RE.test(after.slice(0, 14));
}
// Returns { all, write, read }: `write` is what this session's sandbox will deny, `read` is advisory.
// Paths inside the workspace are never listed.
export function pathsOutsideCwd(task, cwd) {
  const inside = normCwd(cwd);
  const text = String(task || '');
  const outside = (p) => {
    const n = normCwd(p);
    return n !== inside && !n.startsWith(inside + '\\') && !inside.startsWith(n + '\\');
  };
  const hits = new Map();
  const add = (raw, index, length, mustExist) => {
    const p = stripTrailing(raw);
    if (p.length < 4 || !/[\\/]/.test(p) || !outside(p)) return;
    // An unquoted match stops at the first space, so "D:/Program Files/x" yields the fragment
    // "D:/Program". Quoted paths are trusted as written; bare ones must resolve to something real,
    // otherwise the advisory fills with fragments and gets ignored - which is how a real violation
    // hides among false positives.
    //
    // A deliverable named in a brief usually does NOT exist yet, and MEASURED: requiring existence hid
    // "把结论写入 D:\x\report.md" completely, so the guard was blind to precisely the writes it exists to
    // catch. An extension is what distinguishes a complete file path from a space-truncated directory
    // fragment, so one is accepted on its own terms. (A new *directory* target with no extension is
    // still invisible to this scan - quoted, and the guard sees it.)
    if (mustExist && !fs.existsSync(p) && !/\.[A-Za-z0-9]{1,6}$/.test(p)) return;
    const key = normCwd(p);
    // Keep one entry per directory tree, and let the strongest claim win: naming both "X" and a file
    // under it is noise, while a write into a path already listed as read-only must not be softened.
    for (const kept of [...hits.keys()]) {
      if (kept === key) { hits.set(key, { path: hits.get(kept).path, write: hits.get(kept).write || isWriteTarget(text, index, length) }); return; }
      if (key.startsWith(kept + '\\')) {         // a descendant of something already kept
        hits.set(kept, { path: hits.get(kept).path, write: hits.get(kept).write || isWriteTarget(text, index, length) });
        return;
      }
      if (kept.startsWith(key + '\\')) hits.delete(kept);   // an ancestor of what was kept
    }
    hits.set(key, { path: p, write: isWriteTarget(text, index, length) });
  };
  const quoted = [...text.matchAll(QUOTED_PATH_RE)];
  for (const m of quoted) add(m[1], m.index, m[0].length, false);
  for (const m of text.matchAll(BARE_PATH_RE)) {
    if (quoted.some((q) => m.index >= q.index && m.index < q.index + q[0].length)) continue;
    add(m[0], m.index, m[0].length, true);
  }
  const all = [...hits.values()];
  return { all: all.map((h) => h.path), write: all.filter((h) => h.write).map((h) => h.path),
    read: all.filter((h) => !h.write).map((h) => h.path) };
}

/* ------------------------------------------------------------------ paging window */
// session/page answers with the newest `maxMessages` events at or below `throughSeq`. Anchoring the
// cursor at the tail therefore loses an older round entirely - and an aborted round then reads back
// as "idle", which is exactly the false-negative the state machine exists to prevent. A round is
// always read from its own baseline; only "what is this session doing right now" wants the tail.
export function pageWindow({ sinceSeq, asOfSeq, maxMessages, anchored = 'baseline' }) {
  const asOf = Number(asOfSeq) || 0;
  if (!asOf) return { throughSeq: 0, sinceSeq: Number(sinceSeq) || 0, anchored, note: 'no readable log yet (asOfSeq=0)' };
  // A negative sinceSeq means "include seq 0", which is where a session's first permission/preset lives.
  const from = anchored === 'tail' ? Math.max(0, asOf - maxMessages) : (Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0);
  return { throughSeq: Math.min(asOf, from + maxMessages), sinceSeq: from, anchored };
}

/* ------------------------------------------------------------------ permission state */
// MEASURED: the effective sandbox mode is `projections.values.permissions.currentValue`, and the
// moments it changed are `permission/preset` events. A session a human escalated mid-flight is not
// comparable to the round that failed before the escalation, so the history travels with the audit.
export function permissionHistory(events) {
  const evs = events || [];
  const presets = evs.filter((e) => e?.type === 'permission/preset')
    .map((e) => ({ seq: e.seq, preset: e.data?.preset ?? null, at: e.time ?? null }));
  const modes = evs.filter((e) => e?.type === 'sandbox/mode')
    .map((e) => ({ seq: e.seq, mode: e.data?.mode ?? null, source: e.data?.source ?? null }));
  // MEASURED: escalating the preset also flips the approval policy (ask -> never) and is driven by a
  // `command/run` whose source says who did it, so "was this raised by a human" is answerable. The
  // event carries {commandId, name, args?, source} - the command text is name+args, not a `line`.
  const approvals = evs.filter((e) => e?.type === 'approval/policy')
    .map((e) => ({ seq: e.seq, policy: e.data?.policy ?? null }));
  // MEASURED: `source` arrives as an object ({kind:"user"}), and `args` may carry its own leading
  // space, so both are normalised - an audit field that prints "[object Object]" gets ignored.
  const srcOf = (s) => (s && typeof s === 'object' ? (s.kind || JSON.stringify(s)) : s ?? null);
  const commands = evs.filter((e) => e?.type === 'command/run')
    .map((e) => ({ seq: e.seq, command: [e.data?.name, e.data?.args].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80),
      source: srcOf(e.data?.source) }));
  const first = presets.length ? presets[0].preset : null;
  const last = presets.length ? presets[presets.length - 1].preset : null;
  return { presets, modes, approvals, commands, firstPreset: first, lastPreset: last,
    escalated: presets.length > 1 && first !== last,
    escalatedBy: commands.find((c) => /permission/i.test(c.command))?.source ?? null };
}

// MEASURED (2026-10-18): under approval policy "ask", an operation dsh will not do silently emits
// `approval/asked {id, toolName, reason}` and waits for a human; `approval/decided {id, outcome}`
// closes it (observed outcomes: allowed-once, cancelled). A round can therefore sit waiting on a
// person while looking merely "running" - which is fatal for unattended dispatch, so the unanswered
// ones are surfaced explicitly instead of being inferred from a timeout.
export function approvalState(events) {
  const asked = [];
  const decided = new Map();
  let policy = null;
  for (const e of events || []) {
    if (e?.type === 'approval/policy') policy = e.data?.policy ?? policy;
    else if (e?.type === 'approval/asked') {
      asked.push({ seq: e.seq, id: e.data?.id ?? null, toolName: e.data?.toolName ?? null,
        reason: String(e.data?.reason ?? '').replace(/\s+/g, ' ').slice(0, 200) });
    } else if (e?.type === 'approval/decided') decided.set(e.data?.id ?? null, e.data?.outcome ?? null);
  }
  const pending = asked.filter((a) => a.id === null || !decided.has(a.id));
  return { approvalPolicy: policy, approvalAsked: asked.length,
    approvals: asked.map((a) => ({ ...a, outcome: decided.get(a.id) ?? null })), pending };
}

// MEASURED: a round can span hundreds of events, so any fixed-size window may miss its verdict - and
// a window that reaches past the round picks up the NEXT round's turn/end, which reads a user-aborted
// round as "completed". Cutting at the round's own first turn/end is what makes the verdict belong to
// the round that is being audited.
export function sliceRound(events) {
  const evs = events || [];
  const end = evs.findIndex((e) => e?.type === 'turn/end');
  return end < 0 ? evs : evs.slice(0, end + 1);
}

// MEASURED: one round spanned 1080+ events with its verdict at seq 1084, while a 1000-message window
// opened at the baseline stopped at 1004 - so a COMPLETED round was read back as "idle". Any fixed
// budget is a guess at the round's length, so the read walks the cursor forward until the round's own
// turn/end is collected, then cuts at it. `walk:false` keeps polling cheap: one small page, no verdict
// guarantee, which is why the caller must not treat that state as settled.
// `pageFn(cursor, maxMessages)` is the network read; keeping it injected is what makes this testable
// offline, and the paging rule is the part that breaks first on a dsh upgrade.
export const PAGE_SIZE = 1000;
export const MAX_PAGES = 12;
export async function walkRound(pageFn, sinceSeq, { walk = true, first = 24, pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {}) {
  const base = Number(sinceSeq) || 0;
  let cursor = base;
  let all = [];
  let asOfSeq = 0;
  let pages = 0;
  for (;;) {
    const w = await pageFn(cursor, pages === 0 ? first : pageSize);
    asOfSeq = w?.window?.asOfSeq ?? asOfSeq;
    all = all.concat(w?.events || []);
    pages++;
    const newest = w?.window?.newestSeq ?? null;
    if (all.some((e) => e?.type === 'turn/end') || !walk) break;
    if (!newest || newest >= asOfSeq || pages >= maxPages) break;
    cursor = newest;
  }
  const evs = sliceRound(all);
  // The window describes the events being handed back, not everything the pages fetched: after the cut
  // at this round's turn/end, a later seq belongs to the next round and must not be reported as read.
  const lastSeq = evs.length ? evs[evs.length - 1].seq : base;
  const settled = evs.some((e) => e?.type === 'turn/end');
  return { events: evs,
    window: { sinceSeq: base, asOfSeq, pages, oldestSeq: evs.length ? evs[0].seq : null, newestSeq: lastSeq,
      truncated: !settled && asOfSeq > lastSeq } };
}

// The reply shape an orchestrator needs to *branch*, in ~200 bytes. Everything else in a tool reply is
// either the deliverable (business text) or diagnostics, and both cost the calling model's context on
// every read - so the default carries only this, and detail:true is the explicit way to ask for more.
export const VERDICT_KEYS = ['state', 'settled', 'running', 'error', 'abortReason', 'verdictComplete',
  'pending', 'waitingOnHuman', 'asked', 'note'];
export function pickVerdict(o) {
  const out = {};
  const keep = (v) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0);
  for (const k of VERDICT_KEYS) if (keep(o?.[k])) out[k] = o[k];
  // These two are load-bearing even when false - "not settled" is the answer, not an absence of one.
  for (const k of ['settled', 'verdictComplete']) if (o?.[k] !== undefined) out[k] = !!o[k];
  // These only qualify an ABSENT verdict, so they ride only while there is nothing to report yet.
  if (!o?.settled && o?.windowTruncated) out.windowTruncated = true;
  // The absence is the whole message here: "dsh never started this round" is the case an orchestrator
  // must not mistake for "still working". When it did start, state + the note already say enough, so
  // the field is dropped and a poll stays at its usual size.
  if (!o?.settled && o?.turnStarted === false) out.turnStarted = false;
  return out;
}

// Keep the tail of a text list under a byte budget: the final answer of a round is what the caller is
// auditing, so the oldest step narrations give way - and the drop is reported, never silent. The last
// text is never dropped whole: if it alone exceeds the budget it is cut instead, because an empty
// "result" is worse than a short one.
export function capTexts(items, maxBytes, key = 'text') {
  const list = items || [];
  const size = (x) => Buffer.byteLength(String(x?.[key] ?? ''), 'utf8');
  let bytes = 0;
  const kept = [];
  let dropped = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (bytes + size(list[i]) > maxBytes) { dropped = i + 1; break; }
    bytes += size(list[i]);
    kept.unshift(list[i]);
  }
  let cutInPlace = false;
  if (!kept.length && list.length) {
    const last = list[list.length - 1];
    // Cutting a UTF-8 string on a byte boundary leaves a replacement character at the end (measured:
    // 100 bytes of budget produced 102 bytes and a stray U+FFFD), so step back to a char boundary.
    const buf = Buffer.from(String(last?.[key] ?? ''), 'utf8');
    let end = Math.min(buf.length, maxBytes);
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    const cut = buf.subarray(0, end).toString('utf8');
    cutInPlace = size(last) > Buffer.byteLength(cut, 'utf8');
    kept.push({ ...last, [key]: cut, textTruncated: cutInPlace });
    dropped = list.length - 1;
  }
  return { kept, droppedCount: dropped, truncated: dropped > 0 || cutInPlace,
    note: dropped > 0
      ? `${dropped} earlier assistant message(s) omitted to stay under ${maxBytes} bytes; the round's verdict is unaffected - for the full transcript read the dsh UI or the report file the task wrote`
      : cutInPlace ? `the final message alone exceeds ${maxBytes} bytes and was cut; read the dsh UI or the report file for the rest` : undefined };
}

// The dispatch guard for a crossed client timeout: the timeout is the *client's* deadline, not dsh's
// cancellation (measured: request timed out at 6 s, the round still completed at ~14 s, no session/cancel
// sent). So a fresh dispatch that looks like a re-send of the round still in flight is refused rather
// than paying for the same work twice.
export function inFlightRound(s) {
  const r = (s?.rounds || []).slice(-1)[0];
  return r && r.outcome === 'running' ? r : null;
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
// The pattern must NOT include the bare `File sandbox: <mode>.` footnote: dsh appends that to
// ordinary tool output too, so matching it turns every unrelated failure into a "sandbox denial".
const SANDBOX_MARK = /sandbox:\s*file access denied|escalation available|operation not permitted|\bEPERM\b/i;
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
  // MEASURED: a bare error COUNT is useless to an auditor: the bodies are what say whether the round failed on
  // a sandbox denial, a tool bug, or the task itself. tool/result carries no name, so it is joined
  // back to its tool/call by (turn, step) - both are present on each event.
  const stepName = new Map();
  for (const c of toolCalls) stepName.set(`${c.data?.turn}:${c.data?.step}`, { name: c.data?.name || null, callId: c.data?.callId || null });
  const failed = toolResults.filter((r) => r.data?.message?.isError);
  const reason = turnEnd?.data?.reason || {};
  return {
    settled: !!turnEnd,
    turnStarted: evs.some((e) => e.type === 'turn/start'),
    running,
    state: turnEnd ? (reason.kind === 'completed' ? 'completed' : String(reason.kind || 'unknown'))
      : running === false ? 'idle' : 'running',
    error: reason.error ? { code: reason.error.code || null, message: String(reason.error.message || '').slice(0, 400) } : null,
    // MEASURED: an abort carries a nested reason - {"kind":"aborted","reason":{"kind":"user"}} - which
    // is the difference between "the operator stopped it" and "dsh gave up".
    abortReason: reason.kind === 'aborted' ? (reason.reason?.kind || null) : null,
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

// A round can be parked on a person in more than one way, and watching only approvals misses the common
// one. MEASURED (ptc session): ask_user_question is NOT directly callable (tool/result answers
// UNKNOWN_TOOL: "call ask_user_question from inside a run_code program instead"); run_code dispatches it,
// and the wait is the gap between `tool/ptc-dispatch-start` and the matching `tool/ptc-dispatch` sharing
// one subCallId - which only closes when a human answers. Observed: 102 s parked like that while
// approvalState.pending stayed empty, so the round read as ordinary "running". Only dispatches whose
// tool name is a question count; a long-running shell dispatch is work in progress, not a blocked round.
const QUESTION_TOOL_RE = /ask.*user|user.*question|question/i;
export function humanWaits(events, activeUserQuestions, { settled = false } = {}) {
  const open = new Map();
  for (const e of events || []) {
    if (e?.type === 'tool/ptc-dispatch-start' && e.data?.subCallId) {
      const d = e.data;
      open.set(d.subCallId, { kind: 'question', name: d.name || null, seq: e.seq, time: e.time ?? null,
        questions: ((d.arguments?.questions) || []).map((q) => ({ id: q?.id ?? null, header: q?.header ?? null,
          question: String(q?.question ?? '').slice(0, 200), options: (q?.options || []).map((o) => o?.label ?? o).slice(0, 8) })) });
    } else if (e?.type === 'tool/ptc-dispatch' && e.data?.subCallId) open.delete(e.data.subCallId);
  }
  const waits = [...open.values()];
  const asked = waits.filter((w) => QUESTION_TOOL_RE.test(String(w.name || '')));
  const active = Array.isArray(activeUserQuestions) ? activeUserQuestions : [];
  for (const q of active) {
    waits.push({ kind: 'userQuestion', name: q?.toolName || 'userQuestion', seq: q?.seq ?? null,
      questions: [{ id: q?.id ?? null, header: q?.header ?? null, question: String(q?.question ?? '').slice(0, 200),
        options: (q?.options || []).map((o) => o?.label ?? o).slice(0, 8) }] });
  }
  // A settled round is not parked on anyone. A cancelled ask_user_question leaves its dispatch unclosed
  // forever, so without this gate dsh_wait would bail out of finished work claiming a human is needed.
  return { humanWaits: waits, asked, waitingOnHuman: !settled && (asked.length > 0 || active.length > 0) };
}

// These fields are what an orchestrator branches on, so they are computed once, here, and tested
// offline. `verdictComplete` means exactly one thing: this round's own turn/end is in hand. It must
// never be OR-ed with window coverage, or a round that is legitimately still running - and whose log
// happens to be fully read - would report verdictComplete:true, the same false confidence the cursor
// walk was added to remove.
//
// There used to be a third field here, `logExhausted`, and it is gone on purpose: for any unsettled
// round it was exactly `!windowTruncated` (asOfSeq <= lastSeq vs. asOfSeq > lastSeq), so it carried no
// information while its name claimed the log had ended - which the read cannot know, because the log
// grows as we read it. What actually separates the two actionable readings is whether dsh ever recorded
// a turn/start for this round, and that is a fact about the events, so it is reported directly.
export function verdictFields(r, window) {
  const settled = !!r?.settled;
  const out = { windowTruncated: !!window?.truncated, verdictComplete: settled };
  if (settled || !window) return out;
  out.turnStarted = !!r.turnStarted;
  if (window.readFailed) {
    // A failed page read is not a short log: it cannot be reported as "the log ends at seq N", and the
    // seq is not even known, which is how a diagnostic used to print `seq undefined` at a caller.
    out.note = 'the event log for this round could not be read (dsh did not answer the page request); nothing about this round is verified - re-read with dsh_result';
  } else if (out.windowTruncated) {
    out.note = `no turn/end within seq ${window.sinceSeq}..${window.newestSeq} of ${window.asOfSeq}; state is not a verdict - re-read with dsh_result`;
  } else if (!r.turnStarted) {
    out.note = `the log ends at seq ${window.asOfSeq ?? '?'} and this round recorded no turn/start at all - the dispatch was not picked up. Treat as unverified.`;
  } else if (r.state === 'idle') {
    // MEASURED: a verdict sitting one seq beyond the read snapshot produced this exact shape, and the
    // old wording called an already-completed round "never dispatched" - the prescription that makes an
    // orchestrator re-run finished work. If the round started, "not picked up" is simply not the story.
    out.note = `this round started (first event seq ${window.oldestSeq ?? window.sinceSeq}) but no turn/end was seen within seq ${window.sinceSeq}..${window.newestSeq} of ${window.asOfSeq}; the log grew past the read snapshot - re-read, and do NOT re-dispatch`;
  }
  return out;
}
