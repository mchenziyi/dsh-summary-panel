/**
 * Kill the process in the window between a Team-board commit and the Reins
 * ledger write (ticket #8).
 *
 * The board appends and flushes its `team/task` event inside the tool body, so
 * a successful `team_task_update {action:"claim"}` is already durable when
 * post-execute listeners run. Reins binds that claim to an execution in its own
 * post-execute listener; this fixture is inserted BEFORE the plugin under test
 * in the profile patch, so its listener runs first and the SIGKILL lands
 * exactly between "board committed" and "ledger written".
 *
 * This is the crash a restart must reconcile, produced without any test-only
 * branch in the product: the fixture owns no product state and only kills the
 * process it runs in.
 */

export const name = 'e2e-crash-injector';

export function apply(ctx, config = {}) {
  const tool = typeof config.tool === 'string' && config.tool !== '' ? config.tool : 'team_task_update';
  const action = typeof config.action === 'string' && config.action !== '' ? config.action : undefined;
  let fired = false;
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const name = exec !== null && typeof exec === 'object' ? exec.name : undefined;
    const invoked = exec !== null && typeof exec === 'object' ? exec.arguments?.action : undefined;
    // Only a call the board actually committed reaches the crash window: a
    // refusal (stale revision, guarded claim) never wrote anything to cut in
    // half.
    const committed = result !== null && typeof result === 'object' && result.isError !== true;
    if (committed && !fired && name === tool && (action === undefined || invoked === action)) {
      fired = true;
      const label = action === undefined ? tool : `${tool} ${action}`;
      console.error(`[e2e-crash-injector] SIGKILL after ${label} committed to the Team board, before the ledger write`);
      process.kill(process.pid, 'SIGKILL');
    }
    return next();
  });
}
