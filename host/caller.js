/**
 * The calling session of one tool execution.
 *
 * The execution gate, the task-tree tools, the Team claim binding and the
 * interrupt evidence all need the same answer, and a wrong answer here widens
 * someone's permission, so it lives in exactly one place: the identity comes
 * from the live agent's session header, never from model input. Only when the
 * header names nothing does the session id (or, last, the agent id) stand in —
 * a host adapter or a test may expose a session without a header.
 *
 * This module is pure: no I/O, no dependencies, no dsh package.
 *
 * @param exec - the tool execution object (`{ agent }`); anything else is
 *   treated as "no caller".
 * @returns `{ sessionId, header }`; `sessionId` is `undefined` when nothing
 *   names the caller, and callers must treat that as "deny".
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
