/**
 * Worker lifetime in standard mode (design v8 I2b, ticket #7).
 *
 * One real DSH process, one Lead and two real continuable subagents:
 *
 *   - subagent A claims t2, writes, releases it, then is refused t3: its one
 *     lifetime binding has already ended (released);
 *   - subagent B, a NEW instance, claims the same t2 and gets a NEW execution
 *     id, and A's ended record is untouched;
 *   - the Lead is exempt from the lifetime rule: it claims, releases and
 *     claims again across three tasks, producing three distinct execution ids.
 *
 * The Lead holds a spawn seat while spawning a subagent because spawning is a
 * class A tool; that seat is released immediately, so it never overlaps a
 * subagent's claim. Refusals and ids are observed where they happened: every
 * session's real tool results, plus the tree file on disk.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'worker-lifetime-standard';
export const summary = 'Standard mode: a subagent holds one task for life, a new subagent retries it, and the Lead is exempt';
export const team = false;
export const prompt = 'Prove Worker lifetime: a subagent releases task one and is refused task two, a new subagent retries the same task with a new execution id, and the Lead does three tasks with three ids. Use "prove worker lifetime" as the approval basis.';

const APPROVED_TASK = (title, summary, status = 'in_progress') => ({
  op: 'create',
  title,
  summary,
  executionApproval: 'approved',
  approvalBasis: 'prove worker lifetime',
  status,
});

export const program = [
  // 1. t1 is the Lead's spawn seat, t2/t3 are the subagent tasks. Spawning a
  //    subagent is class A, so the Lead must hold an execution while it spawns.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove Worker lifetime (standard mode)' },
        APPROVED_TASK('Spawn seat', 'held by the Lead only while spawning'),
        APPROVED_TASK('Subagent task one', 'claimed and released by the first subagent'),
        APPROVED_TASK('Subagent task two', 'the released subagent may not claim it'),
      ],
    },
  },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't1' }] } },
  {
    tool: 'subagent',
    arguments: {
      description: 'first worker',
      prompt: 'Wait for an assignment, then claim task t2, release it, and try task t3.',
    },
  },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1' }] } },
  {
    waitForSubagentTurns: 1,
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'assign', id: 't2', member: '{{subagentId}}' },
        { op: 'assign', id: 't3', member: '{{subagentId}}' },
      ],
    },
  },
  {
    tool: 'send_message',
    arguments: {
      agent_id: '{{subagentId}}',
      message: 'Claim t2, write child-a.txt, release t2, then try to claim t3 and report what the tools answered.',
    },
  },
  // 2. Second subagent: the retry of the SAME task needs a new instance. The
  //    Lead claims its spawn seat again while spawning, then releases it.
  { waitForSubagentTurns: 2, tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't1' }] } },
  {
    tool: 'subagent',
    arguments: {
      description: 'second worker',
      prompt: 'Wait for an assignment, then claim the task you are given.',
    },
  },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1' }] } },
  {
    waitForSubagentTurns: 1,
    tool: 'task_tree_write',
    arguments: { ops: [{ op: 'assign', id: 't2', member: '{{subagentId}}' }] },
  },
  {
    tool: 'send_message',
    arguments: {
      agent_id: '{{subagentId}}',
      message: 'Claim t2, write child-b.txt, release t2, and report the execution id.',
    },
  },
  { waitForSubagentTurns: 2, tool: 'task_tree_read', arguments: {} },
  // 3. The Lead is exempt: three sequential tasks, three execution ids.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        APPROVED_TASK('Lead task one', 'the Lead does tasks serially'),
        { op: 'claim', id: 't4' },
        { op: 'release', id: 't4' },
      ],
    },
  },
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        APPROVED_TASK('Lead task two', 'the Lead does tasks serially'),
        { op: 'claim', id: 't5' },
        { op: 'release', id: 't5' },
      ],
    },
  },
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        APPROVED_TASK('Lead task three', 'the Lead does tasks serially'),
        { op: 'claim', id: 't6' },
        { op: 'release', id: 't6' },
      ],
    },
  },
  { tool: 'task_tree_read', arguments: {} },
  { text: 'worker lifetime exercised' },
];

export const subagentProgram = [
  // Subagent A, turn 1 (spawned): wait for its assignment.
  { text: 'ready for an assignment' },
  // Subagent A, turn 2: claim, write, release, then try a second task.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't2' }] } },
  { tool: 'write', arguments: { file_path: 'child-a.txt', content: 'the first subagent held t2\n' } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't2' }] } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't3' }] } },
  { text: 'released t2 and was refused t3' },
  // Subagent B, turn 1 (spawned): wait for its assignment.
  { text: 'ready for an assignment' },
  // Subagent B, turn 2: claim the same task as a new Worker instance.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't2' }] } },
  { tool: 'write', arguments: { file_path: 'child-b.txt', content: 'the second subagent retried t2\n' } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't2' }] } },
  { text: 'retried t2 as a new Worker' },
];

/** One session record from the in-process transcript, by origin. */
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

/** The subagent session that wrote one witness file. */
function subagentWriting(sessions, filePath) {
  return sessions.find((session) => (session.calls ?? []).some((call) => call.tool === 'write'
    && call.input?.file_path === filePath
    && call.status === 'completed'));
}

/** The parsed `{ ok, applied }` payload a task_tree_write call returned. */
function outcomeOf(call) {
  if (call === undefined) return undefined;
  let text = call.result;
  if (Array.isArray(text)) {
    text = text.filter((block) => block?.type === 'text').map((block) => block.text).join('');
  }
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The execution id a claim call returned, if any. */
function executionIdOf(call) {
  const outcome = outcomeOf(call);
  const applied = Array.isArray(outcome?.applied) ? outcome.applied : [];
  return applied.find((entry) => typeof entry.executionId === 'string')?.executionId;
}

function readPayload(call) {
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
  const lead = leadOf(sessions);
  const workerA = subagentWriting(sessions, 'child-a.txt');
  const workerB = subagentWriting(sessions, 'child-b.txt');
  check(assertions, 'the run produced a Lead and two distinct subagent sessions',
    lead !== undefined && workerA !== undefined && workerB !== undefined
    && workerA.sessionId !== lead?.sessionId && workerB.sessionId !== lead?.sessionId
    && workerA?.sessionId !== workerB?.sessionId,
    `lead=${lead?.sessionId} a=${workerA?.sessionId} b=${workerB?.sessionId}`);
  if (lead === undefined || workerA === undefined || workerB === undefined) return assertions;

  // 1. Worker A claimed t2, released it, then could not claim t3.
  const claimA = callMatching(workerA, 'task_tree_write', (input) => Array.isArray(input.ops)
    && input.ops.some((op) => op.op === 'claim' && op.id === 't2'));
  const releaseA = callMatching(workerA, 'task_tree_write', (input) => Array.isArray(input.ops)
    && input.ops.some((op) => op.op === 'release' && op.id === 't2'));
  const claimSecondA = callMatching(workerA, 'task_tree_write', (input) => Array.isArray(input.ops)
    && input.ops.some((op) => op.op === 'claim' && op.id === 't3'));
  check(assertions, 'subagent A claimed t2', claimA?.status === 'completed',
    `status=${claimA?.status} result=${JSON.stringify(claimA?.result)}`);
  check(assertions, 'subagent A released t2', releaseA?.status === 'completed', `status=${releaseA?.status}`);
  check(assertions, 'a released subagent cannot claim a second task',
    claimSecondA?.status === 'error'
    && typeof claimSecondA.result === 'string'
    && claimSecondA.result.includes('only one task in its lifetime')
    && claimSecondA.result.includes('NEW Worker instance'),
    claimSecondA === undefined ? 'no second claim call' : `status=${claimSecondA.status} result=${JSON.stringify(claimSecondA.result)}`);

  // 2. Worker B, a new instance, claimed the SAME task with a new id.
  const claimB = callMatching(workerB, 'task_tree_write', (input) => Array.isArray(input.ops)
    && input.ops.some((op) => op.op === 'claim' && op.id === 't2'));
  check(assertions, 'a new subagent instance claimed the released t2', claimB?.status === 'completed',
    `status=${claimB?.status} result=${JSON.stringify(claimB?.result)}`);
  check(assertions, 'the new subagent wrote while holding t2',
    (await exists(workdir, 'child-b.txt')) === 'the second subagent retried t2\n', 'child-b.txt');

  // 3. The Lead is exempt: three tasks, three ids.
  const leadTaskClaims = callsOf(lead, 'task_tree_write')
    .filter((call) => Array.isArray(call.input?.ops) && call.input.ops.some((op) => op.op === 'claim' && ['t4', 't5', 't6'].includes(op.id)))
    .map(executionIdOf);
  check(assertions, 'the Lead did three sequential tasks with three distinct execution ids',
    leadTaskClaims.length === 3 && leadTaskClaims.every((id) => typeof id === 'string') && new Set(leadTaskClaims).size === 3,
    JSON.stringify(leadTaskClaims));

  // 4. The tree file: both subagent records ended, keyed by session id.
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
  const workers = tree?.workline?.workers !== null && typeof tree?.workline?.workers === 'object' ? tree.workline.workers : {};
  const t2Executions = executions.filter((execution) => execution.taskId === 't2');
  const exA = t2Executions.find((execution) => execution.sessionId === workerA.sessionId);
  const exB = t2Executions.find((execution) => execution.sessionId === workerB.sessionId);
  check(assertions, 'the retry of t2 is a second execution with its own id',
    t2Executions.length === 2
    && typeof exA?.executionId === 'string' && typeof exB?.executionId === 'string'
    && exA.executionId !== exB.executionId
    && exB.attempt === 2
    && exA.state === 'ended' && exA.endReason === 'released'
    && exB.state === 'ended' && exB.endReason === 'released',
    JSON.stringify(t2Executions.map((execution) => [execution.executionId, execution.sessionId, execution.attempt, execution.state, execution.endReason])));
  check(assertions, 'each subagent has one ended lifetime record keyed by its session id',
    workers[workerA.sessionId]?.state === 'ended'
    && workers[workerA.sessionId]?.boundTaskId === 't2'
    && workers[workerA.sessionId]?.executionId === exA?.executionId
    && workers[workerB.sessionId]?.state === 'ended'
    && workers[workerB.sessionId]?.boundTaskId === 't2'
    && workers[workerB.sessionId]?.executionId === exB?.executionId,
    JSON.stringify(Object.fromEntries(Object.entries(workers).map(([sessionId, worker]) => [sessionId, [worker.state, worker.boundTaskId, worker.executionId]]))));
  check(assertions, 'the Lead has no lifetime record (it is exempt)',
    workers[lead.sessionId] === undefined,
    JSON.stringify(Object.keys(workers)));
  check(assertions, 'the Lead\'s three executions belong to the Lead session and are all ended',
    leadTaskClaims.length === 3
    && leadTaskClaims.every((id) => executions.some((execution) => execution.executionId === id
      && execution.sessionId === lead.sessionId
      && execution.state === 'ended')),
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.sessionId, execution.state])));

  // 5. The read view: t3 was never claimed, and both subagent bindings are over.
  const read = readPayload(callMatching(lead, 'task_tree_read', () => true));
  const readTasks = Array.isArray(read?.tasks) ? read.tasks : [];
  check(assertions, 'the tree read shows t2 and t3 with no active executor',
    readTasks.find((task) => task.id === 't2')?.executor === null
    && readTasks.find((task) => task.id === 't3')?.executor === null,
    JSON.stringify(readTasks.map((task) => [task.id, task.status, task.executor])));

  return assertions;
}
