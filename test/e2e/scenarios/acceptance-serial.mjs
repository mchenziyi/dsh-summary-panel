/**
 * Acceptance: standard mode works a parent's three sub-tasks one at a time
 * (ticket #11; design v8 I3, §5).
 *
 * The user-visible promise: in the standard mode the whole workline has ONE
 * execution seat, so while one sub-task is being worked on the next one cannot
 * start, and the persisted tree never shows two sub-tasks in progress at once.
 *
 * One real DSH process, one Lead and no Agent Team. The Lead creates a delivery
 * task with three sub-tasks, then works them in order:
 *
 *   1. claim t2, write; try to claim t3 -> refused by the single seat, and the
 *      read still shows only t2 in progress and t3 pending;
 *   2. complete t2; claim t3, write; try to claim t4 -> refused the same way;
 *   3. complete t3; claim t4, write; complete t4;
 *   4. mark the delivery task in progress again ("waiting for the user's
 *      acceptance"), which is the only in-progress task left.
 *
 * The assertions are user-visible facts only: what each tool call returned,
 * what the task tree said at each checkpoint (the tool reads the persisted
 * record), and the tree file on disk. No internal function is inspected.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'acceptance-serial';
export const summary = 'Acceptance, standard mode: a parent with three sub-tasks runs them one at a time — the next cannot start until the previous is done';
export const team = false;
export const prompt = 'Accept standard-mode serial execution: work the three sub-tasks of one delivery task in order, refusing the next until the previous is done. Use "prove serial execution" as the approval basis.';

const BASIS = 'prove serial execution';

/** One sub-task of the delivery task; a child of an approved parent inherits approval. */
const STEP = (title, summary) => ({ op: 'create', parentId: 't1', title, summary });

/** One class A write of the task's file. */
const writeStep = (file, content) => ({ tool: 'write', arguments: { file_path: file, content } });

/** A checkpoint: the tree as the tool read it from the persisted record. */
const checkpoint = () => ({ tool: 'task_tree_read', arguments: {} });

/** Start the next sub-task: the status change and its claim in one atomic batch. */
const startStep = (id) => ({
  tool: 'task_tree_write',
  arguments: { ops: [{ op: 'update', id, status: 'in_progress' }, { op: 'claim', id }] },
});

export const program = [
  // 1. One delivery task with three sub-tasks; nothing has started.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Ship the delivery one sub-task at a time' },
        {
          op: 'create',
          title: 'Ship the delivery',
          summary: 'the delivery task whose three sub-tasks must run in order',
          executionApproval: 'approved',
          approvalBasis: BASIS,
        },
        STEP('Step one', 'the first sub-task; the only one that may run'),
        STEP('Step two', 'must wait until step one is done'),
        STEP('Step three', 'must wait until step two is done'),
      ],
    },
  },
  checkpoint(),
  // 2. Step one runs alone.
  startStep('t2'),
  writeStep('step-one.txt', 'step one was written while it was the only running task\n'),
  checkpoint(),
  // 3. Step two cannot start while step one is in progress.
  startStep('t3'),
  checkpoint(),
  // 4. Step one is done; step two now starts, and step three is refused.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'complete', id: 't2', result: 'step one done' }] } },
  startStep('t3'),
  writeStep('step-two.txt', 'step two was written while it was the only running task\n'),
  checkpoint(),
  startStep('t4'),
  checkpoint(),
  // 5. Step two is done; step three runs and finishes.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'complete', id: 't3', result: 'step two done' }] } },
  startStep('t4'),
  writeStep('step-three.txt', 'step three was written while it was the only running task\n'),
  checkpoint(),
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'complete', id: 't4', result: 'step three done' }] } },
  checkpoint(),
  // 6. The delivery waits for the user's acceptance; it is the only task left
  //    in progress.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [{
        op: 'update',
        id: 't1',
        status: 'in_progress',
        progress: 'The three sub-tasks are done; waiting for the user to accept the delivery.',
      }],
    },
  },
  checkpoint(),
  { text: 'standard-mode serial execution exercised' },
];

/** Every session record from the in-process transcript. */
function sessionsOf(artefacts) {
  return artefacts.toolTranscript?.present === true ? artefacts.toolTranscript.sessions : [];
}

/** Calls of one tool in one session, in call order. */
function callsOf(session, tool) {
  return (session?.calls ?? []).filter((call) => call.tool === tool);
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

/** The tasks a read returned, or [] when it did not answer with a tree. */
function tasksOf(read) {
  return Array.isArray(read?.tasks) ? read.tasks : [];
}

/** The ids of the tasks a read showed as `in_progress`. */
function inProgress(read) {
  return tasksOf(read).filter((task) => task.status === 'in_progress').map((task) => task.id);
}

/** The status of one task in a read. */
function statusOf(read, id) {
  return tasksOf(read).find((task) => task.id === id)?.status;
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

/** A single-seat refusal names the in-flight execution and the task that holds it. */
function isSeatRefusal(call, otherTaskId) {
  return call?.status === 'error'
    && typeof call.result === 'string'
    && call.result.includes('already holds execution')
    && call.result.includes(`task ${otherTaskId}`);
}

export async function verify({ artefacts, workdir }) {
  const assertions = [];
  const sessions = sessionsOf(artefacts);
  const lead = sessions.find((session) => session.header?.origin !== 'subagent');
  check(assertions, 'the run produced one real Lead session', lead !== undefined && sessions.length === 1,
    `sessions=${sessions.map((session) => session.sessionId).join(',')}`);
  if (lead === undefined) return assertions;

  const writes = callsOf(lead, 'task_tree_write');
  const checks = callsOf(lead, 'task_tree_read').map(payloadOf);
  const refusals = writes.filter((call) => call.status === 'error');

  // 1. The checkpoints: never two sub-tasks in progress, and each sub-task is
  //    the only one in progress exactly while it is being worked on.
  const working = [checks[1], checks[2], checks[3], checks[4], checks[5]].filter((read) => read !== undefined);
  check(assertions, 'the run took five checkpoints while the delivery was being worked on',
    working.length === 5, `checkpoints=${checks.length}`);
  check(assertions, 'no checkpoint ever showed two tasks in progress',
    checks.every((read) => inProgress(read).length <= 1),
    JSON.stringify(checks.map((read) => inProgress(read))));
  check(assertions, 'while step one ran it was the only task in progress',
    JSON.stringify(inProgress(checks[1])) === JSON.stringify(['t2'])
    && statusOf(checks[1], 't3') === 'pending' && statusOf(checks[1], 't4') === 'pending',
    JSON.stringify(checks[1]?.tasks?.map((task) => [task.id, task.status])));
  check(assertions, 'the refused step two left the tree at step one only',
    JSON.stringify(inProgress(checks[2])) === JSON.stringify(['t2'])
    && statusOf(checks[2], 't3') === 'pending',
    JSON.stringify(checks[2]?.tasks?.map((task) => [task.id, task.status])));
  check(assertions, 'while step two ran it was the only task in progress and step one was done',
    JSON.stringify(inProgress(checks[3])) === JSON.stringify(['t3'])
    && statusOf(checks[3], 't2') === 'done',
    JSON.stringify(checks[3]?.tasks?.map((task) => [task.id, task.status])));
  check(assertions, 'the refused step three left the tree at step two only',
    JSON.stringify(inProgress(checks[4])) === JSON.stringify(['t3'])
    && statusOf(checks[4], 't4') === 'pending',
    JSON.stringify(checks[4]?.tasks?.map((task) => [task.id, task.status])));
  check(assertions, 'while step three ran it was the only task in progress',
    JSON.stringify(inProgress(checks[5])) === JSON.stringify(['t4']),
    JSON.stringify(checks[5]?.tasks?.map((task) => [task.id, task.status])));

  // 2. The second (and third) sub-task really could not start early: the tool
  //    refused the whole batch, naming the execution and the task in flight.
  const refusedTwo = writes.find((call) => Array.isArray(call.input?.ops)
    && call.input.ops.some((op) => op.op === 'update' && op.id === 't3'));
  const refusedThree = writes.find((call) => Array.isArray(call.input?.ops)
    && call.input.ops.some((op) => op.op === 'update' && op.id === 't4'));
  check(assertions, 'step two was refused while step one held the single execution seat',
    isSeatRefusal(refusedTwo, 't2'), refusedTwo === undefined ? 'no step two call' : `status=${refusedTwo.status} ${refusedTwo.result}`);
  check(assertions, 'step three was refused while step two held the single execution seat',
    isSeatRefusal(refusedThree, 't3'), refusedThree === undefined ? 'no step three call' : `status=${refusedThree.status} ${refusedThree.result}`);
  check(assertions, 'every work-batch refusal was a single-seat refusal (nothing else was refused)',
    refusals.length === 2 && refusals.every((call) => isSeatRefusal(call, call === refusedTwo ? 't2' : 't3')),
    `refusals=${refusals.length}`);

  // 3. Class A work happened only while holding the seat, in order.
  for (const [file, content] of [
    ['step-one.txt', 'step one was written while it was the only running task\n'],
    ['step-two.txt', 'step two was written while it was the only running task\n'],
    ['step-three.txt', 'step three was written while it was the only running task\n'],
  ]) {
    const call = callsOf(lead, 'write').find((candidate) => candidate.input?.file_path === file);
    check(assertions, `the worker wrote ${file} while it held the seat`,
      call?.status === 'completed' && (await exists(workdir, file)) === content,
      call === undefined ? 'no write call' : `status=${call.status}`);
  }

  // 4. The persisted tree: each sub-task got exactly one execution, they ran in
  //    order, and they are all ended when the run finishes.
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];
  const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
  check(assertions, 'the tree file on disk is the one the last read showed',
    artefacts.taskTree.present === true
    && JSON.stringify(checks[7]?.tasks?.map((task) => [task.id, task.status]))
      === JSON.stringify(tasks.map((task) => [task.id, task.status])),
    JSON.stringify({ present: artefacts.taskTree.present, path: artefacts.taskTree.path }));
  check(assertions, 'each sub-task has its own ended execution, in the order they ran',
    executions.length === 3
    && JSON.stringify(executions.map((execution) => execution.taskId)) === JSON.stringify(['t2', 't3', 't4'])
    && executions.every((execution) => execution.state === 'ended' && execution.endReason === 'completed')
    && executions.every((execution) => execution.sessionId === lead.sessionId)
    && new Set(executions.map((execution) => execution.executionId)).size === 3
    && executions[0].startedAt <= executions[1].startedAt
    && executions[1].startedAt <= executions[2].startedAt
    && executions[0].endedAt <= executions[1].startedAt
    && executions[1].endedAt <= executions[2].startedAt,
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.taskId, execution.startedAt, execution.endedAt, execution.endReason])));
  check(assertions, 'every sub-task execution was the first attempt and each task is done with no owner',
    executions.every((execution) => execution.attempt === 1)
    && ['t2', 't3', 't4'].every((id) => tasks.find((task) => task.id === id)?.status === 'done'
      && tasks.find((task) => task.id === id)?.owner === null),
    JSON.stringify(tasks.map((task) => [task.id, task.status, task.owner])));
  check(assertions, 'the delivery task waits for the user: in progress, no execution, acceptance required',
    tasks.find((task) => task.id === 't1')?.status === 'in_progress'
    && tasks.find((task) => task.id === 't1')?.owner === null
    && tasks.find((task) => task.id === 't1')?.requiresUserAcceptance === true
    && tasks.find((task) => task.id === 't2')?.requiresUserAcceptance === false,
    JSON.stringify(tasks.map((task) => [task.id, task.status, task.owner, task.requiresUserAcceptance])));
  check(assertions, 'the final read shows only the delivery task in progress',
    JSON.stringify(inProgress(checks[7])) === JSON.stringify(['t1']),
    JSON.stringify(checks[7]?.tasks?.map((task) => [task.id, task.status])));
  check(assertions, 'the Lead never held more than one execution: the ledger has no parallel rows',
    executions.filter((execution) => execution.state !== 'ended').length === 0,
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.state])));
  return assertions;
}
