/**
 * Crash convergence: the Team board commits the claim, the process dies before
 * the ledger write, and a restart converges the three mirrors (design v8 §7.2,
 * §8.2, I17; ticket #8).
 *
 * The crash is real, not simulated in the product: a fixture plugin inserted
 * before the panel sends SIGKILL in the post-execute window where the board's
 * `team/task` event is already flushed and the Reins ledger is not yet written.
 * Run 1 therefore leaves exactly the state the design must reconcile:
 *
 *     board  task-1 in_progress, owner worker-a, revision 2
 *     tree   t1 dispatched, no owner, empty execution ledger
 *     journal one `prepared` claim intent, never settled
 *
 * Run 2 resumes the same Session (same workline, replayed board) and its first
 * tool call reconciles: the intent plus the revision advance plus the matching
 * owner prove the claim, so exactly one execution is rebuilt. Run 3 restarts
 * again and proves convergence is idempotent — no second execution, ever.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'crash-reconcile';
export const summary = 'Crash between board commit and ledger write converges on restart to exactly one execution';
export const team = true;
export const prompt = 'Prove crash reconciliation: the board commits the claim, the process dies before the ledger, and a restart converges to exactly one execution. Use "prove crash reconcile" as the approval basis.';
export const crash = { tool: 'team_task_update', action: 'claim' };

const FIRST_TURN = [
  { tool: 'team_task_create', arguments: { subject: 'crash one', description: 'claimed by worker-a, then the process dies' } },
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove crash reconciliation' },
        { op: 'create', title: 'Crash task', summary: 'its claim must survive a crash', executionApproval: 'approved', approvalBasis: 'prove crash reconcile' },
        { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
      ],
    },
  },
  {
    tool: 'spawn_teammate',
    arguments: { name: 'worker-a', description: 'the Worker dispatched to the crash task', prompt: 'Claim task-1, then write crash-bound.txt and report.' },
  },
  { waitForTeammate: 'worker-a', tool: 'team_task_list', arguments: {} },
  { text: 'the claim was committed; this process is about to die' },
];

export const runs = [
  {
    prompt,
    program: FIRST_TURN,
    teamResponses: {
      'worker-a': [
        // The board commit below is what the crash cuts in half: its post-execute
        // never reaches the Reins binding listener.
        { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 1, action: 'claim' } },
        { tool: 'write', arguments: { file_path: 'crash-bound.txt', content: 'worker-a held task-1\n' } },
        { text: 'worker-a claimed task-1' },
      ],
    },
    expect: 'crash',
  },
  {
    prompt: 'Restart after the crash and read the workline; the host must reconcile the mirrors.',
    program: [
      { tool: 'task_tree_read', arguments: {} },
      { tool: 'team_task_list', arguments: {} },
      { text: 'restarted and read' },
    ],
    resume: true,
  },
  {
    prompt: 'Restart a second time and read the workline again; reconciliation must not add a second execution.',
    program: [
      { tool: 'task_tree_read', arguments: {} },
      { text: 'restarted again' },
    ],
    resume: true,
  },
];

function sessionsOf(artefacts) {
  return artefacts.toolTranscript?.present === true ? artefacts.toolTranscript.sessions : [];
}

function leadOf(sessions) {
  return sessions.find((session) => session.header?.origin !== 'subagent');
}

/**
 * The session that attempted one board claim. The crash cuts the call off, so
 * in run 1 the call is 'unanswered' — its session is still the Worker whose
 * roster id the journal recorded.
 */
function sessionClaiming(sessions, taskId) {
  return sessions.find((session) => (session.calls ?? []).some((call) => call.tool === 'team_task_update'
    && call.input?.action === 'claim'
    && call.input?.task_id === taskId));
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

export async function verify({ runs: outcomes, artefacts, workdir }) {
  const assertions = [];
  const first = outcomes[0];
  const second = outcomes[1];
  const third = outcomes[2];

  // 1. The crash really happened in the window: the board committed, the ledger
  //    did not, and only an intent was on disk.
  check(assertions, 'the first run was killed between the board commit and the ledger write',
    first?.run.status !== 0 && first.run.signal === 'SIGKILL',
    `status=${first?.run.status} signal=${first?.run.signal}`);
  const firstTree = first?.artefacts.taskTree?.present === true ? first.artefacts.taskTree.tree : undefined;
  const firstTask = taskOf(firstTree, 't1');
  check(assertions, 'after the crash the tree still has the dispatch and no execution',
    firstTask !== undefined && firstTask.owner === null && firstTask.dispatch?.member === 'worker-a'
    && executionsOf(firstTree).length === 0,
    JSON.stringify({ task: firstTask === undefined ? 'missing' : [firstTask.status, firstTask.owner, firstTask.dispatch], executions: executionsOf(firstTree).length }));
  const worker = sessionClaiming(sessionsOf(first?.artefacts), 'task-1');
  check(assertions, 'the intent was durable before the crash and was never settled',
    (() => {
      const entries = journalEntries(first?.artefacts);
      return entries.length === 1
        && entries[0].state === 'prepared'
        && entries[0].taskId === 't1'
        && entries[0].member === 'worker-a'
        && entries[0].revisionBefore === 1
        && typeof entries[0].requestId === 'string'
        && entries[0].sessionId === worker?.sessionId;
    })(),
    JSON.stringify(journalEntries(first?.artefacts)));

  // 2. The board survived the crash (it is replayed from the Lead Session log),
  //    so the restart has an authority to reconcile against.
  const board = artefacts.teamBoard;
  const boardTasks = board.present === true && Array.isArray(board.tasks) ? board.tasks : [];
  const boardMembers = board.present === true && Array.isArray(board.members) ? board.members : [];
  const task1 = boardTasks.find((task) => task.id === 'task-1');
  const member = boardMembers.find((entry) => entry.name === 'worker-a');
  check(assertions, 'the restarted board still shows the Worker\'s committed claim',
    task1?.status === 'in_progress' && task1?.ownerName === 'worker-a' && task1?.revision === 2,
    JSON.stringify(boardTasks.map((task) => [task.id, task.status, task.ownerName, task.revision])));
  check(assertions, 'the replayed roster still names the Worker\'s real session id',
    typeof member?.id === 'string' && member.id === worker?.sessionId,
    JSON.stringify(boardMembers.map((entry) => [entry.name, entry.id])));

  // 3. Run 2 already converged on exactly one execution, rebuilt from the
  //    journal, with all three mirrors agreeing.
  const tree = second?.artefacts.taskTree?.present === true ? second.artefacts.taskTree.tree : undefined;
  const task = taskOf(tree, 't1');
  const executions = executionsOf(tree);
  const rebuilt = executions.filter((execution) => execution.taskId === 't1');
  check(assertions, 'the restart converged on exactly one execution',
    rebuilt.length === 1,
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.taskId, execution.state])));
  const execution = rebuilt[0];
  check(assertions, 'the rebuilt execution carries the board revision and the roster session id',
    execution !== undefined
    && execution.mode === 'team'
    && execution.state === 'active'
    && execution.claimRevision === 2
    && execution.member === 'worker-a'
    && execution.sessionId === worker?.sessionId
    && execution.rebuiltFrom === 'wal'
    && typeof execution.requestId === 'string',
    JSON.stringify(execution));
  check(assertions, 'the rebuilt execution matches the task stamp (the third mirror)',
    task !== undefined
    && task.status === 'in_progress'
    && task.owner?.executionId === execution?.executionId
    && task.owner?.sessionId === worker?.sessionId
    && task.owner?.member === 'worker-a'
    && task.dispatch === null,
    JSON.stringify({ task: task === undefined ? 'missing' : [task.status, task.owner, task.dispatch] }));
  const workers = tree?.workline?.workers !== null && typeof tree?.workline?.workers === 'object' ? tree.workline.workers : {};
  const workerRow = worker?.sessionId === undefined ? undefined : workers[worker.sessionId];
  check(assertions, 'the Worker record was rebuilt with the same binding',
    workerRow !== undefined
    && workerRow.state === 'bound'
    && workerRow.boundTaskId === 't1'
    && workerRow.executionId === execution?.executionId,
    JSON.stringify(workerRow));
  check(assertions, 'the restart recorded no conflict for a provable claim',
    (Array.isArray(tree?.workline?.conflicts) ? tree.workline.conflicts : []).length === 0,
    JSON.stringify(tree?.workline?.conflicts ?? []));

  // The intent journal is settled exactly once, and the second restart does not
  // create another execution.
  const journal = journalEntries(artefacts);
  const settled = journal.filter((entry) => entry.state === 'committed');
  check(assertions, 'the claim intent is marked committed exactly once',
    settled.length === 1
    && settled[0].requestId === execution?.requestId
    && settled[0].executionId === execution?.executionId,
    JSON.stringify(journal));
  const thirdTree = third?.artefacts.taskTree?.present === true ? third.artefacts.taskTree.tree : undefined;
  check(assertions, 'a second restart leaves exactly one execution, unchanged',
    executionsOf(thirdTree).length === 1
    && executionsOf(thirdTree)[0].executionId === execution?.executionId
    && executionsOf(thirdTree)[0].state === 'active',
    JSON.stringify(executionsOf(thirdTree).map((entry) => [entry.executionId, entry.state])));
  const thirdTask = taskOf(thirdTree, 't1');
  check(assertions, 'the second restart keeps the same task stamp',
    thirdTask?.owner?.executionId !== undefined && thirdTask?.owner?.executionId === execution?.executionId,
    JSON.stringify(thirdTask?.owner));
  check(assertions, 'the second restart adds no journal decision',
    journalEntries(third?.artefacts).filter((entry) => entry.state === 'committed').length === 1,
    JSON.stringify(journalEntries(third?.artefacts)));

  // 4. The write the crashed Worker never reached must not have landed.
  check(assertions, 'the write after the crashed claim never landed', (await exists(workdir, 'crash-bound.txt')) === undefined,
    'crash-bound.txt');
  return assertions;
}
