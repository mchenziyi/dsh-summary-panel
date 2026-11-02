/**
 * Mount the task-tree feature onto the summary-panel plugin.
 *
 * index.js keeps its existing read-only routes and calls this once; the task
 * tree adds two GET routes, two agent tools, and one prompt section. Every part
 * degrades independently: a storage failure only surfaces as
 * `available: false`, a missing tool registry or prompt service skips that
 * part, and nothing here may fail the plugin load (CONTRACT.md §6).
 */

import { createTaskStore } from './store.js';
import { createSessionSupport } from './session.js';
import { createTaskHandlers } from './routes.js';
import { registerTaskTreeTools } from './tools.js';
import { registerTaskTreePrompt } from './prompt.js';

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

  let prompt = false;
  try {
    prompt = registerTaskTreePrompt(ctx);
  } catch (error) {
    logger.warn(`[summary-panel] task tree prompt disabled: ${String(error?.message ?? error)}`);
  }

  return { store, tools, prompt };
}
