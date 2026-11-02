/**
 * Model-facing tools for the task tree (CONTRACT.md §3).
 *
 * Tools are registered as plain `ToolDefinition` objects instead of
 * `defineTool` because importing `@deepseek-ai/*` on this plugin's resolution
 * path is unsafe (the desktop host resolves a different dsh build). Argument
 * validation therefore lives in `host/model.js`, which throws readable errors.
 *
 * Both tools locate the caller's workline automatically: the chain of
 * `SessionHeader.parentSession` up to the root session. Writes are refused for
 * subagent sessions and for Agent Team teammates (only the lead maintains the
 * tree); reads are unrestricted.
 */

import { EXECUTION_APPROVALS, TASK_STATUSES, applyOps, readSnapshot } from './model.js';
import { verifyUserQuote } from './evidence.js';

const WRITE_DENIED_SUBAGENT = 'task_tree_write is reserved for the lead session; a subagent (or teammate) must report changes to the lead instead';
const WRITE_DENIED_TEAMMATE = 'task_tree_write is reserved for the lead in an Agent Team; teammates report progress, blockers, and completion to the lead';

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
            enum: ['init', 'reviseGoal', 'create', 'update', 'move', 'defer', 'resume', 'archive', 'restore', 'focus', 'claim', 'release', 'complete'],
            description: 'The operation to apply.',
          },
          id: { type: 'string', description: 'Target task id, e.g. "t3".' },
          parentId: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Parent task id for create/move; null makes the task a top-level task.',
          },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'The complete focus set for op "focus"; [] clears it.',
          },
          title: { type: 'string', description: 'Short task name, 1..40 characters, single line.' },
          summary: { type: 'string', description: 'One-line hover summary, at most 240 characters.' },
          outline: { type: 'string', description: 'Free-form goal outline for op "init".' },
          current: { type: 'string', description: 'The revised current goal for op "reviseGoal".' },
          reason: { type: 'string', description: 'Why the goal changed (reviseGoal) or why the task is archived (archive).' },
          status: {
            type: 'string',
            enum: [...TASK_STATUSES],
            description: 'Task status. A task must be approved for execution before it may become "in_progress".',
          },
          executionApproval: {
            type: 'string',
            enum: [...EXECUTION_APPROVALS],
            description: '"approved" when the user asked for this work or agreed to it; "pending" for an idea, a proposal, or unrequested scope. A pending task may be discussed and planned but not started. Tasks under an approved parent inherit approval; anything else starts pending.',
          },
          approvalBasis: {
            type: 'string',
            description: 'The user\'s own words that authorised the work (quote, at most 200 characters). Required to approve a task whose parent is not approved; the host rejects a quote that does not appear in a real user message.',
          },
          progress: { type: 'string', description: 'Meaningful progress notes, at most 2000 characters.' },
          result: { type: 'string', description: 'Completion result, at most 500 characters.' },
          blockerReason: { type: 'string', description: 'Why the task is blocked; an empty value together with blockerUnblock clears the blocker.' },
          blockerUnblock: { type: 'string', description: 'What must happen to unblock the task.' },
          deferredReason: { type: 'string', description: 'Why the task is deferred (op "defer").' },
          resumeCondition: { type: 'string', description: 'What would let the deferred task resume.' },
          order: { type: 'integer', description: 'Sibling order for create/move; default appends.' },
          confirmedByUser: {
            type: 'boolean',
            description: 'Set true only to record the user\'s own acceptance of a delivered task; it then needs confirmationBasis. Omit it to complete a normal implementation task as self-verified.',
          },
          confirmationBasis: {
            type: 'string',
            description: 'The user\'s own words accepting the delivered work (quote, at most 200 characters). Required with confirmedByUser: true, verified against the session log, and it must come after you reported the delivery.',
          },
          requiresUserAcceptance: {
            type: 'boolean',
            description: 'Whether the task needs the user\'s acceptance before it can be completed. Top-level tasks default to true (a delivered requirement); children default to false (an implementation step). A task that needs acceptance rejects agent self-completion.',
          },
          acceptanceBasis: {
            type: 'string',
            description: 'The user\'s own words that waived the acceptance requirement (quote, at most 200 characters). Required to set requiresUserAcceptance: false; the host rejects a quote that appears in no real user message.',
          },
          originalGoal: { type: 'string', description: 'The immutable original goal for op "init".' },
        },
      },
    },
  },
});

const READ_OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['worklineId', 'goal', 'focus', 'tasks'],
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
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'parentId', 'title', 'status', 'approval', 'requiresUserAcceptance', 'deferred', 'blocked', 'owner', 'depth'],
        properties: {
          id: { type: 'string' },
          parentId: NULLABLE_STRING,
          title: { type: 'string' },
          status: { type: 'string', enum: [...TASK_STATUSES] },
          approval: { type: 'string', enum: [...EXECUTION_APPROVALS] },
          requiresUserAcceptance: { type: 'boolean' },
          acceptanceBasis: NULLABLE_STRING,
          deferred: { type: 'boolean' },
          blocked: { type: 'boolean' },
          owner: { type: 'boolean' },
          depth: { type: 'integer' },
          summary: { type: 'string' },
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
        },
      },
    },
  },
});

const READ_DESCRIPTION = [
  'Read the workline task tree: the goal (original and current), the current focus, and every active task in tree order with its depth, status, execution approval, and whether it needs the user\'s acceptance.',
  'Call this at the start of a session or branch, before resuming interrupted work, before planning a large new chunk, and whenever you need to confirm the current goal, focus, approval, or task state; do not rebuild a tree that already exists.',
  'Pass details: true to also get each task summary, progress notes, result, completion kind, and approval basis. Archived tasks are omitted by default; pass includeArchived: true when you need to check what was cancelled before (reason, time, original location, progress), for example before proposing a direction the user may already have rejected.',
].join(' ');

const WRITE_DESCRIPTION = [
  'Maintain the workline task tree (lead session only). The tree covers the whole life of the work: idea, discussion, approval, execution, acceptance, and cancellation. Write when the user raises an idea, states or changes a requirement, decides to execute, defer, or cancel something, or confirms delivery — and when a task starts, progresses, pauses, or blocks. Do not wait for code to be written: record what is worth tracking when it appears, before you answer.',
  'Keep titles short (1..40 characters) and put explanations in summary; refine an existing task instead of creating a near-duplicate. Do not create a node for a trivial fix or an intermediate step: record it in the current task progress instead.',
  'executionApproval separates permission from progress. "approved" means the user asked for this work or agreed to it; "pending" means an idea, a proposal, or scope you invented, which may be discussed and planned but not started. Tasks created under an approved parent inherit approval; everything else starts pending. Approving a task whose parent is not approved requires approvalBasis quoting the user\'s own words — the host rejects a quote that appears in no real user message. A pending task cannot become in_progress or be claimed.',
  'Completion, acceptance, and approval are separate. A top-level task is a delivered requirement and defaults to requiresUserAcceptance: true; its steps default to false and may be completed on your own verification with complete and no confirmedByUser. A task that requires acceptance cannot be completed by the agent: record the delivered work in progress or result, keep it in progress, and complete it only after the user accepts, with confirmedByUser: true and confirmationBasis quoting their acceptance — the quote must come after you reported the delivery, and the instruction that authorised the work does not count. Setting requiresUserAcceptance: false needs a real user instruction plus an acceptanceBasis quote; a quote that appears in no real user message is rejected, so never speak for the user. A self-verified completion can later be accepted by passing confirmedByUser: true plus confirmationBasis.',
  'Only the lead maintains the tree; in an Agent Team, teammates report to the lead and never write the tree themselves.',
  'init runs once per workline and writes the immutable original goal plus the outline. When the user decides to change the project direction, call reviseGoal immediately with a reason quoting their decision — it does not need implementation to start. When you merely propose a direction, discuss it first.',
  'defer keeps the status and progress of a task that may come back later and removes it from the focus; it cannot be focused or claimed until resumed. archive means the task will not be done: it and its whole subtree leave the active tree with a reason and stay visible in the archive. A pending "not now" from the user is respected even for approved tasks.',
  'Every batch is validated first and applied atomically; on failure nothing is written.',
].join(' ');

/** Resolve the calling session and its header from a tool execution. */
function callerOf(exec) {
  const session = exec !== null && typeof exec === 'object' ? exec.agent?.session : undefined;
  const header = session !== null && typeof session === 'object' ? session.header : undefined;
  const agentId = exec !== null && typeof exec === 'object' ? exec.agent?.id : undefined;
  const sessionId = typeof header?.id === 'string' && header.id !== ''
    ? header.id
    : (typeof session?.id === 'string' && session.id !== ''
      ? session.id
      : (typeof agentId === 'string' && agentId !== '' ? agentId : undefined));
  return { sessionId, header };
}

/** Refuse tree maintenance when the caller is not the lead session. */
function assertWritable(ctx, agent, header, sessionId) {
  if (sessionId === undefined) throw new Error('task_tree_write cannot resolve the calling session');
  if (header !== undefined && header !== null && header.origin === 'subagent') {
    throw new Error(WRITE_DENIED_SUBAGENT);
  }
  const agentTeams = ctx.get('agentTeams');
  if (agentTeams === undefined || typeof agentTeams.membership !== 'function') return;
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
      assertWritable(ctx, exec?.agent, caller.header, caller.sessionId);
      const ops = args !== null && typeof args === 'object' && !Array.isArray(args) ? args.ops : undefined;
      if (!Array.isArray(ops) || ops.length === 0) {
        throw new Error('ops must be a non-empty array of task tree operations');
      }
      const worklineId = await sessions.rootSessionId(caller.sessionId, caller.header);
      await store.ensure();
      // Approval and acceptance quotes are checked against the caller's own log:
      // the agent cannot approve work, or accept a delivery, in the user's name.
      const session = exec?.agent?.session;
      const verifyQuote = (quote) => verifyUserQuote(session, quote);
      const outcome = await store.update(worklineId, (current) => applyOps(current, ops, {
        worklineId,
        now: Date.now(),
        actorSessionId: caller.sessionId,
        isLive: sessions.isLive,
        verifyUserQuote: verifyQuote,
      }));
      return { ok: true, worklineId, applied: outcome.applied };
    },
  };

  ctx.effect(() => tools.register(readTool), 'summary-panel: tool task_tree_read');
  ctx.effect(() => tools.register(writeTool), 'summary-panel: tool task_tree_write');
  return true;
}
