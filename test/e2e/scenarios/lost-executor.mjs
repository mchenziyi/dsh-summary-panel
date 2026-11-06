/**
 * Lost executor and force termination (design v8 I0/I2b/I16, §6.3, §8.3;
 * ticket #10).
 *
 * Run 1 proves the force-termination sequence on a LIVE worker in one real DSH
 * process with the real Agent Team:
 *
 *   (a) an idle worker's execution may not be force-released: no interrupt was
 *       recorded, so the Lead's release is refused and nothing changes;
 *   (b) the Lead traps the worker in a running turn; the Host refuses the
 *       force release because the worker is still running;
 *   (c) the Lead interrupts it and confirms it is not running; the force
 *       release then succeeds: the Team board gives up ownership, the execution
 *       ends `force-terminated` and the Worker's lifetime record ends;
 *   (d) that force-terminated worker's next write is refused;
 *   (e) a NEW Worker (worker-b) is dispatched and claims the task, receiving a
 *       NEW execution id.
 *
 * Between the runs the harness deletes worker-b's persisted Session from the
 * throwaway profile. That is the state the design calls "the worker session can
 * no longer be resolved": a real loss of the session store, not a product
 * switch. Run 2 resumes the Lead and proves:
 *
 *   (f) reconciliation marks worker-b's execution `orphaned` ("executor lost")
 *       and does NOT silently release it: the stamp and the board ownership
 *       stay, and the tool/panel snapshots say `executorLost`;
 *   (g) another worker's write is refused, and it cannot take the task while
 *       the lost execution is still there;
 *   (h) after interrupt_agent (the roster still knows the durable worker) and
 *       confirmation that it is not running, the Lead force-releases it; the
 *       board is released, the execution ends, the lifetime ends and the stamp
 *       clears;
 *   (i) worker-c then claims the task and gets a third, distinct execution id.
 */

import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'lost-executor';
export const summary = 'A lost executor is marked and refused permission; only an interrupted, stopped worker is force-released; new workers get new execution ids';
export const team = true;
export const prompt = 'Prove lost executors and force termination: refuse a force release on a running worker, force-terminate it once it stopped, show the terminated worker cannot write, then lose the next worker session, see it marked "executor lost", force-release it and let a new worker take the task. Use "prove lost executor recovery" as the approval basis.';

const APPROVED_TASK = {
  op: 'create',
  title: 'Lost executor task',
  summary: 'its executor is force-terminated, then lost, then replaced',
  executionApproval: 'approved',
  approvalBasis: 'prove lost executor recovery',
};

const FIRST_RUN = [
  { tool: 'team_task_create', arguments: { subject: 'lost one', description: 'worker-a is force-terminated; worker-b then claims it' } },
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove lost executors and force termination' },
        APPROVED_TASK,
        { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
      ],
    },
  },
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-a',
      description: 'the Worker that claims, gets stuck, is interrupted and force-terminated',
      prompt: 'Claim task-1, write worker-a.txt, then wait.',
    },
  },
  // worker-a has claimed and is idle between turns: no interrupt, so a force
  // release must be refused (an idle worker is not lost and not abandoned).
  { waitForTeammate: 'worker-a', tool: 'team_task_list', arguments: {} },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1', force: true, reason: 'idle worker, no interrupt yet' }] } },
  // Trap worker-a in a turn that cannot finish, and wait until it is running.
  { tool: 'send_message', arguments: { target: 'worker-a', message: 'Hold this turn; do not finish it.' } },
  { waitForMemberStatus: { name: 'worker-a', status: 'running' }, tool: 'list_agents', arguments: {} },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1', force: true, reason: 'running worker, no interrupt yet' }] } },
  // Interrupt, confirm it stopped, then force-release it.
  { tool: 'interrupt_agent', arguments: { target: 'worker-a' } },
  { waitForMemberStatus: { name: 'worker-a', status: 'inactive' }, tool: 'list_agents', arguments: {} },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1', force: true, reason: 'worker-a was stuck and had to be force-terminated' }] } },
  // The force-terminated worker may not write again.
  { tool: 'send_message', arguments: { target: 'worker-a', message: 'Try to write again now.' } },
  { waitForTeammateTurns: { name: 'worker-a', turns: 3 }, tool: 'list_agents', arguments: {} },
  // A NEW Worker takes the same task and gets a NEW execution id.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'dispatch', id: 't1', member: 'worker-b', teamTaskId: 'task-1' }] } },
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-b',
      description: 'the Worker whose Session is lost before run 2',
      prompt: 'Claim task-1 at its current revision, write worker-b.txt, and report.',
    },
  },
  { waitForTeammate: 'worker-b', tool: 'team_task_list', arguments: {} },
  { tool: 'task_tree_read', arguments: { details: true } },
  { text: 'run one done' },
];

const SECOND_RUN = [
  // The first tool call reconciles the workline: worker-b's session is gone, so
  // its execution is marked orphaned, and this read shows "executor lost".
  { tool: 'task_tree_read', arguments: { details: true } },
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-c',
      description: 'the fresh Worker that takes the task after the lost executor is released',
      prompt: 'Try to write, then wait for a message.',
    },
  },
  // Another worker holds no permission while the lost execution still owns the
  // task: its write is refused.
  { waitForTeammate: 'worker-c', tool: 'list_agents', arguments: {} },
  // The durable roster still names worker-b, so the Lead can interrupt it and
  // confirm the Host agreed it is not running before force-releasing.
  { tool: 'interrupt_agent', arguments: { target: 'worker-b' } },
  { tool: 'list_agents', arguments: {} },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1', force: true, reason: 'worker-b session can no longer be resolved' }] } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'dispatch', id: 't1', member: 'worker-c', teamTaskId: 'task-1' }] } },
  { tool: 'send_message', arguments: { target: 'worker-c', message: 'Claim task-1 at its current revision and write worker-c.txt.' } },
  { waitForTeammateTurns: { name: 'worker-c', turns: 2 }, tool: 'list_agents', arguments: {} },
  { tool: 'task_tree_read', arguments: { details: true } },
  { text: 'run two done' },
];

/** Walk the throwaway profile and delete the persisted Session of one worker. */
async function removeSessionRecord(home, sessionId) {
  const removed = [];
  const walk = async (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() !== true) continue;
      const path = join(dir, entry.name);
      if (entry.name === sessionId) {
        removed.push(path);
        continue;
      }
      await walk(path, depth + 1);
    }
  };
  await walk(home, 0);
  for (const path of removed) await rm(path, { recursive: true, force: true });
  return removed;
}

export const runs = [
  {
    prompt,
    program: FIRST_RUN,
    teamResponses: {
      'worker-a': [
        { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 1, action: 'claim' } },
        { tool: 'write', arguments: { file_path: 'worker-a.txt', content: 'worker-a held task-1\n' } },
        { text: 'worker-a claimed task-1' },
        // A slow turn: the Agent really is running while the Lead checks it,
        // refuses the force release and interrupts it.
        { text: 'holding the turn', holdMs: 5000 },
        { tool: 'write', arguments: { file_path: 'after-force.txt', content: 'must not land\n' } },
        { text: 'worker-a tried to write after termination' },
      ],
      'worker-b': [
        { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 3, action: 'claim' } },
        { tool: 'write', arguments: { file_path: 'worker-b.txt', content: 'worker-b held task-1\n' } },
        { text: 'worker-b claimed task-1' },
      ],
    },
    after: async ({ profile, sessionId }) => {
      // The Session store of worker-b is destroyed between the runs: its
      // execution keeps saying who held the task, but nothing can resolve that
      // session any more. This is the lost-executor state, produced by losing
      // the session record, not by a product switch.
      const treePath = join(profile.taskTreeDir, `${sessionId}.json`);
      const tree = JSON.parse(await readFile(treePath, 'utf8'));
      const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
      const active = executions.filter((execution) => execution.state !== 'ended');
      const lost = active[active.length - 1];
      if (lost === undefined) throw new Error('run 1 left no non-terminal execution to lose');
      const removed = await removeSessionRecord(profile.home, lost.sessionId);
      if (removed.length === 0) throw new Error(`no persisted Session directory for ${lost.sessionId} was found`);
    },
  },
  {
    prompt: 'Restart after worker-b\'s Session was lost. Reconcile, show the executor as lost, then interrupt and force-release it before a new worker takes the task.',
    program: SECOND_RUN,
    resume: true,
    teamResponses: {
      'worker-c': [
        { tool: 'write', arguments: { file_path: 'lost-bound.txt', content: 'must not land\n' } },
        { text: 'worker-c could not write yet' },
        { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 5, action: 'claim' } },
        { tool: 'write', arguments: { file_path: 'worker-c.txt', content: 'worker-c holds task-1\n' } },
        { text: 'worker-c claimed task-1' },
      ],
    },
  },
];

function sessionsOf(artefacts) {
  return artefacts.toolTranscript?.present === true ? artefacts.toolTranscript.sessions : [];
}

function leadOf(sessions) {
  return sessions.find((session) => session.header?.origin !== 'subagent');
}

function workerOf(sessions, tool, match) {
  return sessions.find((session) => session.header?.origin === 'subagent'
    && (session.calls ?? []).some((call) => call.tool === tool && match(call.input ?? {})));
}

function callsOf(session, tool) {
  return (session?.calls ?? []).filter((call) => call.tool === tool);
}

function readPayload(call) {
  if (call === undefined || typeof call.result !== 'string') return undefined;
  try {
    return JSON.parse(call.result);
  } catch {
    return undefined;
  }
}

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

function taskOf(tree, id) {
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];
  return tasks.find((task) => task.id === id);
}

function executionsOf(tree) {
  return Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
}

function workersOf(tree) {
  return tree?.workline?.workers !== null && typeof tree?.workline?.workers === 'object' ? tree.workline.workers : {};
}

export async function verify({ runs: outcomes, workdir }) {
  const assertions = [];
  const first = outcomes[0];
  const second = outcomes[1];

  // ---- run 1: force termination of a live worker -------------------------
  const firstTree = first?.artefacts.taskTree?.present === true ? first.artefacts.taskTree.tree : undefined;
  const lead1 = leadOf(sessionsOf(first?.artefacts));
  const forceCalls = callsOf(lead1, 'task_tree_write')
    .filter((call) => Array.isArray(call.input?.ops)
      && call.input.ops.some((op) => op !== null && typeof op === 'object' && op.force === true));
  check(assertions, 'the idle-worker force release is refused because no interrupt was recorded',
    forceCalls[0]?.status === 'error' && typeof forceCalls[0].result === 'string'
    && forceCalls[0].result.includes('recorded no interrupt'),
    forceCalls[0] === undefined ? 'no force call' : `status=${forceCalls[0].status} ${forceCalls[0].result}`);
  check(assertions, 'the running worker\'s force release is refused',
    forceCalls[1]?.status === 'error' && typeof forceCalls[1].result === 'string'
    && forceCalls[1].result.includes('still running'),
    forceCalls[1] === undefined ? 'no second force call' : `status=${forceCalls[1].status} ${forceCalls[1].result}`);
  const releasedPayload = readPayload(forceCalls[2]);
  const forcedExecutionId = releasedPayload?.applied?.[0]?.executionId;
  check(assertions, 'once interrupted and stopped, the force release succeeds',
    forceCalls[2]?.status === 'completed' && typeof forcedExecutionId === 'string',
    forceCalls[2] === undefined ? 'no successful force call' : `status=${forceCalls[2].status} ${forceCalls[2].result}`);

  const executions1 = executionsOf(firstTree);
  const forced = executions1.find((execution) => execution.executionId === forcedExecutionId);
  check(assertions, 'the forced execution ended with force-terminated',
    forced !== undefined && forced.state === 'ended' && forced.endReason === 'force-terminated',
    JSON.stringify(executions1.map((execution) => [execution.executionId, execution.state, execution.endReason])));
  const terminationTask = taskOf(firstTree, 't1');
  check(assertions, 'the force release kept the task open and let a new Worker claim it',
    terminationTask?.status === 'in_progress' && terminationTask?.owner?.member === 'worker-b',
    JSON.stringify(terminationTask === undefined ? 'missing' : [terminationTask.status, terminationTask.owner]));
  const forcedWorker = Object.values(workersOf(firstTree)).find((worker) => worker.executionId === forcedExecutionId);
  check(assertions, 'the force-terminated worker\'s lifetime record ended',
    forcedWorker !== undefined && forcedWorker.state === 'ended' && forcedWorker.endReason === 'force-terminated',
    JSON.stringify(workersOf(firstTree)));

  // The force-terminated worker's next write is refused.
  const terminatedWorker = workerOf(sessionsOf(first?.artefacts), 'write',
    (input) => input.file_path === 'after-force.txt');
  const refusedWrite = callsOf(terminatedWorker, 'write')
    .find((call) => call.input?.file_path === 'after-force.txt');
  check(assertions, 'the force-terminated worker\'s next write is refused',
    refusedWrite?.status === 'error' && typeof refusedWrite.result === 'string'
    && refusedWrite.result.includes('force-terminated'),
    refusedWrite === undefined ? 'no write call' : `status=${refusedWrite.status} ${refusedWrite.result}`);
  check(assertions, 'its refused write left nothing on disk',
    (await exists(workdir, 'after-force.txt')) === undefined, 'after-force.txt');

  // A NEW worker took the task and got a NEW execution id.
  const bindExecution = executions1.filter((execution) => execution.state !== 'ended');
  check(assertions, 'a new Worker binds the task with a NEW execution id',
    bindExecution.length === 1 && bindExecution[0].executionId !== forcedExecutionId,
    JSON.stringify(executions1.map((execution) => [execution.executionId, execution.state])));
  check(assertions, 'the new Worker\'s binding is the task stamp',
    terminationTask === undefined ? false : taskOf(firstTree, 't1')?.owner?.executionId === bindExecution[0]?.executionId,
    JSON.stringify(taskOf(firstTree, 't1')?.owner));
  const board1 = first?.artefacts.teamBoard?.present === true ? first.artefacts.teamBoard : undefined;
  const boardTask1 = (board1?.tasks ?? []).find((task) => task.id === 'task-1');
  check(assertions, 'the Team board shows the new Worker owning the task',
    boardTask1?.status === 'in_progress' && boardTask1?.ownerName === 'worker-b',
    JSON.stringify((board1?.tasks ?? []).map((task) => [task.id, task.status, task.ownerName, task.revision])));

  // ---- run 2: the lost executor -----------------------------------------
  const secondTree = second?.artefacts.taskTree?.present === true ? second.artefacts.taskTree.tree : undefined;
  const executions2 = executionsOf(secondTree);
  const lostExecution = executions2.find((execution) => execution.executionId === bindExecution[0]?.executionId);

  const lead2 = leadOf(sessionsOf(second?.artefacts));
  const leadReads = callsOf(lead2, 'task_tree_read');
  const lostRead = readPayload(leadReads[0]);
  const lostRow = (lostRead?.tasks ?? []).find((row) => row.id === 't1');
  check(assertions, 'the Lead sees the task marked executor lost',
    lostRow?.executorLost === true && lostRow?.executionState === 'orphaned' && lostRow?.owner === true,
    JSON.stringify((lostRead?.tasks ?? []).map((row) => [row.id, row.owner, row.executorLost, row.executionState])));
  check(assertions, 'the lost execution is never silently released: the task still records it as owner',
    lostRow?.owner === true && lostRow?.executorLost === true && lostRow?.executionState === 'orphaned',
    JSON.stringify(lostRow));

  const workerC = workerOf(sessionsOf(second?.artefacts), 'write', (input) => input.file_path === 'lost-bound.txt');
  const lostWrite = callsOf(workerC, 'write').find((call) => call.input?.file_path === 'lost-bound.txt');
  check(assertions, 'another worker still grants no permission while the lost execution holds the task',
    lostWrite?.status === 'error' && typeof lostWrite.result === 'string'
    && lostWrite.result.includes('holds no active execution'),
    lostWrite === undefined ? 'no write call' : `status=${lostWrite.status} ${lostWrite.result}`);
  check(assertions, 'that refused write left nothing on disk',
    (await exists(workdir, 'lost-bound.txt')) === undefined, 'lost-bound.txt');

  const force2 = callsOf(lead2, 'task_tree_write')
    .filter((call) => Array.isArray(call.input?.ops)
      && call.input.ops.some((op) => op !== null && typeof op === 'object' && op.force === true));
  const lostReleased = readPayload(force2[0]);
  check(assertions, 'the Lead force-releases the lost execution once the worker is confirmed stopped',
    force2[0]?.status === 'completed' && lostReleased?.applied?.[0]?.executionId === lostExecution?.executionId,
    force2[0] === undefined ? 'no force release' : `status=${force2[0].status} ${force2[0].result}`);
  const endedLost = executionsOf(secondTree).find((execution) => execution.executionId === lostExecution?.executionId);
  check(assertions, 'the lost execution ended force-terminated and its lifetime record ended',
    endedLost?.state === 'ended' && endedLost?.endReason === 'force-terminated'
    && Object.values(workersOf(secondTree)).some((worker) => worker.executionId === lostExecution?.executionId
      && worker.state === 'ended'),
    JSON.stringify({ execution: endedLost, workers: workersOf(secondTree) }));

  const finalActive = executionsOf(secondTree).filter((execution) => execution.state !== 'ended');
  check(assertions, 'a new Worker claims the task with a third, distinct execution id',
    finalActive.length === 1 && finalActive[0].executionId !== lostExecution?.executionId,
    JSON.stringify(executionsOf(secondTree).map((execution) => [execution.executionId, execution.state])));
  const finalRead = readPayload(leadReads[leadReads.length - 1]);
  const finalRow = (finalRead?.tasks ?? []).find((row) => row.id === 't1');
  check(assertions, 'the final read shows the new executor and no lost marker',
    finalRow?.owner === true && finalRow?.executorLost === false && finalRow?.executionState === 'active'
    && finalRow?.executor?.name === 'worker-c',
    JSON.stringify((finalRead?.tasks ?? []).map((row) => [row.id, row.owner, row.executorLost, row.executor?.name])));
  const board2 = second?.artefacts.teamBoard?.present === true ? second.artefacts.teamBoard : undefined;
  const boardTask2 = (board2?.tasks ?? []).find((task) => task.id === 'task-1');
  check(assertions, 'the Team board belongs to the new Worker at the highest revision',
    boardTask2?.status === 'in_progress' && boardTask2?.ownerName === 'worker-c' && boardTask2?.revision === 6,
    JSON.stringify((board2?.tasks ?? []).map((task) => [task.id, task.status, task.ownerName, task.revision])));
  check(assertions, 'the workspace shows the new Worker did the work',
    (await exists(workdir, 'worker-c.txt')) === 'worker-c holds task-1\n', 'worker-c.txt');
  check(assertions, 'the force-terminated worker and the lost worker left no file',
    (await exists(workdir, 'worker-a.txt')) !== undefined
    && (await exists(workdir, 'worker-b.txt')) !== undefined
    && (await exists(workdir, 'after-force.txt')) === undefined
    && (await exists(workdir, 'lost-bound.txt')) === undefined,
    'worker-a.txt/worker-b.txt exist; after-force.txt/lost-bound.txt do not');
  return assertions;
}
