/**
 * Claim evidence: only a Worker's own claim creates an execution (design v8
 * §6.1, §7.1, I12; ticket #8).
 *
 * One real team-mode run proves the two ends of the evidence rule:
 *
 *   (a) a task that was only DISPATCHED creates no execution — the Worker that
 *       never claimed holds no class A permission and the ledger stays empty for
 *       it, even though the board task exists;
 *   (b) the claim that DID happen wrote its intent to the journal BEFORE the
 *       board call, bound exactly one execution AFTER the board committed, and
 *       the ledger row carries the roster session id and the revision the board
 *       actually returned;
 *   (c) that Worker's own board completion ends its execution (and its one
 *       lifetime binding), leaving the task in progress for the Lead to accept.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'execution-evidence';
export const summary = 'Dispatch creates no execution; only the Worker\'s claim does, and its completion ends it';
export const team = true;
export const prompt = 'Prove that an execution comes only from a real claim: dispatch two tasks, let one worker claim and complete its task, and let the other only be dispatched. Use "prove execution evidence" as the approval basis.';

const APPROVED_TASK = (title, summary) => ({
  op: 'create',
  title,
  summary,
  executionApproval: 'approved',
  approvalBasis: 'prove execution evidence',
});

export const program = [
  // 1. Two board tasks, both pending at revision 1.
  { tool: 'team_task_create', arguments: { subject: 'evidence one', description: 'claimed and completed by worker-a' } },
  { tool: 'team_task_create', arguments: { subject: 'evidence two', description: 'dispatched to worker-b, never claimed' } },
  // 2. The tree owns the user-side tasks and the routing record.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove execution evidence' },
        APPROVED_TASK('Claimed task', 'worker-a claims and completes it'),
        APPROVED_TASK('Dispatched only', 'worker-b never claims it'),
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
  // 3. worker-b is dispatched but never claims: it holds nothing.
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-b',
      description: 'dispatched to task-2 but never claims it',
      prompt: 'Try to write dispatched-only.txt without claiming anything, then report.',
    },
  },
  { waitForTeammate: 'worker-b', tool: 'team_task_list', arguments: {} },
  // 4. worker-a claims its board task, writes, then completes the board task.
  {
    tool: 'spawn_teammate',
    arguments: {
      name: 'worker-a',
      description: 'claims task-1, writes, then completes it',
      prompt: 'Claim task-1, write evidence-bound.txt, then complete task-1 and report.',
    },
  },
  { waitForTeammate: 'worker-a', tool: 'team_task_list', arguments: {} },
  { tool: 'task_tree_read', arguments: { details: true } },
  { text: 'execution evidence exercised' },
];

export const teamResponses = {
  'worker-b': [
    // (a) No claim, so no execution, so no class A permission.
    { tool: 'write', arguments: { file_path: 'dispatched-only.txt', content: 'must not land\n' } },
    // It never claims task-2: dispatch alone must not create an execution.
    { text: 'worker-b was only dispatched' },
  ],
  'worker-a': [
    { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 1, action: 'claim' } },
    { tool: 'write', arguments: { file_path: 'evidence-bound.txt', content: 'worker-a held task-1\n' } },
    { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 2, action: 'complete' } },
    // (c) The ended execution takes the class A permission with it.
    { tool: 'write', arguments: { file_path: 'after-complete.txt', content: 'must not land\n' } },
    { text: 'worker-a claimed and completed task-1' },
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

function taskOf(tree, id) {
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];
  return tasks.find((task) => task.id === id);
}

function executionsOf(tree) {
  return Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
}

function journalEntries(artefacts) {
  return artefacts.claimJournal?.present === true && Array.isArray(artefacts.claimJournal.entries)
    ? artefacts.claimJournal.entries
    : [];
}

export async function verify({ artefacts, workdir }) {
  const assertions = [];
  const sessions = sessionsOf(artefacts);
  const lead = leadOf(sessions);
  const workerA = sessionClaiming(sessions, 'task-1');
  const workerB = sessions.find((session) => session.sessionId !== lead?.sessionId && session.sessionId !== workerA?.sessionId);
  check(assertions, 'the run produced a Lead and two teammate sessions',
    lead !== undefined && workerA !== undefined && workerB !== undefined,
    `lead=${lead?.sessionId} worker-a=${workerA?.sessionId} worker-b=${workerB?.sessionId}`);
  if (lead === undefined || workerA === undefined || workerB === undefined) return assertions;

  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const executions = executionsOf(tree);
  const board = artefacts.teamBoard;
  const boardTasks = board.present === true && Array.isArray(board.tasks) ? board.tasks : [];
  const boardTask = (id) => boardTasks.find((task) => task.id === id);

  // (a) Dispatch alone creates nothing.
  const t2 = taskOf(tree, 't2');
  check(assertions, 'the dispatched-only task has no execution and no holder',
    t2 !== undefined && t2.owner === null && t2.dispatch?.member === 'worker-b'
    && executions.every((execution) => execution.taskId !== 't2'),
    JSON.stringify({ task: t2 === undefined ? 'missing' : [t2.status, t2.owner, t2.dispatch], executions: executions.map((execution) => execution.taskId) }));
  check(assertions, 'its board task is still pending and unowned',
    boardTask('task-2')?.status === 'pending' && boardTask('task-2')?.ownerName === undefined,
    JSON.stringify(boardTasks.map((task) => [task.id, task.status, task.ownerName])));
  const unboundWrite = callMatching(workerB, 'write', () => true);
  check(assertions, 'the never-claiming Worker is refused every class A tool',
    unboundWrite?.status === 'error'
    && typeof unboundWrite.result === 'string'
    && unboundWrite.result.includes('holds no active execution'),
    unboundWrite === undefined ? 'no write call' : `status=${unboundWrite.status} result=${JSON.stringify(unboundWrite.result)}`);
  check(assertions, 'the dispatch-only task stayed dispatch-only on the board too',
    callsOf(workerB, 'team_task_update').length === 0,
    `${callsOf(workerB, 'team_task_update').length} board calls`);
  check(assertions, 'the write that was never authorised left nothing on disk',
    (await exists(workdir, 'dispatched-only.txt')) === undefined,
    'dispatched-only.txt');

  // (b) The claim that happened is backed by the journal and the board.
  const execution = executions.find((entry) => entry.taskId === 't1');
  check(assertions, 'exactly one execution exists, and it belongs to the claiming Worker',
    executions.length === 1
    && execution !== undefined
    && execution.mode === 'team'
    && execution.sessionId === workerA.sessionId
    && execution.member === 'worker-a'
    && execution.claimRevision === 2,
    JSON.stringify(executions.map((entry) => [entry.executionId, entry.taskId, entry.sessionId, entry.member, entry.state])));
  check(assertions, 'the execution is tied to the claim call that created it',
    typeof execution?.requestId === 'string' && execution.requestId !== ''
    && typeof execution?.rebuiltFrom !== 'string',
    JSON.stringify({ requestId: execution?.requestId, rebuiltFrom: execution?.rebuiltFrom ?? null }));
  const journal = journalEntries(artefacts);
  const prepared = journal.filter((entry) => entry.state === 'prepared');
  const settled = journal.filter((entry) => entry.state === 'committed');
  check(assertions, 'the intent was durable before the board call and settled once after it',
    prepared.length === 1
    && prepared[0].taskId === 't1'
    && prepared[0].member === 'worker-a'
    && prepared[0].sessionId === workerA.sessionId
    && prepared[0].revisionBefore === 1
    && settled.length === 1
    && settled[0].requestId === prepared[0].requestId
    && settled[0].executionId === execution?.executionId,
    JSON.stringify(journal));

  // (c) The Worker's own board completion ends the execution and its lifetime.
  check(assertions, 'the completed task\'s execution is ended by the board completion',
    execution?.state === 'ended' && execution.endReason === 'completed',
    JSON.stringify(execution));
  const t1 = taskOf(tree, 't1');
  check(assertions, 'the task keeps waiting for the Lead with no execution stamp',
    t1 !== undefined && t1.owner === null && t1.status === 'in_progress' && t1.dispatch === null,
    JSON.stringify(t1 === undefined ? 'missing' : [t1.status, t1.owner, t1.dispatch]));
  const workers = tree?.workline?.workers !== null && typeof tree?.workline?.workers === 'object' ? tree.workline.workers : {};
  check(assertions, 'the Worker lifetime record ends with the execution',
    workers[workerA.sessionId]?.state === 'ended'
    && workers[workerA.sessionId]?.endReason === 'completed'
    && workers[workerA.sessionId]?.executionId === execution?.executionId,
    JSON.stringify(workers[workerA.sessionId]));
  check(assertions, 'the board task is completed and still names its owner',
    boardTask('task-1')?.status === 'completed' && boardTask('task-1')?.ownerName === 'worker-a',
    JSON.stringify(boardTasks.map((task) => [task.id, task.status, task.ownerName])));
  const afterComplete = callMatching(workerA, 'write', (input) => input.file_path === 'after-complete.txt');
  check(assertions, 'the ended Worker lost class A immediately',
    afterComplete?.status === 'error'
    && typeof afterComplete.result === 'string'
    && afterComplete.result.includes('holds no active execution'),
    afterComplete === undefined ? 'no write call' : `status=${afterComplete.status} result=${JSON.stringify(afterComplete.result)}`);
  check(assertions, 'the workline recorded no conflict for an ordinary claim',
    (Array.isArray(tree?.workline?.conflicts) ? tree.workline.conflicts : []).length === 0,
    JSON.stringify(tree?.workline?.conflicts ?? []));
  return assertions;
}
