/**
 * The execution gate (design v8 §3, §7, §10): class A tools need an active
 * execution for the caller's workline, and a Team Lead never gets one.
 *
 * Tools are classified into three classes:
 *
 * - **A — workspace modification / code execution.** These may only run while
 *   the calling session holds an active execution (a `claim` stamp) on a task
 *   in its workline's tree.
 * - **B — task management and execution control.** Authorised by role and
 *   ownership; it never needs an execution. This is what makes `claim` itself
 *   possible without a circular dependency.
 * - **C — read-only.** Always allowed.
 *
 * Two modes, decided by composition rather than by model input:
 *
 * - **Standard mode** (no Agent Team service): the one execution seat rule
 *   above.
 * - **Team mode** (the Agent Team service is composed): the Lead is a pure
 *   coordinator. Every class A tool is refused for the Lead — including shell,
 *   because one `sed -i` would bypass the file tools — and it is refused before
 *   the workline is even consulted, so it does not depend on who holds a seat.
 *   A teammate gets class A only after the Lead dispatched a tree task to its
 *   roster name and the Worker's own Team-board claim bound an execution. The
 *   guard therefore also pre-checks two class B calls: `team_task_update
 *   {action:"claim"}` must match the dispatch for the roster-resolved caller
 *   and must not target a task stopped by an unresolved evidence conflict, and
 *   `reassign` is refused outright because assignment is not a binding.
 *
 * The classification is **default-deny**: only tools that provably read (C) or
 * provably manage tasks/executions (B) are allow-listed; anything else —
 * including a tool a later plugin registers — is class A. A short blacklist of
 * `write`/`edit`/`bash` would silently pass every new mutating tool.
 *
 * The gate is a monotonic tool guard registered through `ctx.tools.guard`, so
 * it runs before dispatch and no listener can out-vote it. It must decide
 * synchronously: the caller's identity comes from the live agent, and the
 * caller's tree comes from the store's synchronous snapshot (its in-process
 * cache, read from disk only when that workline has not been touched yet).
 *
 * A committed execution is not enough on its own: the guard decides before the
 * tree write, so a second claim would pass the same coarse checks while the
 * first is still in flight. Every ownership-changing call therefore takes a
 * synchronous seat from `host/reservation.js` here, before dispatch; the seat
 * is released only by that call's own tool result (or its agent going idle),
 * never by a timer.
 *
 * A workline with no persisted tree is unmanaged: nothing is restricted, so
 * ordinary sessions are never affected (design §14.4).
 */

import { workerLifetimeDenial, workerLifetimeOf } from './lifetime.js';
import { seatDenialReason, seatRequestFor } from './reservation.js';
import { teamMembershipOf, teamServiceOf } from './roster.js';

const MAX_WORKLINE_DEPTH = 50;

/** Class B: task management and execution control, authorised without an execution. */
const MANAGES_TOOLS = Object.freeze(new Set([
  'spawn_teammate',
  'send_message',
  'wait_agent',
  'list_agents',
  'interrupt_agent',
  'ask_user_question',
  'todo_write',
  'present',
  'create_goal',
  'get_goal',
  'update_goal',
]));

/** Class B by prefix: the two task systems plus session/goal/schedule control. */
const MANAGES_PREFIXES = Object.freeze(['task_tree_', 'team_task_', 'schedule_', 'session_']);

/** Class C: read-only tools, always allowed. */
const READS_TOOLS = Object.freeze(new Set([
  'read',
  'grep',
  'glob',
  'read_image',
  'skill',
  'plugin_market',
  'load_workspace_dependencies',
]));

/** Class C by prefix: web, background-job inspection, and host introspection. */
const READS_PREFIXES = Object.freeze(['web_', 'job_', 'cordis_inspect_']);

/**
 * Classify one tool name.
 *
 * Order matters: a task-management name that also looks read-only is B, and
 * everything unnamed is A. An absent or malformed name is A too — a denial the
 * model can read is safer than an unclassified mutation.
 * @param name - the tool name from the registry.
 * @returns `'A'`, `'B'`, or `'C'`.
 */
export function classifyTool(name) {
  if (typeof name !== 'string' || name === '') return 'A';
  if (MANAGES_TOOLS.has(name)) return 'B';
  if (MANAGES_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'B';
  if (READS_TOOLS.has(name)) return 'C';
  if (READS_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'C';
  return 'A';
}

/** The calling session, resolved from the live agent — never from model input. */
function callerOf(exec) {
  const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined;
  const header = agent !== null && typeof agent === 'object' ? agent.session?.header : undefined;
  if (typeof header?.id === 'string' && header.id !== '') return { sessionId: header.id, header };
  if (typeof agent?.id === 'string' && agent.id !== '') return { sessionId: agent.id, header };
  return { sessionId: undefined, header };
}

/**
 * Resolve the workline synchronously: walk `parentSession` through the live
 * session service. A header that is not live stops the walk at the last known
 * id, exactly like the async `sessions.rootSessionId` fallback.
 */
function worklineOf(ctx, sessionId, header) {
  let currentId = sessionId;
  let currentHeader = header;
  for (let depth = 0; depth < MAX_WORKLINE_DEPTH; depth += 1) {
    const parent = typeof currentHeader?.parentSession === 'string' ? currentHeader.parentSession : '';
    if (parent === '' || parent === currentId) return currentId;
    currentId = parent;
    let next;
    try {
      next = ctx.get('sessions')?.get?.(parent);
    } catch {
      next = undefined;
    }
    currentHeader = next?.header;
    if (currentHeader === undefined) return currentId;
  }
  return currentId;
}

/** Whether any live task in the tree carries this session's claim stamp. */
function holdsExecution(tasks, sessionId) {
  return tasks.some((task) => task !== null
    && typeof task === 'object'
    && task.archived !== true
    && task.owner !== null
    && typeof task.owner === 'object'
    && task.owner.sessionId === sessionId);
}

/**
 * The model-readable team-mode denial. It says who the caller is, which tools
 * are refused, and what it should do instead — coordination stays open.
 */
export function leadDenialReason({ tool, sessionId }) {
  return [
    `${tool} is a class A tool (workspace modification or code execution), and session ${sessionId}`
    + ' is the Lead of an Agent Team, which only coordinates.',
    'In team mode the Lead runs no concrete work: writing files, edit, shell, terminal, worktree, workflow,'
    + ' ralph and subagent spawn are all refused, even while a task execution is held.',
    'Spawn a teammate with spawn_teammate and send it the task; the Lead keeps task_tree_* and team_task_*'
    + ' for coordination.',
  ].join(' ');
}

/**
 * The model-readable refusal of `team_task_update reassign` (design v8 §6.2,
 * I18). Assignment via the board would write `in_progress + ownerId` directly,
 * and a later `claim` can only start from `pending`; there is no coherent
 * "assign then claim" path, so team mode refuses assignment outright.
 */
export function reassignDenialReason({ sessionId }) {
  return [
    `team_task_update reassign is refused for session ${sessionId}: assignment is not a binding in an Agent Team.`,
    'A Worker claim can only start from pending, while reassign writes in_progress and owner directly, so the two can never be combined.',
    'The Lead dispatches the task in the tree (task_tree_write {"op":"dispatch","id":"<task>","member":"<worker-name>","teamTaskId":"<task-N>"}),'
    + ' and the Worker claims it on the Team board with team_task_update {action:"claim"}; that claim is what creates the execution.',
  ].join(' ');
}

/**
 * The model-readable refusal of a Team-board claim that has no matching
 * dispatch (design v8 §6.1 ⑥). Identity comes from the roster, so a
 * model-supplied owner field cannot widen this.
 */
export function teamClaimDenialReason({ taskId, sessionId, detail }) {
  return [
    `team_task_update claim for ${taskId === undefined ? 'this task' : `team task ${taskId}`} is refused for session ${sessionId}: ${detail}.`,
    'Only a Worker the Lead dispatched may claim: the Lead first writes the routing record with'
    + ' task_tree_write {"op":"dispatch","id":"<tree-task>","member":"<worker-name>","teamTaskId":"<task-N>"},'
    + ' and the named Worker then claims the board task; its roster-resolved identity is what the Host binds.',
  ].join(' ');
}

/** The Lead never holds an execution in team mode (design v8 I4). */
export function leadClaimDenialReason({ sessionId }) {
  return `team_task_update claim is refused for session ${sessionId}: the Team Lead coordinates and never claims a task.`
    + ' Dispatch the board task to a teammate and let that Worker claim it; only the Worker\'s own claim creates an execution.';
}

/**
 * Pre-dispatch checks for a Team-board claim: the task must not be stopped by
 * an unresolved conflict, the caller's roster identity must match the tree
 * dispatch for that board task, and neither the task nor the Worker may already
 * hold an execution. All of it reads Host facts (roster + synced tree
 * snapshot), never the tool arguments' identity fields.
 */
function teamClaimReason({ membership, store, exec }) {
  const taskId = exec?.arguments?.task_id;
  const caller = membership.sessionId;
  if (membership.role !== 'teammate') return leadClaimDenialReason({ sessionId: caller });
  if (typeof taskId !== 'string' || taskId === '') {
    return teamClaimDenialReason({ sessionId: caller, detail: 'the claim names no board task' });
  }
  const rootId = membership.root !== null && typeof membership.root === 'object' && typeof membership.root.id === 'string'
    ? membership.root.id
    : undefined;
  if (rootId === undefined) {
    return teamClaimDenialReason({ taskId, sessionId: caller, detail: 'the roster exposes no Lead workline' });
  }
  let tree;
  try {
    tree = store.snapshot(rootId);
  } catch {
    tree = { present: true, tasks: [] };
  }
  if (tree.present !== true) {
    return teamClaimDenialReason({ taskId, sessionId: caller, detail: 'the workline has no task tree, so no dispatch can exist' });
  }
  const task = (Array.isArray(tree.tasks) ? tree.tasks : []).find((candidate) => candidate !== null
    && typeof candidate === 'object'
    && candidate.teamTaskId === taskId
    && candidate.archived !== true);
  if (task === undefined) {
    return teamClaimDenialReason({ taskId, sessionId: caller, detail: 'no tree task is dispatched for that board task' });
  }
  // A conflict is a workline-level record (design I12): when the Host cannot
  // prove who holds this task, it stops the task instead of guessing. This runs
  // before the dispatch check so every claimant is told the same reason.
  const stopped = (Array.isArray(tree.conflicts) ? tree.conflicts : []).find((candidate) => candidate !== null
    && typeof candidate === 'object'
    && candidate.resolvedAt === null
    && (candidate.taskId === task.id || candidate.scope === 'workline'));
  if (stopped !== undefined) {
    return teamClaimDenialReason({
      taskId,
      sessionId: caller,
      detail: `tree task ${task.id} is stopped by conflict ${stopped.id} (${stopped.kind}); its evidence is contradictory, so no claim may start on it until a human resolves the conflict`,
    });
  }
  const dispatchedTo = task.dispatch !== null && typeof task.dispatch === 'object' && typeof task.dispatch.member === 'string'
    ? task.dispatch.member
    : undefined;
  if (dispatchedTo === undefined) {
    return teamClaimDenialReason({ taskId, sessionId: caller, detail: `tree task ${task.id} carries no dispatch` });
  }
  if (dispatchedTo !== membership.name) {
    return teamClaimDenialReason({ taskId, sessionId: caller, detail: `tree task ${task.id} is dispatched to ${dispatchedTo}, not ${membership.name}` });
  }
  if (task.deferred === true || task.status === 'done') {
    return teamClaimDenialReason({ taskId, sessionId: caller, detail: `tree task ${task.id} is not open for work` });
  }
  if (task.owner !== null && task.owner !== undefined) {
    return teamClaimDenialReason({ taskId, sessionId: caller, detail: `tree task ${task.id} already holds an execution` });
  }
  const holder = (Array.isArray(tree.tasks) ? tree.tasks : []).find((candidate) => candidate !== null
    && typeof candidate === 'object'
    && candidate.archived !== true
    && candidate.owner !== null
    && typeof candidate.owner === 'object'
    && candidate.owner.sessionId === caller);
  if (holder !== undefined) {
    return teamClaimDenialReason({ taskId, sessionId: caller, detail: `this Worker already holds an execution on task ${holder.id}` });
  }
  // I2b: this Worker instance holds ONE task for life. A lifetime record that
  // has ended survives every release, so the same instance can never claim a
  // second task; the retry must go to a NEW Worker instance. The lifetime map
  // is keyed by the roster-resolved session id, never by a mutable task field.
  const lifetime = workerLifetimeOf(tree, caller);
  if (lifetime !== undefined && lifetime.state !== 'created') {
    return teamClaimDenialReason({
      taskId,
      sessionId: caller,
      detail: workerLifetimeDenial({ sessionId: caller, worker: lifetime }),
    });
  }
  return undefined;
}

/** The model-readable denial. It names the missing execution and the way out. */
export function denialReason({ tool, sessionId, worklineId }) {
  return [
    `${tool} is a class A tool (workspace modification or code execution), and session ${sessionId}`
    + ` holds no active execution for workline ${worklineId}.`,
    'Claim a task first: task_tree_write {"op":"claim","id":"<task>"}.',
    'Task-management tools (claim, release, task_tree_*) are class B and need no execution, which is why claim can never depend on itself.',
  ].join(' ');
}

/**
 * Build the synchronous guard function.
 * @param options - `{ ctx, store, seats }`; `store.snapshot(worklineId)` is sync
 *   and `seats` (optional) is the concurrency seat table from
 *   `host/reservation.js`.
 * @returns `(exec) => reason | undefined`; a returned string denies the call.
 */
export function createExecutionGuard({ ctx, store, seats }) {
  return function executionGuard(exec) {
    const name = exec !== null && typeof exec === 'object' ? exec.name : undefined;
    const label = typeof name === 'string' && name !== '' ? name : '(unnamed tool)';
    const caller = callerOf(exec);
    let agentTeams;
    let membership;
    try {
      agentTeams = teamServiceOf(ctx);
      if (agentTeams !== undefined) membership = teamMembershipOf(agentTeams, exec?.agent);
    } catch {
      agentTeams = undefined;
      membership = undefined;
    }

    // Team-only refusal and pre-dispatch checks. They run for class B too,
    // because reassign and claim are exactly the operations that must never
    // reach the Team board without a Host decision (design v8 I18, §6).
    if (agentTeams !== undefined && label === 'team_task_update') {
      const action = exec?.arguments?.action;
      const sessionId = caller.sessionId ?? membership?.sessionId ?? '(unknown)';
      if (action === 'reassign') return reassignDenialReason({ sessionId });
      if (action === 'claim') {
        if (membership === undefined) {
          return teamClaimDenialReason({ sessionId, detail: 'the host cannot resolve the caller as a Team member' });
        }
        let denial;
        try {
          denial = teamClaimReason({ membership, store, exec });
        } catch {
          denial = teamClaimDenialReason({ sessionId, detail: 'the Host could not verify the dispatch for this claim' });
        }
        if (denial !== undefined) return denial;
        // Allowed so far: the seat below still has to hand it to this call
        // before the board may commit, so two in-flight claims cannot both win.
      }
    }

    // A claim is not atomic with the tree write, so the seat is taken
    // synchronously here, before dispatch: a second in-flight claim sees this
    // one and is refused (design v8 §9, I14). Only real end-of-call evidence
    // releases it — never a timer.
    if (seats !== undefined) {
      let worklineId;
      try {
        worklineId = membership?.role === 'teammate'
          && membership.root !== null && typeof membership.root === 'object'
          && typeof membership.root.id === 'string'
          ? membership.root.id
          : (caller.sessionId === undefined ? undefined : worklineOf(ctx, caller.sessionId, caller.header));
      } catch {
        worklineId = undefined;
      }
      const request = seatRequestFor({
        tool: label,
        args: exec?.arguments,
        mode: agentTeams === undefined ? 'standard' : 'team',
        worklineId,
        sessionId: caller.sessionId,
      });
      if (request !== undefined) {
        const taken = seats.reserve({ requestId: exec?.callId, tool: label, ...request });
        if (taken.ok !== true) {
          return seatDenialReason({ tool: label, sessionId: caller.sessionId ?? '(unknown)', holder: taken.holder });
        }
      }
    }

    if (classifyTool(name) !== 'A') return undefined;
    if (caller.sessionId === undefined) {
      return `${label} is a class A tool, and the host cannot resolve the calling session;`
        + ' class A tools require a session holding an active execution for its workline.';
    }
    try {
      // Team mode first: a Lead is refused before the workline is consulted, so
      // no claim and no tree can ever widen its permission.
      if (agentTeams !== undefined && membership?.role === 'lead') {
        return leadDenialReason({ tool: label, sessionId: caller.sessionId });
      }
      // A teammate's workline is the roster's Lead, so identity-scoped facts do
      // not depend on walking a header a model could influence.
      const worklineId = membership?.role === 'teammate'
        && membership.root !== null && typeof membership.root === 'object'
        && typeof membership.root.id === 'string'
        ? membership.root.id
        : worklineOf(ctx, caller.sessionId, caller.header);
      const tree = store.snapshot(worklineId);
      if (tree.present !== true) return undefined;
      if (holdsExecution(tree.tasks, caller.sessionId)) return undefined;
      return denialReason({ tool: label, sessionId: caller.sessionId, worklineId });
    } catch (error) {
      // Fail closed: an unreadable gate never widens permission.
      return `${label} was denied because the execution gate could not resolve this workline's task tree`;
    }
  };
}

/**
 * Register the execution gate on the plugin context.
 * @param ctx - the plugin context.
 * @param deps - `{ store, seats }`; `seats` is optional so a host without the
 *   released-evidence observers keeps the gate's committed-state behaviour.
 * @returns whether the guard was registered (false when the registry is absent).
 */
export function registerExecutionGuard(ctx, { store, seats }) {
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.guard !== 'function') return false;
  ctx.effect(() => tools.guard(createExecutionGuard({ ctx, store, seats })), 'summary-panel: execution gate');
  return true;
}
