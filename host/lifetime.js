/**
 * Worker lifetime records (design v8 I2b, ticket #7).
 *
 * A Worker instance — a Team teammate or a standard-mode subagent — holds at
 * most ONE task in its whole life. Releasing an execution, completing it, or
 * failing it ends that instance's eligibility: it may never claim a second
 * task. A retry of the task needs a NEW Worker instance, which gets a NEW
 * execution id. The Lead is exempt: it may work through tasks serially.
 *
 * The record lives in `workline.workers`, keyed by the Host-resolved session
 * id — never by a mutable field such as a task's `assignee` or `owner`. It is
 * written in the same atomic tree record as the execution, and ending an
 * execution keeps it (`state:"ended"`) instead of deleting it, so a release
 * cannot make an ended Worker claimable again, and a ledger rebuild starting
 * from nothing cannot resurrect it by forgetting a mutable flag.
 *
 * `state` moves `created` -> `bound` -> `ended`. This slice registers the
 * record when the execution is bound (a spawn-time `created` record is not
 * needed for the rule); an unknown persisted state fails closed as `ended`.
 *
 * This module is pure: no I/O, no dependencies on the tree model.
 */

/** The longest name/session string kept in one lifetime record. */
const MAX_ID = 200;

function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value.slice(0, MAX_ID) : null;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize one persisted lifetime record. An unknown state is treated as
 * `ended` on purpose: a record that cannot be read must not grant a second
 * binding (fail closed).
 */
export function normalizeWorker(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  const state = entry.state === 'created' || entry.state === 'bound' ? entry.state : 'ended';
  return {
    kind: entry.kind === 'teammate' ? 'teammate' : (entry.kind === 'subagent' ? 'subagent' : null),
    name: textOrNull(entry.name),
    state,
    boundTaskId: textOrNull(entry.boundTaskId),
    executionId: textOrNull(entry.executionId),
    createdAt: numberOr(entry.createdAt, 0),
    updatedAt: numberOr(entry.updatedAt, 0),
    endedAt: typeof entry.endedAt === 'number' ? entry.endedAt : null,
    endReason: textOrNull(entry.endReason),
  };
}

/**
 * Every usable lifetime record in one workline, keyed by session id.
 * @param workline - a persisted or cloned workline record.
 */
export function normalizeWorkers(workline) {
  const raw = workline !== null && typeof workline === 'object' ? workline.workers : undefined;
  const workers = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return workers;
  for (const [sessionId, entry] of Object.entries(raw)) {
    if (typeof sessionId !== 'string' || sessionId === '') continue;
    const worker = normalizeWorker(entry);
    if (worker !== undefined) workers[sessionId] = worker;
  }
  return workers;
}

/** One Worker's lifetime record, normalized; undefined when it never bound. */
export function workerLifetimeOf(workline, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  const workers = normalizeWorkers(workline);
  return workers[sessionId];
}

/**
 * The model-readable refusal shared by the tree model and the execution gate:
 * it names the ended binding and the only way forward (a new instance).
 */
export function workerLifetimeDenial({ sessionId, worker }) {
  const bound = typeof worker?.boundTaskId === 'string'
    ? `task ${worker.boundTaskId}${typeof worker.executionId === 'string' ? ` (execution ${worker.executionId})` : ''}`
    : 'a task';
  const ended = worker?.state === 'ended'
    ? `has already ended its one lifetime task binding on ${bound}`
    : `is already bound to ${bound} for life`;
  return `session ${sessionId} ${ended}; a Worker instance may hold only one task in its lifetime,`
    + ' so retry the task with a NEW Worker instance — releasing or failing the execution never restores it';
}

/**
 * Record the lifetime binding created by a successful claim.
 * The Lead is never registered (design v8 I2b exempts it).
 * @returns the stored record, or undefined for the Lead.
 */
export function bindWorkerLifetime(workline, {
  sessionId, leadSessionId, kind, name, taskId, executionId, now,
}) {
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId === leadSessionId) return undefined;
  if (workline.workers === null || typeof workline.workers !== 'object' || Array.isArray(workline.workers)) {
    workline.workers = {};
  }
  const existing = normalizeWorker(workline.workers[sessionId]);
  workline.workers[sessionId] = {
    kind: kind === 'teammate' ? 'teammate' : (kind === 'subagent' ? 'subagent' : null),
    name: textOrNull(name),
    state: 'bound',
    boundTaskId: textOrNull(taskId),
    executionId: textOrNull(executionId),
    createdAt: existing === undefined || existing.createdAt === 0 ? now : existing.createdAt,
    updatedAt: now,
    endedAt: null,
    endReason: null,
  };
  return workline.workers[sessionId];
}

/**
 * End one Worker's lifetime when its execution ends. The record is kept, so
 * the ended instance can never claim again; ending it twice is idempotent.
 * The Lead is never registered, so the Lead is never ended.
 * @returns the ended record, or undefined when the session has none.
 */
export function endWorkerLifetime(workline, {
  sessionId, leadSessionId, reason, executionId, now,
}) {
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId === leadSessionId) return undefined;
  if (workline.workers === null || typeof workline.workers !== 'object' || Array.isArray(workline.workers)) return undefined;
  const worker = normalizeWorker(workline.workers[sessionId]);
  if (worker === undefined) return undefined;
  if (worker.state === 'ended') return worker;
  const ended = {
    ...worker,
    state: 'ended',
    executionId: textOrNull(executionId) ?? worker.executionId,
    updatedAt: now,
    endedAt: now,
    endReason: textOrNull(reason),
  };
  workline.workers[sessionId] = ended;
  return ended;
}
