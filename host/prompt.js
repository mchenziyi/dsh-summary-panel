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
].join('\n');

/**
 * Register the maintenance prompt when the `systemPrompt` service exists.
 * @param ctx - the plugin context.
 * @returns whether a section was registered.
 */
export function registerTaskTreePrompt(ctx) {
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return false;
  ctx.effect(
    () => systemPrompt.section({ name: TASK_TREE_SECTION, order: 60, text: TASK_TREE_PROMPT }),
    'summary-panel: task tree prompt',
  );
  return true;
}
