/**
 * HTTP handlers for the task tree panel (CONTRACT.md §4).
 *
 * These are plain `(ctx, session, url)` handlers handed to index.js's existing
 * `route()` wrapper, so they inherit the connection trust fence, the
 * `sessionId` requirement, the 404 for unknown sessions, and `cache-control:
 * no-store`. The client only reads here.
 */

import { httpSnapshot, statusSnapshot } from './model.js';

const NO_STORAGE = Object.freeze({ available: false, reason: 'no-storage' });

/**
 * Create the two read-only handlers.
 * @param deps - `{ store, sessions }`.
 * @returns `{ tasks, status }` handlers.
 */
export function createTaskHandlers({ store, sessions }) {
  /** Resolve one session's workline, or undefined when storage cannot be used. */
  async function worklineOf(session) {
    try {
      return await sessions.rootSessionId(session.id, session.header);
    } catch {
      return undefined;
    }
  }

  async function tasksHandler(ctx, session) {
    const worklineId = await worklineOf(session);
    if (worklineId === undefined) return NO_STORAGE;
    try {
      await store.ensure();
      const envelope = await store.read(worklineId);
      return httpSnapshot(envelope, worklineId, { isLive: sessions.isLive });
    } catch {
      return NO_STORAGE;
    }
  }

  async function statusHandler(ctx, session) {
    const worklineId = await worklineOf(session);
    if (worklineId === undefined) return NO_STORAGE;
    try {
      await store.ensure();
      const envelope = await store.read(worklineId);
      return statusSnapshot(envelope, worklineId);
    } catch {
      return NO_STORAGE;
    }
  }

  return { tasks: tasksHandler, status: statusHandler };
}
