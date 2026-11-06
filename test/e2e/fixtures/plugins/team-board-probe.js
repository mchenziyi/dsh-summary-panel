/**
 * Export the live Agent Team board from inside the running DSH process.
 *
 * Team state is in-memory only: once the `dsh` process exits there is nothing
 * on disk to read, so the board has to be captured while the process is alive.
 * This fixture plugin writes its last snapshot to `config.out` at every turn
 * end; a profile without the Agent Team writes that there is none.
 */

import { writeFileSync } from 'node:fs';

export const name = 'e2e-team-probe';

/** The agent whose session produced this event, if it is still live. */
function liveAgent(ctx, session) {
  const agents = ctx.get('agents');
  const list = agents !== undefined && typeof agents.list === 'function' ? agents.list() : [];
  return list.find((candidate) => candidate.session === session || candidate.session?.id === session?.id || candidate.id === session?.id);
}

export function apply(ctx, config = {}) {
  const write = (value) => {
    try {
      writeFileSync(config.out, `${JSON.stringify(value, null, 2)}\n`);
    } catch {
      /* probe output must never break the run */
    }
  };
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    const teams = ctx.get('agentTeams');
    if (teams === undefined) {
      write({ present: false, reason: 'no agentTeams service in this profile' });
      return;
    }
    const agent = liveAgent(ctx, session);
    if (agent === undefined) {
      write({ present: false, reason: 'no live agent for this session' });
      return;
    }
    try {
      write({
        present: true,
        members: typeof teams.listMembers === 'function' ? teams.listMembers(agent) : undefined,
        tasks: teams.listTasks(agent),
      });
    } catch (error) {
      write({ present: false, reason: String(error?.message ?? error) });
    }
  });
}
