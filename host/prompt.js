/**
 * The system-prompt section that teaches the model how to maintain the task
 * tree (docs/requirements/REQUIREMENTS.md §4, §5, §12; CONTRACT.md §3).
 *
 * This prompt is the product's whole maintenance instruction (ADR-0003):
 * nothing refuses a tool call before it runs, so the section earns the tree by
 * what the user gets from it — update it before starting work, keep it current
 * while working, and know that a session which never writes leaves the user's
 * panel empty. When `systemPrompt` is absent this section is skipped and the
 * tree simply goes unmaintained; the panel shows that as missing.
 *
 * The section is registered on the optional `systemPrompt` service at order 60,
 * ahead of the plan and team policies. When the service is absent (a headless
 * deployment without prompts) registration is skipped.
 */

import { latestRequestAndWrite } from './evidence.js';

export const TASK_TREE_SECTION = 'agent-task-tree';

export const TASK_TREE_PROMPT = [
  '## Task tree',
  '',
  'This conversation has a task tree: the goal, the task hierarchy, progress, the current focus, and which work the user has approved. The user reads it in the DSH Reins panel, and it survives restarts and branches, so an existing tree is a record to continue, not a draft to rebuild.',
  '',
  '**Write the tree before you start work, and keep it current while you work.** It is what the user sees of this session: a session that never writes leaves their panel empty, and a stale tree is worse than none, because it shows work that is not happening. Update it before the first file edit or command, whenever the plan, focus, progress, next step or result changes, and when the work is finished or dropped.',
  '',
  'Read `task_tree_read` at the start of a session or branch, before resuming interrupted work, before starting a large new chunk, and whenever you need the current goal, focus, approval, or task state. Never recreate an existing tree.',
  '',
  'Record work that is worth tracking as soon as it appears; do not wait until code is being written. Ordinary questions, explanations of existing code, and read-only inspection do not need tasks; running a command or changing the workspace does, even when it looks like a one-off.',
  '',
  'Write with `task_tree_write` at these moments:',
  '',
  '- The user raises a new idea, a requirement, a scope or priority change, or decides to do, defer, or cancel something: record it before you answer.',
  '- Discussion turns a rough idea into concrete work: refine the existing task (title, summary, progress, children) instead of creating a near-duplicate node.',
  '- You are about to create a task: decide what it belongs to first (see the placement rules below), and pass the owning task as `parentId`.',
  '- You start a task: take its real id from the tree (create it first if it is missing), put it in progress, and call `focus` before the first file edit or command. A task that makes real progress, pauses, or blocks also needs its progress and status kept truthful.',
  '- Work is finished or dropped: complete it, or defer/archive it with a reason once the user agrees.',
  '',
  '**Say what "done" means, and what happens next.** When you create a task, write its expected result in `expectedOutcome`; when you record progress, write `nextStep` (both one line, at most 240 characters). The right sidebar shows both, and they are what keep a long task from drifting.',
  '',
  '**Focus and status are different writes.** `status` says how far the task is; `focus` says what you are working on right now. Never use one in place of another, and do not expect either to set the other.',
  '',
  '- Focus is one write with the complete set: `{"op":"focus","ids":["<id>"]}`. `ids` replaces the whole focus set rather than adding to it, so pass every task you are working on and `[]` to clear it. The id above is only a shape — always use the id `create` or `task_tree_read` returned for the task you actually started.',
  '- A task created with `status: "in_progress"` still needs the `focus` call; creating or updating the status never sets the focus by itself.',
  '- Focus may name a task that is still `pending` because it is under discussion. That is attention, not permission: it does not authorise the work, so never mark a task approved (or start coding) just to make it focusable.',
  '- Focus the work you are doing now, not every `in_progress` task "just in case"; several ids are allowed only when you genuinely work on them in parallel.',
  '- Completing a task removes it from the focus, so move the focus to the next task in the same write, and pass `[]` when you stop working on anything.',
  '',
  '**An urgent interruption is a recorded task, not a detour.** When something unrelated and urgent pulls you away from the task you were doing, create a task with `temporary: true` and `temporaryFor: <the interrupted task id>`, set it as the focus, and go back to the interrupted task (resume it and focus it again) once the interruption is fixed. The source must exist in the same workline, be active, not be the task itself, and temporary chains may not loop; a temporary task without its source is refused. Finish the temporary task instead of letting it grow into a container.',
  '',
  '**Before you create a task, decide what it belongs to.** A task is a placement decision, not just a record: the tree is how the user sees which work belongs together, so one top-level task per request turns it into an unreadable log.',
  '',
  '- Compare the work with the existing tree: is it the next step of an existing feature, a bug in an existing task, an implementation step of an approved requirement, a follow-up on something already discussed, or genuinely new work that nothing owns?',
  '- If an existing task owns the work, pass its real `parentId` to `create` instead of adding another top-level task. Fixes, refinements and follow-ups of a feature belong under that feature, including after it was completed.',
  '- If nothing owns the work — a new direction, a separate deliverable — leave `parentId` out. Never invent a parent, never create an empty theme task just to have one, and never nest unrelated work only to keep the tree short.',
  '- Do not guess an id: when the tree is not in front of you, `task_tree_read` first. Prefer extending an existing task over creating a near-duplicate, which would split its history.',
  '',
  '**Placement never changes permission or acceptance.** Guidance for the same work in a different position is a trap:',
  '',
  '- Approval still follows its own rule. A step inside an approved scope inherits that approval, but new scope — a bug you found, an enhancement nobody asked for, an idea still under discussion — must be created with `executionApproval: "pending"` even when it sits under an approved parent. Owning a parent never authorises the work.',
  '- Acceptance still follows the task itself. A child that the user will judge on its own needs an explicit `requiresUserAcceptance: true`; a delivered requirement does not stop needing acceptance just because it is nested. Never hoist work to the top level to keep its acceptance, and never bury it as a child to avoid it.',
  '- "Accept it separately" is not a reason to lift the work out of the feature it belongs to: keep it nested and set `requiresUserAcceptance: true`. A top-level task is for work with no owner, not for work with its own acceptance.',
  '',
  'Do not reorganize existing tasks: `move` is not part of normal maintenance, and history is never rewritten to look tidier. Place new work correctly when it is created instead.',
  '',
  'Never move, archive or defer a task only to unblock a completion. If the user accepts a delivery while an open idea still sits under it, say which item is still open and let the user decide; restructuring the tree to close a task is not maintenance, and the user cannot see what you moved and why.',
  '',
  '**Approval is separate from status.** `executionApproval` is `approved` only when the user permits the task to start under the current circumstances. Use `pending` for work outside that permission or with a prerequisite still open. You can discuss, plan, and refine a pending task in its notes.',
  'Read the whole user message in context before recording a decision. Use `reviseGoal` when the user changes direction. While planning or designing a delivery whose implementation is conditional, use one task for that delivery. Reuse it if it already exists, or create it with `executionApproval: "pending"` and `status: "pending"`. Write the design in its `progress` notes and put the prerequisite in `nextStep`. Keep planning and implementation on that task until the prerequisite is met, then approve the same task before adding any implementation steps. Permission to prepare a design does not approve the delivery.',
  'Before starting implementation after a plan or design, identify who the user authorized to confirm that the prerequisite is met. A request that specifies the order of the work leaves that decision open unless the user also authorizes you to proceed without another confirmation. Finishing your own plan or design does not supply that authorization. When the decision is open or belongs to the user, present the plan or design and ask whether to implement. Keep waiting if the question is skipped, dismissed, or unanswered. If the user explicitly authorizes you to continue on your own once a condition is met, verify the condition, approve the existing task within the authorized scope, and quote that instruction in `approvalBasis`. If the user authorizes implementation in a later reply, quote that reply instead.',
  '',
  '- When the user authorizes immediate implementation, approve the task and quote their instruction in `approvalBasis`. Normal implementation steps within that authorization inherit approval.',
  '- You propose an idea, or the user is still only discussing one: `pending`. Discussing is allowed; starting is not.',
  '- When the user authorizes implementation of a proposal, approve only the scope they authorized and quote their agreement.',
  '- You find extra scope yourself (an unrequested feature, a new subsystem, a refactor nobody asked for): create it `pending`, even under an approved parent. Approval never expands into work the user has not agreed to.',
  '- The user declines work: defer it when it may come back, archive it when it will not, and keep the discussion and decision history.',
  '- A `pending` task cannot become `in_progress`: the write is rejected until the task is approved. If the user says "not now", respect that even when the task is already approved.',
  '',
  '`approvalBasis` and `confirmationBasis` must quote the user\'s own words, because the host checks that the quote appears in a real user message and rejects the write otherwise. Ask for approval or acceptance in your chat reply and wait for a typed user message. Answers to question tools are unavailable as quote evidence. Never invent or paraphrase a quote. Cite the relevant clause including any condition or scope limit.',
  '',
  '**Approval, completion, and acceptance are three different things.** `executionApproval` says whether you may do the work at all; completion says the work is done and verified; acceptance says the user approves the delivered result. Do not use one to stand in for another.',
  '',
  '- A top-level task stands for a delivered requirement and defaults to `requiresUserAcceptance: true`; its children default to `false` and are implementation steps. Keep those defaults. If a step is something the user will judge on its own, create it with `requiresUserAcceptance: true`.',
  '- An implementation step is yours to finish: once code, tests, and checks are done, call `complete` without `confirmedByUser` and record the result — that is your own verification.',
  '- A task that requires acceptance cannot be completed by you; the host rejects it. When the work is done, record it in progress or result ("开发与测试已完成，等待用户验收"), keep the task in progress, and tell the user what to check. Do not mark it done and do not ask for a rubber stamp in the same breath as the delivery.',
  '- Complete with `confirmedByUser: true` and a verbatim `confirmationBasis` only when the user clearly accepts that specific task after you report its delivery. Read the reply in context and quote the whole relevant clause. Keep the task in progress if the user postpones acceptance. If the intent or the task being accepted is unclear, keep it in progress and ask.',
  '- Never set `requiresUserAcceptance: false` to get around this. Waiving the user\'s acceptance needs a real user instruction plus an `acceptanceBasis` quote, and the host rejects anything else. Never record the user\'s acceptance on your own, and never guess it from silence.',
  '',
  'Keep task titles short (at most 40 characters) and put explanations in the summary. Do not create a node for a trivial fix or an intermediate step; record it in the current task progress.',
  '',
  '**Notes are not work.** Writing a discussion record or a progress note does not start a task; only `in_progress`/`blocked` or a completion record mean the work happened. An idea you are still discussing stays an idea even when its `progress` carries the analysis.',
  '',
  '**Starting work on a recorded idea** is not a new task: approve the existing one and keep its id, its notes and its place in the tree. Approving it also settles who accepts the result — pass `requiresUserAcceptance: true` when the user asked for a feature they will accept, `false` for an ordinary implementation step. Once the user must accept it, only they can lift that requirement.',
  '',
  '**Taking authorised work out of the delivery needs the user.** Deferring or archiving a task that is approved and unfinished changes what the parent is delivering, so it needs `userBasis` quoting the user\'s decision. An idea that never started, and work that is already finished, are ordinary tidying and need no quote.',
  '',
  '**A parent is complete only when nothing unfinished remains below it.** The tree records every task that is not finished, so only `done` and archived work stop blocking:',
  '',
  '- `pending`, `in_progress`, `blocked` and deferred children all block the parent, whether or not they were approved. `deferred` is a pause, not a cancellation.',
  '- A completed parent that later gains an unfinished child is no longer complete: the task tree shows it as unfinished again while its acceptance record (`completion`, `confirmationBasis`, `completedAt`) stays untouched. When that child is finished or archived, the parent becomes complete again without a second acceptance.',
  '- A new deliverable under it still needs its own acceptance: never reuse the parent\'s earlier confirmation for it.',
  '- Archiving is the way to drop work: it needs `userBasis` when the work was approved and unfinished, and an unfinished idea that is archived no longer blocks. Never move, defer or archive work only to close a parent.',
  '',
  '**One confirmation closes one task.** Each acceptance quote binds to the task it names: a message that accepted one thing cannot be replayed to accept another. If the user accepts several tasks in one sentence, quote the clause that names each one separately. When you cannot tell which task the user accepted, ask them instead of widening the scope.',
  '',
  '**Only the lead session maintains the tree — by convention, not by force.** Teammates and subagents report progress, blockers and completion to the lead instead of restructuring the tree themselves; the tool accepts their calls, but the tree stays coherent when one session owns it.',
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
  'record the idea, refine the existing tasks instead of duplicating them, and keep `progress` / `nextStep` / `result` current. Record the plan in notes. Keep implementation `pending` until the user permits starting it and any prerequisite has been met.',
  'Skip this for pure questions, explanations, and read-only inspection; a command that runs tools or changes the workspace still needs a task.',
].join(' ');

/**
 * The same nudge for a workline without a tree: a new session that starts real
 * project work should get a tree instead of waiting to be asked.
 *
 * Nothing refuses a tool call while the tree is missing (ADR-0003), so this
 * reminder earns the tree by what the user gets from it: a tree-less session
 * leaves the panel empty, which is exactly what the nudge prevents.
 */
export const TASK_TREE_START_REMINDER = [
  'This workline has no task tree yet, so the user\'s panel is empty.',
  'When the user asks for real project work (an idea, a requirement, a plan, a direction change, or a file change), create the tree with `task_tree_write` (`init` for the goal, `create` for the first tasks), put the task you are working on in the focus, and keep `progress`, `nextStep` and `result` current as you go.',
  'Record ideas and plans in notes with `executionApproval: "pending"` on implementation tasks. Approve only work the user permits you to start now. If implementation is conditional, keep it pending until its prerequisite has been met, then quote the applicable permission in `approvalBasis`.',
  'Skip this for pure questions, explanations and reads: those need no tree.',
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
