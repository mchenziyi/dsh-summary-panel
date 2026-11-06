/**
 * Team execution ends and Worker lifetime (design v8 §6.3, I2b, ticket #7).
 *
 * A Worker's own successful `team_task_update {action:"complete"}` or `{action:
 * "release"}` is a fact the Host can observe on the real tool result. This
 * module watches that awaited `tools/post-execute` waterfall (the sibling of
 * the claim binding) and ends the execution bound to that board task when the
 * caller is its roster-resolved owner:
 *
 * - `complete` ends the execution with `endReason:"completed"`; the tree task
 *   stays `in_progress` because the Lead still accepts the delivery;
 * - `release` ends it with `endReason:"released"` and clears the claim stamp.
 *
 * Either way the Worker's lifetime record becomes `ended` and is kept, so the
 * same instance can never claim a second task, while a NEW Worker instance can
 * claim the retried task and receives a NEW execution id.
 *
 * The observer is deliberately narrow: the identity comes from the roster (not
 * from `exec.arguments`), only the executor's own transition counts (a Lead
 * releasing someone else's task is the force-release slice, not this one), and
 * a failed update never rewrites the tool result or the tree.
 */

import { endTeamExecution } from './model.js';

/** The composed Agent Team service, when this profile has one. */
function teamServiceOf(ctx) {
  try {
    const agentTeams = ctx.get('agentTeams');
    return agentTeams !== null && typeof agentTeams === 'object' ? agentTeams : undefined;
  } catch {
    return undefined;
  }
}

/** The roster-resolved membership of one live Agent; never model input. */
function membershipOf(agentTeams, agent) {
  if (agent === null || typeof agent !== 'object') return undefined;
  let membership;
  if (typeof agentTeams.tryMembership === 'function') {
    try {
      membership = agentTeams.tryMembership(agent);
    } catch {
      membership = undefined;
    }
  }
  if (membership === undefined && typeof agentTeams.membership === 'function') {
    try {
      membership = agentTeams.membership(agent);
    } catch {
      membership = undefined;
    }
  }
  if (membership === null || typeof membership !== 'object') return undefined;
  if (typeof membership.id !== 'string' || membership.id === '') return undefined;
  if (typeof membership.role !== 'string') return undefined;
  if (typeof agent.id !== 'string' || agent.id === '') return undefined;
  return { ...membership, sessionId: agent.id };
}

/**
 * The execution end a finished `team_task_update` call actually committed, or
 * undefined. Only a successful complete (status `completed`) or release
 * (status `pending`) whose committed revision advanced by exactly one counts.
 */
function committedEnd(exec, result) {
  if (exec === null || typeof exec !== 'object' || exec.name !== 'team_task_update') return undefined;
  const args = exec.arguments;
  if (args === null || typeof args !== 'object') return undefined;
  if (args.action !== 'complete' && args.action !== 'release') return undefined;
  if (typeof args.task_id !== 'string' || args.task_id === '') return undefined;
  if (result === null || typeof result !== 'object' || result.isError === true) return undefined;
  const view = result.value;
  if (view === null || typeof view !== 'object') return undefined;
  if (view.id !== args.task_id) return undefined;
  const expectedStatus = args.action === 'complete' ? 'completed' : 'pending';
  if (view.status !== expectedStatus) return undefined;
  if (!Number.isInteger(args.expected_revision) || view.revision !== args.expected_revision + 1) return undefined;
  return {
    action: args.action,
    teamTaskId: args.task_id,
    revision: view.revision,
    ownerName: typeof view.ownerName === 'string' ? view.ownerName : undefined,
  };
}

/** End the execution the Worker's own board transition ended. */
async function endClaim({ agentTeams, store, exec, result, logger }) {
  const ended = committedEnd(exec, result);
  if (ended === undefined) return false;
  const membership = membershipOf(agentTeams, exec.agent);
  // Only a teammate's own transition ends its execution; a Lead's release of
  // another member's task is the explicit force-release path, not this one.
  if (membership === undefined || membership.role !== 'teammate') return false;
  if (ended.action === 'complete' && ended.ownerName !== membership.name) return false;
  const rootId = membership.root !== null && typeof membership.root === 'object'
    && typeof membership.root.id === 'string'
    ? membership.root.id
    : undefined;
  if (rootId === undefined) return false;
  try {
    await store.update(rootId, (current) => endTeamExecution(current, {
      teamTaskId: ended.teamTaskId,
      sessionId: membership.sessionId,
      reason: ended.action === 'complete' ? 'completed' : 'released',
      now: Date.now(),
    }));
    return true;
  } catch (error) {
    // The board already committed; the tree stays as it was and no lifetime
    // record is invented. The ledger/tree discrepancy is evidence for the
    // reconciliation slice, never a reason to rewrite the committed result.
    logger.warn(`[summary-panel] team task ${ended.teamTaskId} ${ended.action} committed on the board but was not applied to the tree: ${String(error?.message ?? error)}`);
    return false;
  }
}

/**
 * Register the post-execute observer that ends a Worker's execution when its
 * own board complete/release commits. It never throws: the board's commit is
 * already a fact, and a failed end must not rewrite the tool result.
 *
 * @param ctx - the plugin context.
 * @param deps - `{ store, logger }`.
 * @returns whether the observer was registered (false without the registry).
 */
export function registerTeamExecutionEnd(ctx, { store, logger = console } = {}) {
  if (store === undefined || typeof store.snapshot !== 'function' || typeof store.update !== 'function') return false;
  if (typeof ctx.on !== 'function') return false;
  const handler = async (exec, result, next) => {
    try {
      // Resolved per call: the Agent Team service may be published after this
      // plugin mounts, exactly like the claim binding.
      const agentTeams = teamServiceOf(ctx);
      if (agentTeams !== undefined) await endClaim({ agentTeams, store, exec, result, logger });
    } catch (error) {
      try {
        logger.warn(`[summary-panel] team execution end failed: ${String(error?.message ?? error)}`);
      } catch {
        /* observation must never break the tool result */
      }
    }
    return next();
  };
  ctx.effect(() => ctx.on('tools/post-execute', handler), 'summary-panel: team execution end');
  return true;
}
