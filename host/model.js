/**
 * Pure task-tree domain logic.
 *
 * This module owns every rule of the workline task tree (validation, the
 * parent/child invariants, focus and occupancy semantics, goal revisions, and
 * the wire snapshots consumed by the tools and HTTP routes). It deliberately
 * imports nothing: no dsh package, no zod, and no node built-in. Storage lives
 * in `host/store.js`, so this file is directly unit-testable.
 *
 * A workline record is the persisted envelope `{ version, workline, tasks }`.
 * All operations are applied to a private clone first; a failure anywhere in
 * the batch leaves the caller's record untouched (the batch is atomic).
 */

/** The four active task statuses. */
export const TASK_STATUSES = Object.freeze(['pending', 'in_progress', 'blocked', 'done']);

/** Every operation accepted by `task_tree_write`. */
export const TASK_OPS = Object.freeze([
  'init',
  'reviseGoal',
  'create',
  'update',
  'move',
  'defer',
  'resume',
  'archive',
  'focus',
  'claim',
  'release',
  'complete',
]);

/** Contract limits (CONTRACT.md §1 and §3). */
export const LIMITS = Object.freeze({
  title: 40,
  summary: 240,
  progress: 2000,
  result: 500,
  outline: 4000,
  goal: 4000,
  reason: 1000,
  shortText: 500,
  blocker: 1000,
  archivedListed: 200,
  maxOps: 100,
});

/** Fields each op may carry; anything else is a caller mistake worth reporting. */
const OP_FIELDS = Object.freeze({
  init: ['op', 'originalGoal', 'outline'],
  reviseGoal: ['op', 'current', 'reason'],
  create: ['op', 'title', 'summary', 'parentId', 'status', 'progress', 'order'],
  update: ['op', 'id', 'title', 'summary', 'status', 'progress', 'result', 'blockerReason', 'blockerUnblock', 'confirmedByUser'],
  move: ['op', 'id', 'parentId', 'order'],
  defer: ['op', 'id', 'deferredReason', 'resumeCondition'],
  resume: ['op', 'id'],
  archive: ['op', 'id', 'reason'],
  focus: ['op', 'ids'],
  claim: ['op', 'id'],
  release: ['op', 'id'],
  complete: ['op', 'id', 'confirmedByUser', 'result'],
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

export function isBlocked(task) {
  return task.status === 'blocked' || task.blocker !== null && task.blocker !== undefined;
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
    status: TASK_STATUSES.includes(task.status) ? task.status : 'pending',
    deferred: task.deferred === true,
    deferredReason: typeof task.deferredReason === 'string' ? task.deferredReason : null,
    resumeCondition: typeof task.resumeCondition === 'string' ? task.resumeCondition : null,
    archived: task.archived === true,
    archiveReason: typeof task.archiveReason === 'string' ? task.archiveReason : null,
    archivedAt: typeof task.archivedAt === 'number' ? task.archivedAt : null,
    progress: typeof task.progress === 'string' ? task.progress : '',
    result: typeof task.result === 'string' ? task.result : null,
    blocker: task.blocker !== null && typeof task.blocker === 'object' && typeof task.blocker.reason === 'string'
      ? { reason: task.blocker.reason, unblock: typeof task.blocker.unblock === 'string' ? task.blocker.unblock : '' }
      : null,
    owner: task.owner !== null && typeof task.owner === 'object' && typeof task.owner.sessionId === 'string'
      ? { sessionId: task.owner.sessionId, since: numberOr(task.owner.since, 0) }
      : null,
    completion: task.completion === 'user-confirmed' || task.completion === 'self' ? task.completion : null,
    completedAt: typeof task.completedAt === 'number' ? task.completedAt : null,
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

function finishTask(state, task, now) {
  const unfinished = childTasks(state, task.id).filter((child) => child.status !== 'done');
  if (unfinished.length > 0) {
    const ids = unfinished.map((child) => child.id).join(', ');
    fail(`task ${task.id} cannot be done while child tasks are unfinished: ${ids}`);
  }
  task.status = 'done';
  task.completion = 'user-confirmed';
  task.completedAt = now;
  task.blocker = null;
  task.owner = null;
  removeFromFocus(state, task.id);
  touch(state, task, now);
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
  const progress = op.progress === undefined ? '' : multiLine(op.progress, 'progress', LIMITS.progress);
  const order = op.order === undefined ? nextOrder(state, parentId, undefined) : normalizeOrder(op.order);
  const id = nextTaskId(state);
  state.tasks.push({
    id,
    worklineId: state.workline.id,
    parentId,
    order,
    title,
    summary,
    status,
    deferred: false,
    deferredReason: null,
    resumeCondition: null,
    archived: false,
    archiveReason: null,
    archivedAt: null,
    progress,
    result: null,
    blocker: null,
    owner: null,
    completion: null,
    completedAt: null,
    createdAt: context.now,
    updatedAt: context.now,
  });
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

function applyUpdate(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id, { active: true });
  if (op.title !== undefined) task.title = singleLine(op.title, 'title', LIMITS.title, { required: true });
  if (op.summary !== undefined) task.summary = singleLine(op.summary, 'summary', LIMITS.summary);
  if (op.progress !== undefined) task.progress = multiLine(op.progress, 'progress', LIMITS.progress);
  if (op.result !== undefined) task.result = multiLine(op.result, 'result', LIMITS.result);
  applyBlocker(state, task, op);
  if (op.status !== undefined) {
    const status = normalizeStatus(op.status);
    if (status === 'done') {
      if (task.status !== 'done') {
        if (op.confirmedByUser !== true) {
          fail(`task ${id}: marking done requires confirmedByUser: true after the user confirms completion`);
        }
        if (task.deferred) fail(`task ${id}: resume the deferred task before completing it`);
        finishTask(state, task, context.now);
      }
    } else {
      if (task.status === 'done') {
        task.completion = null;
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
  let order;
  if (op.order !== undefined) order = normalizeOrder(op.order);
  else if (parentId !== task.parentId) order = nextOrder(state, parentId, task.id);
  else order = task.order;
  task.parentId = parentId;
  task.order = order;
  touch(state, task, context.now);
  return { op: 'move', id };
}

function applyDefer(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id, { active: true });
  const reason = optionalSingleLine(op.deferredReason, 'deferredReason', LIMITS.shortText);
  const condition = optionalSingleLine(op.resumeCondition, 'resumeCondition', LIMITS.shortText);
  if (op.deferredReason !== undefined) task.deferredReason = reason === '' ? null : reason;
  if (op.resumeCondition !== undefined) task.resumeCondition = condition === '' ? null : condition;
  task.deferred = true;
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

function applyArchive(state, op, context) {
  const id = requireTaskId(op);
  const task = findTask(state, id, { active: true });
  const reason = singleLine(op.reason, 'reason', LIMITS.reason, { required: true });
  const stack = [task.id];
  const archived = [];
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (archived.includes(currentId)) continue;
    const current = state.tasks.find((candidate) => candidate.id === currentId);
    if (current === undefined || current.archived) continue;
    current.archived = true;
    current.archiveReason = reason;
    current.archivedAt = context.now;
    current.owner = null;
    removeFromFocus(state, current.id);
    touch(state, current, context.now);
    archived.push(current.id);
    for (const child of childTasks(state, current.id)) stack.push(child.id);
  }
  return { op: 'archive', id };
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
    if (task.status === 'pending') {
      task.status = 'in_progress';
      touch(state, task, context.now);
    }
  }
  state.workline.focus = next;
  state.workline.updatedAt = context.now;
  return { op: 'focus' };
}

function applyClaim(state, op, context) {
  const id = requireTaskId(op);
  const actor = typeof context.actorSessionId === 'string' && context.actorSessionId !== '' ? context.actorSessionId : undefined;
  if (actor === undefined) fail(`task ${id}: claim requires a calling session`);
  const task = findTask(state, id, { active: true });
  if (task.deferred) fail(`task ${id} is deferred and cannot be claimed`);
  if (task.status !== 'in_progress') fail(`task ${id} must be in_progress to claim (current: ${task.status})`);
  const owner = task.owner;
  if (owner !== null && owner.sessionId !== actor) {
    const live = typeof context.isLive === 'function' ? context.isLive(owner.sessionId) === true : false;
    if (live) fail(`task ${id} is claimed by live session ${owner.sessionId}`);
  }
  task.owner = { sessionId: actor, since: context.now };
  touch(state, task, context.now);
  return { op: 'claim', id };
}

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
  if (op.confirmedByUser !== true) {
    fail(`task ${id}: complete requires confirmedByUser: true after the user confirms completion`);
  }
  if (task.status === 'done') fail(`task ${id} is already done`);
  if (task.deferred) fail(`task ${id}: resume the deferred task before completing it`);
  if (op.result !== undefined) task.result = multiLine(op.result, 'result', LIMITS.result);
  finishTask(state, task, context.now);
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
 * @param context - `{ worklineId, now, actorSessionId, isLive }`.
 * @returns `{ envelope, applied }`; throws {@link TaskTreeError} without side effects.
 */
export function applyOps(envelope, ops, context = {}) {
  const worklineId = requireWorklineId(context.worklineId);
  const now = numberOr(context.now, Date.now());
  const actorSessionId = typeof context.actorSessionId === 'string' && context.actorSessionId !== ''
    ? context.actorSessionId
    : undefined;
  const isLive = typeof context.isLive === 'function' ? context.isLive : () => false;
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
      applied.push(applyOne(state, ops[index], { worklineId, now, actorSessionId, isLive }));
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

/**
 * The `task_tree_read` payload (CONTRACT.md §3).
 * @param envelope - persisted envelope or undefined.
 * @param worklineId - the resolved workline id.
 * @param details - include summary/progress/result when true.
 */
export function readSnapshot(envelope, worklineId, details = false) {
  if (envelope === undefined) return { worklineId, goal: null, focus: [], tasks: [] };
  const workline = envelope.workline ?? {};
  const goal = workline.goal === null || workline.goal === undefined
    ? null
    : { original: workline.goal.original, current: workline.goal.current };
  const tasks = orderedTree(envelope.tasks).map(({ task, depth }) => {
    const row = {
      id: task.id,
      parentId: task.parentId,
      title: task.title,
      status: task.status,
      deferred: task.deferred === true,
      blocked: isBlocked(task),
      owner: task.owner !== null && task.owner !== undefined,
      depth,
    };
    if (details) {
      row.summary = task.summary ?? '';
      row.progress = task.progress ?? '';
      row.result = typeof task.result === 'string' ? task.result : null;
    }
    return row;
  });
  return {
    worklineId,
    goal,
    focus: Array.isArray(workline.focus) ? [...workline.focus] : [],
    tasks,
  };
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
  const active = orderedTree(tasks).map(({ task }) => ({
    id: task.id,
    parentId: task.parentId,
    order: task.order,
    title: task.title,
    summary: task.summary,
    status: task.status,
    deferred: task.deferred === true,
    deferredReason: task.deferredReason ?? null,
    resumeCondition: task.resumeCondition ?? null,
    blocker: task.blocker === null || task.blocker === undefined
      ? null
      : { reason: task.blocker.reason, unblock: task.blocker.unblock ?? '' },
    progress: task.progress,
    result: task.result ?? null,
    ownerSessionId: task.owner === null || task.owner === undefined ? null : task.owner.sessionId,
    ownerLive: task.owner === null || task.owner === undefined ? false : isLive(task.owner.sessionId) === true,
    completion: task.completion ?? null,
    updatedAt: task.updatedAt,
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
