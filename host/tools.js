/**
 * Model-facing tools for the task tree (CONTRACT.md §3).
 *
 * Tools are registered as plain `ToolDefinition` objects instead of
 * `defineTool` because importing `@deepseek-ai/*` on this plugin's resolution
 * path is unsafe (the desktop host resolves a different dsh build). Argument
 * validation therefore lives in `host/model.js`, which throws readable errors.
 *
 * Both tools locate the caller's workline automatically: the chain of
 * `SessionHeader.parentSession` up to the root session. `task_tree_read` is
 * unrestricted. `task_tree_write` is maintained by the lead: a standard-mode
 * subagent may claim and release only its own assigned task, and an Agent Team
 * teammate never writes the tree at all (the lead dispatches, the Worker's own
 * board claim binds the execution).
 */

import { callerOf } from './caller.js';
import {
  CONFLICT_KINDS, EXECUTION_APPROVALS, TASK_STATUSES, applyOps, forceReleaseReadiness, readSnapshot,
} from './model.js';
import { MAX_BASIS, MIN_QUOTE, verifyUserQuote } from './evidence.js';

const WRITE_DENIED_SUBAGENT = 'task_tree_write is reserved for the lead session; a subagent (or teammate) must report changes to the lead instead';
const WRITE_DENIED_TEAMMATE = 'task_tree_write is reserved for the lead in an Agent Team; teammates report progress, blockers, and completion to the lead';
/** The only task-tree ops a standard-mode subagent may call: its own seat. */
const SUBAGENT_OPS = Object.freeze(['claim', 'release']);

/** A JSON Schema subset node for `string | null`. */
const NULLABLE_STRING = Object.freeze({ oneOf: [{ type: 'string' }, { type: 'null' }] });

const READ_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    details: {
      type: 'boolean',
      description: 'Also return each task summary, progress, and result (default false).',
    },
    includeArchived: {
      type: 'boolean',
      description: 'Also list archived tasks, newest first, with the archive reason, archive time, original location, status, and progress (default false).',
    },
    archivedLimit: {
      type: 'integer',
      description: 'Maximum archived rows to return when includeArchived is true (1..200, default 50).',
    },
  },
});

const WRITE_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['ops'],
  properties: {
    ops: {
      type: 'array',
      description: 'Operations applied in order. The whole batch is validated before anything is written.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: {
            type: 'string',
            enum: ['init', 'reviseGoal', 'create', 'update', 'move', 'defer', 'resume', 'archive', 'restore', 'focus', 'assign', 'dispatch', 'claim', 'release', 'complete', 'resolveConflict'],
            description: 'The operation to apply.',
          },
          id: { type: 'string', description: 'Target task id, e.g. "t3".' },
          parentId: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Parent task id for create/move. Prefer the task that actually owns this work: a fix, refinement, follow-up or implementation step of an existing feature belongs under it, including when that task is already done. Leave it out only when no existing task owns the work; null makes the task a top-level task. Placement does not grant execution approval and does not decide who accepts the result.',
          },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'The complete focus set for op "focus": it replaces the whole set instead of adding to it, so pass every task you are working on and [] to clear it.',
          },
          member: {
            type: 'string',
            description: 'For op "assign" (standard mode, lead session only): the subagent session id the lead read from the spawn result, or "lead" to hand the task back. For op "dispatch" (team mode, lead only): the Team member name that should claim the task. Assignment and dispatch are routing, not a claim: neither gives an execution or changes any permission.',
          },
          teamTaskId: {
            type: 'string',
            description: 'For op "dispatch" (team mode, lead only): the Team-board task id the dispatched Worker must claim (for example "task-3"). The Host binds the execution only when that Worker\'s own board claim succeeds.',
          },
          conflictId: {
            type: 'string',
            description: 'For op "resolveConflict" (Lead only): the conflict id from task_tree_read (for example "cf-1"). The resolution records who decided, when, and why, and lets the task be worked again; it never picks an executor or revives an execution.',
          },
          title: { type: 'string', description: 'Short task name, 1..40 characters, single line.' },
          summary: { type: 'string', description: 'One-line hover summary, at most 240 characters.' },
          expectedOutcome: { type: 'string', description: 'What the task is expected to deliver, one line, at most 240 characters. Write it when the task is created; the right sidebar shows it.' },
          nextStep: { type: 'string', description: 'The immediate next move, one line, at most 240 characters. Update it together with progress; the right sidebar shows it.' },
          temporary: {
            type: 'boolean',
            description: 'True when this task absorbs an urgent problem that interrupted the mainline task; it must then name that task in temporaryFor. Setting temporaryFor alone also makes the task temporary, and temporary: false clears the link.',
          },
          temporaryFor: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'The interrupted mainline task id. Must exist in this workline, be active (not archived), not be this task, and must not close a loop of temporary tasks. A temporary task must always name its source; finish it and go back to the interrupted task.',
          },
          outline: { type: 'string', description: 'Free-form goal outline for op "init".' },
          current: { type: 'string', description: 'The revised current goal for op "reviseGoal".' },
          reason: { type: 'string', description: 'Why the goal changed (reviseGoal), why the task is archived (archive), or why an execution is force-terminated (release with force).' },
          status: {
            type: 'string',
            enum: [...TASK_STATUSES],
            description: 'Task status. A task must be approved for execution before it may become "in_progress".',
          },
          executionApproval: {
            type: 'string',
            enum: [...EXECUTION_APPROVALS],
            description: '"approved" when the user asked for this work or agreed to it; "pending" for an idea, a proposal, or unrequested scope. A pending task may be discussed and planned but not started. A task created directly under an approved parent inherits approval; anything else starts pending.',
          },
          approvalBasis: {
            type: 'string',
            description: `The user's own words that authorised the work (quote, ${MIN_QUOTE} to ${MAX_BASIS} characters). Required to approve a task whose parent is not approved; the host rejects a quote that does not appear in a real user message.`,
          },
          progress: { type: 'string', description: 'Meaningful progress notes, at most 2000 characters.' },
          result: { type: 'string', description: 'Completion result, at most 500 characters.' },
          blockerReason: { type: 'string', description: 'Why the task is blocked; an empty value together with blockerUnblock clears the blocker.' },
          blockerUnblock: { type: 'string', description: 'What must happen to unblock the task.' },
          userBasis: {
            type: 'string',
            description: `For op "defer"/"archive" on approved, unfinished work: the user's own words deciding it (quote, ${MIN_QUOTE} to ${MAX_BASIS} characters). Archiving takes the whole subtree, so an approved, unfinished descendant needs the quote too. Verified against the session log; an idea that never started and finished work need no quote.`,
          },
          deferredReason: { type: 'string', description: 'Why the task is deferred (op "defer"). Deferring is a pause, not a cancellation: deferred work still blocks the parent task from being completed.' },
          resumeCondition: { type: 'string', description: 'What would let the deferred task resume.' },
          order: { type: 'integer', description: 'Sibling order for create/move; default appends.' },
          confirmedByUser: {
            type: 'boolean',
            description: 'Set true only to record the user\'s own acceptance of a delivered task; it then needs confirmationBasis. Omit it to complete a normal implementation task as self-verified.',
          },
          confirmationBasis: {
            type: 'string',
            description: `The user's own words accepting the delivered work (quote, ${MIN_QUOTE} to ${MAX_BASIS} characters). Required with confirmedByUser: true, verified against the session log, and it must come after you reported the delivery.`,
          },
          requiresUserAcceptance: {
            type: 'boolean',
            description: 'Whether the task needs the user\'s acceptance before it can be completed. Top-level tasks default to true (a delivered requirement); children default to false (an implementation step). A task that needs acceptance rejects agent self-completion.',
          },
          acceptanceBasis: {
            type: 'string',
            description: `The user's own words that waived the acceptance requirement (quote, ${MIN_QUOTE} to ${MAX_BASIS} characters). Required to set requiresUserAcceptance: false; the host rejects a quote that appears in no real user message.`,
          },
          originalGoal: { type: 'string', description: 'The immutable original goal for op "init".' },
          force: {
            type: 'boolean',
            description: 'For op "release" (Lead only): force-terminate the execution of another session. The Host refuses it unless it recorded that session\'s interrupt_agent call and can prove the worker is not running; it then ends the execution (force-terminated), ends that Worker\'s lifetime record, and clears the Team-board ownership so a NEW Worker can take the task.',
          },
        },
      },
    },
  },
});

const READ_OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['worklineId', 'goal', 'focus', 'conflicts', 'tasks'],
  properties: {
    worklineId: { type: 'string' },
    goal: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['original', 'current'],
          properties: {
            original: { type: 'string' },
            current: { type: 'string' },
          },
        },
      ],
    },
    focus: { type: 'array', items: { type: 'string' } },
    archived: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'parentId', 'title', 'status', 'approval', 'archivedAt', 'archiveReason', 'path'],
        properties: {
          id: { type: 'string' },
          parentId: NULLABLE_STRING,
          title: { type: 'string' },
          status: { type: 'string', enum: [...TASK_STATUSES] },
          approval: { type: 'string', enum: [...EXECUTION_APPROVALS] },
          deferred: { type: 'boolean' },
          archivedAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          archiveReason: NULLABLE_STRING,
          summary: { type: 'string' },
          progress: { type: 'string' },
          result: NULLABLE_STRING,
          completion: NULLABLE_STRING,
          path: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    archivedTotal: { type: 'integer' },
    conflicts: {
      type: 'array',
      description: 'Every evidence contradiction recorded on this workline, oldest first. An entry with resolvedAt: null stops claims for its task (or the whole workline when scope is "workline"); only the Lead resolves one, with task_tree_write {"op":"resolveConflict","conflictId":"<id>","reason":"<why>"}.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'scope', 'taskId', 'kind', 'evidence', 'createdAt', 'resolvedAt', 'resolvedBy', 'resolution'],
        properties: {
          id: { type: 'string' },
          scope: { type: 'string', enum: ['task', 'workline'] },
          taskId: NULLABLE_STRING,
          kind: { type: 'string', enum: [...CONFLICT_KINDS] },
          evidence: { type: 'object' },
          createdAt: { type: 'number' },
          resolvedAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          resolvedBy: NULLABLE_STRING,
          resolution: NULLABLE_STRING,
        },
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'parentId', 'title', 'status', 'settled', 'approval', 'requiresUserAcceptance', 'deferred', 'blocked', 'owner', 'depth'],
        properties: {
          id: { type: 'string' },
          parentId: NULLABLE_STRING,
          title: { type: 'string' },
          status: { type: 'string', enum: [...TASK_STATUSES] },
          settled: {
            type: 'boolean',
            description: 'Whether the task is done and nothing unfinished remains below it. A done task that gained unfinished children is `false` and shows as unfinished until the subtree settles.',
          },
          approval: { type: 'string', enum: [...EXECUTION_APPROVALS] },
          requiresUserAcceptance: { type: 'boolean' },
          acceptanceBasis: NULLABLE_STRING,
          deferred: { type: 'boolean' },
          blocked: { type: 'boolean' },
          owner: { type: 'boolean' },
          executor: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'name', 'sessionId'],
                properties: {
                  kind: { type: 'string', enum: ['lead', 'teammate', 'subagent'] },
                  name: { type: 'string' },
                  sessionId: { type: 'string' },
                },
              },
            ],
            description: 'Who holds the active execution: a named teammate, the lead, or a subagent session. Null when nobody does.',
          },
          executorLost: {
            type: 'boolean',
            description: 'True when this task\'s execution is orphaned because its worker session can no longer be resolved (executor lost). Such an execution grants no workspace permission, is never released or reassigned on its own, and only a Lead force release ends it.',
          },
          executionState: {
            oneOf: [
              { type: 'string', enum: ['active', 'orphaned', 'ended', 'missing'] },
              { type: 'null' },
            ],
            description: 'The lifecycle state behind the task\'s claim stamp: active grants class A permission; orphaned (executor lost) and ended grant none; missing means the stamp has no ledger record; null means the task holds no execution.',
          },
          depth: { type: 'integer' },
          temporary: {
            type: 'boolean',
            description: 'True when this task was created to absorb an urgent interruption of another task in this workline.',
          },
          temporaryFor: {
            ...NULLABLE_STRING,
            description: 'The interrupted mainline task id; null for an ordinary task.',
          },
          summary: { type: 'string' },
          expectedOutcome: { type: 'string', description: 'What the task is expected to deliver (details: true).' },
          nextStep: { type: 'string', description: 'The immediate next move (details: true).' },
          progress: { type: 'string' },
          result: NULLABLE_STRING,
          completion: NULLABLE_STRING,
          approvalBasis: NULLABLE_STRING,
          acceptanceBasis: NULLABLE_STRING,
        },
      },
    },
  },
});

const WRITE_OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'worklineId', 'applied'],
  properties: {
    ok: { type: 'boolean' },
    worklineId: { type: 'string' },
    applied: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string' },
          id: { type: 'string' },
          executionId: { type: 'string' },
          conflictId: { type: 'string' },
        },
      },
    },
  },
});

const READ_DESCRIPTION = [
  'Read the workline task tree: the goal (original and current), the current focus, and every active task in tree order with its depth, status, execution approval, whether it needs the user\'s acceptance, whether it is settled (done with nothing unfinished below it), and who holds its execution (the executor name), if anyone. `executorLost` marks a task whose executor session can no longer be resolved: that execution grants no workspace permission, is never silently released, and needs a Lead force release after interrupt_agent and confirmation the worker stopped.',
  'Call this at the start of a session or branch, before resuming interrupted work, before planning a large new chunk, and whenever you need to confirm the current goal, focus, approval, or task state; do not rebuild a tree that already exists.',
  'Pass details: true to also get each task summary, expected outcome, next step, progress notes, result, completion kind, and approval basis. Archived tasks are omitted by default; pass includeArchived: true when you need to check what was cancelled before (reason, time, original location, progress), for example before proposing a direction the user may already have rejected.',
  '`conflicts` lists the evidence contradictions that stop this workline: an unresolved entry (resolvedAt: null) refuses new claims on its task, or on every task when its scope is "workline". The Host never guesses who holds a stopped task. Only the Lead records the human decision that ends it: task_tree_write {"op":"resolveConflict","conflictId":"<id>","reason":"<why>"} stores who decided, when, and why, and the task can be worked again after that.',
].join(' ');

const WRITE_DESCRIPTION = [
  'Maintain the workline task tree (lead session only). Before creating a task, decide what it belongs to: check the current tree, and pass the owning task as parentId when one exists (a fix, refinement, follow-up or implementation step of an existing feature belongs under that feature, even once it is done). Leave parentId out only when nothing owns the work; never invent a parent, an empty theme task, or an unrelated nesting just to keep the tree short. When the ids are not at hand, task_tree_read first instead of guessing.',
  'Placement changes neither permission nor acceptance: a child still needs its own executionApproval (new scope under an approved parent must be created pending), and a child the user will judge on its own needs requiresUserAcceptance: true just like a top-level task. "Accept it separately" is not a reason to lift work out of the feature it belongs to. Do not reorganize existing tasks: move is not part of normal maintenance, and never move, archive or defer a task only to unblock a completion.',
  'Maintain the workline task tree (lead session only). The tree covers the whole life of the work: idea, discussion, approval, execution, acceptance, and cancellation. Write when the user raises an idea, states or changes a requirement, decides to execute, defer, or cancel something, or confirms delivery — and when a task starts, progresses, pauses, or blocks. Do not wait for code to be written: record what is worth tracking when it appears, before you answer.',
  'Keep titles short (1..40 characters) and put explanations in summary; refine an existing task instead of creating a near-duplicate. Do not create a node for a trivial fix or an intermediate step: record it in the current task progress instead.',
  'Write down what "done" looks like: when you create a task, put its expected result in `expectedOutcome` (one line, at most 240 characters), and when you record progress, also write `nextStep` (one line, at most 240 characters) so the next session knows the immediate move. The right sidebar shows both.',
  'An urgent, unrelated interruption does not replace the mainline task. Create a task with `temporary: true` and `temporaryFor: <the interrupted task id>`, move the focus to it, finish it, then resume the interrupted task. A temporary task must name its source: the source must exist in this workline, be active (not archived), not be the task itself, and the interrupt chain must never loop back. Naming a source with `temporaryFor` alone makes the task temporary; `temporary: false` clears the link. The right sidebar shows "temporary, interrupted <task>"; do not leave a finished temporary task as a container.',
  `executionApproval separates permission from progress. "approved" means the user asked for this work or agreed to it; "pending" means an idea, a proposal, or scope you invented, which may be discussed and planned but not started. A task created directly under an approved parent inherits approval — only the direct parent decides, so approval never tunnels through a pending step; everything else starts pending. Approving a task whose parent is not approved requires approvalBasis quoting the user\'s own words — the host rejects a quote that appears in no real user message or is shorter than ${MIN_QUOTE} characters. A pending task cannot become in_progress or be claimed.`,
  'Starting to execute is its own sequence: create or read the task to get its real id, set the status to in_progress, then call focus with that id before the first file edit or command — for example {"op":"focus","ids":["<id>"]}, where ids is the COMPLETE focus set (it replaces the previous set, [] clears it). Creating a task as in_progress does not set the focus, and neither does claim: status says how far the task is, focus says what you are working on now, claim says which session owns it. Focus may name a pending, still-unapproved task because it is under discussion; that is attention, not permission, so never approve a task or start coding just to make it focusable, and do not focus every in_progress task "just in case". Completing a task clears it from the focus, so move the focus to the next task in the same write.',
  'Notes are not execution: a discussion or progress note does not start a task, and starting work on a recorded idea reuses that task (same id, same history) while approving it also decides requiresUserAcceptance. Deferring or archiving an approved, unfinished task changes the current delivery and needs userBasis quoting the user\'s decision; archiving takes the whole subtree, so an approved, unfinished descendant needs that quote too. Ideas that never started and finished work are tidied freely.',
  'A parent is complete only when nothing unfinished remains below it: pending, in_progress, blocked and deferred children all block it, while done and archived work does not. A completed parent that gains an unfinished child is shown as unfinished again and keeps its acceptance record; when that child finishes or is archived the parent is complete again. A new deliverable beneath it still needs its own acceptance, and one acceptance quote closes one task — never replay the same quote for another task.',
  'One confirmation closes one task: each acceptance quote binds to the task it names. If the user accepted several tasks in one sentence, quote the clause naming each one; if you cannot tell which task they accepted, ask instead of widening the scope.',
  'Completion, acceptance, and approval are separate. A top-level task is a delivered requirement and defaults to requiresUserAcceptance: true; its steps default to false and may be completed on your own verification with complete and no confirmedByUser. A task that requires acceptance cannot be completed by the agent: record the delivered work in progress or result, keep it in progress, and complete it only after the user accepts, with confirmedByUser: true and confirmationBasis quoting their acceptance — the quote must come after you reported the delivery, and the instruction that authorised the work does not count. Setting requiresUserAcceptance: false needs a real user instruction plus an acceptanceBasis quote; a quote that appears in no real user message is rejected, so never speak for the user. A self-verified completion can later be accepted by passing confirmedByUser: true plus confirmationBasis.',
  'A lost executor is not a free task. `task_tree_read` marks a task `executorLost` when the session holding its execution can no longer be resolved: that execution grants no workspace permission, is not released on its own, and the task is never handed to another session. Only the lead may end it, and only after interrupting the worker and confirming it stopped: call `interrupt_agent`, check with `list_agents` that the worker is not running, then `task_tree_write {"op":"release","id":"<task>","force":true,"reason":"<why>"}`. The force release ends the execution, ends that Worker\'s lifetime binding and clears the Team-board ownership, so a NEW Worker can claim the task with a NEW execution id; a force-terminated worker can never write again. An idle worker between turns is NOT lost: its session is still live and keeps its execution.',
  'Only the lead maintains the tree. In standard mode the whole workline shares ONE execution seat: while anyone holds it, every other claim is refused. To hand a task to a subagent, release it, assign the subagent session id you read from the spawn result, let the subagent claim and release it, then assign "lead" and claim again; the new claim gets a NEW execution id, and an ended execution is never revived. Assignment is routing, not a claim: it grants nothing by itself. A subagent may call claim and release only, and only for the task assigned to it. In an Agent Team the lead only coordinates: the host refuses it every class A tool (writing files, edit, shell, terminal, worktree, workflow, ralph, subagent spawn) even while a task execution is held, so spawn a teammate with spawn_teammate, send it the work, and keep the tree and the Team board to yourself. Team mode is claim-first: the lead creates the Team-board task and the tree task, associates them with task_tree_write {"op":"dispatch","id":"<task>","member":"<worker-name>","teamTaskId":"<task-N>"}, spawns that named teammate, and the Worker claims the board task itself with team_task_update {action:"claim"} — only that claim creates the execution, resolves the Worker identity through the Team roster, and turns the tree task in_progress with its executor. There is no assign and no reassign in team mode: the Host refuses team_task_update reassign, and the lead never claims a team task in the tree.',
  'init runs once per workline and writes the immutable original goal plus the outline. When the user decides to change the project direction, call reviseGoal immediately with a reason quoting their decision — it does not need implementation to start. When you merely propose a direction, discuss it first.',
  'defer keeps the status and progress of a task that may come back later and removes it from the focus; it cannot be focused or claimed until resumed. archive means the task will not be done: it and its whole subtree leave the active tree with a reason and stay visible in the archive. A pending "not now" from the user is respected even for approved tasks.',
  'A conflict (see task_tree_read `conflicts`) stops claims on its task until a human decides. The Lead records that decision with {"op":"resolveConflict","conflictId":"<id>","reason":"<why>"}: it stores the resolver, the time, and the reason, and never picks an executor or revives an execution. A defer or archive that would end another session\'s execution is refused with the same answer: interrupt the worker, then force-release it.',
  'Every batch is validated first and applied atomically; on failure nothing is written.',
].join(' ');

/**
 * Decide what the caller may write.
 *
 * The lead maintains the whole tree. In standard mode a subagent may only
 * claim (and release) a task the lead assigned to it: that is the handover, and
 * it is not tree maintenance. In an Agent Team the lead still owns the tree and
 * teammates are refused outright: they report progress to the lead.
 *
 * @returns `{ restricted }`; `restricted` means "only claim/release".
 */
function writableBy(ctx, agent, header, sessionId, standardMode) {
  if (sessionId === undefined) throw new Error('task_tree_write cannot resolve the calling session');
  const agentTeams = ctx.get('agentTeams');
  if (agentTeams !== undefined && typeof agentTeams.membership === 'function') {
    let membership;
    try {
      membership = agentTeams.membership(agent);
    } catch {
      membership = undefined;
    }
    if (membership !== null && typeof membership === 'object' && membership.role === 'teammate') {
      throw new Error(WRITE_DENIED_TEAMMATE);
    }
  }
  if (header !== undefined && header !== null && header.origin === 'subagent') {
    // A standard-mode subagent owns only its assigned seat; in team mode the
    // tree stays with the lead until claim-first dispatch lands.
    if (!standardMode) throw new Error(WRITE_DENIED_SUBAGENT);
    return { restricted: true };
  }
  return { restricted: false };
}

/** Validate that an assign target is a real subagent of this workline. */
async function assertAssignTarget({ member, worklineId, sessions }) {
  if (member === 'lead') return;
  if (typeof member !== 'string' || member.trim() === '') {
    throw new Error('assign member must be a subagent session id or "lead"');
  }
  const target = member.trim();
  const header = await sessions.headerOf(target);
  if (header === undefined) {
    throw new Error(`assign member ${JSON.stringify(target)} is not a known session`);
  }
  if (header.origin !== 'subagent') {
    throw new Error(`assign member ${JSON.stringify(target)} is not a subagent session`);
  }
  const targetWorkline = await sessions.rootSessionId(target, header);
  if (targetWorkline !== worklineId) {
    throw new Error(`assign member ${JSON.stringify(target)} belongs to workline ${targetWorkline}, not ${worklineId}`);
  }
}

function textResult(value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

/**
 * Register `task_tree_read` and `task_tree_write` on the plugin context.
 * @param ctx - the plugin context.
 * @param deps - `{ store, sessions }` from `host/store.js` and `host/session.js`.
 * @returns whether the tools were registered (false when the registry is absent).
 */
export function registerTaskTreeTools(ctx, { store, sessions }) {
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.register !== 'function') return false;

  const readTool = {
    name: 'task_tree_read',
    description: READ_DESCRIPTION,
    parameters: READ_PARAMETERS,
    output: {
      schema: READ_OUTPUT,
      render(args, value) {
        return textResult(value);
      },
    },
    async execute(args, exec) {
      const caller = callerOf(exec);
      const worklineId = await sessions.rootSessionId(caller.sessionId, caller.header);
      await store.ensure();
      const envelope = await store.read(worklineId);
      const details = args !== null && typeof args === 'object' && args.details === true;
      const includeArchived = args !== null && typeof args === 'object' && args.includeArchived === true;
      const archivedLimit = args !== null && typeof args === 'object' ? args.archivedLimit : undefined;
      return readSnapshot(envelope, worklineId, details, { includeArchived, archivedLimit });
    },
  };

  const writeTool = {
    name: 'task_tree_write',
    description: WRITE_DESCRIPTION,
    parameters: WRITE_PARAMETERS,
    output: {
      schema: WRITE_OUTPUT,
      render(args, value) {
        return textResult(value);
      },
    },
    async execute(args, exec) {
      const caller = callerOf(exec);
      if (caller.sessionId === undefined) throw new Error('task_tree_write cannot resolve the calling session');
      const ops = args !== null && typeof args === 'object' && !Array.isArray(args) ? args.ops : undefined;
      if (!Array.isArray(ops) || ops.length === 0) {
        throw new Error('ops must be a non-empty array of task tree operations');
      }
      // Team mode is "the Agent Team service is composed" (design v8 §3, §7).
      // The team slice owns dispatch and claim-first binding, so a teammate
      // still never writes the tree; the Lead keeps it.
      const standardMode = ctx.get('agentTeams') === undefined;
      const permission = writableBy(ctx, exec?.agent, caller.header, caller.sessionId, standardMode);
      if (permission.restricted) {
        // The handover gives a subagent exactly one power: its own seat.
        for (const op of ops) {
          if (op === null || typeof op !== 'object' || !SUBAGENT_OPS.includes(op.op)) {
            throw new Error(WRITE_DENIED_SUBAGENT);
          }
        }
      }
      const worklineId = await sessions.rootSessionId(caller.sessionId, caller.header);
      if (!permission.restricted && standardMode) {
        for (const op of ops) {
          if (op !== null && typeof op === 'object' && op.op === 'assign') {
            await assertAssignTarget({ member: op.member, worklineId, sessions });
          }
        }
      }
      await store.ensure();
      // A force release writes a DIFFERENT store (the Team board) before this
      // one, so every precondition is checked against the persisted record
      // first: a refused release must never reach the board (design I13).
      const forceOps = ops.filter((op) => op !== null && typeof op === 'object'
        && op.op === 'release' && op.force === true);
      const isRunning = (sessionId) => {
        // A worker whose turn is still running must not be force-terminated,
        // and an unreadable answer counts as running (fail closed).
        try {
          return ctx.get('agents')?.get?.(sessionId)?.status === 'running';
        } catch {
          return true;
        }
      };
      if (forceOps.length > 0) {
        const current = await store.read(worklineId);
        if (current === undefined) {
          throw new Error('task_tree_write cannot force-release: this workline has no persisted task tree');
        }
        for (const op of forceOps) {
          const readiness = forceReleaseReadiness(current, {
            taskId: op.id,
            actorSessionId: caller.sessionId,
            isRunning,
          });
          if (readiness.ok !== true) throw new Error(readiness.reason);
        }
        const agentTeams = ctx.get('agentTeams');
        if (!standardMode && agentTeams !== undefined) {
          for (const op of forceOps) {
            const task = (Array.isArray(current.tasks) ? current.tasks : []).find((candidate) => candidate !== null
              && typeof candidate === 'object'
              && candidate.id === op.id);
            const teamTaskId = task !== null && task !== undefined && typeof task.teamTaskId === 'string'
              ? task.teamTaskId
              : undefined;
            if (teamTaskId === undefined) {
              throw new Error(`task ${op.id} is not associated with a Team-board task, so the Host cannot clear its board ownership`);
            }
            const view = agentTeams.getTask(exec.agent, teamTaskId);
            if (view === null || typeof view !== 'object') {
              throw new Error(`the Team board has no task ${teamTaskId}; the Host cannot clear ownership it cannot read`);
            }
            if (view.status !== 'in_progress') {
              throw new Error(`Team task ${teamTaskId} is ${view.status}, not in_progress; there is no board ownership to force-release`);
            }
            const expectedOwner = task?.owner !== null && task?.owner !== undefined
              && typeof task.owner.member === 'string'
              ? task.owner.member
              : undefined;
            if (expectedOwner !== undefined && view.ownerName !== expectedOwner) {
              throw new Error(`Team task ${teamTaskId} is owned by ${String(view.ownerName ?? 'nobody')},`
                + ` not ${expectedOwner}; the Host will not release another member's claim`);
            }
            // Board first (design v8 I13, §6.3): if this write fails the ledger
            // stays active and the Lead can retry; the reverse order would leave
            // a terminal execution the board still owns.
            const released = await agentTeams.updateTask(exec.agent, {
              taskId: teamTaskId,
              expectedRevision: view.revision,
              action: 'release',
            });
            if (released === null || typeof released !== 'object' || released.status !== 'pending') {
              throw new Error(`the Team board did not release ${teamTaskId}; the execution stays active`);
            }
          }
        }
      }
      // Approval and acceptance quotes are checked against the caller's own log:
      // the agent cannot approve work, or accept a delivery, in the user's name.
      const session = exec?.agent?.session;
      const verifyQuote = (quote) => verifyUserQuote(session, quote);
      const outcome = await store.update(worklineId, (current) => applyOps(current, ops, {
        worklineId,
        now: Date.now(),
        actorSessionId: caller.sessionId,
        isLive: sessions.isLive,
        isRunning,
        verifyUserQuote: verifyQuote,
        standardMode,
      }));
      return { ok: true, worklineId, applied: outcome.applied };
    },
  };

  ctx.effect(() => tools.register(readTool), 'summary-panel: tool task_tree_read');
  ctx.effect(() => tools.register(writeTool), 'summary-panel: tool task_tree_write');
  return true;
}
