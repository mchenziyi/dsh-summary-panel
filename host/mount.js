/**
 * Mount the task-tree feature onto the summary-panel plugin.
 *
 * index.js keeps its existing read-only routes and calls this once; the task
 * tree adds two GET routes, two agent tools, one prompt section, the Team claim
 * binding (an awaited post-execute observer), and the claim evidence pass (an
 * intent journal plus one reconciliation per workline). Nothing here decides
 * before a tool runs: an agent modifies the workspace whenever it wants, and
 * the tree records who is doing what for the panel to show (ADR-0003). Every
 * part degrades independently: a storage failure only surfaces as
 * `available: false`, a missing tool registry or prompt service skips that
 * part, and nothing here may fail the plugin load (CONTRACT.md §6).
 */

import { createTaskStore } from './store.js';
import { createSessionSupport } from './session.js';
import { createTaskHandlers } from './routes.js';
import { registerTaskTreeTools } from './tools.js';
import { registerTaskTreePrompt } from './prompt.js';
import { registerTeamClaimBinding } from './binding.js';
import { registerTeamExecutionEnd } from './team-lifetime.js';
import { registerEvidence } from './reconcile.js';
import { registerInterruptEvidence } from './recovery.js';

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

  // The concurrency seats and the execution gate are gone (ticket #16): nothing
  // below may refuse a tool call. The claim evidence pass does run before
  // dispatch, but only to record; every handler below is an observer.

  // Team claim-first binding: the Worker's own board claim is what the Host
  // turns into an execution. It is a post-execute observer, so a failed binding
  // never rewrites the board's committed result.
  let binding = false;
  try {
    binding = registerTeamClaimBinding(ctx, { store, logger });
  } catch (error) {
    logger.warn(`[summary-panel] team claim binding disabled: ${String(error?.message ?? error)}`);
  }

  // A Worker's own Team-board complete/release ends its execution and its one
  // lifetime binding (ticket #7). Like the binding it is a post-execute
  // observer, so a failed end never rewrites the board's committed result.
  let teamLifetime = false;
  try {
    teamLifetime = registerTeamExecutionEnd(ctx, { store, logger });
  } catch (error) {
    logger.warn(`[summary-panel] team execution end disabled: ${String(error?.message ?? error)}`);
  }

  // Interrupt evidence (ticket #10): a successful interrupt_agent records
  // interruptedAt on that worker's execution. It is not end evidence — only a
  // Lead force release may end an orphaned execution (design I16).
  let recovery = false;
  try {
    recovery = registerInterruptEvidence(ctx, { store, sessions, logger });
  } catch (error) {
    logger.warn(`[summary-panel] interrupt evidence disabled: ${String(error?.message ?? error)}`);
  }

  // Claim evidence (ticket #8): the intent journal is written before a board
  // claim, and the workline is reconciled once per process on the first tool
  // call. It is registered after the binding so that its post-execute
  // settlement sees the ledger row the binding just wrote.
  let evidence = false;
  try {
    evidence = registerEvidence(ctx, { store, sessions, logger });
  } catch (error) {
    logger.warn(`[summary-panel] claim evidence disabled: ${String(error?.message ?? error)}`);
  }

  let prompt = false;
  try {
    prompt = registerTaskTreePrompt(ctx, { store });
  } catch (error) {
    logger.warn(`[summary-panel] task tree prompt disabled: ${String(error?.message ?? error)}`);
  }

  return {
    store, tools, prompt, binding, teamLifetime, evidence, recovery,
  };
}
