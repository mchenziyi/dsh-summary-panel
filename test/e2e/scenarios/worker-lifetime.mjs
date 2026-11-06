/**
 * Worker lifetime: one task per Worker instance (design v8 I2b, ticket #7).
 *
 * One real DSH process, one Lead and three real named teammates:
 *
 *   - worker-a claims task-1, writes, completes it on the Team board, and then
 *     is refused task-2: its one lifetime binding has ended (completed);
 *   - worker-b claims task-2, writes, releases it, and then is refused task-3:
 *     its one lifetime binding has ended (released);
 *   - worker-c, a NEW Worker instance, claims task-2 again and gets a NEW
 *     execution id; the ended records of worker-a and worker-b are untouched;
 *   - the Lead never holds an execution in team mode.
 *
 * The refusals are observed in each session's real tool results (the harness
 * exporter follows every session, not just the Lead's); execution ids and the
 * lifetime records come from the tree file on disk.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'worker-lifetime';
export const summary = 'One task per Worker: a completed or released Worker cannot claim again; a new Worker retries with a new execution id';
export const team = true;
export const prompt = 'Prove Worker lifetime: worker-a completes task-1 and is refused task-2, worker-b releases task-2 and is refused task-3, and worker-c retries task-2 with a new execution id. Use "prove worker lifetime" as the approval basis.';

const APPROVED_TASK = (title, summary) => ({
  op: 'create',
  title,
  summary,
  executionApproval: 'approved',
  approvalBasis: 'prove worker lifetime',
});

export const program = [
  // 1. Three Team-board tasks, all pending at revision 1.
  { tool: 'team_task_create', arguments: { subject: 'lifetime one', description: 'task-1 is completed by worker-a' } },
  { tool: 'team_task_create', arguments: { subject: 'lifetime two', description: 'task-2 is retried by worker-c after worker-b releases it' } },
  { tool: 'team_task_create', arguments: { subject: 'lifetime three', description: 'task-3 tests the released worker-b' } },
  // 2. The tree owns the user-side tasks; all three start dispatched to worker-a
  //    so its attempt on task-2 is about its own lifetime, not a dispatch error.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove Worker lifetime' },
        APPROVED_TASK('Lifetime one', 'completed by worker-a'),
        APPROVED_TASK('Lifetime two', 'retried by a new Worker'),
        APPROVED_TASK('Lifetime three', 'never claimed by a released Worker'),
      ],
    },
  },
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
        { op: 'dispatch', id: 't2', member: 'worker-a', teamTaskId: 'task-2' },
        { op: 'dispatch', id: 't3', member: 'worker-a', teamTaskId: 'task-3' },
      ],
    },
  },
  // 3. worker-a: claim, write, complete, then try a second task.
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-a',
      description: 'completes task-1 and is then refused task-2',
      prompt: 'Claim task-1 at revision 1, write worker-a-bound.txt, complete task-1 at revision 2, try to write again, then try to claim task-2 at revision 1 and report.',
    },
  },
  { waitForTeammate: 'worker-a', tool: 'team_task_list', arguments: {} },
  // 4. Route task-2 and task-3 to worker-b, which releases task-2.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'dispatch', id: 't2', member: 'worker-b', teamTaskId: 'task-2' },
        { op: 'dispatch', id: 't3', member: 'worker-b', teamTaskId: 'task-3' },
      ],
    },
  },
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-b',
      description: 'releases task-2 and is then refused task-3',
      prompt: 'Claim task-2 at revision 1, write worker-b-bound.txt, release task-2 at revision 2, try to write again, then try to claim task-3 at revision 1 and report.',
    },
  },
  { waitForTeammate: 'worker-b', tool: 'team_task_list', arguments: {} },
  // 5. The retry of task-2 needs a NEW Worker instance.
  {
    tool: 'task_tree_write',
    arguments: { ops: [{ op: 'dispatch', id: 't2', member: 'worker-c', teamTaskId: 'task-2' }] },
  },
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-c',
      description: 'claims task-2 again as a new Worker',
      prompt: 'Claim task-2 at revision 3, write worker-c-bound.txt, and report the execution id.',
    },
  },
  { waitForTeammate: 'worker-c', tool: 'team_task_list', arguments: {} },
  { tool: 'task_tree_read', arguments: {} },
  { text: 'worker lifetime exercised' },
];

export const teamResponses = {
  'worker-a': [
    { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 1, action: 'claim' } },
    { tool: 'write', arguments: { file_path: 'worker-a-bound.txt', content: 'worker-a holds task-1\n' } },
    { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 2, action: 'complete' } },
    { tool: 'write', arguments: { file_path: 'worker-a-after-complete.txt', content: 'must not land\n' } },
    { tool: 'team_task_update', arguments: { task_id: 'task-2', expected_revision: 1, action: 'claim' } },
    { text: 'worker-a finished task-1' },
  ],
  'worker-b': [
    { tool: 'team_task_update', arguments: { task_id: 'task-2', expected_revision: 1, action: 'claim' } },
    { tool: 'write', arguments: { file_path: 'worker-b-bound.txt', content: 'worker-b holds task-2\n' } },
    { tool: 'team_task_update', arguments: { task_id: 'task-2', expected_revision: 2, action: 'release' } },
    { tool: 'write', arguments: { file_path: 'worker-b-after-release.txt', content: 'must not land\n' } },
    { tool: 'team_task_update', arguments: { task_id: 'task-3', expected_revision: 1, action: 'claim' } },
    { text: 'worker-b released task-2' },
  ],
  'worker-c': [
    { tool: 'team_task_update', arguments: { task_id: 'task-2', expected_revision: 3, action: 'claim' } },
    { tool: 'write', arguments: { file_path: 'worker-c-bound.txt', content: 'worker-c retried task-2\n' } },
    { text: 'worker-c retried task-2' },
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

/** The session that successfully completed one board claim of a task at a revision. */
function sessionClaiming(sessions, taskId, revision) {
  return sessions.find((session) => (session.calls ?? []).some((call) => call.tool === 'team_task_update'
    && call.input?.action === 'claim'
    && call.input?.task_id === taskId
    && call.input?.expected_revision === revision
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

/** The lifetime refusal names the one-task rule and the new-instance way out. */
function refusedForLifetime(call) {
  return call?.status === 'error'
    && typeof call.result === 'string'
    && call.result.includes('only one task in its lifetime')
    && call.result.includes('NEW Worker instance');
}

export async function verify({ artefacts, workdir }) {
  const assertions = [];
  const sessions = sessionsOf(artefacts);
  const lead = leadOf(sessions);
  const workerA = sessionClaiming(sessions, 'task-1', 1);
  const workerB = sessionClaiming(sessions, 'task-2', 1);
  const workerC = sessionClaiming(sessions, 'task-2', 3);
  check(assertions, 'the run produced a Lead and three distinct teammate sessions',
    lead !== undefined && workerA !== undefined && workerB !== undefined && workerC !== undefined
    && new Set([lead?.sessionId, workerA?.sessionId, workerB?.sessionId, workerC?.sessionId]).size === 4,
    `lead=${lead?.sessionId} a=${workerA?.sessionId} b=${workerB?.sessionId} c=${workerC?.sessionId}`);
  if (lead === undefined || workerA === undefined || workerB === undefined || workerC === undefined) return assertions;

  // 1. worker-a completed task-1 and then lost every permission.
  const claimA = callMatching(workerA, 'team_task_update', (input) => input.action === 'claim' && input.task_id === 'task-1');
  const writeA = callMatching(workerA, 'write', (input) => input.file_path === 'worker-a-bound.txt');
  const completeA = callMatching(workerA, 'team_task_update', (input) => input.action === 'complete' && input.task_id === 'task-1');
  const writeAfterComplete = callMatching(workerA, 'write', (input) => input.file_path === 'worker-a-after-complete.txt');
  const claimSecondA = callMatching(workerA, 'team_task_update', (input) => input.action === 'claim' && input.task_id === 'task-2');
  check(assertions, 'worker-a claimed task-1', claimA?.status === 'completed', `status=${claimA?.status} result=${JSON.stringify(claimA?.result)}`);
  check(assertions, 'worker-a wrote while it held task-1',
    writeA?.status === 'completed' && (await exists(workdir, 'worker-a-bound.txt')) === 'worker-a holds task-1\n', 'worker-a-bound.txt');
  check(assertions, 'worker-a completed task-1 on the Team board', completeA?.status === 'completed',
    `status=${completeA?.status} result=${JSON.stringify(completeA?.result)}`);
  check(assertions, 'worker-a lost class A the moment its execution ended',
    writeAfterComplete?.status === 'error'
    && typeof writeAfterComplete.result === 'string'
    && writeAfterComplete.result.includes('holds no active execution'),
    `status=${writeAfterComplete?.status} result=${JSON.stringify(writeAfterComplete?.result)}`);
  check(assertions, 'the refused write after completion left no file',
    (await exists(workdir, 'worker-a-after-complete.txt')) === undefined, 'worker-a-after-complete.txt');
  check(assertions, 'a completed Worker cannot claim a second task',
    refusedForLifetime(claimSecondA),
    claimSecondA === undefined ? 'no second claim call' : `status=${claimSecondA.status} result=${JSON.stringify(claimSecondA.result)}`);

  // 2. worker-b released task-2 and then lost every permission.
  const claimB = callMatching(workerB, 'team_task_update', (input) => input.action === 'claim' && input.task_id === 'task-2');
  const writeB = callMatching(workerB, 'write', (input) => input.file_path === 'worker-b-bound.txt');
  const releaseB = callMatching(workerB, 'team_task_update', (input) => input.action === 'release' && input.task_id === 'task-2');
  const writeAfterRelease = callMatching(workerB, 'write', (input) => input.file_path === 'worker-b-after-release.txt');
  const claimSecondB = callMatching(workerB, 'team_task_update', (input) => input.action === 'claim' && input.task_id === 'task-3');
  check(assertions, 'worker-b claimed task-2', claimB?.status === 'completed', `status=${claimB?.status} result=${JSON.stringify(claimB?.result)}`);
  check(assertions, 'worker-b wrote while it held task-2',
    writeB?.status === 'completed' && (await exists(workdir, 'worker-b-bound.txt')) === 'worker-b holds task-2\n', 'worker-b-bound.txt');
  check(assertions, 'worker-b released task-2 on the Team board', releaseB?.status === 'completed',
    `status=${releaseB?.status} result=${JSON.stringify(releaseB?.result)}`);
  check(assertions, 'worker-b lost class A after its release',
    writeAfterRelease?.status === 'error'
    && typeof writeAfterRelease.result === 'string'
    && writeAfterRelease.result.includes('holds no active execution'),
    `status=${writeAfterRelease?.status} result=${JSON.stringify(writeAfterRelease?.result)}`);
  check(assertions, 'the refused write after release left no file',
    (await exists(workdir, 'worker-b-after-release.txt')) === undefined, 'worker-b-after-release.txt');
  check(assertions, 'a released Worker cannot claim a second task',
    refusedForLifetime(claimSecondB),
    claimSecondB === undefined ? 'no second claim call' : `status=${claimSecondB.status} result=${JSON.stringify(claimSecondB.result)}`);

  // 3. A NEW Worker instance retries the same task.
  const claimC = callMatching(workerC, 'team_task_update', (input) => input.action === 'claim' && input.task_id === 'task-2');
  const writeC = callMatching(workerC, 'write', (input) => input.file_path === 'worker-c-bound.txt');
  check(assertions, 'a new Worker instance claimed the released task-2', claimC?.status === 'completed',
    `status=${claimC?.status} result=${JSON.stringify(claimC?.result)}`);
  check(assertions, 'the new Worker could write for the retried task',
    writeC?.status === 'completed' && (await exists(workdir, 'worker-c-bound.txt')) === 'worker-c retried task-2\n', 'worker-c-bound.txt');

  // 4. The tree file: lifetime records survive the ended executions.
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];
  const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
  const workers = tree?.workline?.workers !== null && typeof tree?.workline?.workers === 'object' ? tree.workline.workers : {};
  const exA = executions.find((execution) => execution.taskId === 't1' && execution.sessionId === workerA.sessionId);
  const exB = executions.find((execution) => execution.taskId === 't2' && execution.sessionId === workerB.sessionId);
  const exC = executions.find((execution) => execution.taskId === 't2' && execution.sessionId === workerC.sessionId);
  check(assertions, 'the ledger keeps one ended execution for each finished Worker and one active for the new one',
    exA?.state === 'ended' && exA.endReason === 'completed'
    && exB?.state === 'ended' && exB.endReason === 'released'
    && exC?.state === 'active',
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.taskId, execution.sessionId, execution.state, execution.endReason])));
  check(assertions, 'the retry got a NEW execution id for the same task, with the attempt advanced',
    typeof exC?.executionId === 'string'
    && typeof exB?.executionId === 'string'
    && exC.executionId !== exB.executionId
    && exC.attempt === 2,
    `released=${JSON.stringify(exB?.executionId)} retry=${JSON.stringify(exC?.executionId)} attempt=${exC?.attempt}`);
  check(assertions, 'the completed Worker keeps its own ended lifetime record',
    workers[workerA.sessionId]?.state === 'ended'
    && workers[workerA.sessionId]?.endReason === 'completed'
    && workers[workerA.sessionId]?.boundTaskId === 't1'
    && workers[workerA.sessionId]?.executionId === exA?.executionId,
    JSON.stringify(workers[workerA.sessionId]));
  check(assertions, 'the released Worker keeps its own ended lifetime record',
    workers[workerB.sessionId]?.state === 'ended'
    && workers[workerB.sessionId]?.endReason === 'released'
    && workers[workerB.sessionId]?.boundTaskId === 't2'
    && workers[workerB.sessionId]?.executionId === exB?.executionId,
    JSON.stringify(workers[workerB.sessionId]));
  check(assertions, 'the new Worker has its own bound lifetime record keyed by session id',
    workers[workerC.sessionId]?.state === 'bound'
    && workers[workerC.sessionId]?.boundTaskId === 't2'
    && workers[workerC.sessionId]?.executionId === exC?.executionId,
    JSON.stringify(workers[workerC.sessionId]));
  check(assertions, 'the Lead never gets a lifetime record or an execution in team mode',
    workers[lead.sessionId] === undefined
    && executions.every((execution) => execution.sessionId !== lead.sessionId),
    JSON.stringify(Object.keys(workers)));
  check(assertions, 'the tree tasks follow the executions: t1 and t2 waiting, t2 held by worker-c, t3 still pending',
    tasks.find((task) => task.id === 't1')?.owner === null
    && tasks.find((task) => task.id === 't1')?.status === 'in_progress'
    && tasks.find((task) => task.id === 't2')?.owner?.sessionId === workerC.sessionId
    && tasks.find((task) => task.id === 't2')?.status === 'in_progress'
    && tasks.find((task) => task.id === 't3')?.status === 'pending'
    && tasks.find((task) => task.id === 't3')?.owner === null,
    JSON.stringify(tasks.map((task) => [task.id, task.status, task.owner?.member, task.owner?.sessionId])));

  // 5. The read view names the new executor; the board matches the tree.
  const read = readPayload(callMatching(lead, 'task_tree_read', () => true));
  const readTasks = Array.isArray(read?.tasks) ? read.tasks : [];
  check(assertions, 'the Lead sees worker-c as the executor of the retried task',
    readTasks.find((task) => task.id === 't2')?.executor?.name === 'worker-c'
    && readTasks.find((task) => task.id === 't2')?.executor?.sessionId === workerC.sessionId,
    JSON.stringify(readTasks.map((task) => [task.id, task.executor])));

  const board = artefacts.teamBoard;
  const boardTasks = board.present === true && Array.isArray(board.tasks) ? board.tasks : [];
  const board1 = boardTasks.find((task) => task.id === 'task-1');
  const board2 = boardTasks.find((task) => task.id === 'task-2');
  const board3 = boardTasks.find((task) => task.id === 'task-3');
  check(assertions, 'the Team board shows task-1 completed, task-2 owned by worker-c, task-3 untouched',
    board1?.status === 'completed' && board1?.ownerName === 'worker-a' && board1?.revision === 3
    && board2?.status === 'in_progress' && board2?.ownerName === 'worker-c' && board2?.revision === 4
    && board3?.status === 'pending' && board3?.ownerName === undefined && board3?.revision === 1,
    JSON.stringify(boardTasks.map((task) => [task.id, task.status, task.ownerName, task.revision])));

  return assertions;
}
