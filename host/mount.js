/**
 * Mount the task-tree feature onto the summary-panel plugin.
 *
 * index.js keeps its existing read-only routes and calls this once; the task
 * tree adds two GET routes, two agent tools, one prompt section, the execution
 * gate (a monotonic tool guard), and the Team claim binding (an awaited
 * post-execute observer). Every part degrades independently: a storage failure
 * only surfaces as `available: false`, a missing tool registry or prompt
 * service skips that part, and nothing here may fail the plugin load
 * (CONTRACT.md §6).
 */

import { createTaskStore } from './store.js';
import { createSessionSupport } from './session.js';
import { createTaskHandlers } from './routes.js';
import { registerTaskTreeTools } from './tools.js';
import { registerTaskTreePrompt } from './prompt.js';
import { registerExecutionGuard } from './guard.js';
import { createSeatTable, registerSeatObservers } from './reservation.js';
import { registerTeamClaimBinding } from './binding.js';

/**
 * @param ctx - the plugin context.
 * @param options - `{ route, root, env, logger }`; `route` is index.js's exact
 * GET-route helper, `root` overrides the storage directory (tests).
 * @returns the mounted parts and their registration status.
 */
export function mountTaskTree(ctx, options = {}) {
  const logger = options.logger ?? console;
  const route = options.route;
  const store = createTaskStore({ root: options.root, env: options.env, logger });
  const sessions = createSessionSupport(ctx);
  const handlers = createTaskHandlers({ store, sessions });

  if (typeof route === 'function') {
    route(ctx, '/tasks', handlers.tasks);
    route(ctx, '/tasks/status', handlers.status);
  }

  let tools = false;
  try {
    tools = registerTaskTreeTools(ctx, { store, sessions });
  } catch (error) {
    logger.warn(`[summary-panel] task tree tools disabled: ${String(error?.message ?? error)}`);
  }

  // The concurrency seats are taken by the guard and released by real
  // end-of-call evidence (a matching tool result, or the owning agent going
  // idle). The table is in-process only: an index, not a fact source.
  const seats = createSeatTable({ logger });
  let seatObservers = false;
  try {
    seatObservers = registerSeatObservers(ctx, { seats, logger });
  } catch (error) {
    logger.warn(`[summary-panel] seat observers disabled: ${String(error?.message ?? error)}`);
  }

  // The execution gate is registered after the tools it protects. It is a
  // monotonic guard, so it runs before dispatch and cannot be out-voted by a
  // pre-execute listener. It only seats calls when the end-of-call observers
  // are live: a reservation nothing can release would wedge every later claim.
  let guard = false;
  try {
    guard = registerExecutionGuard(ctx, { store, seats: seatObservers ? seats : undefined });
  } catch (error) {
    logger.warn(`[summary-panel] execution gate disabled: ${String(error?.message ?? error)}`);
  }

  // Team claim-first binding: the Worker's own board claim is what the Host
  // turns into an execution. It is a post-execute observer, so a failed binding
  // never rewrites the board's committed result.
  let binding = false;
  try {
    binding = registerTeamClaimBinding(ctx, { store, logger });
  } catch (error) {
    logger.warn(`[summary-panel] team claim binding disabled: ${String(error?.message ?? error)}`);
  }

  let prompt = false;
  try {
    prompt = registerTaskTreePrompt(ctx, { store });
  } catch (error) {
    logger.warn(`[summary-panel] task tree prompt disabled: ${String(error?.message ?? error)}`);
  }

  return { store, seats, tools, prompt, guard, binding, seatObservers };
}
