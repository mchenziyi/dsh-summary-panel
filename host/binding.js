/**
 * Team claim-first binding (design v8 §6.1, §7.2).
 *
 * The Team board's `claim` only works on a task in `pending`, while `reassign`
 * writes `in_progress + ownerId` directly: there is no "assign then claim"
 * sequence, so assignment can never be the binding. The Worker's own claim is
 * the fact the Host turns into an execution.
 *
 * This module watches the real tool result of `team_task_update {action:"claim"}`
 * through the awaited `tools/post-execute` waterfall. A successful call carries
 * the committed `TeamTaskView`, so the binding is based on the board's real
 * return value, not on anything the model said. The caller's identity is
 * resolved by the Team roster from the live Agent; no argument field is read as
 * identity. The tree is then updated in one atomic write: the task becomes
 * `in_progress`, the claim stamp carries the roster-resolved session id and
 * Team name, and the execution ledger gets one `mode:"team"` record.
 *
 * A claim that cannot be proven (another dispatch target, a stale revision, an
 * existing execution, a vanished tree task) binds nothing. That is fail-closed:
 * the Worker keeps no class A permission, and the contradiction is adjudicated
 * by `host/reconcile.js` — this module never guesses an executor.
 */

import { bindTeamClaim } from './model.js';
import { teamMembershipOf, teamServiceOf } from './roster.js';

/**
 * The claim a finished `team_task_update` call actually committed, or undefined.
 * Only a successful claim whose committed view says `in_progress` counts.
 */
function committedClaim(exec, result) {
  if (exec === null || typeof exec !== 'object' || exec.name !== 'team_task_update') return undefined;
  const args = exec.arguments;
  if (args === null || typeof args !== 'object' || args.action !== 'claim') return undefined;
  if (typeof args.task_id !== 'string' || args.task_id === '') return undefined;
  if (result === null || typeof result !== 'object' || result.isError === true) return undefined;
  const view = result.value;
  if (view === null || typeof view !== 'object') return undefined;
  if (view.id !== args.task_id || view.status !== 'in_progress') return undefined;
  return {
    teamTaskId: args.task_id,
    revision: view.revision,
    ownerName: typeof view.ownerName === 'string' ? view.ownerName : undefined,
    expectedRevision: args.expected_revision,
  };
}

/**
 * Bind one successful board claim to the tree task that dispatched it.
 * @returns whether an execution was written.
 */
async function bindClaim({ agentTeams, store, exec, result, logger }) {
  const claim = committedClaim(exec, result);
  if (claim === undefined) return false;
  const membership = teamMembershipOf(agentTeams, exec.agent);
  if (membership === undefined || membership.role !== 'teammate') return false;
  const rootId = membership.root !== null && typeof membership.root === 'object'
    && typeof membership.root.id === 'string'
    ? membership.root.id
    : undefined;
  if (rootId === undefined) return false;
  // The committed view must name the roster identity. A model cannot supply
  // this: `membership` comes from the live Agent, not from `exec.arguments`.
  if (claim.ownerName !== membership.name) return false;
  // The board increments revision by exactly one on a committed update. A
  // larger jump means someone else wrote in the window, so the claim is not
  // provable and binds nothing.
  if (!Number.isInteger(claim.expectedRevision) || claim.revision !== claim.expectedRevision + 1) return false;

  const snapshot = store.snapshot(rootId);
  if (snapshot.present !== true) return false;
  const task = (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).find((candidate) => candidate !== null
    && typeof candidate === 'object'
    && candidate.archived !== true
    && candidate.teamTaskId === claim.teamTaskId);
  if (task === undefined) return false;

  try {
    await store.update(rootId, (current) => bindTeamClaim(current, {
      taskId: task.id,
      teamTaskId: claim.teamTaskId,
      sessionId: membership.sessionId,
      member: membership.name,
      revision: claim.revision,
      // The Registry call id ties this ledger row to the claim-intent journal
      // entry written before the board call, so a restart can settle it.
      requestId: typeof exec.callId === 'string' && exec.callId !== '' ? exec.callId : undefined,
      now: Date.now(),
    }));
    return true;
  } catch (error) {
    // The board already committed, so the claim is visible but unproven here.
    // Fail closed (no execution, no class A permission) and leave the conflict
    // for the reconciliation pass; never invent an executor.
    logger.warn(`[summary-panel] team claim on ${claim.teamTaskId} committed on the board but was not bound: ${String(error?.message ?? error)}`);
    return false;
  }
}

/**
 * Register the post-execute observer that turns a Worker's successful board
 * claim into an execution. It never throws: the Team board's commit is already
 * a fact, and a binding failure must not rewrite the tool result.
 *
 * @param ctx - the plugin context.
 * @param deps - `{ store, logger }`.
 * @returns whether the observer was registered (false without the registry).
 */
export function registerTeamClaimBinding(ctx, { store, logger = console } = {}) {
  if (store === undefined || typeof store.snapshot !== 'function' || typeof store.update !== 'function') return false;
  if (typeof ctx.on !== 'function') return false;
  const handler = async (exec, result, next) => {
    try {
      // The Agent Team service may be published after this plugin mounts, so
      // team mode is resolved per call, exactly like the execution gate does.
      const agentTeams = teamServiceOf(ctx);
      if (agentTeams !== undefined) await bindClaim({ agentTeams, store, exec, result, logger });
    } catch (error) {
      try {
        logger.warn(`[summary-panel] team claim binding failed: ${String(error?.message ?? error)}`);
      } catch {
        /* observation must never break the tool result */
      }
    }
    return next();
  };
  ctx.effect(() => ctx.on('tools/post-execute', handler), 'summary-panel: team claim binding');
  return true;
}
