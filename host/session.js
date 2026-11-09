/**
 * Session facts the task tree needs: header lookup, workline resolution, and
 * session liveness.
 *
 * A workline is identified by the ROOT session id: branches and subagent
 * children walk `SessionHeader.parentSession` up to the top, at most 50 levels
 * (CONTRACT.md §1). When a header cannot be read the walk stops at the current
 * session instead of failing.
 */

const MAX_WORKLINE_DEPTH = 50;

/**
 * Build the session helpers for one plugin context.
 * @param ctx - the plugin context (services are read with `ctx.get`).
 * @returns `{ headerOf, rootSessionId, isLive }`.
 */
export function createSessionSupport(ctx) {
  /** Any readable header for one session: live first, then the persisted log. */
  async function headerOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    try {
      const sessions = ctx.get('sessions');
      const live = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
      if (live !== undefined && live.header !== undefined) return live.header;
    } catch {
      /* fall through to persistence */
    }
    try {
      const persistence = ctx.get('sessionPersistence');
      if (persistence !== undefined && typeof persistence.stat === 'function') {
        const snapshot = await persistence.stat(sessionId);
        if (snapshot !== undefined && snapshot.header !== undefined) return snapshot.header;
      }
    } catch {
      /* unknown session */
    }
    return undefined;
  }

  /**
   * Resolve the workline id for a session.
   * @param sessionId - the calling session.
   * @param header - its already-known header, when available.
   */
  async function rootSessionId(sessionId, header) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('cannot resolve a workline without a session id');
    }
    let currentId = sessionId;
    let currentHeader = header;
    for (let depth = 0; depth < MAX_WORKLINE_DEPTH; depth += 1) {
      if (currentHeader === undefined) currentHeader = await headerOf(currentId);
      if (currentHeader === undefined) return currentId;
      const parent = typeof currentHeader.parentSession === 'string' ? currentHeader.parentSession : '';
      if (parent === '' || parent === currentId) return currentId;
      currentId = parent;
      currentHeader = undefined;
    }
    return currentId;
  }

  /** Whether a session still exists in this process (its occupancy is live). */
  function isLive(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    try {
      const sessions = ctx.get('sessions');
      if (sessions !== undefined && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) {
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const agents = ctx.get('agents');
      if (agents !== undefined && typeof agents.get === 'function' && agents.get(sessionId) !== undefined) {
        return true;
      }
    } catch {
      /* not live */
    }
    return false;
  }

  /**
   * The resolution of one executor session (design v8 I0/I16):
   *
   * - `active`   — the Host can still name the session: it is live, or its
   *                persisted record resolves and the same session can resume.
   *                A session that cannot resume can never call a tool, so a
   *                restart of a provable worker must NOT strip its execution;
   * - `orphaned` — nothing resolves it any more ("executor lost"). The panel
   *                shows it as lost, it is never silently released, and only a
   *                Lead force-release ends it.
   *
   * A session that cannot even be looked up (an empty id) is orphaned: the
   * fail-closed direction is always "no permission", never "assume alive".
   * @param sessionId - the executor session recorded in the execution ledger.
   */
  async function resolveSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return 'orphaned';
    if (isLive(sessionId)) return 'active';
    const header = await headerOf(sessionId);
    return header === undefined ? 'orphaned' : 'active';
  }

  return { headerOf, rootSessionId, isLive, resolveSession };
}
