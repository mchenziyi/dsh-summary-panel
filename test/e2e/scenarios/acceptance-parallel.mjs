/**
 * Acceptance: team mode runs three independent sub-tasks in parallel on three
 * Workers (ticket #11; design v8 I3/I4/I2b, §6, §7.2).
 *
 * The user-visible promise: the Lead only coordinates, each Worker binds exactly
 * one task by claiming its own Team-board task, and the three Workers really run
 * at the same time instead of taking turns.
 *
 * One real DSH process with the real Agent Team and three real named teammates:
 *
 *   1. the Lead creates three Team-board tasks and three tree tasks, and
 *      dispatches one to each Worker (routing only — no owner, no execution);
 *   2. the three Workers are spawned; each first holds its own turn while the
 *      Lead is still coordinating, so the Lead's own `list_agents` observation
 *      shows all three of them running at the same moment — genuine overlap,
 *      not three sequential runs;
 *   3. each Worker then claims its own board task (which is what binds the
 *      execution) and writes its file; the tree ends with three active
 *      executions, one per Worker, and no dispatch left;
 *   4. the Lead never holds an execution: its own class A write is refused.
 *
 * Assertions use only user-visible facts: what the tool calls returned (the
 * transcript follows every session), the live Team board, and the persisted
 * tree file. No internal function is inspected.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'acceptance-parallel';
export const summary = 'Acceptance, team mode: three Workers hold three different tasks and are observed running at the same instant';
export const team = true;
export const prompt = 'Accept team-mode parallel execution: three independent sub-tasks, three Workers each bound to exactly one task, genuinely running at the same time. Use "prove three workers in parallel" as the approval basis.';

const BASIS = 'prove three workers in parallel';

/** One dispatched sub-task: approved work routed to the Worker that should claim it. */
const TASK = (title, summary) => ({
  op: 'create',
  title,
  summary,
  executionApproval: 'approved',
  approvalBasis: BASIS,
});

/** The three Workers and the board task each one owns. */
const WORKERS = [
  { name: 'worker-a', board: 'task-1', file: 'worker-a.txt', marker: 'worker-a holds its own task\n' },
  { name: 'worker-b', board: 'task-2', file: 'worker-b.txt', marker: 'worker-b holds its own task\n' },
  { name: 'worker-c', board: 'task-3', file: 'worker-c.txt', marker: 'worker-c holds its own task\n' },
];

export const program = [
  // 1. Three independent Team-board tasks.
  { tool: 'team_task_create', arguments: { subject: 'parallel one', description: 'claimed by worker-a' } },
  { tool: 'team_task_create', arguments: { subject: 'parallel two', description: 'claimed by worker-b' } },
  { tool: 'team_task_create', arguments: { subject: 'parallel three', description: 'claimed by worker-c' } },
  // 2. The tree owns the user-side tasks and the routing records.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Run three independent sub-tasks in parallel' },
        TASK('Parallel one', 'worker-a claims and works on it'),
        TASK('Parallel two', 'worker-b claims and works on it'),
        TASK('Parallel three', 'worker-c claims and works on it'),
        { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
        { op: 'dispatch', id: 't2', member: 'worker-b', teamTaskId: 'task-2' },
        { op: 'dispatch', id: 't3', member: 'worker-c', teamTaskId: 'task-3' },
      ],
    },
  },
  // 3. Three real teammates, each holding its first turn long enough for the
  //    Lead to observe all three running at once.
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-a',
      description: 'claims and works on task-1',
      prompt: 'Claim task-1 at revision 1, write worker-a.txt, then report.',
    },
  },
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-b',
      description: 'claims and works on task-2',
      prompt: 'Claim task-2 at revision 1, write worker-b.txt, then report.',
    },
  },
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-c',
      description: 'claims and works on task-3',
      prompt: 'Claim task-3 at revision 1, write worker-c.txt, then report.',
    },
  },
  // 4. The Lead observes the roster while all three Workers are in their held
  //    turn. These tool results are the overlap evidence.
  { waitForMemberStatus: { name: 'worker-a', status: 'running' }, tool: 'list_agents', arguments: {} },
  { waitForMemberStatus: { name: 'worker-b', status: 'running' }, tool: 'list_agents', arguments: {} },
  { waitForMemberStatus: { name: 'worker-c', status: 'running' }, tool: 'list_agents', arguments: {} },
  // 5. Wait until each Worker's whole scripted turn is done (its own board
  //    claim is what bound the execution; the write came in the same turn).
  { waitForTeammate: 'worker-a', tool: 'team_task_list', arguments: {} },
  { waitForTeammate: 'worker-b', tool: 'team_task_list', arguments: {} },
  { waitForTeammate: 'worker-c', tool: 'team_task_list', arguments: {} },
  // 6. The tree now shows three holders, one per Worker.
  { tool: 'task_tree_read', arguments: {} },
  // 7. The Lead is a pure coordinator: it cannot do class A work even though
  //    its Workers are busy.
  { tool: 'write', arguments: { file_path: 'lead-during-parallel.txt', content: 'the Lead must not write\n' } },
  { text: 'team-mode parallel execution exercised' },
];

/**
 * Each teammate claims its own board task first, then writes. The first turn is
 * held so the Lead's `list_agents` can see all three running together; the
 * second turn is held so the three writes also overlap.
 */
export const teamResponses = Object.fromEntries(WORKERS.map((worker, index) => [worker.name, [
  {
    tool: 'team_task_update',
    arguments: { task_id: worker.board, expected_revision: 1, action: 'claim' },
    holdMs: 7000 - index * 500,
  },
  {
    tool: 'write',
    arguments: { file_path: worker.file, content: worker.marker },
    holdMs: 2000,
  },
  { text: `${worker.name} finished its one task` },
]]));

/** Every session record from the in-process transcript. */
function sessionsOf(artefacts) {
  return artefacts.toolTranscript?.present === true ? artefacts.toolTranscript.sessions : [];
}

/** Calls of one tool in one session, in call order. */
function callsOf(session, tool) {
  return (session?.calls ?? []).filter((call) => call.tool === tool);
}

/** One call addressed by its own input, so repeated tools never collide. */
function callMatching(session, tool, match) {
  return callsOf(session, tool).find((call) => match(call.input ?? {}));
}

/** The parsed payload a tool call returned, or undefined. */
function payloadOf(call) {
  if (call === undefined || typeof call.result !== 'string') return undefined;
  try {
    return JSON.parse(call.result);
  } catch {
    return undefined;
  }
}

/** The `list_agents` rows a call returned, or [] when it answered nothing. */
function rosterOf(call) {
  const payload = payloadOf(call);
  return Array.isArray(payload) ? payload : [];
}

/** The Worker session that successfully claimed one board task. */
function sessionClaiming(sessions, boardTaskId) {
  return sessions.find((session) => (session.calls ?? []).some((call) => call.tool === 'team_task_update'
    && call.input?.action === 'claim'
    && call.input?.task_id === boardTaskId
    && call.status === 'completed'));
}

/** Read one file in the session workspace, or undefined when absent. */
async function exists(workdir, path) {
  try {
    return await readFile(join(workdir, path), 'utf8');
  } catch {
    return undefined;
  }
}

function check(assertions, label, ok, detail) {
  assertions.push({ label, ok, detail });
}

export async function verify({ artefacts, workdir }) {
  const assertions = [];
  const sessions = sessionsOf(artefacts);
  const lead = sessions.find((session) => session.header?.origin !== 'subagent');
  const owners = WORKERS.map((worker) => ({
    ...worker,
    session: sessionClaiming(sessions, worker.board),
  }));
  check(assertions, 'the run produced a Lead and three distinct teammate sessions',
    lead !== undefined
    && owners.every((owner) => owner.session !== undefined && owner.session.sessionId !== lead.sessionId)
    && new Set(owners.map((owner) => owner.session?.sessionId)).size === 3,
    `lead=${lead?.sessionId} workers=${owners.map((owner) => owner.session?.sessionId).join(',')}`);
  if (lead === undefined || owners.some((owner) => owner.session === undefined)) return assertions;
  // 1. Genuine overlap: one roster observation, taken while the Lead was
  //    coordinating, shows all three Workers running at the same moment.
  const rosters = callsOf(lead, 'list_agents');
  const snapshots = rosters.map((call) => rosterOf(call));
  const allRunning = snapshots.find((rows) => WORKERS.every((worker) => rows.some((row) => row.target === worker.name
    && row.role === 'teammate' && row.status === 'running')));
  check(assertions, 'the Lead observed all three Workers running at the same instant',
    allRunning !== undefined,
    snapshots.map((rows) => rows.filter((row) => row.role === 'teammate')
      .map((row) => `${row.target}:${row.status}`).join(' ')).join(' | '));

  // 2. Each Worker bound exactly one task through its own board claim.
  const claims = sessions.flatMap((session) => callsOf(session, 'team_task_update')
    .filter((call) => call.input?.action === 'claim'));
  check(assertions, 'exactly three board claims were made and all succeeded',
    claims.length === 3 && claims.every((call) => call.status === 'completed'),
    claims.map((call) => `${call.input?.task_id}:${call.status}`).join(' '));
  check(assertions, 'each Worker claimed a different board task',
    new Set(claims.map((call) => call.input?.task_id)).size === 3,
    claims.map((call) => call.input?.task_id).join(','));
  for (const owner of owners) {
    const claim = callMatching(owner.session, 'team_task_update',
      (input) => input.action === 'claim' && input.task_id === owner.board);
    check(assertions, `${owner.name} claimed ${owner.board} from its own session`,
      claim?.status === 'completed', `status=${claim?.status}`);
    const write = callMatching(owner.session, 'write', (input) => input.file_path === owner.file);
    check(assertions, `${owner.name} could write while bound to ${owner.board}`,
      write?.status === 'completed' && (await exists(workdir, owner.file)) === owner.marker,
      write === undefined ? 'no write call' : `status=${write.status}`);
  }

  // 3. The Lead is refused class A work in team mode.
  const leadWrite = callMatching(lead, 'write', (input) => input.file_path === 'lead-during-parallel.txt');
  check(assertions, 'the Lead cannot do class A work while its Workers run',
    leadWrite?.status === 'error' && typeof leadWrite.result === 'string'
    && leadWrite.result.includes('only coordinates'),
    leadWrite === undefined ? 'no Lead write call' : `status=${leadWrite.status} ${leadWrite.result}`);
  check(assertions, 'the refused Lead write left nothing on disk',
    (await exists(workdir, 'lead-during-parallel.txt')) === undefined, 'lead-during-parallel.txt');

  // 4. The persisted tree: three simultaneous active executions, one per task.
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];
  const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
  const workers = tree?.workline?.workers !== null && typeof tree?.workline?.workers === 'object' ? tree.workline.workers : {};
  check(assertions, 'the tree has three non-terminal executions, all active',
    executions.length === 3 && executions.every((execution) => execution.state === 'active' && execution.mode === 'team'),
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.taskId, execution.sessionId, execution.state])));
  check(assertions, 'each execution belongs to one different Worker on one different task',
    new Set(executions.map((execution) => execution.executionId)).size === 3
    && new Set(executions.map((execution) => execution.taskId)).size === 3
    && new Set(executions.map((execution) => execution.sessionId)).size === 3,
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.taskId, execution.sessionId])));
  for (const owner of owners) {
    const task = tasks.find((candidate) => candidate.id === `t${WORKERS.findIndex((worker) => worker.name === owner.name) + 1}`);
    const execution = executions.find((candidate) => candidate.taskId === task?.id);
    check(assertions, `${owner.name} owns its tree task through its own execution`,
      task?.status === 'in_progress'
      && task?.owner?.sessionId === owner.session.sessionId
      && task?.owner?.member === owner.name
      && task?.dispatch === null
      && task?.teamTaskId === owner.board
      && execution?.sessionId === owner.session.sessionId
      && execution?.executionId === task?.owner?.executionId,
      JSON.stringify({ task: task?.id, status: task?.status, owner: task?.owner, dispatch: task?.dispatch }));
    check(assertions, `${owner.name} keeps its one bound lifetime record`,
      workers[owner.session.sessionId]?.state === 'bound'
      && workers[owner.session.sessionId]?.boundTaskId === task?.id
      && workers[owner.session.sessionId]?.executionId === task?.owner?.executionId,
      JSON.stringify(workers[owner.session.sessionId]));
  }
  check(assertions, 'the Lead holds no execution and no lifetime record',
    executions.every((execution) => execution.sessionId !== lead.sessionId) && workers[lead.sessionId] === undefined,
    JSON.stringify(Object.keys(workers)));
  check(assertions, 'no execution has ended: the three ran side by side and are still held',
    executions.every((execution) => execution.state !== 'ended'),
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.state, execution.endReason])));

  // 5. The live Team board agrees with the tree.
  const board = artefacts.teamBoard?.present === true ? artefacts.teamBoard : undefined;
  const boardTasks = Array.isArray(board?.tasks) ? board.tasks : [];
  check(assertions, 'the Team board shows the three tasks in progress under the three Workers',
    boardTasks.filter((task) => task.status === 'in_progress').length === 3
    && WORKERS.every((worker) => {
      const row = boardTasks.find((task) => task.id === worker.board);
      return row?.status === 'in_progress' && row?.ownerName === worker.name && row?.revision === 2;
    }),
    JSON.stringify(boardTasks.map((task) => [task.id, task.status, task.ownerName, task.revision])));
  check(assertions, 'the final read shows each sub-task with its own executor',
    (() => {
      const read = payloadOf(callsOf(lead, 'task_tree_read')[0]);
      const rows = Array.isArray(read?.tasks) ? read.tasks : [];
      return WORKERS.every((worker, index) => {
        const row = rows.find((candidate) => candidate.id === `t${index + 1}`);
        return row?.status === 'in_progress' && row?.owner === true
          && row?.executor?.name === worker.name && row?.executorLost === false;
      });
    })(),
    JSON.stringify(payloadOf(callsOf(lead, 'task_tree_read')[0])?.tasks?.map((row) => [row.id, row.status, row.executor?.name])));
  return assertions;
}
