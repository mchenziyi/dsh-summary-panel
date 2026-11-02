/**
 * The system-prompt section that teaches the model how to maintain the task
 * tree (REQUIREMENTS.md §4, §5, §12; CONTRACT.md §3).
 *
 * The section is registered on the optional `systemPrompt` service at order 60,
 * ahead of the plan and team policies. When the service is absent (a headless
 * deployment without prompts) registration is skipped.
 */

export const TASK_TREE_SECTION = 'agent-task-tree';

export const TASK_TREE_PROMPT = [
  '## Task tree',
  '',
  'This conversation has a task tree: the workline goal, the task hierarchy, progress, and the current focus. The user reads it in the summary panel, and it survives restarts and branches, so an existing tree is a record to continue, not a draft to rebuild.',
  '',
  'Read `task_tree_read` at the start of a session or branch, before resuming interrupted work, before starting a large new chunk, and whenever you need the current goal, focus, or task state. Never recreate an existing tree.',
  '',
  'Write with `task_tree_write` at these moments:',
  '',
  '- The user gives an explicit instruction: update the tree before acting on it.',
  '- You start executing a task: put it in the focus, mark it in progress, and claim it.',
  '- A task makes real progress, or you pause it: record meaningful progress, not every tool call.',
  '- You hit a blocker: set status blocked with the blocker reason and the unblock condition.',
  '- Work is deferred or archived after agreeing with the user: defer keeps the status and progress for later; archive removes the task and its subtree from the active tree with a reason.',
  '- You finish a task: ask the user first, then complete it with confirmedByUser: true and record the result.',
  '',
  'Keep task titles short (at most 40 characters) and put explanations in the summary. Do not create a node for a trivial fix or an intermediate step; record it in the current task progress. Do not mark a parent done while its children are unfinished.',
  '',
  'Only the lead session maintains the tree. In an Agent Team, teammates report progress, blockers, and completion to the lead and never write the tree themselves.',
  '',
  'A goal revision changes the current goal and must carry a reason; the original goal is immutable. Explain the original goal, the proposed goal, and the impact and get the user\'s explicit confirmation before calling `reviseGoal`.',
  '',
  'When planning, `task_tree_read` with includeArchived: true shows what was cancelled earlier and why. Use it before proposing a direction the user may already have rejected; archived history is context, not a veto — the user may still decide to do it.',
  '',
  'A completed task may receive new unfinished children later, for example a bug found after the feature shipped. Add the child under the completed task, leave the parent\'s completion time and record untouched, and let the child carry its own status and progress.',
  '',
  'Use `restore` only when the user explicitly decides to resume a cancelled task. Restore keeps the original id, progress, and archive history; do not restore a task the user has not asked for.',
].join('\n');

/** Reminder shown until the current user request has a tree write of its own. */
export const TASK_TREE_REMINDER = [
  'The user just sent a new message. If it asks for development work (code changes or a multi-step task), call `task_tree_write` before you start, not after:',
  'focus the task you are working on, mark it in progress, and create the tasks the new request needs.',
  'Skip this only for pure questions or a trivial single-step fix.',
].join(' ');

/** Concatenated text of one event's content blocks. */
function eventText(event) {
  const content = event?.data?.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

/** The newest real user message and the newest tree write in the session tail. */
function latestUserAndWrite(session) {
  const end = Number(session?.seq) || 0;
  const events = session.snapshotEvents(Math.max(0, end - 80));
  let lastUser = -1;
  let lastWrite = -1;
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = eventText(event);
      // Runtime-context refreshes and skill reminders are injected by the host,
      // not typed by the user; only a real request should trigger the reminder.
      if (text.startsWith('Current runtime context') || text.startsWith('<system-reminder>')) continue;
      lastUser = Math.max(lastUser, Number(event.seq));
    } else if (event.type === 'tool/call' && event.data?.name === 'task_tree_write') {
      lastWrite = Math.max(lastWrite, Number(event.seq));
    }
  }
  return { lastUser, lastWrite };
}

/** Resolve the root session id synchronously, preferring live parents. */
function rootSessionIdSync(ctx, session) {
  let current = session;
  let root = session.id;
  for (let depth = 0; depth < 20; depth += 1) {
    const parentId = current?.header?.parentSession;
    if (typeof parentId !== 'string' || parentId === '') return root;
    let live;
    try {
      const sessions = ctx.get('sessions');
      live = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(parentId) : undefined;
    } catch {
      live = undefined;
    }
    if (live === undefined) return parentId;
    current = live;
    root = live.id;
  }
  return root;
}

/**
 * The per-turn nudge: non-empty while the latest user request has no
 * `task_tree_write` after it. It disappears as soon as the agent writes.
 * @param ctx - plugin context (for `sessions`).
 * @param store - task store (sync `has`).
 * @param session - the assembling agent's session.
 */
export function taskTreeReminderFor(ctx, store, session) {
  try {
    if (session === undefined || session === null || typeof session !== 'object') return '';
    if (session.header !== undefined && session.header.origin === 'subagent') return '';
    if (store === undefined || typeof store.has !== 'function') return '';
    const root = rootSessionIdSync(ctx, session);
    if (root === '' || store.has(root) !== true) return '';
    const { lastUser, lastWrite } = latestUserAndWrite(session);
    if (lastUser < 0 || lastUser <= lastWrite) return '';
    return TASK_TREE_REMINDER;
  } catch {
    return '';
  }
}

/**
 * Register the maintenance prompt and the per-turn reminder when the
 * `systemPrompt` service exists.
 * @param ctx - the plugin context.
 * @param options - `{ store }` for the "has a tree" gate.
 * @returns whether a section was registered.
 */
export function registerTaskTreePrompt(ctx, options = {}) {
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return false;
  const store = options.store;
  ctx.effect(
    () => systemPrompt.section({ name: TASK_TREE_SECTION, order: 60, text: TASK_TREE_PROMPT }),
    'summary-panel: task tree prompt',
  );
  if (typeof systemPrompt.context === 'function') {
    ctx.effect(
      () => systemPrompt.context({
        name: 'agent-task-tree:reminder',
        order: 61,
        text: (context) => {
          const session = context !== null && typeof context === 'object' && context.agent !== undefined
            ? context.agent.session
            : undefined;
          return taskTreeReminderFor(ctx, store, session);
        },
      }),
      'summary-panel: task tree reminder',
    );
  }
  return true;
}
