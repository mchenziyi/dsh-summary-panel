/**
 * Session facts the task tree needs: who is calling a tool, header lookup,
 * workline resolution, and session liveness.
 *
 * A workline is identified by the ROOT session id: branches and subagent
 * children walk `SessionHeader.parentSession` up to the top, at most 50 levels
 * (CONTRACT.md §1). When a header cannot be read the walk stops at the current
 * session instead of failing.
 */

const MAX_WORKLINE_DEPTH = 50;

/**
 * The calling session of one tool execution.
 *
 * The identity comes from the live agent's session header, never from model
 * input: a wrong answer here would file a write under someone else's workline.
 * Only when the header names nothing does the session id (or, last, the agent
 * id) stand in — a host adapter or a test may expose a session without a
 * header.
 *
 * This function is pure: no I/O, no dependencies, no dsh package.
 *
 * @param exec - the tool execution object (`{ agent }`); anything else is
 *   treated as "no caller".
 * @returns `{ sessionId, header }`; `sessionId` is `undefined` when nothing
 *   names the caller.
 */
export function callerOf(exec) {
  const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined;
  const session = agent !== null && typeof agent === 'object' ? agent.session : undefined;
  const header = session !== null && typeof session === 'object' ? session.header : undefined;
  const sessionId = typeof header?.id === 'string' && header.id !== ''
    ? header.id
    : (typeof session?.id === 'string' && session.id !== ''
      ? session.id
      : (typeof agent?.id === 'string' && agent.id !== '' ? agent.id : undefined));
  return { sessionId, header };
}

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

  return { headerOf, rootSessionId, isLive };
}
