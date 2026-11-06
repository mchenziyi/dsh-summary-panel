/**
 * Acceptance: an abnormal Worker is replaced, and the retry gets a new
 * execution id (ticket #11; design v8 I2b/I16, §6.3, §8.3).
 *
 * The user-visible promise: when a Worker is stuck and has to be force-
 * terminated, its instance loses every permission — it cannot write and its
 * lifetime is over — and the same task can be taken over by a NEW Worker, which
 * gets a NEW execution id. The old execution keeps its ended record.
 *
 * One real DSH process with the real Agent Team:
 *
 *   1. worker-a claims its dispatched task and writes; the Lead then traps it in
 *      a long turn;
 *   2. the Host refuses a force release while worker-a is still running (a
 *      running worker is not "abandoned"), proving the termination is based on
 *      evidence rather than on a timer;
 *   3. the Lead interrupts it, confirms it is not running, and force-releases
 *      it: the Team board gives up ownership, the execution ends
 *      `force-terminated`, and worker-a's lifetime ends;
 *   4. worker-a's next write is refused and leaves no file;
 *   5. worker-b (a NEW Worker instance) is dispatched and claims the same task
 *      at the released board revision, receiving a NEW execution id.
 *
 * Assertions use only user-visible facts: what the tool calls returned (the
 * transcript follows every session), the live Team board, and the persisted
 * tree file. No internal function is inspected.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'acceptance-retry';
export const summary = 'Acceptance: a force-terminated Worker loses permission; a NEW Worker takes the same task with a NEW execution id';
export const team = true;
export const prompt = 'Accept abnormal retry: force-terminate a stuck Worker, show the old instance has no permission left, then let a new Worker take the same task with a new execution id. Use "prove abnormal retry" as the approval basis.';

const BASIS = 'prove abnormal retry';

export const program = [
  // 1. One Team-board task, dispatched to worker-a.
  { tool: 'team_task_create', arguments: { subject: 'retry one', description: 'worker-a is terminated; worker-b takes over' } },
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Replace an abnormal Worker without losing the task' },
        {
          op: 'create',
          title: 'Retry the interrupted task',
          summary: 'its first Worker is force-terminated and a new Worker takes over',
          executionApproval: 'approved',
          approvalBasis: BASIS,
        },
        { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
      ],
    },
  },
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-a',
      description: 'claims the task and is then force-terminated',
      prompt: 'Claim task-1 at revision 1, write worker-a.txt, and report.',
    },
  },
  // 2. worker-a claimed and is idle again.
  { waitForTeammate: 'worker-a', tool: 'team_task_list', arguments: {} },
  // 3. Trap it in a long turn and refuse to force-release a running worker.
  { tool: 'send_message', arguments: { target: 'worker-a', message: 'Hold this turn; do not finish it.' } },
  { waitForMemberStatus: { name: 'worker-a', status: 'running' }, tool: 'list_agents', arguments: {} },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1', force: true, reason: 'a running worker is not an abandoned one' }] } },
  // 4. Interrupt, confirm it stopped, then force-terminate it.
  { tool: 'interrupt_agent', arguments: { target: 'worker-a' } },
  { waitForMemberStatus: { name: 'worker-a', status: 'inactive' }, tool: 'list_agents', arguments: {} },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1', force: true, reason: 'worker-a was stuck and had to be force-terminated' }] } },
  // 5. The old instance must have lost the workspace.
  { tool: 'send_message', arguments: { target: 'worker-a', message: 'Try to write again now.' } },
  { waitForMemberStatus: { name: 'worker-a', status: 'running' }, tool: 'list_agents', arguments: {} },
  { waitForMemberStatus: { name: 'worker-a', status: 'inactive' }, tool: 'list_agents', arguments: {} },
  // 6. A NEW Worker takes over the same task.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'dispatch', id: 't1', member: 'worker-b', teamTaskId: 'task-1' }] } },
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-b',
      description: 'the fresh Worker that takes the released task',
      prompt: 'Claim task-1 at its current revision, write worker-b.txt, and report.',
    },
  },
  { waitForTeammate: 'worker-b', tool: 'team_task_list', arguments: {} },
  { tool: 'task_tree_read', arguments: { details: true } },
  { text: 'abnormal retry exercised' },
];

export const teamResponses = {
  'worker-a': [
    { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 1, action: 'claim' } },
    { tool: 'write', arguments: { file_path: 'worker-a.txt', content: 'worker-a holds task-1\n' } },
    { text: 'worker-a claimed task-1' },
    // The slow turn the Lead interrupts. It never finishes normally.
    { text: 'holding this turn', holdMs: 8000 },
    // After the force termination: no execution, no permission. The hold keeps
    // the Agent visibly running so the Lead can wait for it deterministically.
    { tool: 'write', arguments: { file_path: 'after-force.txt', content: 'must not land\n' }, holdMs: 1500 },
    { text: 'worker-a tried to write after termination' },
  ],
  'worker-b': [
    { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 3, action: 'claim' } },
    { tool: 'write', arguments: { file_path: 'worker-b.txt', content: 'worker-b holds task-1\n' } },
    { text: 'worker-b took the task over' },
  ],
};

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
  const workerA = sessions.find((session) => (session.calls ?? []).some((call) => call.tool === 'team_task_update'
    && call.input?.action === 'claim' && call.input?.expected_revision === 1 && call.status === 'completed'));
  const workerB = sessions.find((session) => (session.calls ?? []).some((call) => call.tool === 'team_task_update'
    && call.input?.action === 'claim' && call.input?.expected_revision === 3 && call.status === 'completed'));
  check(assertions, 'the run produced a Lead, the old Worker and a NEW Worker session',
    lead !== undefined && workerA !== undefined && workerB !== undefined
    && new Set([lead?.sessionId, workerA?.sessionId, workerB?.sessionId]).size === 3,
    `lead=${lead?.sessionId} old=${workerA?.sessionId} new=${workerB?.sessionId}`);
  if (lead === undefined || workerA === undefined || workerB === undefined) return assertions;

  // 1. The force release is evidence-based: refused while the worker runs.
  const forceCalls = callsOf(lead, 'task_tree_write')
    .filter((call) => Array.isArray(call.input?.ops)
      && call.input.ops.some((op) => op !== null && typeof op === 'object' && op.force === true));
  check(assertions, 'a running Worker cannot be force-released',
    forceCalls[0]?.status === 'error' && typeof forceCalls[0].result === 'string'
    && forceCalls[0].result.includes('still running'),
    forceCalls[0] === undefined ? 'no force release' : `status=${forceCalls[0].status} ${forceCalls[0].result}`);
  const released = payloadOf(forceCalls[1]);
  const oldExecutionId = released?.applied?.[0]?.executionId;
  check(assertions, 'once interrupted and confirmed stopped, the Lead force-terminates the Worker',
    forceCalls[1]?.status === 'completed' && typeof oldExecutionId === 'string',
    forceCalls[1] === undefined ? 'no successful force release' : `status=${forceCalls[1].status} ${forceCalls[1].result}`);

  // 2. The old instance lost every permission: its write is refused and left
  //    nothing on disk.
  const oldWrite = callMatching(workerA, 'write', (input) => input.file_path === 'after-force.txt');
  check(assertions, 'the terminated Worker cannot write any more',
    oldWrite?.status === 'error' && typeof oldWrite.result === 'string'
    && oldWrite.result.includes('force-terminated'),
    oldWrite === undefined ? 'no post-termination write' : `status=${oldWrite.status} ${oldWrite.result}`);
  check(assertions, 'its refused write left no file',
    (await exists(workdir, 'after-force.txt')) === undefined, 'after-force.txt');

  // 3. The NEW Worker took over the same task and did the work.
  const newClaim = callMatching(workerB, 'team_task_update',
    (input) => input.action === 'claim' && input.task_id === 'task-1');
  check(assertions, 'the new Worker claimed the same board task after the board was released',
    newClaim?.status === 'completed' && newClaim.input?.expected_revision === 3,
    newClaim === undefined ? 'no new claim' : `revision=${newClaim.input?.expected_revision} status=${newClaim.status}`);
  const newWrite = callMatching(workerB, 'write', (input) => input.file_path === 'worker-b.txt');
  check(assertions, 'the new Worker wrote its file while bound',
    newWrite?.status === 'completed' && (await exists(workdir, 'worker-b.txt')) === 'worker-b holds task-1\n',
    newWrite === undefined ? 'no new write' : `status=${newWrite.status}`);

  // 4. The persisted tree: the old execution is ended, the new one active, and
  //    they are different ids on the same task (a real retry).
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
  const task = (Array.isArray(tree?.tasks) ? tree.tasks : []).find((candidate) => candidate.id === 't1');
  const workers = tree?.workline?.workers !== null && typeof tree?.workline?.workers === 'object' ? tree.workline.workers : {};
  const oldExecution = executions.find((execution) => execution.executionId === oldExecutionId);
  const newExecution = executions.find((execution) => execution.state === 'active');
  check(assertions, 'the terminated execution is kept as ended force-terminated',
    oldExecution !== undefined && oldExecution.state === 'ended'
    && oldExecution.endReason === 'force-terminated'
    && oldExecution.sessionId === workerA.sessionId,
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.taskId, execution.sessionId, execution.state, execution.endReason])));
  check(assertions, 'the retry produced a NEW execution id for the same task',
    newExecution !== undefined
    && newExecution.executionId !== oldExecutionId
    && newExecution.taskId === 't1'
    && newExecution.sessionId === workerB.sessionId
    && newExecution.attempt === 2,
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.taskId, execution.attempt, execution.state])));
  check(assertions, 'the task is still open and now owned by the new Worker',
    task?.status === 'in_progress'
    && task?.owner?.sessionId === workerB.sessionId
    && task?.owner?.executionId === newExecution?.executionId
    && task?.dispatch === null,
    JSON.stringify(task === undefined ? 'missing' : { id: task.id, status: task.status, owner: task.owner, dispatch: task.dispatch }));
  check(assertions, 'the old Worker lifetime ended, the new Worker lifetime is bound',
    workers[workerA.sessionId]?.state === 'ended'
    && workers[workerA.sessionId]?.endReason === 'force-terminated'
    && workers[workerA.sessionId]?.executionId === oldExecutionId
    && workers[workerB.sessionId]?.state === 'bound'
    && workers[workerB.sessionId]?.boundTaskId === 't1'
    && workers[workerB.sessionId]?.executionId === newExecution?.executionId,
    JSON.stringify({ old: workers[workerA.sessionId], new: workers[workerB.sessionId] }));

  // 5. The user-facing read names the new executor and no lost marker.
  const read = payloadOf(callsOf(lead, 'task_tree_read')[0]);
  const row = (read?.tasks ?? []).find((candidate) => candidate.id === 't1');
  check(assertions, 'the final read shows the new Worker as the executor',
    row?.owner === true && row?.executor?.name === 'worker-b'
    && row?.executor?.sessionId === workerB.sessionId
    && row?.executorLost === false && row?.executionState === 'active',
    JSON.stringify((read?.tasks ?? []).map((candidate) => [candidate.id, candidate.owner, candidate.executor, candidate.executionState])));

  // 6. The live Team board belongs to the new Worker at the highest revision.
  const board = artefacts.teamBoard?.present === true ? artefacts.teamBoard : undefined;
  const boardTask = (board?.tasks ?? []).find((candidate) => candidate.id === 'task-1');
  check(assertions, 'the Team board is owned by the new Worker at the post-release revision',
    boardTask?.status === 'in_progress' && boardTask?.ownerName === 'worker-b' && boardTask?.revision === 4,
    JSON.stringify((board?.tasks ?? []).map((candidate) => [candidate.id, candidate.status, candidate.ownerName, candidate.revision])));

  check(assertions, 'the old Worker still wrote its file while it held the task (the work was real)',
    (await exists(workdir, 'worker-a.txt')) === 'worker-a holds task-1\n', 'worker-a.txt');
  return assertions;
}
