/**
 * Team mode: claim-first binding (design v8 §6, §7.2; ticket #6).
 *
 * The Lead dispatches a tree task to a named Worker; the Worker claims the
 * associated Team-board task itself; only that claim creates the execution, and
 * only then may the Worker modify the workspace. One real process proves:
 *
 *   (a) an unbound Worker's `write` is refused;
 *   (b) after its own claim, that Worker writes, while another member's write
 *       for that task is refused;
 *   (c) the tree task turns `in_progress` and carries its roster-resolved
 *       executor;
 *   (d) `team_task_update reassign` is refused outright;
 *   (e) a model-supplied identity field (`owner`) is not trusted: the dispatch
 *       names the roster member, and the ledger stores the session id the
 *       Host resolved from the live Agent, never the argument.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'team-bind';
export const summary = 'Team claim-first binding: a dispatched Worker claims the board, then only it may write';
export const team = true;
export const prompt = 'Prove team-mode claim-first binding: dispatch two tasks to two workers, let each claim its own board task, then verify writes and refusal of reassign. Use "prove team claim binding" as the approval basis.';

const APPROVED_TASK = (title, summary) => ({
  op: 'create',
  title,
  summary,
  executionApproval: 'approved',
  approvalBasis: 'prove team claim binding',
});

export const program = [
  // 1. Two Team-board tasks, both pending at revision 1.
  { tool: 'team_task_create', arguments: { subject: 'binding one', description: 'task-1 must be claimed by worker-a' } },
  { tool: 'team_task_create', arguments: { subject: 'binding two', description: 'task-2 must be claimed by worker-b' } },
  // 2. The tree owns the user-side tasks and the routing record.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove team claim-first binding' },
        APPROVED_TASK('Binding one', 'routed to worker-a'),
        APPROVED_TASK('Binding two', 'routed to worker-b'),
      ],
    },
  },
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
        { op: 'dispatch', id: 't2', member: 'worker-b', teamTaskId: 'task-2' },
      ],
    },
  },
  // 3. The Lead cannot claim at all in team mode: only a Worker's own board
  //    claim creates an execution.
  { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 1, action: 'claim' } },
  // 4. Two real teammates, each with its own scripted program. worker-b runs
  //    first so its forged-identity attempt meets task-1 while it is still
  //    pending and its dispatch is still present.
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-b',
      description: 'the Worker dispatched to task-2',
      prompt: 'Write worker-b-unbound.txt, then try to claim task-1 at revision 2 passing owner worker-a, write worker-b-task1.txt, then claim task-2 at revision 1, write worker-b-bound.txt, and report.',
    },
  },
  { waitForTeammate: 'worker-b', tool: 'team_task_list', arguments: {} },
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-a',
      description: 'the Worker dispatched to task-1',
      prompt: 'Write worker-a-unbound.txt, then claim shared task task-1 at revision 1, write worker-a-bound.txt, then report.',
    },
  },
  // 5. Wait for the second teammate, then prove reassign is dead and read the tree.
  { waitForTeammate: 'worker-a', tool: 'team_task_list', arguments: {} },
  { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 2, action: 'reassign', owner: 'worker-b' } },
  { tool: 'task_tree_read', arguments: {} },
  { tool: 'write', arguments: { file_path: 'lead-bind.txt', content: 'the lead must not write\n' } },
  { text: 'team claim binding exercised' },
];

export const teamResponses = {
  'worker-a': [
    // (a) unbound: no execution yet.
    { tool: 'write', arguments: { file_path: 'worker-a-unbound.txt', content: 'must not land\n' } },
    // Its own board claim is the binding.
    { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 1, action: 'claim' } },
    // (b) bound: now it may modify the workspace.
    { tool: 'write', arguments: { file_path: 'worker-a-bound.txt', content: 'worker-a holds task-1\n' } },
    // Another Worker's task is not its to claim.
    { tool: 'team_task_update', arguments: { task_id: 'task-2', expected_revision: 1, action: 'claim' } },
    { text: 'worker-a bound to task-1' },
  ],
  'worker-b': [
    // (a) unbound.
    { tool: 'write', arguments: { file_path: 'worker-b-unbound.txt', content: 'must not land\n' } },
    // (e) a model-supplied identity field is not trusted: the guard resolves
    // this caller through the roster, sees it is worker-b, and refuses.
    { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 2, action: 'claim', owner: 'worker-a' } },
    // (b) still unbound, so it cannot write for the task worker-a holds.
    { tool: 'write', arguments: { file_path: 'worker-b-task1.txt', content: 'must not land\n' } },
    // Its own claim.
    { tool: 'team_task_update', arguments: { task_id: 'task-2', expected_revision: 1, action: 'claim' } },
    { tool: 'write', arguments: { file_path: 'worker-b-bound.txt', content: 'worker-b holds task-2\n' } },
    { text: 'worker-b bound to task-2' },
  ],
};

/** Every session record from the in-process transcript. */
function sessionsOf(artefacts) {
  return artefacts.toolTranscript?.present === true ? artefacts.toolTranscript.sessions : [];
}

function leadOf(sessions) {
  return sessions.find((session) => session.header?.origin !== 'subagent');
}

/** Calls of one tool in one session, in call order. */
function callsOf(session, tool) {
  return (session?.calls ?? []).filter((call) => call.tool === tool);
}

/** One call addressed by its own input, so repeated tools never collide. */
function callMatching(session, tool, match) {
  return callsOf(session, tool).find((call) => match(call.input ?? {}));
}

/** The session that successfully claimed one board task (the Worker identity). */
function sessionClaiming(sessions, taskId) {
  return sessions.find((session) => (session.calls ?? []).some((call) => call.tool === 'team_task_update'
    && call.input?.action === 'claim'
    && call.input?.task_id === taskId
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

/** The parsed JSON a task_tree_read call returned. */
function readPayload(call) {
  if (call === undefined || typeof call.result !== 'string') return undefined;
  try {
    return JSON.parse(call.result);
  } catch {
    return undefined;
  }
}

export async function verify({ artefacts, workdir }) {
  const assertions = [];
  const sessions = sessionsOf(artefacts);
  const lead = leadOf(sessions);
  const workerA = sessionClaiming(sessions, 'task-1');
  const workerB = sessionClaiming(sessions, 'task-2');
  check(assertions, 'the run produced a Lead and two teammate sessions',
    lead !== undefined && workerA !== undefined && workerB !== undefined,
    `lead=${lead?.sessionId} worker-a=${workerA?.sessionId} worker-b=${workerB?.sessionId}`);
  if (lead === undefined || workerA === undefined || workerB === undefined) return assertions;
  check(assertions, 'the workers are real child sessions, not the Lead',
    workerA.sessionId !== lead.sessionId && workerB.sessionId !== lead.sessionId && workerA.sessionId !== workerB.sessionId,
    `${workerA.sessionId} / ${workerB.sessionId}`);

  // 2. The Lead dispatched both tasks as routing only.
  const dispatch = callMatching(lead, 'task_tree_write', (input) => Array.isArray(input.ops)
    && input.ops.some((op) => op.op === 'dispatch'));
  check(assertions, 'the Lead dispatched both tree tasks to named Workers',
    dispatch?.status === 'completed'
    && dispatch.input.ops.some((op) => op.op === 'dispatch' && op.member === 'worker-a' && op.teamTaskId === 'task-1')
    && dispatch.input.ops.some((op) => op.op === 'dispatch' && op.member === 'worker-b' && op.teamTaskId === 'task-2'),
    dispatch === undefined ? 'no dispatch call' : `status=${dispatch.status} result=${JSON.stringify(dispatch.result)}`);

  // 3. The Lead cannot claim; dispatch is not assignment.
  const leadClaim = callMatching(lead, 'team_task_update', (input) => input.action === 'claim' && input.task_id === 'task-1');
  check(assertions, 'the Lead is refused a Team-board claim',
    leadClaim?.status === 'error'
    && typeof leadClaim.result === 'string'
    && leadClaim.result.includes('Team Lead coordinates'),
    leadClaim === undefined ? 'no Lead claim call' : `status=${leadClaim.status} result=${JSON.stringify(leadClaim.result)}`);

  // (a) Unbound Workers are refused before their own claim.
  for (const [worker, path] of [['worker-a', 'worker-a-unbound.txt'], ['worker-b', 'worker-b-unbound.txt']]) {
    const session = worker === 'worker-a' ? workerA : workerB;
    const call = callMatching(session, 'write', (input) => input.file_path === path);
    check(assertions, `${worker}'s unbound write was refused`,
      call?.status === 'error' && typeof call.result === 'string' && call.result.includes('holds no active execution'),
      call === undefined ? 'no write call' : `status=${call.status} result=${JSON.stringify(call.result)}`);
    check(assertions, `the refused ${worker} write left no file`, (await exists(workdir, path)) === undefined, path);
  }

  // (b) Each Worker claimed its own board task, then wrote.
  const claimA = callMatching(workerA, 'team_task_update', (input) => input.action === 'claim' && input.task_id === 'task-1');
  const claimB = callMatching(workerB, 'team_task_update', (input) => input.action === 'claim' && input.task_id === 'task-2');
  check(assertions, 'worker-a claimed task-1 on the Team board', claimA?.status === 'completed',
    claimA === undefined ? 'no claim call' : `status=${claimA.status} result=${JSON.stringify(claimA.result)}`);
  check(assertions, 'worker-b claimed task-2 on the Team board', claimB?.status === 'completed',
    claimB === undefined ? 'no claim call' : `status=${claimB.status} result=${JSON.stringify(claimB.result)}`);
  const writeA = callMatching(workerA, 'write', (input) => input.file_path === 'worker-a-bound.txt');
  const writeB = callMatching(workerB, 'write', (input) => input.file_path === 'worker-b-bound.txt');
  check(assertions, 'worker-a could write after its own claim',
    writeA?.status === 'completed' && (await exists(workdir, 'worker-a-bound.txt')) === 'worker-a holds task-1\n',
    writeA === undefined ? 'no write call' : `status=${writeA.status}`);
  check(assertions, 'worker-b could write after its own claim',
    writeB?.status === 'completed' && (await exists(workdir, 'worker-b-bound.txt')) === 'worker-b holds task-2\n',
    writeB === undefined ? 'no write call' : `status=${writeB.status}`);

  // (b)+(e) Another member cannot take or write the first Worker's task, even
  // when it passes the first Worker's name as an identity field.
  const steal = callMatching(workerB, 'team_task_update', (input) => input.action === 'claim' && input.task_id === 'task-1');
  check(assertions, 'worker-b cannot claim task-1 that was dispatched to worker-a',
    steal?.status === 'error'
    && typeof steal.result === 'string'
    && steal.result.includes('dispatched to worker-a, not worker-b'),
    steal === undefined ? 'no steal claim call' : `status=${steal.status} result=${JSON.stringify(steal.result)}`);
  const stealWrite = callMatching(workerB, 'write', (input) => input.file_path === 'worker-b-task1.txt');
  check(assertions, 'worker-b cannot write for a task it does not hold',
    stealWrite?.status === 'error'
    && typeof stealWrite.result === 'string'
    && stealWrite.result.includes('holds no active execution'),
    stealWrite === undefined ? 'no write call' : `status=${stealWrite.status} result=${JSON.stringify(stealWrite.result)}`);
  check(assertions, 'the refused cross-member write left no file', (await exists(workdir, 'worker-b-task1.txt')) === undefined, 'worker-b-task1.txt');

  // (d) reassign is refused outright.
  const reassign = callMatching(lead, 'team_task_update', (input) => input.action === 'reassign');
  check(assertions, 'the Lead reassign is refused',
    reassign?.status === 'error'
    && typeof reassign.result === 'string'
    && reassign.result.includes('reassign is refused')
    && reassign.result.includes('can never be combined'),
    reassign === undefined ? 'no reassign call' : `status=${reassign.status} result=${JSON.stringify(reassign.result)}`);
  check(assertions, 'the Lead still cannot write', (await exists(workdir, 'lead-bind.txt')) === undefined
    && callMatching(lead, 'write', (input) => input.file_path === 'lead-bind.txt')?.status === 'error',
    'lead-bind.txt');

  // (c) The tree file: both tasks are in progress with their real executor, and
  // the ledger holds one team execution per task and session.
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];
  const t1 = tasks.find((task) => task.id === 't1');
  const t2 = tasks.find((task) => task.id === 't2');
  check(assertions, 'the tree shows both tasks in progress with their executor',
    t1?.status === 'in_progress' && t2?.status === 'in_progress'
    && t1.owner?.sessionId === workerA.sessionId && t1.owner?.member === 'worker-a'
    && t2.owner?.sessionId === workerB.sessionId && t2.owner?.member === 'worker-b',
    JSON.stringify(tasks.map((task) => [task.id, task.status, task.owner?.member, task.owner?.sessionId])));
  check(assertions, 'a consumed dispatch is cleared and the board association remains',
    t1?.dispatch === null && t1?.teamTaskId === 'task-1' && t2?.dispatch === null && t2?.teamTaskId === 'task-2',
    JSON.stringify(tasks.map((task) => [task.id, task.dispatch, task.teamTaskId])));
  const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
  check(assertions, 'the ledger has exactly two team executions, one per task and session',
    executions.length === 2
    && executions.every((execution) => execution.mode === 'team' && execution.state === 'active' && execution.claimRevision === 2)
    && executions.some((execution) => execution.taskId === 't1' && execution.sessionId === workerA.sessionId && execution.member === 'worker-a')
    && executions.some((execution) => execution.taskId === 't2' && execution.sessionId === workerB.sessionId && execution.member === 'worker-b'),
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.taskId, execution.sessionId, execution.member, execution.state])));
  check(assertions, 'no execution belongs to the Lead or to an argument-supplied identity',
    executions.every((execution) => execution.sessionId !== lead.sessionId)
    && executions.every((execution) => execution.sessionId === workerA.sessionId || execution.sessionId === workerB.sessionId),
    JSON.stringify(executions.map((execution) => execution.sessionId)));

  // (c) The Lead's read view shows the executor by name.
  const read = readPayload(callMatching(lead, 'task_tree_read', () => true));
  const readTasks = Array.isArray(read?.tasks) ? read.tasks : [];
  check(assertions, 'the Lead sees each tree task in progress with its executor name',
    readTasks.find((task) => task.id === 't1')?.executor?.name === 'worker-a'
    && readTasks.find((task) => task.id === 't2')?.executor?.name === 'worker-b',
    JSON.stringify(readTasks.map((task) => [task.id, task.status, task.executor])));

  // The live Team board: both claims are owned and reassign changed nothing.
  const board = artefacts.teamBoard;
  const boardTasks = board.present === true && Array.isArray(board.tasks) ? board.tasks : [];
  const board1 = boardTasks.find((task) => task.id === 'task-1');
  check(assertions, 'the Team board kept worker-a as owner of task-1 after the refused reassign',
    board1?.status === 'in_progress' && board1?.ownerName === 'worker-a' && board1?.revision === 2,
    JSON.stringify(boardTasks.map((task) => [task.id, task.status, task.ownerName, task.revision])));
  check(assertions, 'the Team board holds the Lead and both named Workers',
    board.present === true && Array.isArray(board.members)
    && board.members.length === 3
    && board.members.some((member) => member.name === 'lead' && member.role === 'lead')
    && board.members.some((member) => member.name === 'worker-a' && member.role === 'teammate')
    && board.members.some((member) => member.name === 'worker-b' && member.role === 'teammate'),
    board.present === true ? JSON.stringify(board.members?.map((member) => [member.name, member.role])) : board.reason);

  return assertions;
}
