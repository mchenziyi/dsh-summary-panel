/**
 * Zero-dependency file storage for the task tree.
 *
 * One JSON file per workline under `<profile>/agent-task-tree/<worklineId>.json`,
 * shaped `{ version: 1, workline, tasks }` (CONTRACT.md §1). Reads are cached in
 * process; writes are serialized per workline with a promise chain and land via
 * a temporary file plus rename, so a crash never leaves a half-written tree.
 *
 * A file that no longer parses is renamed to `<name>.corrupt-<timestamp>` and
 * treated as an empty workline with a warning: the record is preserved for
 * inspection, never silently deleted.
 *
 * Only node built-ins are used; `ctx.storageDomain` is deliberately avoided
 * because the dsh package resolved on this plugin's path may not match the
 * running host.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Workline ids become file names, so only path-safe characters are allowed. */
const WORKLINE_ID = /^[A-Za-z0-9_-]+$/;

/** A task-tree storage failure (invalid id, unreadable record, failed write). */
export class TaskTreeStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskTreeStoreError';
  }
}

/**
 * The storage directory: `<DSH_PROFILE_DIR>/agent-task-tree` when the profile
 * directory is set, otherwise `~/.dsh/agent-task-tree`.
 * @param env - environment to read (defaults to `process.env`).
 */
export function taskTreeDirectory(env = process.env) {
  const profile = typeof env?.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : '';
  if (profile !== '') return join(profile, 'agent-task-tree');
  return join(homedir(), '.dsh', 'agent-task-tree');
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate the persisted envelope shape. Anything outside it counts as a
 * corrupt file rather than poisoning every later read.
 * @param parsed - the JSON value read from disk.
 * @param worklineId - the workline the file belongs to.
 */
function validEnvelope(parsed, worklineId) {
  if (!isRecord(parsed)) return false;
  const workline = parsed.workline;
  if (!isRecord(workline) || typeof workline.id !== 'string' || workline.id !== worklineId) return false;
  if (!Array.isArray(parsed.tasks)) return false;
  return parsed.tasks.every((task) => isRecord(task) && typeof task.id === 'string');
}

/**
 * Create a task-tree store.
 *
 * @param options - `{ root, env, logger }`; `root` overrides directory
 * derivation so tests can point at a temporary directory.
 * @returns the store API: `{ root, directory, has, ensure, available, read, update, snapshot }`.
 */
export function createTaskStore(options = {}) {
  const root = typeof options.root === 'string' && options.root !== ''
    ? options.root
    : taskTreeDirectory(options.env ?? process.env);
  const logger = options.logger ?? console;
  const cache = new Map();
  const chains = new Map();
  let readyPromise;
  let temporaryCounter = 0;

  function fileFor(worklineId) {
    if (typeof worklineId !== 'string' || !WORKLINE_ID.test(worklineId)) {
      throw new TaskTreeStoreError(`invalid workline id ${JSON.stringify(worklineId)}; expected ${WORKLINE_ID}`);
    }
    return join(root, `${worklineId}.json`);
  }

  function warn(message) {
    try {
      logger.warn(message);
    } catch {
      /* logging must never break storage */
    }
  }

  /** Create the storage directory once; a failure stays degraded for this process. */
  function ensure() {
    if (readyPromise === undefined) {
      readyPromise = mkdir(root, { recursive: true }).then(
        () => root,
        (error) => {
          throw new TaskTreeStoreError(`task tree storage is unavailable at ${root}: ${String(error?.message ?? error)}`);
        },
      );
    }
    return readyPromise;
  }

  /** @returns whether one workline already has a persisted tree (sync, for prompts). */
  function has(worklineId) {
    try {
      return existsSync(fileFor(worklineId));
    } catch {
      return false;
    }
  }

  /** @returns whether the storage directory can be created and written. */
  async function available() {
    try {
      await ensure();
      return true;
    } catch {
      return false;
    }
  }

  async function quarantine(file, worklineId) {
    const target = `${file}.corrupt-${Date.now()}`;
    try {
      await rename(file, target);
      warn(`[summary-panel] corrupt task tree file for workline ${worklineId} moved to ${target}`);
    } catch (error) {
      warn(`[summary-panel] corrupt task tree file for workline ${worklineId} could not be quarantined: ${String(error?.message ?? error)}`);
    }
  }

  async function readFromDisk(worklineId) {
    const file = fileFor(worklineId);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw new TaskTreeStoreError(`cannot read task tree ${file}: ${String(error?.message ?? error)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      await quarantine(file, worklineId);
      return undefined;
    }
    if (!validEnvelope(parsed, worklineId)) {
      await quarantine(file, worklineId);
      return undefined;
    }
    return { version: 1, workline: parsed.workline, tasks: parsed.tasks };
  }

  /**
   * Load one workline, cached in process.
   * @param worklineId - the root session id of the workline.
   * @returns the envelope, or undefined for an empty (or quarantined) workline.
   */
  async function read(worklineId) {
    fileFor(worklineId);
    if (cache.has(worklineId)) return cache.get(worklineId);
    const loaded = await readFromDisk(worklineId);
    cache.set(worklineId, loaded);
    return loaded;
  }

  /** Atomically replace one workline file with the given envelope. */
  async function persist(worklineId, envelope) {
    const file = fileFor(worklineId);
    await ensure();
    temporaryCounter += 1;
    const temporary = `${file}.tmp-${process.pid}-${temporaryCounter}`;
    const text = JSON.stringify({
      version: 1,
      workline: envelope.workline,
      tasks: Array.isArray(envelope.tasks) ? envelope.tasks : [],
    });
    try {
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, file);
    } catch (error) {
      throw new TaskTreeStoreError(`cannot write task tree ${file}: ${String(error?.message ?? error)}`);
    }
  }

  /**
   * The snapshot shape. The Worker lifetime records travel with the tasks they
   * constrain, and the unresolved conflicts travel with them too, because a
   * synchronous decision (the tool guard) must be able to see that a task is
   * stopped without awaiting storage. Each field is omitted when empty so the
   * common shape stays exactly `{ present, tasks }`.
   */
  function snapshotOf(envelope) {
    const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
    const workline = envelope.workline !== null && typeof envelope.workline === 'object' ? envelope.workline : {};
    const raw = workline.workers;
    const workers = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
    const rawConflicts = workline.conflicts;
    const conflicts = Array.isArray(rawConflicts)
      ? rawConflicts.filter((conflict) => conflict !== null && typeof conflict === 'object' && conflict.resolvedAt === null)
      : undefined;
    return {
      present: true,
      tasks,
      ...(workers !== undefined && Object.keys(workers).length > 0 ? { workers } : {}),
      ...(conflicts !== undefined && conflicts.length > 0 ? { conflicts } : {}),
    };
  }

  /**
   * Synchronous snapshot of one workline, for a decision that must not await
   * (the tool guard decides mid-call, before dispatch).
   *
   * It prefers the in-process cache, which every `update` refreshes before it
   * returns, so a `claim` or `release` is visible to the next guard call
   * immediately. A cold workline is read from disk with a synchronous read —
   * bounded to one small file, never a pending promise — and then cached.
   *
   * Fail-closed on a present-but-unreadable tree: a corrupt or unreadable
   * record reports `present: true` with no tasks, which denies class A tools
   * rather than silently freeing them. Only a genuinely absent file means the
   * workline is unmanaged.
   *
   * @param worklineId - the root session id of the workline.
   * @returns `{ present, tasks, workers?, unreadable? }`; `workers` is present
   *   only once a Worker lifetime record exists, and `tasks` is read-only.
   */
  function snapshot(worklineId) {
    let file;
    try {
      file = fileFor(worklineId);
    } catch {
      return { present: false, tasks: [] };
    }
    if (cache.has(worklineId)) {
      const envelope = cache.get(worklineId);
      return envelope === undefined ? { present: false, tasks: [] } : snapshotOf(envelope);
    }
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        cache.set(worklineId, undefined);
        return { present: false, tasks: [] };
      }
      return { present: true, tasks: [], unreadable: true };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { present: true, tasks: [] };
    }
    if (!validEnvelope(parsed, worklineId)) return { present: true, tasks: [] };
    const envelope = { version: 1, workline: parsed.workline, tasks: parsed.tasks };
    cache.set(worklineId, envelope);
    return snapshotOf(envelope);
  }

  /** Run `task` after every earlier write for the same workline settled. */
  function enqueue(worklineId, task) {
    const previous = chains.get(worklineId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => {});
    chains.set(worklineId, settled);
    settled.then(() => {
      if (chains.get(worklineId) === settled) chains.delete(worklineId);
    });
    return run;
  }

  /**
   * Read-modify-write one workline under its write lock.
   *
   * @param worklineId - the root session id of the workline.
   * @param mutate - receives a defensive copy of the current envelope (or
   * undefined) and returns `{ envelope, ... }`; returning undefined writes nothing.
   * @returns the value `mutate` returned, after the new envelope is persisted.
   */
  function update(worklineId, mutate) {
    fileFor(worklineId);
    return enqueue(worklineId, async () => {
      const current = clone(await read(worklineId));
      const outcome = await mutate(current);
      if (outcome === undefined) return undefined;
      const envelope = outcome.envelope;
      await persist(worklineId, envelope);
      cache.set(worklineId, clone(envelope));
      return outcome;
    });
  }

  return { root, directory: root, has, ensure, available, read, update, snapshot };
}
