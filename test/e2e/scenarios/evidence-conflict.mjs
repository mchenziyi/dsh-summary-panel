/**
 * Contradictory evidence: stop the workline with a recorded conflict instead of
 * guessing an executor (design v8 §7.2, §8.2, I12; ticket #8).
 *
 * Run 1 produces the same real crash window as `crash-reconcile`: the board
 * committed worker-a's claim (task-1 in_progress, owner worker-a, revision 2)
 * and the process died before the ledger write. What makes the evidence
 * contradictory is that the intent journal is then GONE — lost with the index,
 * which is exactly the design's "in_progress + ownerId and nothing else" state.
 *
 * A restart must therefore:
 *
 *   (d) record a workline-level conflict, create NO execution, rebuild nothing
 *       and revive nobody;
 *   (b) refuse the new Worker's claim BEFORE the board because the task is
 *       stopped by that conflict, and leave the board untouched.
 */

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'evidence-conflict';
export const summary = 'Unprovable board ownership becomes a recorded conflict that blocks new claims';
export const team = true;
export const prompt = 'Prove contradictory evidence: the board owns a task whose claim cannot be proven, so the workline records a conflict and refuses new claims. Use "prove conflict handling" as the approval basis.';
export const crash = { tool: 'team_task_update', action: 'claim' };

export const runs = [
  {
    prompt,
    program: [
      { tool: 'team_task_create', arguments: { subject: 'conflict one', description: 'claimed by worker-a, then the process dies' } },
      {
        tool: 'task_tree_write',
        arguments: {
          ops: [
            { op: 'init', originalGoal: 'Prove conflict handling' },
            { op: 'create', title: 'Conflicted task', summary: 'board-owned, evidence lost', executionApproval: 'approved', approvalBasis: 'prove conflict handling' },
            { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
          ],
        },
      },
      {
        tool: 'spawn_teammate',
        arguments: { name: 'worker-a', description: 'the Worker dispatched to the conflicted task', prompt: 'Claim task-1 and report.' },
      },
      { waitForTeammate: 'worker-a', tool: 'team_task_list', arguments: {} },
      { text: 'the claim was committed; this process is about to die' },
    ],
    teamResponses: {
      'worker-a': [
        { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 1, action: 'claim' } },
        { text: 'worker-a claimed task-1' },
      ],
    },
    expect: 'crash',
    // The index lost the intent journal: the board still owns task-1, but no
    // Host record proves who claimed it or at which revision. Nothing in the
    // product is switched off — a restart has to treat this as contradictory.
    after: async ({ profile, sessionId }) => {
      await rm(join(profile.taskTreeDir, `${sessionId}.claims.jsonl`), { force: true });
    },
  },
  {
    prompt: 'Restart after the crash: the board owns a task whose claim cannot be proven. Record what the Host can prove and claim nothing.',
    program: [
      { tool: 'task_tree_read', arguments: {} },
      {
        tool: 'spawn_teammate',
        arguments: { name: 'worker-b', description: 'a fresh Worker trying to claim the conflicted task', prompt: 'Try to claim task-1, then write conflict-bound.txt and report.' },
      },
      { waitForTeammate: 'worker-b', tool: 'team_task_list', arguments: {} },
      { tool: 'task_tree_read', arguments: { details: true } },
      { text: 'restarted and read' },
    ],
    resume: true,
    teamResponses: {
      'worker-b': [
        { tool: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 2, action: 'claim' } },
        { tool: 'write', arguments: { file_path: 'conflict-bound.txt', content: 'must not land\n' } },
        { text: 'worker-b could not claim the conflicted task' },
      ],
    },
  },
];

function sessionsOf(artefacts) {
  return artefacts.toolTranscript?.present === true ? artefacts.toolTranscript.sessions : [];
}

function callsOf(session, tool) {
  return (session?.calls ?? []).filter((call) => call.tool === tool);
}

function callMatching(session, tool, match) {
  return callsOf(session, tool).find((call) => match(call.input ?? {}));
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

function conflictsOf(tree) {
  return Array.isArray(tree?.workline?.conflicts) ? tree.workline.conflicts : [];
}

export async function verify({ runs: outcomes, artefacts, workdir }) {
  const assertions = [];
  const first = outcomes[0];
  const second = outcomes[1];

  check(assertions, 'the first run was killed between the board commit and the ledger write',
    first?.run.status !== 0 && first.run.signal === 'SIGKILL',
    `status=${first?.run.status} signal=${first?.run.signal}`);
  const firstTree = first?.artefacts.taskTree?.present === true ? first.artefacts.taskTree.tree : undefined;
  check(assertions, 'after the crash the tree held the dispatch and no execution',
    taskOf(firstTree, 't1')?.owner === null
    && executionsOf(firstTree).length === 0,
    JSON.stringify(taskOf(firstTree, 't1')));
  // The intent existed in run 1 and was removed before the restart, so the
  // board owner can no longer be tied to a Host record.
  check(assertions, 'the intent journal existed after the crash and is gone at the restart',
    first?.artefacts.claimJournal?.present === true
    && Array.isArray(first.artefacts.claimJournal.entries)
    && first.artefacts.claimJournal.entries.some((entry) => entry.state === 'prepared' && entry.taskId === 't1')
    && artefacts.claimJournal?.present !== true,
    JSON.stringify({ first: first?.artefacts.claimJournal?.entries ?? null, second: artefacts.claimJournal ?? null }));

  // The board is authoritative and still owned — with no proof of how.
  const board = artefacts.teamBoard;
  const boardTasks = board.present === true && Array.isArray(board.tasks) ? board.tasks : [];
  const task1 = boardTasks.find((task) => task.id === 'task-1');
  check(assertions, 'the restarted board still owns task-1', task1?.status === 'in_progress'
    && task1?.ownerName === 'worker-a' && task1?.revision === 2,
    JSON.stringify(boardTasks.map((task) => [task.id, task.status, task.ownerName, task.revision])));

  // (d) A recorded, unresolved, task-scoped conflict on the workline — not an
  // execution state.
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const conflicts = conflictsOf(tree);
  const conflict = conflicts.find((entry) => entry.kind === 'unproven-claim' && entry.taskId === 't1');
  check(assertions, 'the contradiction is recorded as one unresolved conflict on the task',
    conflict !== undefined && conflict.resolvedAt === null && conflict.scope === 'task'
    && conflict.kind === 'unproven-claim'
    && conflict.evidence?.boardRevision === 2 && conflict.evidence?.ownerName === 'worker-a'
    && conflict.evidence?.journal === 'no intent',
    JSON.stringify(conflicts));

  // No execution was invented, and the tree says no one holds the task.
  check(assertions, 'no execution was created and no executor was guessed',
    executionsOf(tree).length === 0
    && taskOf(tree, 't1')?.owner === null
    && taskOf(tree, 't1')?.status === 'pending',
    JSON.stringify({ executions: executionsOf(tree), task: taskOf(tree, 't1') }));
  check(assertions, 'the unprovable evidence is reported in the run log',
    String(second?.run.stderr ?? '').includes(conflict?.id ?? '\u0000'),
    String(second?.run.stderr ?? '').trim().split('\n').slice(-3).join(' | '));

  // (b) A new Worker's claim is refused by the conflict, before it reaches the
  // board, and nothing on the board changes.
  const sessions = sessionsOf(second?.artefacts);
  const worker = sessions.find((session) => (session?.calls ?? []).some((call) => call.tool === 'team_task_update'
    && call.input?.action === 'claim'));
  const claim = callMatching(worker, 'team_task_update', (input) => input.action === 'claim');
  check(assertions, 'the new Worker\'s claim is refused because the task is stopped by the conflict',
    claim?.status === 'error'
    && typeof claim.result === 'string'
    && claim.result.includes('stopped by conflict')
    && claim.result.includes(conflict?.id ?? '\u0000'),
    claim === undefined ? 'no claim call' : `status=${claim.status} result=${JSON.stringify(claim.result)}`);
  const write = callMatching(worker, 'write', () => true);
  check(assertions, 'the refused Worker holds no class A permission either',
    write?.status === 'error' && typeof write.result === 'string' && write.result.includes('holds no active execution'),
    write === undefined ? 'no write call' : `status=${write.status} result=${JSON.stringify(write.result)}`);
  check(assertions, 'the refused write left nothing on disk', (await exists(workdir, 'conflict-bound.txt')) === undefined,
    'conflict-bound.txt');

  // Still one conflict, still no execution: reconciliation is idempotent and the
  // board was never rewritten by a refused claim (the guard refused it first).
  const read = readPayload(callMatching(sessions.find((session) => session.header?.origin !== 'subagent'), 'task_tree_read', () => true));
  check(assertions, 'the Lead\'s read still shows the task unowned', (read?.tasks ?? []).find((row) => row.id === 't1')?.owner === false,
    JSON.stringify((read?.tasks ?? []).map((row) => [row.id, row.owner, row.executor])));
  check(assertions, 'the workline keeps exactly one conflict after the refused claim',
    conflicts.length === 1 && task1?.revision === 2,
    JSON.stringify({ conflicts: conflicts.length, revision: task1?.revision }));
  check(assertions, 'the refused claim wrote no new intent to the lost journal',
    artefacts.claimJournal?.present !== true,
    JSON.stringify(artefacts.claimJournal?.entries ?? artefacts.claimJournal?.reason));
  return assertions;
}
