/**
 * Pure task-tree domain logic.
 *
 * This module owns every rule of the workline task tree (validation, the
 * parent/child invariants, focus and claim semantics, goal revisions, and the
 * wire snapshots consumed by the tools and HTTP routes). It imports nothing:
 * no dsh package, no zod, and no node built-in. Storage lives in
 * `host/store.js`, so this file is directly unit-testable.
 *
 * A workline record is the persisted envelope `{ version, workline, tasks }`.
 * `task.owner` is a record of who is working on a task, not a credential: it
 * refuses nothing. The only concurrency check is a compare-and-set on `claim`,
 * which stops two sessions from working on the same task; no tool call is
 * decided by it. All operations are applied to a private clone first; a failure
 * anywhere in the batch leaves the caller's record untouched (the batch is
 * atomic).
 */

/** The four active task statuses. */
export const TASK_STATUSES = Object.freeze(['pending', 'in_progress', 'blocked', 'done']);

/**
 * Execution approval, which is independent of the status.
 *
 * - `approved`: the user asked for this work or agreed to it, so the agent may
 *   start when the task comes up.
 * - `pending`: an idea, a proposal, or unrequested scope; the agent may discuss,
 *   analyse, plan, and refine it, but must ask before executing.
 */
export const EXECUTION_APPROVALS = Object.freeze(['approved', 'pending']);

/**
 * Every operation accepted by `task_tree_write`.
 *
 * These are tree maintenance only. `claim` and `release` record who is working
 * on a task (and clear it again); they grant and withhold nothing.
 */
export const TASK_OPS = Object.freeze([
  'init',
  'reviseGoal',
  'create',
  'update',
  'move',
  'defer',
  'resume',
  'archive',
  'restore',
  'focus',
  'claim',
  'release',
  'complete',
]);

/** Contract limits (CONTRACT.md §1 and §3). */
export const LIMITS = Object.freeze({
  title: 40,
  summary: 240,
  // What the task is expected to deliver, and the immediate next move. Both are
  // one-liners shown in the right sidebar, so they share the summary bound.
  expectedOutcome: 240,
  nextStep: 240,
  progress: 2000,
  result: 500,
  outline: 4000,
  goal: 4000,
  reason: 1000,
  shortText: 500,
  blocker: 1000,
  basis: 200,
  archivedListed: 200,
  maxOps: 100,
});

/** Fields each op may carry; anything else is a caller mistake worth reporting. */
const OP_FIELDS = Object.freeze({
  init: ['op', 'originalGoal', 'outline'],
  reviseGoal: ['op', 'current', 'reason'],
  create: ['op', 'title', 'summary', 'expectedOutcome', 'nextStep', 'parentId', 'status', 'progress', 'order', 'executionApproval', 'approvalBasis', 'requiresUserAcceptance', 'acceptanceBasis', 'temporary', 'temporaryFor'],
  update: ['op', 'id', 'title', 'summary', 'expectedOutcome', 'nextStep', 'status', 'progress', 'result', 'blockerReason', 'blockerUnblock', 'confirmedByUser', 'executionApproval', 'approvalBasis', 'confirmationBasis', 'requiresUserAcceptance', 'acceptanceBasis', 'temporary', 'temporaryFor'],
  move: ['op', 'id', 'parentId', 'order'],
  defer: ['op', 'id', 'deferredReason', 'resumeCondition', 'userBasis'],
  resume: ['op', 'id'],
  archive: ['op', 'id', 'reason', 'userBasis'],
  restore: ['op', 'id'],
  focus: ['op', 'ids'],
  claim: ['op', 'id'],
  release: ['op', 'id'],
  complete: ['op', 'id', 'confirmedByUser', 'confirmationBasis', 'result'],
});

/** One rejected task-tree operation, with a model-readable reason. */
export class TaskTreeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskTreeError';
  }
}

function fail(message) {
  throw new TaskTreeError(message);
}

function clone(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function codePointLength(text) {
  return Array.from(text).length;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeStatus(value) {
  if (!TASK_STATUSES.includes(value)) {
    fail(`status must be one of ${TASK_STATUSES.join(', ')} (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Trimmed single-line text with an optional emptiness and length rule. */
function singleLine(value, name, max, { required = false } = {}) {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  const text = value.trim();
  if (/[\r\n]/.test(text)) fail(`${name} must be a single line`);
  if (required && text === '') fail(`${name} must not be empty`);
  const length = codePointLength(text);
  if (length > max) fail(`${name} must be at most ${max} characters (got ${length})`);
  return text;
}

/** Free-form text that may span lines (progress, result, outline). */
function multiLine(value, name, max, { required = false } = {}) {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  const text = value.trim();
  if (required && text === '') fail(`${name} must not be empty`);
  const length = codePointLength(text);
  if (length > max) fail(`${name} must be at most ${max} characters (got ${length})`);
  return text;
}

function optionalSingleLine(value, name, max) {
  if (value === undefined) return undefined;
  return singleLine(value, name, max);
}

function normalizeOrder(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`order must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

function normalizeApproval(value) {
  if (!EXECUTION_APPROVALS.includes(value)) {
    fail(`executionApproval must be one of ${EXECUTION_APPROVALS.join(', ')} (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Ask the caller's session whether a real user message contains this quote.
 * The verdict comes from `context.verifyUserQuote`, which `host/tools.js` wires
 * to the session log; this module stays free of session access.
 */
function verifyQuote(context, quote) {
  const verify = typeof context.verifyUserQuote === 'function' ? context.verifyUserQuote : undefined;
  if (verify === undefined) {
    return { ok: false, reason: 'the calling session exposes no user messages to compare against' };
  }
  let verdict;
  try {
    verdict = verify(quote);
  } catch (error) {
    return { ok: false, reason: `verification failed: ${String(error?.message ?? error)}` };
  }
  if (verdict === true) return { ok: true };
  if (verdict !== null && typeof verdict === 'object' && verdict.ok === true) {
    return { ok: true, seq: numberOr(verdict.seq, -1), time: numberOr(verdict.time, 0) };
  }
  return {
    ok: false,
    reason: verdict !== null && typeof verdict === 'object' && typeof verdict.reason === 'string' && verdict.reason !== ''
      ? verdict.reason
      : 'no user message contains it',
  };
}

/**
 * Whether the direct parent is an approved, active scope to inherit from.
 *
 * Only the direct parent decides: an approved grandparent cannot approve work
 * inside a step the user left unapproved, so one more level of nesting never
 * tunnels back through a pending boundary.
 */
function approvedParent(state, parentId) {
  if (typeof parentId !== 'string') return false;
  const parent = state.tasks.find((candidate) => candidate.id === parentId);
  if (parent === undefined || parent.archived === true) return false;
  return parent.executionApproval === 'approved';
}

/** Refuse to start executing a task the user has not approved. */
function assertExecutable(task) {
  if (task.executionApproval === 'approved') return;
  fail(
    `task ${task.id} is not approved: ask the user, then set executionApproval: "approved"`
    + ' with their words in approvalBasis, and only then start it',
  );
}

/**
 * Apply `executionApproval` from a create/update op.
 *
 * An explicit `approved` always needs the user's own words, verified against the
 * session log. Inheritance is not decided here: `applyCreate` hands an approved
 * scope down to the steps it creates, so approving something that already exists
 * can never happen without a quote.
 */
function applyApproval(task, op, context, options = {}) {
  if (op.executionApproval === undefined) {
    if (op.approvalBasis !== undefined) {
      fail(`task ${task.id}: approvalBasis only applies together with executionApproval: "approved"`);
    }
    return;
  }
  const next = normalizeApproval(op.executionApproval);
  if (next === 'pending') {
    if (hasStarted(task)) {
      fail(
        `task ${task.id} has already started, so withdrawing its approval would hide unfinished work behind`
        + ' a completed parent; defer it or finish it instead',
      );
    }
    task.executionApproval = 'pending';
    task.approvalBasis = null;
    task.approvalAt = null;
    return;
  }
  const basis = op.approvalBasis === undefined ? '' : singleLine(op.approvalBasis, 'approvalBasis', LIMITS.basis);
  if (basis === '') {
    fail(
      `task ${task.id}: approving an existing task requires approvalBasis quoting the user's instruction;`
      + ' only a normal step created inside an approved scope inherits that approval',
    );
  }
  const verdict = verifyQuote(context, basis);
  if (!verdict.ok) {
    fail(
      `task ${task.id}: approvalBasis does not appear in a user message (${verdict.reason});`
      + " quote the user's own words, or leave the task pending until they agree",
    );
  }
  // Turning a recorded idea into work also settles who accepts the result; the
  // caller has to say so instead of inheriting a default that may be wrong.
  if (options.requireAcceptanceDecision === true
    && task.executionApproval !== 'approved'
    && task.approvalAt === null
    && op.requiresUserAcceptance === undefined) {
    fail(
      `task ${task.id}: approving a recorded idea also decides who accepts it;`
      + ' pass requiresUserAcceptance: true for a feature the user will accept, or false for an ordinary implementation step',
    );
  }
  task.executionApproval = 'approved';
  task.approvalBasis = basis;
  task.approvalAt = context.now;
}

/**
 * Apply `requiresUserAcceptance` from a create/update op.
 *
 * Making the requirement stricter is always allowed. Waiving it hands the agent
 * a shortcut around the user's acceptance, so it needs the user's own words.
 */
function applyAcceptanceRequirement(task, op, context) {
  if (op.requiresUserAcceptance === undefined) {
    if (op.acceptanceBasis !== undefined) {
      fail(`task ${task.id}: acceptanceBasis only applies together with requiresUserAcceptance: false`);
    }
    return;
  }
  if (typeof op.requiresUserAcceptance !== 'boolean') {
    fail(`task ${task.id}: requiresUserAcceptance must be a boolean`);
  }
  // Restating the current value changes nothing, so it needs no evidence.
  if (op.requiresUserAcceptance === task.requiresUserAcceptance) return;
  if (op.requiresUserAcceptance === true) {
    task.requiresUserAcceptance = true;
    task.acceptanceBasis = null;
    return;
  }
  const basis = op.acceptanceBasis === undefined ? '' : singleLine(op.acceptanceBasis, 'acceptanceBasis', LIMITS.basis);
  if (basis === '') {
    fail(
      `task ${task.id}: dropping the user-acceptance requirement needs acceptanceBasis`
      + " quoting the user's instruction; the agent cannot waive the user's acceptance on its own",
    );
  }
  const verdict = verifyQuote(context, basis);
  if (!verdict.ok) {
    fail(
      `task ${task.id}: acceptanceBasis does not appear in a user message (${verdict.reason});`
      + ' ask the user before waiving their acceptance',
    );
  }
  task.requiresUserAcceptance = false;
  task.acceptanceBasis = basis;
}

/**
 * The verified acceptance quote for a completion that claims user confirmation.
 * @returns the quote, or null when the agent records its own verification.
 */
function basisKey(text) {
  return String(text).replace(/\s+/g, '');
}

function confirmationBasisFor(state, task, op, context) {
  if (op.confirmedByUser !== true) return null;
  const basis = op.confirmationBasis === undefined ? '' : singleLine(op.confirmationBasis, 'confirmationBasis', LIMITS.basis);
  if (basis === '') {
    fail(
      `task ${task.id}: confirmedByUser: true records the user's acceptance and needs confirmationBasis`
      + " quoting what the user said; omit confirmedByUser to record your own verification instead",
    );
  }
  const verdict = verifyQuote(context, basis);
  if (!verdict.ok) {
    fail(
      `task ${task.id}: confirmationBasis does not appear in a user message (${verdict.reason});`
      + ' ask the user to accept the delivered work, then quote their answer',
    );
  }
  // One quote closes one task: a message that accepted one thing cannot be
  // replayed to accept another, so the user's words bind to what they said.
  const key = basisKey(basis);
  const clash = state.tasks.find((candidate) => candidate.id !== task.id
    && typeof candidate.completionBasis === 'string'
    && basisKey(candidate.completionBasis) === key);
  if (clash !== undefined) {
    fail(
      `task ${task.id}: this quote already recorded the user's acceptance of task ${clash.id} "${clash.title}";`
      + ' each task needs its own confirmation — quote the part of the message that names this task, or ask the user to confirm it separately',
    );
  }
  const floor = Math.max(numberOr(task.createdAt, 0), numberOr(task.approvalAt, 0));
  const said = numberOr(verdict.time, 0);
  if (said > 0 && floor > 0 && said <= floor) {
    fail(
      `task ${task.id}: the quoted message predates this task's authorisation, so it is the instruction`
      + ' that started the work rather than the user\'s acceptance; quote what the user said after you reported the delivery',
    );
  }
  return basis;
}

export function isBlocked(task) {
  return task.status === 'blocked' || task.blocker !== null && task.blocker !== undefined;
}

/** Execution approval of any record, including one written before the field existed. */
export function approvalOf(task) {
  return task !== null && typeof task === 'object' && task.executionApproval === 'approved' ? 'approved' : 'pending';
}

/** The recorded completion kind, or null when the task is not completed. */
export function completionOf(task) {
  if (task === null || typeof task !== 'object') return null;
  return task.completion === 'user-confirmed' || task.completion === 'self' ? task.completion : null;
}

/**
 * Whether a task needs the user's acceptance before it can be completed.
 *
 * Records written before this field existed follow the creation default: a
 * top-level task stands for a delivered requirement, a child is an
 * implementation step.
 */
export function requiresAcceptanceOf(task) {
  if (task === null || typeof task !== 'object') return true;
  if (task.requiresUserAcceptance === false) return false;
  if (task.requiresUserAcceptance === true) return true;
  return typeof task.parentId !== 'string';
}

/** A fresh, empty persisted envelope for a workline. */
export function createEmptyEnvelope(worklineId, now) {
  return {
    version: 1,
    workline: {
      id: worklineId,
      createdAt: now,
      updatedAt: now,
      goal: null,
      outline: '',
      focus: [],
      nextSeq: 1,
    },
    tasks: [],
  };
}

function normalizeGoal(goal) {
  if (goal === null || goal === undefined || typeof goal !== 'object') return null;
  const original = typeof goal.original === 'string' ? goal.original : '';
  if (original === '') return null;
  const current = typeof goal.current === 'string' && goal.current !== '' ? goal.current : original;
  const changes = Array.isArray(goal.changes)
    ? goal.changes
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        at: numberOr(entry.at, 0),
        reason: typeof entry.reason === 'string' ? entry.reason : '',
        previous: typeof entry.previous === 'string' ? entry.previous : '',
        next: typeof entry.next === 'string' ? entry.next : '',
      }))
    : [];
  return { original, current, changes };
}

function normalizeTask(task, worklineId) {
  return {
    id: task.id,
    worklineId: typeof task.worklineId === 'string' ? task.worklineId : worklineId,
    parentId: typeof task.parentId === 'string' ? task.parentId : null,
    order: numberOr(task.order, 0),
    title: typeof task.title === 'string' ? task.title : '',
    summary: typeof task.summary === 'string' ? task.summary : '',
    expectedOutcome: typeof task.expectedOutcome === 'string' ? task.expectedOutcome : '',
    nextStep: typeof task.nextStep === 'string' ? task.nextStep : '',
    // A task created to absorb an urgent interruption: it names the mainline
    // task it interrupted (`temporaryFor`) so the panel can say what was paused.
    // Records written before this field existed are ordinary tasks.
    temporary: task.temporary === true,
    temporaryFor: typeof task.temporaryFor === 'string' && task.temporaryFor !== '' ? task.temporaryFor : null,
    status: TASK_STATUSES.includes(task.status) ? task.status : 'pending',
    deferred: task.deferred === true,
    deferredReason: typeof task.deferredReason === 'string' ? task.deferredReason : null,
    deferredBasis: typeof task.deferredBasis === 'string' && task.deferredBasis !== '' ? task.deferredBasis : null,
    archiveBasis: typeof task.archiveBasis === 'string' && task.archiveBasis !== '' ? task.archiveBasis : null,
    resumeCondition: typeof task.resumeCondition === 'string' ? task.resumeCondition : null,
    archived: task.archived === true,
    archiveReason: typeof task.archiveReason === 'string' ? task.archiveReason : null,
    archivedAt: typeof task.archivedAt === 'number' ? task.archivedAt : null,
    archiveBatch: typeof task.archiveBatch === 'string' && task.archiveBatch !== '' ? task.archiveBatch : null,
    progress: typeof task.progress === 'string' ? task.progress : '',
    result: typeof task.result === 'string' ? task.result : null,
    blocker: task.blocker !== null && typeof task.blocker === 'object' && typeof task.blocker.reason === 'string'
      ? { reason: task.blocker.reason, unblock: typeof task.blocker.unblock === 'string' ? task.blocker.unblock : '' }
      : null,
    // Who is working on the task, as a record the panel can show. It is written
    // by `claim` and cleared by `release` / completion / deferral / archiving;
    // it refuses nothing. Records written by older builds may also carry
    // `executionId` and `member`; the former is ignored (the execution ledger
    // is gone), the latter is kept so the panel can still name the teammate.
    owner: task.owner !== null && typeof task.owner === 'object' && typeof task.owner.sessionId === 'string'
      ? {
        sessionId: task.owner.sessionId,
        member: typeof task.owner.member === 'string' && task.owner.member !== '' ? task.owner.member : null,
        since: numberOr(task.owner.since, 0),
      }
      : null,
    completion: task.completion === 'user-confirmed' || task.completion === 'self' ? task.completion : null,
    completionBasis: typeof task.completionBasis === 'string' && task.completionBasis !== '' ? task.completionBasis : null,
    completedAt: typeof task.completedAt === 'number' ? task.completedAt : null,
    // Legacy records predate execution approval. They are NOT assumed approved:
    // nobody recorded a user instruction for them.
    executionApproval: task.executionApproval === 'approved' ? 'approved' : 'pending',
    approvalBasis: typeof task.approvalBasis === 'string' && task.approvalBasis !== '' ? task.approvalBasis : null,
    approvalAt: typeof task.approvalAt === 'number' ? task.approvalAt : null,
    requiresUserAcceptance: task.requiresUserAcceptance === false
      ? false
      : (task.requiresUserAcceptance === true || typeof task.parentId !== 'string'),
    acceptanceBasis: typeof task.acceptanceBasis === 'string' && task.acceptanceBasis !== '' ? task.acceptanceBasis : null,
    archiveHistory: Array.isArray(task.archiveHistory)
      ? task.archiveHistory
        .filter((entry) => entry !== null && typeof entry === 'object')
        .map((entry) => ({
          at: numberOr(entry.at, 0),
          reason: typeof entry.reason === 'string' ? entry.reason : '',
          ...(typeof entry.basis === 'string' && entry.basis !== '' ? { basis: entry.basis } : {}),
        }))
        .slice(-20)
      : [],
    createdAt: numberOr(task.createdAt, 0),
    updatedAt: numberOr(task.updatedAt, 0),
  };
}

/** Copy an envelope into the mutable draft the batch is applied to. */
export function cloneEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object') fail('workline record must be an object');
  const workline = envelope.workline;
  if (workline === null || typeof workline !== 'object') fail('workline record is missing workline data');
  if (typeof workline.id !== 'string' || workline.id === '') fail('workline record is missing its id');
  const tasks = Array.isArray(envelope.tasks) ? envelope.tasks.filter((task) => task !== null && typeof task === 'object' && typeof task.id === 'string') : [];
  // Older records may still carry `executions`, `workers`, `conflicts` and
  // `nextExecution`. The execution ledger is gone (ADR-0003), so they are
  // ignored: reading never interprets them and the next write drops them (no
  // migration, no rewrite of a file nobody touched).
  return {
    version: 1,
    workline: {
      id: workline.id,
      createdAt: numberOr(workline.createdAt, 0),
      updatedAt: numberOr(workline.updatedAt, 0),
      goal: normalizeGoal(workline.goal),
      outline: typeof workline.outline === 'string' ? workline.outline : '',
      focus: Array.isArray(workline.focus) ? workline.focus.filter((id) => typeof id === 'string') : [],
      nextSeq: Number.isInteger(workline.nextSeq) && workline.nextSeq > 0 ? workline.nextSeq : 1,
    },
    tasks: tasks.map((task) => normalizeTask(task, workline.id)),
  };
}

function requireWorklineId(value) {
  if (typeof value !== 'string' || value === '') fail('worklineId must be a non-empty string');
  return value;
}

function requireTaskId(op) {
  if (typeof op.id !== 'string' || op.id.trim() === '') fail('id is required');
  return op.id.trim();
}

function findTask(state, id, { active = false } = {}) {
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) fail(`unknown task ${JSON.stringify(id)}`);
  if (active && task.archived) fail(`task ${id} is archived`);
  return task;
}

function childTasks(state, id) {
  return state.tasks.filter((task) => !task.archived && task.parentId === id);
}

function removeFromFocus(state, id) {
  const focus = state.workline.focus;
  const index = focus.indexOf(id);
  if (index !== -1) focus.splice(index, 1);
}

function touch(state, task, now) {
  task.updatedAt = now;
  state.workline.updatedAt = now;
}

function isDescendant(state, candidateId, ancestorId) {
  let current = candidateId;
  const seen = new Set();
  while (typeof current === 'string' && !seen.has(current)) {
    seen.add(current);
    if (current === ancestorId) return true;
    const task = state.tasks.find((candidate) => candidate.id === current);
    current = task === undefined ? null : task.parentId;
  }
  return false;
}

function nextOrder(state, parentId, excludeId) {
  let max = -1;
  for (const task of state.tasks) {
    if (task.archived) continue;
    if (task.parentId !== parentId) continue;
    if (task.id === excludeId) continue;
    max = Math.max(max, task.order);
  }
  return max + 1;
}

function nextTaskId(state) {
  const taken = new Set(state.tasks.map((task) => task.id));
  let seq = Number.isInteger(state.workline.nextSeq) && state.workline.nextSeq > 0 ? state.workline.nextSeq : 1;
  while (taken.has(`t${seq}`)) seq += 1;
  state.workline.nextSeq = seq + 1;
  return `t${seq}`;
}

/**
 * Finish a task.
 *
 * @param basis - the verified user quote for a user-accepted completion, or null
 *   for the agent's own verification. Completion never invents a user verdict.
 */
/** The parent invariant, checked before anything else about a completion. */
/** Whether a task carries free-text notes (discussion, progress, result). */
function hasNotes(task) {
  if (typeof task.progress === 'string' && task.progress.trim() !== '') return true;
  if (typeof task.result === 'string' && task.result.trim() !== '') return true;
  return false;
}

/**
 * Whether work has already happened on a task.
 *
 * Explicit state is the evidence: a status of in_progress/blocked, an owner,
 * or a completion record. Free-text notes alone are not work — an
 * idea under discussion collects notes without anyone starting it — so they
 * only count once the task was actually authorised.
 */
function hasStarted(task) {
  if (task.status === 'in_progress' || task.status === 'blocked') return true;
  if (task.owner !== null && task.owner !== undefined) return true;
  if (task.completion !== null && task.completion !== undefined) return true;
  if (task.executionApproval === 'approved' && hasNotes(task)) return true;
  return false;
}

/** Whether leaving the delivery (defer/archive) needs the user's own words. */
function needsUserDecision(task) {
  if (task.archived === true) return false;
  if (task.status === 'done') return false;
  return task.executionApproval === 'approved' || hasStarted(task);
}

/**
 * The first unfinished task inside a subtree, or null when everything is done.
 *
 * Only finished work and archived work stop blocking: a pending idea, an
 * in-progress or blocked step, and a deferred task all keep the subtree open.
 * Authorisation does not matter here — the tree records every unfinished thing.
 */
function firstUnfinished(state, task) {
  if (task.archived !== true && task.status !== 'done') return task;
  for (const child of childTasks(state, task.id)) {
    const found = firstUnfinished(state, child);
    if (found !== null) return found;
  }
  return null;
}

/** Whether a task is done and nothing unfinished remains anywhere below it. */
function isSettled(state, task) {
  return task.archived === true || firstUnfinished(state, task) === null;
}

function assertDeliveryComplete(state, task) {
  const reasons = [];
  for (const child of childTasks(state, task.id)) {
    const blocker = firstUnfinished(state, child);
    if (blocker === null) continue;
    reasons.push(blocker.id === child.id
      ? `${child.id} "${child.title}" is ${child.status}`
      : `${child.id} "${child.title}" still has unfinished work inside (${blocker.id} "${blocker.title}" is ${blocker.status})`);
  }
  if (reasons.length === 0) return;
  fail(
    `task ${task.id} cannot be done while any work below it is unfinished: ${reasons.join('; ')}.`
    + ' Only finished or archived tasks stop blocking; a deferred task and an idea nobody approved still do.',
  );
}

/**
 * Settlement for every task in one list: done and with nothing unfinished below.
 * A completed task that later gained unfinished children is therefore not
 * settled, while its completion record stays exactly as the user accepted it.
 * @param tasks - every task of the workline.
 * @returns `(id) => boolean`.
 */
function settledLookup(tasks) {
  const byId = new Map();
  const children = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== 'object' || typeof task.id !== 'string') continue;
    byId.set(task.id, task);
    const parentId = typeof task.parentId === 'string' ? task.parentId : null;
    const group = children.get(parentId);
    if (group === undefined) children.set(parentId, [task]);
    else group.push(task);
  }
  const memo = new Map();
  const settled = (id) => {
    const memoized = memo.get(id);
    if (memoized !== undefined) return memoized;
    const task = byId.get(id);
    let value = task !== undefined && task.archived !== true && task.status === 'done';
    if (value === true) {
      for (const child of children.get(id) ?? []) {
        if (child.archived === true) continue;
        if (settled(child.id) !== true) {
          value = false;
          break;
        }
      }
    }
    memo.set(id, value);
    return value;
  };
  return settled;
}

function finishTask(state, task, now, basis) {
  assertDeliveryComplete(state, task);
  if (basis === null && task.requiresUserAcceptance === true) {
    fail(
      `task ${task.id} needs the user's acceptance before it can be completed: record the delivered work`
      + ' in progress or result, keep the task in progress, and complete it only after the user accepts,'
      + ' with confirmedByUser: true and confirmationBasis quoting their acceptance',
    );
  }
  task.status = 'done';
  task.completion = basis === null ? 'self' : 'user-confirmed';
  task.completionBasis = basis;
  task.completedAt = now;
  task.blocker = null;
  task.owner = null;
  removeFromFocus(state, task.id);
  touch(state, task, now);
}

/** Record the user's acceptance of a task the agent already completed. */
function acceptCompletion(state, task, op, context) {
  if (task.completion === 'user-confirmed') return;
  if (op.confirmedByUser !== true) {
    fail(`task ${task.id} is already done; pass confirmedByUser: true with confirmationBasis only once the user accepted it`);
  }
  const basis = confirmationBasisFor(state, task, op, context);
  task.completion = 'user-confirmed';
  task.completionBasis = basis;
  touch(state, task, context.now);
}

function compareTasks(left, right) {
  if (left.order !== right.order) return left.order - right.order;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  const leftSeq = /^t(\d+)$/.exec(left.id);
  const rightSeq = /^t(\d+)$/.exec(right.id);
  if (leftSeq !== null && rightSeq !== null) return Number(leftSeq[1]) - Number(rightSeq[1]);
  return String(left.id).localeCompare(String(right.id));
}

/**
 * Active tasks in tree order: parents before children, siblings by `order`.
 * @param tasks - the workline's tasks.
 * @returns `{ task, depth }` rows; orphans and archived rows are handled defensively.
 */
export function orderedTree(tasks) {
  const active = (Array.isArray(tasks) ? tasks : []).filter((task) => task !== null && typeof task === 'object' && task.archived !== true && typeof task.id === 'string');
  const known = new Set(active.map((task) => task.id));
  const byParent = new Map();
  for (const task of active) {
    const parentId = typeof task.parentId === 'string' && known.has(task.parentId) ? task.parentId : null;
    const group = byParent.get(parentId);
    if (group === undefined) byParent.set(parentId, [task]);
    else group.push(task);
  }
  for (const group of byParent.values()) group.sort(compareTasks);
  const rows = [];
  const visited = new Set();
  const visit = (parentId, depth) => {
    const group = byParent.get(parentId);
    if (group === undefined) return;
    for (const task of group) {
      if (visited.has(task.id)) continue;
      visited.add(task.id);
      rows.push({ task, depth });
      visit(task.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

function applyInit(state, op) {
  if (state.workline.goal !== null) fail(`workline ${state.workline.id} already has a goal; init runs once per workline`);
  const original = singleLine(op.originalGoal, 'originalGoal', LIMITS.goal, { required: true });
  state.workline.goal = { original, current: original, changes: [] };
  if (op.outline !== undefined) state.workline.outline = multiLine(op.outline, 'outline', LIMITS.outline);
  return { op: 'init' };
}

function applyReviseGoal(state, op, context) {
  const goal = state.workline.goal;
  if (goal === null) fail(`workline ${state.workline.id} has no goal yet; run init first`);
  const current = singleLine(op.current, 'current', LIMITS.goal, { required: true });
  const reason = singleLine(op.reason, 'reason', LIMITS.reason, { required: true });
  if (current === goal.current) fail('current goal is unchanged; reviseGoal needs a different value');
  goal.changes.push({ at: context.now, reason, previous: goal.current, next: current });
  goal.current = current;
  return { op: 'reviseGoal' };
}

function applyCreate(state, op, context) {
  const title = singleLine(op.title, 'title', LIMITS.title, { required: true });
  let parentId = null;
  if (op.parentId !== undefined && op.parentId !== null) {
    if (typeof op.parentId !== 'string' || op.parentId === '') fail('parentId must be a task id or null');
    parentId = findTask(state, op.parentId, { active: true }).id;
  }
  const status = op.status === undefined ? 'pending' : normalizeStatus(op.status);
  if (status === 'done') fail('a new task cannot start done; create it and complete it after the user confirms');
  if (status === 'blocked') fail('a new task cannot start blocked; create it and set the blocker in update');
  const summary = op.summary === undefined ? '' : singleLine(op.summary, 'summary', LIMITS.summary);
  const expectedOutcome = op.expectedOutcome === undefined
    ? ''
    : singleLine(op.expectedOutcome, 'expectedOutcome', LIMITS.expectedOutcome);
  const nextStep = op.nextStep === undefined ? '' : singleLine(op.nextStep, 'nextStep', LIMITS.nextStep);
  const progress = op.progress === undefined ? '' : multiLine(op.progress, 'progress', LIMITS.progress);
  const order = op.order === undefined ? nextOrder(state, parentId, undefined) : normalizeOrder(op.order);
  const id = nextTaskId(state);
  // A step created directly inside an approved parent inherits that approval;
  // anything else starts unapproved, including every top-level task.
  const inherited = parentId !== null && approvedParent(state, parentId);
  const task = {
    id,
    worklineId: state.workline.id,
    parentId,
    order,
    title,
    summary,
    expectedOutcome,
    nextStep,
    temporary: false,
    temporaryFor: null,
    status,
    deferred: false,
    deferredReason: null,
    deferredBasis: null,
    resumeCondition: null,
    archived: false,
    archiveReason: null,
    archiveBasis: null,
    archivedAt: null,
    archiveBatch: null,
    progress,
    result: null,
    blocker: null,
    owner: null,
    completion: null,
    completionBasis: null,
    completedAt: null,
    executionApproval: inherited ? 'approved' : 'pending',
    approvalBasis: null,
    approvalAt: inherited ? context.now : null,
    // A top-level task stands for a delivered requirement; a child is a step.
    requiresUserAcceptance: parentId === null,
    acceptanceBasis: null,
    archiveHistory: [],
    createdAt: context.now,
    updatedAt: context.now,
  };
  state.tasks.push(task);
  applyTemporary(state, task, op);
  applyApproval(task, op, context);
  applyAcceptanceRequirement(task, op, context);
  // The create path is the same approval check as update: a task may not be
  // born in progress unless the approval it carries is real.
  if (status === 'in_progress') assertExecutable(task);
  state.workline.updatedAt = context.now;
  return { op: 'create', id };
}

function applyBlocker(state, task, op) {
  const hasReason = op.blockerReason !== undefined;
  const hasUnblock = op.blockerUnblock !== undefined;
  if (!hasReason && !hasUnblock) return;
  const current = task.blocker ?? { reason: '', unblock: '' };
  const reason = hasReason ? singleLine(op.blockerReason, 'blockerReason', LIMITS.blocker) : current.reason;
  const unblock = hasUnblock ? singleLine(op.blockerUnblock, 'blockerUnblock', LIMITS.blocker) : current.unblock;
  if (reason === '' && unblock === '') {
    task.blocker = null;
    return;
  }
  if (reason === '') fail(`task ${task.id}: blockerReason is required when a blocker is recorded`);
  task.blocker = { reason, unblock };
}

/**
 * Apply the interrupt relation (`temporary` / `temporaryFor`).
 *
 * A temporary task absorbs an urgent problem that pulled the agent away from
 * the mainline task; `temporaryFor` names that interrupted task. The two fields
 * are kept consistent: naming a task makes the task temporary, dropping the
 * marker clears the link, and a temporary task must always name its source.
 *
 * The link is a pointer into the same workline, never a place to hide history:
 * the source must exist, be active, and the chain of interrupts must not loop
 * back to the task itself.
 */
function applyTemporary(state, task, op) {
  const hasFlag = op.temporary !== undefined;
  const hasFor = op.temporaryFor !== undefined;
  if (!hasFlag && !hasFor) return;
  if (hasFlag && typeof op.temporary !== 'boolean') fail(`task ${task.id}: temporary must be a boolean`);
  if (hasFor && op.temporaryFor !== null && typeof op.temporaryFor !== 'string') {
    fail(`task ${task.id}: temporaryFor must be a task id or null`);
  }
  // `temporaryFor` is the actionable write: naming the interrupted task is what
  // makes a task temporary, so one field is enough. An explicit false may not
  // leave a source behind.
  const temporary = hasFlag ? op.temporary === true : op.temporaryFor !== null;
  if (temporary === false) {
    if (hasFor && op.temporaryFor !== null) {
      fail(`task ${task.id}: a task that is not temporary cannot name the task it interrupted`);
    }
    task.temporary = false;
    task.temporaryFor = null;
    return;
  }
  const target = hasFor ? op.temporaryFor : task.temporaryFor;
  if (typeof target !== 'string' || target === '') {
    fail(`task ${task.id}: a temporary task must name the task it interrupted with temporaryFor`);
  }
  const source = findTask(state, target);
  if (source.id === task.id) fail(`task ${task.id} cannot be a temporary task for itself`);
  if (source.worklineId !== state.workline.id || task.worklineId !== state.workline.id) {
    fail(`task ${task.id}: temporaryFor must name a task in the same workline (${source.id} belongs to ${source.worklineId})`);
  }
  if (source.archived === true) {
    fail(`task ${task.id}: temporaryFor must name an active task, but ${source.id} is archived`);
  }
  // Walk the interrupt chain from the source. Reaching this task would close a
  // loop: a temporary task that (transitively) interrupted itself has no
  // mainline task to return to, and reading the panel would never settle.
  const seen = new Set([task.id]);
  let cursor = source;
  while (cursor !== undefined) {
    if (seen.has(cursor.id)) {
      fail(`task ${task.id}: temporaryFor would create a cycle of temporary tasks through ${cursor.id}`);
    }
    seen.add(cursor.id);
    cursor = typeof cursor.temporaryFor === 'string'
      ? state.tasks.find((candidate) => candidate.id === cursor.temporaryFor)
      : undefined;
  }
  task.temporary = true;
  task.temporaryFor = source.id;
}

function applyUpdate(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id, { active: true });
  if (op.title !== undefined) task.title = singleLine(op.title, 'title', LIMITS.title, { required: true });
  if (op.summary !== undefined) task.summary = singleLine(op.summary, 'summary', LIMITS.summary);
  if (op.expectedOutcome !== undefined) {
    task.expectedOutcome = singleLine(op.expectedOutcome, 'expectedOutcome', LIMITS.expectedOutcome);
  }
  if (op.nextStep !== undefined) task.nextStep = singleLine(op.nextStep, 'nextStep', LIMITS.nextStep);
  if (op.progress !== undefined) task.progress = multiLine(op.progress, 'progress', LIMITS.progress);
  if (op.result !== undefined) task.result = multiLine(op.result, 'result', LIMITS.result);
  applyBlocker(state, task, op);
  applyTemporary(state, task, op);
  applyApproval(task, op, context, { requireAcceptanceDecision: true });
  applyAcceptanceRequirement(task, op, context);
  // A self-verified completion may later receive the user's acceptance, whether or
  // not the same op also repeats the status.
  if (task.status === 'done' && op.confirmedByUser === true) acceptCompletion(state, task, op, context);
  if (op.status !== undefined) {
    const status = normalizeStatus(op.status);
    if (status === 'done') {
      if (task.status !== 'done') {
        if (task.deferred) fail(`task ${id}: resume the deferred task before completing it`);
        assertDeliveryComplete(state, task);
        finishTask(state, task, context.now, confirmationBasisFor(state, task, op, context));
      }
    } else {
      // Starting execution needs approval; recording progress on work that is
      // already running (for example in a workline written before this rule
      // existed) must not be blocked.
      if (status === 'in_progress' && task.status !== 'in_progress') assertExecutable(task);
      if (task.status === 'done') {
        task.completion = null;
        task.completionBasis = null;
        task.completedAt = null;
      }
      task.status = status;
      if (status === 'blocked' && task.blocker === null) {
        fail(`task ${id}: status blocked requires blockerReason (and optionally blockerUnblock)`);
      }
    }
  }
  touch(state, task, context.now);
  return { op: 'update', id };
}

function applyMove(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id, { active: true });
  let parentId = task.parentId;
  if (op.parentId !== undefined) {
    if (op.parentId === null) {
      parentId = null;
    } else {
      if (typeof op.parentId !== 'string' || op.parentId === '') fail('parentId must be a task id or null');
      const parent = findTask(state, op.parentId, { active: true });
      if (parent.id === task.id) fail(`task ${id} cannot be its own parent`);
      if (isDescendant(state, parent.id, task.id)) fail(`task ${id} cannot move under its own descendant ${parent.id}`);
      parentId = parent.id;
    }
  }
  if (task.status !== 'done' && hasStarted(task)) {
    fail(
      `task ${id} is part of the current delivery and cannot be moved: finish it, defer it, or archive it first;`
      + ' moving work out of a parent does not make it done',
    );
  }
  let order;
  if (op.order !== undefined) order = normalizeOrder(op.order);
  else if (parentId !== task.parentId) order = nextOrder(state, parentId, task.id);
  else order = task.order;
  task.parentId = parentId;
  task.order = order;
  touch(state, task, context.now);
  return { op: 'move', id };
}

/**
 * Take a task out of the current delivery only with the user's own words.
 *
 * Work that is authorised and unfinished is part of what the parent is
 * delivering: deferring or archiving it shrinks that delivery, so the agent
 * cannot do it on its own. Ideas that never got approved, and finished work,
 * are ordinary tidying.
 * @returns the verified quote, or null when no decision was needed.
 */
function applyUserDecision(task, op, context, action) {
  const basis = op.userBasis === undefined ? '' : singleLine(op.userBasis, 'userBasis', LIMITS.basis);
  if (!needsUserDecision(task)) return null;
  if (basis === '') {
    fail(
      `task ${task.id} is authorised and not finished, so ${action} changes the current delivery;`
      + " pass userBasis quoting the user's decision, or finish it first",
    );
  }
  const verdict = verifyQuote(context, basis);
  if (!verdict.ok) {
    fail(
      `task ${task.id}: userBasis does not appear in a user message (${verdict.reason});`
      + ' ask the user before taking this work out of the delivery',
    );
  }
  return basis;
}

function applyDefer(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id, { active: true });
  applyUserDecision(task, op, context, 'defer it');
  const reason = optionalSingleLine(op.deferredReason, 'deferredReason', LIMITS.shortText);
  const condition = optionalSingleLine(op.resumeCondition, 'resumeCondition', LIMITS.shortText);
  if (op.deferredReason !== undefined) task.deferredReason = reason === '' ? null : reason;
  if (op.resumeCondition !== undefined) task.resumeCondition = condition === '' ? null : condition;
  task.deferred = true;
  if (op.userBasis !== undefined) task.deferredBasis = singleLine(op.userBasis, 'userBasis', LIMITS.basis);
  task.owner = null;
  removeFromFocus(state, task.id);
  touch(state, task, context.now);
  return { op: 'defer', id };
}

function applyResume(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id, { active: true });
  task.deferred = false;
  task.deferredReason = null;
  task.resumeCondition = null;
  touch(state, task, context.now);
  return { op: 'resume', id };
}

/** Every task an archive of `task` would move: itself plus its live descendants. */
function archiveSubtree(state, task) {
  const collected = [];
  const seen = new Set();
  const stack = [task.id];
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (seen.has(currentId)) continue;
    seen.add(currentId);
    const current = state.tasks.find((candidate) => candidate.id === currentId);
    if (current === undefined || current.archived) continue;
    collected.push(current);
    for (const child of childTasks(state, current.id)) stack.push(child.id);
  }
  return collected;
}

function applyArchive(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id, { active: true });
  const subtree = archiveSubtree(state, task);
  // The whole subtree leaves the delivery, so one in-flight descendant is enough
  // to make the user's decision necessary — a pending container must not launder
  // authorised work out of it.
  const blockingDescendant = subtree.find((node) => needsUserDecision(node));
  const basis = blockingDescendant === undefined
    ? null
    : applyUserDecision(blockingDescendant, op, context, `archive ${task.id}`);
  const reason = singleLine(op.reason, 'reason', LIMITS.reason, { required: true });
  const batch = `${task.id}@${context.now}`;
  for (const current of subtree) {
    current.archived = true;
    current.archiveReason = reason;
    current.archivedAt = context.now;
    current.archiveBatch = batch;
    current.archiveBasis = basis;
    current.archiveHistory = Array.isArray(current.archiveHistory) ? current.archiveHistory : [];
    current.archiveHistory.push(basis === null ? { at: context.now, reason } : { at: context.now, reason, basis });
    current.archiveHistory = current.archiveHistory.slice(-20);
    current.owner = null;
    removeFromFocus(state, current.id);
    touch(state, current, context.now);
  }
  return { op: 'archive', id };
}

function applyRestore(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id);
  if (task.archived !== true) fail(`task ${id} is not archived`);
  // Restore under the original parent when it is active; otherwise reparent to
  // the nearest active ancestor (or the root) so the tree stays valid.
  let parentId = task.parentId;
  if (parentId !== null) {
    const seen = new Set();
    let cursor = parentId;
    while (typeof cursor === 'string' && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = state.tasks.find((candidate) => candidate.id === cursor);
      if (parent === undefined) {
        cursor = null;
        break;
      }
      if (parent.archived !== true) break;
      cursor = parent.parentId;
    }
    parentId = typeof cursor === 'string' ? cursor : null;
  }
  const batch = task.archiveBatch ?? null;
  if (parentId !== task.parentId) {
    // A reparented root goes to the end of its new siblings.
    task.order = nextOrder(state, parentId, task.id);
  }
  task.parentId = parentId;
  // Restore the archived subtree that the SAME archive event removed: a task
  // archived with its children comes back with them, while a descendant that
  // was cancelled separately stays archived.
  const stack = [task.id];
  while (stack.length > 0) {
    const currentId = stack.pop();
    const current = state.tasks.find((candidate) => candidate.id === currentId);
    if (current === undefined || current.archived !== true) continue;
    current.archived = false;
    current.archiveReason = null;
    current.archivedAt = null;
    current.archiveBatch = null;
    current.owner = null;
    removeFromFocus(state, current.id);
    touch(state, current, context.now);
    for (const child of state.tasks) {
      if (child.parentId !== current.id || child.archived !== true) continue;
      // Legacy records (no batch) keep the old whole-subtree behavior.
      if (batch !== null && child.archiveBatch !== batch) continue;
      stack.push(child.id);
    }
  }
  return { op: 'restore', id };
}

function applyFocus(state, op, context) {
  if (!Array.isArray(op.ids)) fail('ids must be an array of task ids (use [] to clear the focus)');
  const next = [];
  const seen = new Set();
  for (const raw of op.ids) {
    if (typeof raw !== 'string' || raw.trim() === '') fail('ids entries must be non-empty task ids');
    const id = raw.trim();
    if (seen.has(id)) continue;
    const task = findTask(state, id, { active: true });
    if (task.deferred) fail(`task ${id} is deferred and cannot be focused`);
    if (task.status === 'done') fail(`task ${id} is done and cannot be focused`);
    seen.add(id);
    next.push(id);
  }
  for (const id of next) {
    const task = state.tasks.find((candidate) => candidate.id === id);
    // Focus is attention, not permission: an unapproved task can be the current
    // subject of discussion without being started.
    if (task.status === 'pending' && task.executionApproval === 'approved') {
      task.status = 'in_progress';
      touch(state, task, context.now);
    }
  }
  state.workline.focus = next;
  state.workline.updatedAt = context.now;
  return { op: 'focus' };
}

/**
 * Mark a task as being worked on by the calling session.
 *
 * `owner` is a record, not a credential: it grants no permission and refuses no
 * tool call (ADR-0003). The one check kept is a compare-and-set: while one
 * session holds the task, another session's claim is refused, so two sessions
 * cannot work on the same task. The same session may claim again — it only
 * refreshes the record — and `release` clears it whoever calls it.
 */
function applyClaim(state, op, context) {
  const id = requireTaskId(op);
  const actor = typeof context.actorSessionId === 'string' && context.actorSessionId !== ''
    ? context.actorSessionId
    : undefined;
  if (actor === undefined) fail(`task ${id}: claim requires a calling session`);
  const task = findTask(state, id, { active: true });
  if (task.deferred) fail(`task ${id} is deferred and cannot be claimed`);
  assertExecutable(task);
  if (task.status !== 'in_progress') fail(`task ${id} must be in_progress to claim (current: ${task.status})`);
  const owner = task.owner;
  if (owner !== null && owner !== undefined && owner.sessionId !== actor) {
    fail(`task ${id} is already claimed by session ${owner.sessionId};`
      + ' two sessions must not work on the same task — release it first if that session is gone');
  }
  // A record written by the old Team binding also carries the member name. A
  // re-claim by the same session keeps it, so the panel does not lose the name
  // it can still show; any other claim starts a fresh record.
  const keepMember = owner !== null && owner !== undefined && owner.sessionId === actor;
  task.owner = {
    sessionId: actor,
    member: keepMember && typeof owner.member === 'string' && owner.member !== '' ? owner.member : null,
    since: context.now,
  };
  touch(state, task, context.now);
  return { op: 'claim', id };
}

/** Clear the claim record: the session working on the task handed it back. */
function applyRelease(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id, { active: true });
  task.owner = null;
  touch(state, task, context.now);
  return { op: 'release', id };
}

function applyComplete(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id, { active: true });
  if (task.status === 'done') {
    if (task.completion === 'user-confirmed') fail(`task ${id} is already done`);
    if (op.result !== undefined) task.result = multiLine(op.result, 'result', LIMITS.result);
    acceptCompletion(state, task, op, context);
    return { op: 'complete', id };
  }
  if (task.deferred) fail(`task ${id}: resume the deferred task before completing it`);
  assertDeliveryComplete(state, task);
  if (op.result !== undefined) task.result = multiLine(op.result, 'result', LIMITS.result);
  finishTask(state, task, context.now, confirmationBasisFor(state, task, op, context));
  return { op: 'complete', id };
}

function applyOne(state, op, context) {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) fail('each op must be an object');
  const kind = op.op;
  if (typeof kind !== 'string' || kind === '') fail('op.op is required');
  const allowed = OP_FIELDS[kind];
  if (allowed === undefined) fail(`unknown op ${JSON.stringify(kind)}; expected one of ${TASK_OPS.join(', ')}`);
  for (const key of Object.keys(op)) {
    if (!allowed.includes(key)) fail(`unsupported field ${JSON.stringify(key)} for op ${JSON.stringify(kind)}`);
  }
  switch (kind) {
    case 'init': return applyInit(state, op);
    case 'reviseGoal': return applyReviseGoal(state, op, context);
    case 'create': return applyCreate(state, op, context);
    case 'update': return applyUpdate(state, op, context);
    case 'move': return applyMove(state, op, context);
    case 'defer': return applyDefer(state, op, context);
    case 'resume': return applyResume(state, op, context);
    case 'archive': return applyArchive(state, op, context);
    case 'restore': return applyRestore(state, op, context);
    case 'focus': return applyFocus(state, op, context);
    case 'claim': return applyClaim(state, op, context);
    case 'release': return applyRelease(state, op, context);
    case 'complete': return applyComplete(state, op, context);
    /* v8 ignore next -- TASK_OPS and this switch are kept in lockstep. */
    default: return fail(`unknown op ${JSON.stringify(kind)}`);
  }
}

/**
 * Validate and apply one batch of write ops atomically.
 *
 * @param envelope - the current persisted envelope, or undefined for a new workline.
 * @param ops - the flat op objects from `task_tree_write`.
 * @param context - `{ worklineId, now, actorSessionId, verifyUserQuote }`;
 *   `actorSessionId` is the session a claim records as the one working, and
 *   `verifyUserQuote(quote)` returns `{ ok, reason?, seq? }` and gates every
 *   claim of user approval or user acceptance.
 * @returns `{ envelope, applied }`; throws {@link TaskTreeError} without side effects.
 */
export function applyOps(envelope, ops, context = {}) {
  const worklineId = requireWorklineId(context.worklineId);
  const now = numberOr(context.now, Date.now());
  const actorSessionId = typeof context.actorSessionId === 'string' && context.actorSessionId !== ''
    ? context.actorSessionId
    : undefined;
  const verifyUserQuote = typeof context.verifyUserQuote === 'function' ? context.verifyUserQuote : undefined;
  if (!Array.isArray(ops) || ops.length === 0) fail('ops must be a non-empty array');
  if (ops.length > LIMITS.maxOps) fail(`ops must contain at most ${LIMITS.maxOps} entries`);
  const state = envelope === undefined || envelope === null
    ? createEmptyEnvelope(worklineId, now)
    : cloneEnvelope(envelope);
  if (state.workline.id !== worklineId) {
    fail(`workline mismatch: record id ${state.workline.id} does not match ${worklineId}`);
  }
  const applied = [];
  for (let index = 0; index < ops.length; index += 1) {
    try {
      applied.push(applyOne(state, ops[index], {
        worklineId, now, actorSessionId, verifyUserQuote,
      }));
    } catch (error) {
      const message = error instanceof TaskTreeError
        ? error.message
        : `unexpected failure: ${String(error?.message ?? error)}`;
      fail(`ops[${index}]: ${message}`);
    }
  }
  state.workline.updatedAt = now;
  return { envelope: state, applied };
}

/** The claim record as the user should see it: the Lead, a named teammate, or a session. */
function executorOf(task, worklineId) {
  const owner = task.owner;
  if (owner === null || owner === undefined || typeof owner.sessionId !== 'string') return null;
  const kind = owner.sessionId === worklineId ? 'lead' : (typeof owner.member === 'string' ? 'teammate' : 'subagent');
  const name = kind === 'lead' ? 'lead' : (typeof owner.member === 'string' ? owner.member : owner.sessionId);
  return { kind, name, sessionId: owner.sessionId };
}

/**
 * The `task_tree_read` payload (CONTRACT.md §3).
 * @param envelope - persisted envelope or undefined.
 * @param worklineId - the resolved workline id.
 * @param details - include summary/progress/result when true.
 */
export function readSnapshot(envelope, worklineId, details = false, options = {}) {
  const includeArchived = options !== null && typeof options === 'object' && options.includeArchived === true;
  const limitRaw = options !== null && typeof options === 'object' ? options.archivedLimit : undefined;
  const archivedLimit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  if (envelope === undefined) {
    const empty = {
      worklineId, goal: null, focus: [], tasks: [],
    };
    if (includeArchived) {
      empty.archived = [];
      empty.archivedTotal = 0;
    }
    return empty;
  }
  const workline = envelope.workline ?? {};
  const goal = workline.goal === null || workline.goal === undefined
    ? null
    : { original: workline.goal.original, current: workline.goal.current };
  const settled = settledLookup(envelope.tasks);
  const tasks = orderedTree(envelope.tasks).map(({ task, depth }) => {
    const row = {
      id: task.id,
      parentId: task.parentId,
      title: task.title,
      status: task.status,
      settled: settled(task.id),
      approval: approvalOf(task),
      requiresUserAcceptance: requiresAcceptanceOf(task),
      deferred: task.deferred === true,
      blocked: isBlocked(task),
      owner: task.owner !== null && task.owner !== undefined,
      executor: executorOf(task, worklineId),
      // The interrupt relation travels with every row: the tree can mark or
      // explain a temporary task without a second read (right sidebar).
      temporary: task.temporary === true,
      temporaryFor: typeof task.temporaryFor === 'string' ? task.temporaryFor : null,
      depth,
    };
    if (details) {
      row.summary = task.summary ?? '';
      row.expectedOutcome = task.expectedOutcome ?? '';
      row.nextStep = task.nextStep ?? '';
      row.progress = task.progress ?? '';
      row.result = typeof task.result === 'string' ? task.result : null;
      row.completion = completionOf(task);
      row.approvalBasis = typeof task.approvalBasis === 'string' && task.approvalBasis !== '' ? task.approvalBasis : null;
      row.acceptanceBasis = typeof task.acceptanceBasis === 'string' && task.acceptanceBasis !== '' ? task.acceptanceBasis : null;
    }
    return row;
  });
  const snapshot = {
    worklineId,
    goal,
    focus: Array.isArray(workline.focus) ? [...workline.focus] : [],
    tasks,
  };
  if (includeArchived) {
    const archivedTasks = (Array.isArray(envelope.tasks) ? envelope.tasks : [])
      .filter((task) => task.archived === true)
      .sort((left, right) => numberOr(right.archivedAt, 0) - numberOr(left.archivedAt, 0));
    snapshot.archivedTotal = archivedTasks.length;
    snapshot.archived = archivedTasks.slice(0, archivedLimit).map((task) => ({
      id: task.id,
      parentId: task.parentId,
      title: task.title,
      status: task.status,
      approval: approvalOf(task),
      deferred: task.deferred === true,
      archivedAt: task.archivedAt ?? null,
      archiveReason: task.archiveReason ?? null,
      summary: task.summary ?? '',
      progress: task.progress ?? '',
      result: typeof task.result === 'string' ? task.result : null,
      completion: completionOf(task),
      path: ancestorTitles(envelope.tasks, task.parentId),
    }));
  }
  return snapshot;
}

/** Ancestor titles from the root down to the direct parent. */
function ancestorTitles(tasks, parentId) {
  const titles = [];
  const seen = new Set();
  let cursor = parentId;
  while (typeof cursor === 'string' && !seen.has(cursor)) {
    seen.add(cursor);
    const task = tasks.find((candidate) => candidate.id === cursor);
    if (task === undefined) break;
    titles.unshift(task.title);
    cursor = task.parentId;
  }
  return titles;
}

/**
 * The `GET /summary-panel/tasks` payload (CONTRACT.md §4).
 * @param envelope - persisted envelope or undefined.
 * @param worklineId - the resolved workline id.
 * @param options - `{ isLive(sessionId) }` for the occupancy flag.
 */
export function httpSnapshot(envelope, worklineId, options = {}) {
  const isLive = typeof options.isLive === 'function' ? options.isLive : () => false;
  if (envelope === undefined) {
    return {
      available: true,
      worklineId,
      goal: null,
      outline: '',
      focus: [],
      updatedAt: 0,
      tasks: [],
      archived: [],
      archivedCount: 0,
    };
  }
  const workline = envelope.workline ?? {};
  const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
  const goal = workline.goal === null || workline.goal === undefined
    ? null
    : {
      original: workline.goal.original,
      current: workline.goal.current,
      changes: (Array.isArray(workline.goal.changes) ? workline.goal.changes : []).map((entry) => ({
        at: entry.at,
        reason: entry.reason,
        previous: entry.previous,
        next: entry.next,
      })),
    };
  const settled = settledLookup(tasks);
  const active = orderedTree(tasks).map(({ task }) => ({
    id: task.id,
    parentId: task.parentId,
    order: task.order,
    title: task.title,
    summary: task.summary,
    expectedOutcome: task.expectedOutcome ?? '',
    nextStep: task.nextStep ?? '',
    temporary: task.temporary === true,
    temporaryFor: typeof task.temporaryFor === 'string' ? task.temporaryFor : null,
    status: task.status,
    settled: settled(task.id),
    executionApproval: approvalOf(task),
    approvalBasis: typeof task.approvalBasis === 'string' && task.approvalBasis !== '' ? task.approvalBasis : null,
    approvalAt: typeof task.approvalAt === 'number' ? task.approvalAt : null,
    requiresUserAcceptance: requiresAcceptanceOf(task),
    acceptanceBasis: typeof task.acceptanceBasis === 'string' && task.acceptanceBasis !== '' ? task.acceptanceBasis : null,
    deferred: task.deferred === true,
    deferredReason: task.deferredReason ?? null,
    resumeCondition: task.resumeCondition ?? null,
    blocker: task.blocker === null || task.blocker === undefined
      ? null
      : { reason: task.blocker.reason, unblock: task.blocker.unblock ?? '' },
    progress: task.progress,
    result: task.result ?? null,
    ownerSessionId: task.owner === null || task.owner === undefined ? null : task.owner.sessionId,
    ownerName: task.owner === null || task.owner === undefined ? null : (task.owner.member ?? null),
    ownerLive: task.owner === null || task.owner === undefined ? false : isLive(task.owner.sessionId) === true,
    completion: completionOf(task),
    completionBasis: typeof task.completionBasis === 'string' && task.completionBasis !== '' ? task.completionBasis : null,
    completedAt: typeof task.completedAt === 'number' ? task.completedAt : null,
    updatedAt: task.updatedAt,
    ...(Array.isArray(task.archiveHistory) && task.archiveHistory.length > 0
      ? {
        archiveHistory: task.archiveHistory.map((entry) => ({
          at: numberOr(entry.at, 0),
          reason: typeof entry.reason === 'string' ? entry.reason : '',
        })),
      }
      : {}),
  }));
  const archivedTasks = tasks.filter((task) => task.archived === true);
  const archived = archivedTasks
    .slice()
    .sort((left, right) => numberOr(right.archivedAt, 0) - numberOr(left.archivedAt, 0))
    .slice(0, LIMITS.archivedListed)
    .map((task) => ({
      id: task.id,
      parentId: task.parentId,
      title: task.title,
      archiveReason: task.archiveReason ?? null,
      archivedAt: task.archivedAt ?? null,
    }));
  return {
    available: true,
    worklineId,
    goal,
    outline: typeof workline.outline === 'string' ? workline.outline : '',
    focus: Array.isArray(workline.focus) ? [...workline.focus] : [],
    updatedAt: numberOr(workline.updatedAt, 0),
    tasks: active,
    archived,
    archivedCount: archivedTasks.length,
  };
}

/**
 * The `GET /summary-panel/tasks/status` payload (CONTRACT.md §4).
 * @param envelope - persisted envelope or undefined.
 * @param worklineId - the resolved workline id.
 */
export function statusSnapshot(envelope, worklineId) {
  if (envelope === undefined) return { available: true, focus: [], updatedAt: 0 };
  const workline = envelope.workline ?? {};
  const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const focus = [];
  for (const id of Array.isArray(workline.focus) ? workline.focus : []) {
    const task = byId.get(id);
    if (task === undefined || task.archived === true) continue;
    focus.push({ id: task.id, title: task.title, status: task.status, blocked: isBlocked(task) });
  }
  return { available: true, focus, updatedAt: numberOr(workline.updatedAt, 0) };
}
