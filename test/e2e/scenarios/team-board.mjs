/**
 * Prove the team-board artefact: the profile composes the real Agent Team, a
 * scripted session creates a board task through the shipped team tool, and the
 * fixture probe exports the live board (team state is in-memory only, so it
 * cannot be read back from disk after the process exits).
 */

export const name = 'team-board';
export const summary = 'A real Agent Team board task is exported from the live process';
export const team = true;
export const prompt = 'Create one Team task on the board, then list it.';
export const program = [
  { tool: 'team_task_create', arguments: { subject: 'board smoke', description: 'prove the team board export' } },
  { tool: 'team_task_list', arguments: {} },
  { text: 'team task created' },
];

export function verify({ artefacts }) {
  const board = artefacts.teamBoard;
  const created = artefacts.toolResults.calls.find((call) => call.tool === 'team_task_create');
  const result = [
    {
      label: 'the team_task_create tool call completed',
      ok: created !== undefined && created.status === 'completed',
      detail: created === undefined ? 'no team_task_create call in the run' : `status=${created.status}`,
    },
    {
      label: 'the live Team board was exported',
      ok: board.present === true,
      detail: board.present === true ? `${board.tasks?.length ?? 0} task(s), ${board.members?.length ?? 0} member(s)` : board.reason,
    },
  ];
  if (board.present === true) {
    result.push({
      label: 'the board holds the scripted task',
      ok: Array.isArray(board.tasks) && board.tasks.some((task) => task.subject === 'board smoke' && task.status === 'pending'),
      detail: Array.isArray(board.tasks) ? board.tasks.map((task) => `${task.id}:${task.subject}:${task.status}`).join(', ') : 'no tasks',
    });
    result.push({
      label: 'the Lead is the only member',
      ok: Array.isArray(board.members) && board.members.length === 1 && board.members[0].role === 'lead',
      detail: Array.isArray(board.members) ? board.members.map((member) => `${member.name}:${member.role}`).join(', ') : 'no members',
    });
  }
  return result;
}
