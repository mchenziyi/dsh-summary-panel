/**
 * The execution gate (design v8 §3, §10): class A tools need an active
 * execution for the caller's workline.
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
