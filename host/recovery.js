/**
 * Interrupt evidence for force termination (design v8 §6.3, §8.3, I16;
 * ticket #10).
 *
 * `interrupt_agent` is fire-and-return: it proves that the Lead ASKED a worker
 * to stop, never that the worker stopped. The Host therefore records the
 * request as `interruptedAt` on that worker's non-terminal execution and stops
 * there. It is a precondition for a Lead force release, not end evidence:
 * the release itself must still prove the session is not running, and it is
 * the only operation that turns an `orphaned` execution into `ended`.
 *
 * This observer is deliberately narrow:
 *
 * - the caller must be the Team Lead (team mode) or any caller of the standard
 *   `interrupt_agent` (standard mode); the target is resolved through the Host
 *   (the Team roster, or the `agent_id` argument of the subagent tool), never
 *   guessed from the model's prose;
 * - only a real `tools/post-execute` result records anything, and a failed
 *   interrupt records nothing;
 * - a missing tree, a missing execution or an unreadable store changes nothing,
 *   because observation must never break the tool result.
 */

import { callerOf } from './caller.js';
import { markInterrupted } from './model.js';
import { teamMembershipOf, teamServiceOf } from './roster.js';

/**
 * The worker session one successful `interrupt_agent` call targeted, plus the
 * workline that owns its execution, or undefined when the call proves nothing.
 *
 * Team mode names a teammate (`target`, resolved through the durable roster, so
 * the model never needs the real session id). Standard mode passes the child's
 * `agent_id` directly.
 */
async function interruptedTarget({ ctx, sessions, exec, result }) {
  if (exec === null || typeof exec !== 'object' || exec.name !== 'interrupt_agent') return undefined;
  if (result === null || typeof result !== 'object' || result.isError === true) return undefined;
  const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {};
  const agentTeams = teamServiceOf(ctx);
  const membership = agentTeams === undefined ? undefined : teamMembershipOf(agentTeams, exec.agent);
  const rawTarget = typeof args.target === 'string' ? args.target.trim() : '';
  const rawAgentId = typeof args.agent_id === 'string' ? args.agent_id.trim() : '';
  if (membership !== undefined && membership.role === 'lead') {
    const worklineId = membership.root !== null && typeof membership.root === 'object'
      && typeof membership.root.id === 'string'
      ? membership.root.id
      : undefined;
    if (worklineId === undefined) return undefined;
    // The Team tool names a teammate; the roster is the only trusted mapping
    // from that durable name to the session id recorded in the ledger.
    if (rawTarget !== '' && rawTarget !== 'lead') {
      let row;
      try {
        row = agentTeams.listMembers(exec.agent).find((member) => member !== null
          && typeof member === 'object'
          && member.name === rawTarget);
      } catch {
        return undefined;
      }
      const sessionId = row !== null && typeof row === 'object' && typeof row.id === 'string' ? row.id : undefined;
      return sessionId === undefined ? undefined : { sessionId, worklineId };
    }
    // A team profile may still expose the global subagent-control tool, which
    // names the child by session id.
    return rawAgentId === '' ? undefined : { sessionId: rawAgentId, worklineId };
  }
  if (rawAgentId === '') return undefined;
  const caller = callerOf(exec);
  if (caller.sessionId === undefined) return undefined;
  try {
    const worklineId = await sessions.rootSessionId(caller.sessionId, caller.header);
    return { sessionId: rawAgentId, worklineId };
  } catch {
    return undefined;
  }
}

/**
 * Record one observed interrupt on the matching execution(s).
 * @returns whether the ledger changed.
 */
async function recordInterrupt({ ctx, store, sessions, exec, result, logger }) {
  const target = await interruptedTarget({ ctx, sessions, exec, result });
  if (target === undefined) return false;
  const now = Date.now();
  let changed = false;
  try {
    await store.update(target.worklineId, (current) => {
      if (current === undefined) return undefined;
      const outcome = markInterrupted(current, { sessionId: target.sessionId, now });
      if (outcome.changed !== true) return undefined;
      changed = true;
      return { envelope: outcome.envelope };
    });
  } catch (error) {
    logger.warn(`[summary-panel] could not record the interrupt of ${target.sessionId}: ${String(error?.message ?? error)}`);
    return false;
  }
  return changed;
}

/**
 * Register the interrupt observer.
 *
 * @param ctx - the plugin context.
 * @param deps - `{ store, sessions, logger }`.
 * @returns whether the observer was registered (false without the registry).
 */
export function registerInterruptEvidence(ctx, { store, sessions, logger = console } = {}) {
  if (store === undefined || typeof store.update !== 'function') return false;
  if (sessions === undefined || typeof sessions.rootSessionId !== 'function') return false;
  if (typeof ctx.on !== 'function') return false;
  const handler = async (exec, result, next) => {
    try {
      await recordInterrupt({ ctx, store, sessions, exec, result, logger });
    } catch (error) {
      try {
        logger.warn(`[summary-panel] interrupt evidence failed: ${String(error?.message ?? error)}`);
      } catch {
        /* observation must never break the tool result */
      }
    }
    return next();
  };
  ctx.effect(() => ctx.on('tools/post-execute', handler), 'summary-panel: interrupt evidence');
  return true;
}
