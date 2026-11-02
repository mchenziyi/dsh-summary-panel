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

import { TASK_STATUSES, applyOps, readSnapshot } from './model.js';

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
            description: 'Task status. "done" requires confirmedByUser: true; use complete instead where possible.',
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
            description: 'Must be true to complete a task; set it only after the user confirmed completion.',
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
        required: ['id', 'parentId', 'title', 'status', 'archivedAt', 'archiveReason', 'path'],
        properties: {
          id: { type: 'string' },
          parentId: NULLABLE_STRING,
          title: { type: 'string' },
          status: { type: 'string', enum: [...TASK_STATUSES] },
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
        required: ['id', 'parentId', 'title', 'status', 'deferred', 'blocked', 'owner', 'depth'],
        properties: {
          id: { type: 'string' },
          parentId: NULLABLE_STRING,
          title: { type: 'string' },
          status: { type: 'string', enum: [...TASK_STATUSES] },
          deferred: { type: 'boolean' },
          blocked: { type: 'boolean' },
          owner: { type: 'boolean' },
          depth: { type: 'integer' },
          summary: { type: 'string' },
          progress: { type: 'string' },
          result: NULLABLE_STRING,
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
  'Read the workline task tree: the goal (original and current), the current focus, and every active task in tree order with its depth.',
  'Call this at the start of a session or branch, before resuming interrupted work, before planning a large new chunk, and whenever you need to confirm the current goal, focus, or task state; do not rebuild a tree that already exists.',
  'Pass details: true to also get each task summary, progress notes, and result. Archived tasks are omitted by default; pass includeArchived: true when you need to check what was cancelled before (reason, time, original location, progress), for example before proposing a direction the user may already have rejected.',
].join(' ');

const WRITE_DESCRIPTION = [
  'Maintain the workline task tree (lead session only). Write when the user gives an explicit instruction (update the tree before acting), when you start a task (focus it and claim it), when a task makes real progress or is paused, when work is blocked, when a task is deferred or archived after agreeing with the user, and when the user confirms a task is complete.',
  'Keep titles short (1..40 characters) and put explanations in summary; record meaningful progress rather than an operation log.',
  'Do not create a node for a trivial fix or an intermediate step: record it in the current task progress instead.',
  'Ask the user before marking a task complete, pass confirmedByUser: true only after they agree, and record the result.',
  'Only the lead maintains the tree; in an Agent Team, teammates report to the lead and never write the tree themselves.',
  'init runs once per workline and writes the immutable original goal plus the outline. Revising the current goal requires a reason and the user\'s explicit confirmation: explain the original goal, the proposed goal, and the impact, then call reviseGoal.',
  'defer keeps the status and progress of a task that may come back later and removes it from the focus; it cannot be focused or claimed until resumed. archive means the task will not be done: it and its whole subtree leave the active tree with a reason and stay visible in the archive.',
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
      const outcome = await store.update(worklineId, (current) => applyOps(current, ops, {
        worklineId,
        now: Date.now(),
        actorSessionId: caller.sessionId,
        isLive: sessions.isLive,
      }));
      return { ok: true, worklineId, applied: outcome.applied };
    },
  };

  ctx.effect(() => tools.register(readTool), 'summary-panel: tool task_tree_read');
  ctx.effect(() => tools.register(writeTool), 'summary-panel: tool task_tree_write');
  return true;
}
