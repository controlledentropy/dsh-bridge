// The bridge's audit log is the only independent record of what an orchestrator asked dsh to do, so the
// worst thing it can do is stop without saying so. The first version rotated with
// `if (size > max) renameSync(...)` inside a try whose catch set a permanent "logging disabled" flag -
// which meant two bridge processes racing on the same rollover made the loser stop logging entirely,
// silently, for the rest of its life. A lost rename is a normal outcome of that race, not a failure.
//
// So: rotation races are counted and ignored, only repeated real write failures disable logging, the
// disable is announced on stderr where the MCP client can see it, and the status stays readable so a tool
// reply can carry it.
import fs from 'node:fs';

export function createAuditLog({ file, maxBytes, fsImpl = fs, now = () => Date.now(), pid = process.pid,
  stderr = (m) => process.stderr.write(m), failuresBeforeDisable = 3 } = {}) {
  let failures = 0;
  let disabled = false;
  let rotationRaces = 0;
  let written = 0;
  function write(o) {
    if (disabled) return false;
    let text;
    try { text = JSON.stringify({ t: new Date(now()).toISOString(), pid, ...o }) + '\n'; }
    catch { return false; }                                   // an unserialisable payload is not worth losing the log over
    try {
      let size = 0;
      try { size = fsImpl.statSync(file).size; } catch {}       // missing file: first write of a fresh state dir
      if (size && size > maxBytes) {
        try { fsImpl.renameSync(file, `${file}.1`); }
        catch (e) {
          // ENOENT/EPERM/EBUSY here means somebody else rotated it first. Nothing was lost: the append
          // below simply starts the new file. Anything else is a real filesystem problem.
          if (e.code === 'ENOENT' || e.code === 'EPERM' || e.code === 'EBUSY') rotationRaces++;
          else throw e;
        }
      }
      fsImpl.appendFileSync(file, text);
      written++;
      failures = 0;
      return true;
    } catch (e) {
      if (++failures >= failuresBeforeDisable) {
        disabled = true;
        stderr(`dsh-bridge: audit log disabled after ${failures} consecutive write failures (${e.code || ''} ${e.message || e}); `
          + `evidence for this process stops at ${file}\n`);
      }
      return false;
    }
  }
  return { write, status: () => ({ file, disabled, failures, rotationRaces, written, maxBytes }) };
}
