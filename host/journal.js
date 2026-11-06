/**
 * The claim-intent journal for one workline (design v8 §2, §7.1).
 *
 * A Team claim commits on the Team board, which is a different store from the
 * task tree. The board must be written first and the execution ledger after, so
 * a crash in between leaves the board owned and the tree empty. That window can
 * only be adjudicated later if the Host wrote its INTENT down first — before the
 * board call — with the three facts no model can supply: the roster-resolved
 * session id, the Team member name, and the board revision the claim expects.
 *
 * The journal is append-only NDJSON beside the task tree
 * (`<profile>/agent-task-tree/<workline>.claims.jsonl`), and the entry is
 * fsynced: the crash this file exists for happens immediately after the board
 * commit, so "on disk" has to mean durable, not buffered.
 *
 * Like the ledger it is an INDEX, never a truth source: losing it can only ever
 * REDUCE what the Host may prove (an unproven claim becomes a conflict), never
 * grant an execution. A torn final line is ignored rather than guessed at.
 *
 * No node built-in appears anywhere else in `host/`; this module is the one
 * exception because a journal without `fsync` is not a journal.
 */

import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** Workline ids become file names, so only path-safe characters are allowed. */
const WORKLINE_ID = /^[A-Za-z0-9_-]+$/;

/** One journal file per workline, in the same directory as the tree. */
export function journalPath(root, worklineId) {
  if (typeof root !== 'string' || root === '') return undefined;
  if (typeof worklineId !== 'string' || !WORKLINE_ID.test(worklineId)) return undefined;
  return join(root, `${worklineId}.claims.jsonl`);
}

/**
 * Every durable entry of one workline's journal, oldest first.
 *
 * A missing file means "no intent was ever recorded" and yields `[]`. An entry
 * this build cannot read is reported as unparsed instead of being interpreted,
 * because a record nobody can read proves nothing (fail-closed).
 *
 * @param root - the task-tree storage directory.
 * @param worklineId - the workline root session id.
 * @returns `{ present, path, entries, unparsed }`.
 */
export function readJournal(root, worklineId) {
  const path = journalPath(root, worklineId);
  if (path === undefined) return { present: false, entries: [], unparsed: [] };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { present: false, path, entries: [], unparsed: [] };
  }
  const entries = [];
  const unparsed = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      unparsed.push(line);
      continue;
    }
    if (value === null || typeof value !== 'object' || typeof value.requestId !== 'string' || value.requestId === '') {
      unparsed.push(line);
      continue;
    }
    entries.push(value);
  }
  return { present: true, path, entries, unparsed };
}

/**
 * Append one entry durably.
 *
 * `fsync` is the point: the intent must survive a SIGKILL that lands a moment
 * later. A failed append never throws into the tool pipeline — the caller
 * treats an unjournaled claim as unprovable, which is exactly the fail-closed
 * direction.
 *
 * @param root - the task-tree storage directory.
 * @param worklineId - the workline root session id.
 * @param entry - `{ requestId, state, ... }`.
 * @returns whether the entry reached the file.
 */
export function appendIntent(root, worklineId, entry) {
  const path = journalPath(root, worklineId);
  if (path === undefined) return false;
  if (entry === null || typeof entry !== 'object' || typeof entry.requestId !== 'string' || entry.requestId === '') {
    return false;
  }
  // A crash can leave a torn final line with no newline. Terminating it before
  // the next append keeps every later entry readable; the torn line itself
  // stays unparsed, which is the honest reading of a half-written record.
  let needsNewline = false;
  try {
    const existing = readFileSync(path, 'utf8');
    needsNewline = existing !== '' && !existing.endsWith('\n');
  } catch {
    needsNewline = false;
  }
  let fd;
  try {
    fd = openSync(path, 'a');
    writeSync(fd, `${needsNewline ? '\n' : ''}${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* a close failure must not surface as a tool failure */
      }
    }
  }
}

/**
 * The claim intents whose outcome is still unknown.
 *
 * An intent is settled by a later entry with the same `requestId` whose state
 * is `committed` or `aborted`. The journal is append-only, so the latest entry
 * for a request id wins — that is also what lets reconciliation append its
 * decision instead of rewriting history.
 *
 * @param entries - the journal's entries, oldest first.
 * @param taskId - optional tree-task filter.
 * @returns one unsettled prepared entry per request id, oldest first.
 */
export function unsettledIntents(entries, taskId) {
  const settled = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.state === 'committed' || entry.state === 'aborted') settled.add(entry.requestId);
  }
  const latest = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.state !== 'prepared') continue;
    if (settled.has(entry.requestId)) continue;
    if (taskId !== undefined && entry.taskId !== taskId) continue;
    latest.set(entry.requestId, entry);
  }
  return [...latest.values()];
}
