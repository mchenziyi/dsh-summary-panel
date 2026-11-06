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
 *   Teammates keep the standard execution rule; dispatch and claim-first
 *   binding are a later slice, and this gate must never grant them early.
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
 * A workline with no persisted tree is unmanaged: nothing is restricted, so
 * ordinary sessions are never affected (design §14.4).
 */

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
 * Team mode is decided by composition: the Agent Team service exists in this
 * plugin context. Nothing the model says can turn it off, and a profile without
 * the service keeps exactly its standard-mode behaviour.
 */
function teamServiceOf(ctx) {
  try {
    const agentTeams = ctx.get('agentTeams');
    return agentTeams !== null && typeof agentTeams === 'object' ? agentTeams : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The caller's Team role, resolved from the live Agent by the Team roster
 * itself — never from model input. `tryMembership` is the non-throwing probe;
 * `membership` is the fallback for a service that only exposes the strict one.
 * @returns `'lead'`, `'teammate'`, or `undefined` when the caller is not a Team
 *   member (for example a provider-owned subagent inside a team profile).
 */
function teamRoleOf(agentTeams, agent) {
  if (agent === null || typeof agent !== 'object') return undefined;
  let membership;
  let resolved = false;
  if (typeof agentTeams.tryMembership === 'function') {
    try {
      membership = agentTeams.tryMembership(agent);
      resolved = true;
    } catch {
      /* fall through to the strict resolver */
    }
  }
  if (!resolved && typeof agentTeams.membership === 'function') {
    try {
      membership = agentTeams.membership(agent);
    } catch {
      /* an unresolved identity is not a proven Lead */
    }
  }
  if (membership !== null && typeof membership === 'object' && typeof membership.role === 'string') {
    return membership.role;
  }
  return undefined;
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
 * @param options - `{ ctx, store }`; `store.snapshot(worklineId)` is sync.
 * @returns `(exec) => reason | undefined`; a returned string denies the call.
 */
export function createExecutionGuard({ ctx, store }) {
  return function executionGuard(exec) {
    const name = exec !== null && typeof exec === 'object' ? exec.name : undefined;
    if (classifyTool(name) !== 'A') return undefined;
    const label = typeof name === 'string' && name !== '' ? name : '(unnamed tool)';
    const caller = callerOf(exec);
    if (caller.sessionId === undefined) {
      return `${label} is a class A tool, and the host cannot resolve the calling session;`
        + ' class A tools require a session holding an active execution for its workline.';
    }
    try {
      // Team mode first: a Lead is refused before the workline is consulted, so
      // no claim and no tree can ever widen its permission.
      const agentTeams = teamServiceOf(ctx);
      if (agentTeams !== undefined && teamRoleOf(agentTeams, exec?.agent) === 'lead') {
        return leadDenialReason({ tool: label, sessionId: caller.sessionId });
      }
      const worklineId = worklineOf(ctx, caller.sessionId, caller.header);
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
 * @param deps - `{ store }` from `host/store.js`.
 * @returns whether the guard was registered (false when the registry is absent).
 */
export function registerExecutionGuard(ctx, { store }) {
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.guard !== 'function') return false;
  ctx.effect(() => tools.guard(createExecutionGuard({ ctx, store })), 'summary-panel: execution gate');
  return true;
}
