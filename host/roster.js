/**
 * Team roster identity (design v8 §6.1, I6).
 *
 * In team mode the Host may never read an identity from model input: the only
 * trusted answer to "who is calling?" is the roster's own resolution of the
 * LIVE Agent. This module holds that one resolution so the guard, the claim
 * binding, the execution end, and evidence reconciliation cannot drift apart.
 *
 * Two facts matter and they are different:
 *
 * - `membership.id` is the Team identity (the Lead's Team id), not a session;
 * - `agent.id` is the live Agent's own session id, which is what the execution
 *   ledger records and what the Worker lifetime table is keyed by.
 *
 * `root` is the exact live Lead Agent, so a caller that needs the board's
 * authority can read it on the Wave's behalf.
 */

/**
 * The composed Agent Team service, when this profile has one. Team mode is
 * decided by composition: nothing the model says can turn it on or off.
 * @param ctx - the plugin context.
 */
export function teamServiceOf(ctx) {
  try {
    const agentTeams = ctx.get('agentTeams');
    return agentTeams !== null && typeof agentTeams === 'object' ? agentTeams : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The roster-resolved membership of one live Agent.
 *
 * `tryMembership` is the non-throwing probe; `membership` is the fallback for a
 * service that only exposes the strict one. A caller the roster does not know
 * (for example a provider-owned subagent in a team profile) is not a member.
 *
 * @param agentTeams - the composed Team service.
 * @param agent - the exact live Agent.
 * @returns `{ root, id, role, name, sessionId }`, or undefined.
 */
export function teamMembershipOf(agentTeams, agent) {
  if (agentTeams === null || typeof agentTeams !== 'object') return undefined;
  if (agent === null || typeof agent !== 'object') return undefined;
  let membership;
  let resolved = false;
  if (typeof agentTeams.tryMembership === 'function') {
    try {
      membership = agentTeams.tryMembership(agent);
      resolved = true;
    } catch {
      /* fall through to the strict resolver */
    }
  }
  if (!resolved && typeof agentTeams.membership === 'function') {
    try {
      membership = agentTeams.membership(agent);
    } catch {
      /* an unresolved identity is not a proven member */
    }
  }
  if (membership === null || typeof membership !== 'object') return undefined;
  if (typeof membership.role !== 'string') return undefined;
  if (typeof membership.id !== 'string' || membership.id === '') return undefined;
  // The roster's `id` is the Team identity (the Lead's id); the teammate's real
  // session id is the live Agent's id. Only the latter may appear in the
  // execution ledger or in the Worker lifetime table.
  if (typeof agent.id !== 'string' || agent.id === '') return undefined;
  return { ...membership, sessionId: agent.id };
}
