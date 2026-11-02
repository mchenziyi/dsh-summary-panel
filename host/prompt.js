/**
 * The system-prompt section that teaches the model how to maintain the task
 * tree (REQUIREMENTS.md §4, §5, §12; CONTRACT.md §3).
 *
 * The section is registered on the optional `systemPrompt` service at order 60,
 * ahead of the plan and team policies. When the service is absent (a headless
 * deployment without prompts) registration is skipped.
 *
 * The tree covers the whole life of the work — idea, discussion, approval,
 * execution, acceptance, cancellation — so maintenance is triggered by the
 * conversation, not by the moment the agent starts writing code.
 */

import { latestRequestAndWrite } from './evidence.js';

export const TASK_TREE_SECTION = 'agent-task-tree';

export const TASK_TREE_PROMPT = [
  '## Task tree',
  '',
  'This conversation has a task tree: the workline goal, the task hierarchy, progress, the current focus, and whether each task is approved to execute. The user reads it in the DSH Reins panel, and it survives restarts and branches, so an existing tree is a record to continue, not a draft to rebuild.',
  '',
  'Read `task_tree_read` at the start of a session or branch, before resuming interrupted work, before starting a large new chunk, and whenever you need the current goal, focus, approval, or task state. Never recreate an existing tree.',
  '',
  'The tree follows the whole life of the work: idea -> discussion -> approved or deferred -> execution -> user acceptance, or archive. Record work that is worth tracking as soon as it appears; do not wait until code is being written. Ordinary questions, explanations of existing code, and one-off commands do not need tasks.',
  '',
  'Write with `task_tree_write` at these moments:',
  '',
  '- The user raises a new idea, a requirement, a scope or priority change, or decides to execute, defer, or cancel something: record it before you answer.',
  '- Discussion turns a rough idea into concrete work: refine the existing task (title, summary, progress, children) instead of creating a near-duplicate node.',
  '- You start executing a task: take its real id from the tree (create it first if it is missing), put it in progress, and call `focus` before the first file edit or command. A task that makes real progress, pauses, or blocks also needs its progress and status kept truthful.',
  '- Work is finished or dropped: complete it, or defer/archive it with a reason once the user agrees.',
  '',
  '**Focus, status, and claim are three different writes.** `status` says how far the task is, `focus` says what you are working on right now, and `claim` says which session owns it. Never use one in place of another, and do not expect any of them to set the others.',
  '',
  '- Focus is one write with the complete set: `{"op":"focus","ids":["<id>"]}`. `ids` replaces the whole focus set rather than adding to it, so pass every task you are working on and `[]` to clear it. The id above is only a shape — always use the id `create` or `task_tree_read` returned for the task you actually started.',
  '- A task created with `status: "in_progress"` still needs the `focus` call; creating or updating the status never sets the focus by itself.',
  '- Focus may name a task that is still `pending` because it is under discussion. That is attention, not permission: it does not authorise execution, so never mark a task approved (or start coding) just to make it focusable.',
  '- Focus the work you are doing now, not every `in_progress` task "just in case"; several ids are allowed only when you genuinely work on them in parallel.',
  '- Completing a task removes it from the focus, so move the focus to the next task in the same write, and pass `[]` when you stop working on anything.',
  '',
  '**Execution approval is separate from status.** `executionApproval` is `approved` (the user asked for this work, or agreed to it) or `pending` (an idea, a proposal, or scope you thought of yourself). `pending` means discuss, analyse, plan, and refine freely, but ask the user before executing. `approved` means you may start when the task comes up without asking again.',
  '',
  '- The user explicitly asks for a feature: create it `approved` and quote their instruction in `approvalBasis`; its normal implementation steps inherit that approval.',
  '- You propose an idea, or the user is still only discussing one: `pending`. Discussing is allowed; starting is not.',
  '- The user agrees to something you proposed: set it to `approved` and quote their agreement.',
  '- You find extra scope yourself (an unrequested feature, a new subsystem, a refactor nobody asked for): create it `pending`, even under an approved parent. Approval never expands into work the user has not agreed to.',
  '- The user declines work: defer it when it may come back, archive it when it will not, and keep the discussion and decision history.',
  '- A `pending` task cannot become `in_progress` and cannot be claimed: the write is rejected until it is approved. If the user says "not now", respect that even when the task is already approved.',
  '',
  '`approvalBasis` and `confirmationBasis` must quote the user\'s own words, because the host checks that the quote appears in a real user message and rejects the write otherwise. Never invent a quote, never paraphrase one into your own words, and never approve something because it feels intended.',
  '',
  '**Approval, completion, and acceptance are three different things.** `executionApproval` says whether you may do the work at all; completion says the work is done and verified; acceptance says the user approves the delivered result. Do not use one to stand in for another.',
  '',
  '- A top-level task stands for a delivered requirement and defaults to `requiresUserAcceptance: true`; its children default to `false` and are implementation steps. Keep those defaults. If a step is something the user will judge on its own, create it with `requiresUserAcceptance: true`.',
  '- An implementation step is yours to finish: once code, tests, and checks are done, call `complete` without `confirmedByUser` and record the result — that is your own verification.',
  '- A task that requires acceptance cannot be completed by you; the host rejects it. When the work is done, record it in progress or result ("开发与测试已完成，等待用户验收"), keep the task in progress, and tell the user what to check. Do not mark it done and do not ask for a rubber stamp in the same breath as the delivery.',
  '- When the user accepts, complete it with `confirmedByUser: true` and `confirmationBasis` quoting what they said. The quote must come after you reported the delivery: the instruction that authorised the work ("开始吧", "继续") is not acceptance, and the host rejects it.',
  '- Never set `requiresUserAcceptance: false` to get around this. Waiving the user\'s acceptance needs a real user instruction plus an `acceptanceBasis` quote, and the host rejects anything else. Never record the user\'s acceptance on your own, and never guess it from silence.',
  '',
  'Keep task titles short (at most 40 characters) and put explanations in the summary. Do not create a node for a trivial fix or an intermediate step; record it in the current task progress. Do not mark a parent done while its children are unfinished.',
  '',
  'Only the lead session maintains the tree. In an Agent Team, teammates report progress, blockers, and completion to the lead and never write the tree themselves.',
  '',
  'Goals: the original goal is immutable. When the user decides to change the direction of the project, record it immediately with `reviseGoal` and a reason that names their decision — a decided direction change is recorded even when implementation is deferred, and it does not need the work to start. When you are only proposing a direction, discuss it first and revise the goal after the user agrees. A new plan under discussion is a task, not a goal change.',
  '',
  'When planning, `task_tree_read` with includeArchived: true shows what was cancelled earlier and why. Use it before proposing a direction the user may already have rejected; archived history is context, not a veto — the user may still decide to do it.',
  '',
  'A completed task may receive new unfinished children later, for example a bug found after the feature shipped. Add the child under the completed task, leave the parent\'s completion time and record untouched, and let the child carry its own status and progress.',
  '',
  'Use `restore` only when the user explicitly decides to resume a cancelled task. Restore keeps the original id, progress, and archive history; do not restore a task the user has not asked for.',
].join('\n');

/**
 * The per-turn nudge for a workline that already has a tree: it stays non-empty
 * until the newest user request has a `task_tree_write` after it.
 */
export const TASK_TREE_REMINDER = [
  'The user\'s latest message has no `task_tree_write` yet.',
  'If it starts, changes, or decides real project work — a new idea, a requirement, a scope or direction change, an approval, a deferral, a delivered result, the user\'s acceptance — write the tree before you go further:',
  'record the idea, refine the existing tasks instead of duplicating them, and set `executionApproval` from what the user actually said (`pending` for ideas you proposed, `approved` with `approvalBasis` only for work they asked for).',
  'Skip this for pure questions, explanations, or trivial single-step work.',
].join(' ');

/**
 * The same nudge for a workline without a tree: a new session that starts real
 * project work should get a tree instead of waiting to be asked.
 */
export const TASK_TREE_START_REMINDER = [
  'This workline has no task tree yet.',
  'If the user is describing project work — an idea, a requirement, a plan, a direction change — create the tree with `task_tree_write` (`init` for the goal, `create` for the first tasks) instead of waiting to be asked.',
  'Record ideas and proposals as `executionApproval: "pending"`; approve only what the user has asked for, quoting their words in `approvalBasis`.',
  'Skip this for pure questions, explanations, or one-off operations.',
].join(' ');

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
 * `task_tree_write` after it. A workline with a tree is nudged to keep it in
 * sync; a workline without one is nudged to create it when real work starts.
 * @param ctx - plugin context (for `sessions`).
 * @param store - task store (sync `has`).
 * @param session - the assembling agent's session.
 */
export function taskTreeReminderFor(ctx, store, session) {
  try {
    if (session === undefined || session === null || typeof session !== 'object') return '';
    if (session.header !== undefined && session.header.origin === 'subagent') return '';
    const root = rootSessionIdSync(ctx, session);
    if (root === '') return '';
    const { lastRequest, lastWrite } = latestRequestAndWrite(session);
    if (lastRequest < 0 || lastRequest <= lastWrite) return '';
    const hasTree = store !== undefined && typeof store.has === 'function' && store.has(root) === true;
    return hasTree ? TASK_TREE_REMINDER : TASK_TREE_START_REMINDER;
  } catch {
    return '';
  }
}

/**
 * Register the maintenance prompt and the per-turn reminder when the
 * `systemPrompt` service exists.
 * @param ctx - the plugin context.
 * @param options - `{ store }` for the "already has a tree" distinction.
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
