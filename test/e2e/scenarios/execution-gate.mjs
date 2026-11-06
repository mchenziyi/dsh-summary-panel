/**
 * The execution gate: class A tools need an active execution (design v8 §3).
 *
 * One scripted session proves the whole narrow slice in order:
 *
 *   1. no task tree yet        -> `write` succeeds (an unmanaged workline is free)
 *   2. tree initialised        -> `task_tree_write` still works (class B)
 *   3. tree exists, no claim   -> `write` and `bash` are refused, and nothing lands on disk
 *   4. after `claim`           -> `write` succeeds
 *   5. after `release`         -> `write` and `bash` are refused again immediately
 *   6. still no execution      -> task-management calls keep working
 *
 * The denial is observed through the tool result (`status: "error"`, a reason
 * naming the missing execution) and through the workspace (the refused files
 * are absent), which together show the call was denied before any side effect.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'execution-gate';
export const summary = 'Class A tools are refused until claim, and refused again after release';
export const team = false;
export const prompt = 'Prove the execution gate: initialise a task tree, try a workspace change before and after claiming the task, and use "prove the execution gate" as the approval basis.';
export const program = [
  // 1. No tree yet: the workline is unmanaged, so a class A tool is free.
  { tool: 'write', arguments: { file_path: 'unmanaged.txt', content: 'no tree yet\n' } },
  // 2. Class B works with no execution: init the tree and create an approved,
  //    in-progress task in one call.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove class A tools need an active execution' },
        {
          op: 'create',
          title: 'Gated work',
          summary: 'the task whose claim opens the gate',
          executionApproval: 'approved',
          approvalBasis: 'prove the execution gate',
          status: 'in_progress',
        },
      ],
    },
  },
  // 3. Tree exists, no execution: both workspace-modifying tools are refused.
  { tool: 'write', arguments: { file_path: 'before-claim.txt', content: 'must not land\n' } },
  { tool: 'edit', arguments: { file_path: 'unmanaged.txt', old_string: 'no tree yet', new_string: 'must not land' } },
  { tool: 'bash', arguments: { command: 'printf "must not land\\n" > shell-before-claim.txt', description: 'write a sentinel file before claiming' } },
  // 4. Claim is class B: it needs no execution of its own.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't1' }] } },
  // 5. Holding the execution: the same class A tool is allowed.
  { tool: 'write', arguments: { file_path: 'after-claim.txt', content: 'written while claimed\n' } },
  // 6. Releasing drops the execution immediately.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1' }] } },
  { tool: 'write', arguments: { file_path: 'after-release.txt', content: 'must not land either\n' } },
  { tool: 'bash', arguments: { command: 'printf "must not land\\n" > shell-after-release.txt', description: 'write a sentinel file after releasing' } },
  // 7. Task management still works with no execution: add a follow-up step and read.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'create', title: 'Follow-up', parentId: 't1' }] } },
  { tool: 'task_tree_read', arguments: {} },
  { text: 'execution gate exercised' },
];

/** Find the write call for one path, and the bash call whose command names one. */
function writeCall(calls, path) {
  return calls.find((call) => call.tool === 'write' && call.input?.file_path === path);
}
function bashCall(calls, path) {
  return calls.find((call) => call.tool === 'bash' && typeof call.input?.command === 'string' && call.input.command.includes(path));
}

/** Whether one path exists in the session workspace. */
async function exists(workdir, path) {
  try {
    return await readFile(join(workdir, path), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * A class A denial: the tool errored, the message names the missing execution,
 * and the reason names the tool so the model knows what was refused.
 */
function denied(assertions, call, label, needle) {
  assertions.push({
    label: `${label} was refused`,
    ok: call !== undefined && call.status === 'error',
    detail: call === undefined ? 'no such tool call in the run' : `status=${call.status} result=${JSON.stringify(call.result)}`,
  });
  assertions.push({
    label: `${label} was told it holds no active execution`,
    ok: call !== undefined && typeof call.result === 'string'
      && call.result.includes('no active execution')
      && call.result.includes(needle)
      && call.result.includes('class A'),
    detail: call === undefined ? 'no such tool call in the run' : JSON.stringify(call.result),
  });
}

export async function verify({ artefacts, workdir }) {
  const calls = artefacts.toolResults.calls;
  const taskCalls = calls.filter((call) => call.tool === 'task_tree_write');
  const assertions = [];

  // 1. An unmanaged workline: no tree, no constraint.
  const unmanaged = writeCall(calls, 'unmanaged.txt');
  assertions.push({
    label: 'before the tree exists, write is unconstrained',
    ok: unmanaged !== undefined && unmanaged.status === 'completed',
    detail: unmanaged === undefined ? 'no write call for unmanaged.txt' : `status=${unmanaged.status}`,
  });
  assertions.push({
    label: 'the unmanaged write landed on disk',
    ok: (await exists(workdir, 'unmanaged.txt')) === 'no tree yet\n',
    detail: 'unmanaged.txt',
  });

  // 2. Class B needs no execution: init + create, then claim and release.
  assertions.push({
    label: 'the tree was initialised and a task created with no execution (class B)',
    ok: taskCalls[0] !== undefined && taskCalls[0].status === 'completed',
    detail: taskCalls[0] === undefined ? 'no task_tree_write call' : `status=${taskCalls[0].status} result=${JSON.stringify(taskCalls[0].result)}`,
  });
  assertions.push({
    label: 'claim completed with no prior execution (no circular dependency)',
    ok: taskCalls[1] !== undefined && taskCalls[1].status === 'completed',
    detail: taskCalls[1] === undefined ? 'no claim call' : `status=${taskCalls[1].status} result=${JSON.stringify(taskCalls[1].result)}`,
  });
  assertions.push({
    label: 'release completed',
    ok: taskCalls[2] !== undefined && taskCalls[2].status === 'completed',
    detail: taskCalls[2] === undefined ? 'no release call' : `status=${taskCalls[2].status} result=${JSON.stringify(taskCalls[2].result)}`,
  });

  // 3. No execution: class A refused, with nothing written.
  const beforeWrite = writeCall(calls, 'before-claim.txt');
  const beforeEdit = calls.find((call) => call.tool === 'edit' && call.input?.file_path === 'unmanaged.txt');
  const beforeBash = bashCall(calls, 'shell-before-claim.txt');
  denied(assertions, beforeWrite, 'write before claim', 'write');
  denied(assertions, beforeEdit, 'edit before claim', 'edit');
  denied(assertions, beforeBash, 'bash before claim', 'bash');
  assertions.push({
    label: 'the refused write left no file (denied before any side effect)',
    ok: (await exists(workdir, 'before-claim.txt')) === undefined,
    detail: 'before-claim.txt',
  });
  assertions.push({
    label: 'the refused edit left its target file unchanged',
    ok: (await exists(workdir, 'unmanaged.txt')) === 'no tree yet\n',
    detail: 'unmanaged.txt still holds the unmanaged content',
  });
  assertions.push({
    label: 'the refused bash command left no file',
    ok: (await exists(workdir, 'shell-before-claim.txt')) === undefined,
    detail: 'shell-before-claim.txt',
  });

  // 4. After claim: allowed.
  const afterClaim = writeCall(calls, 'after-claim.txt');
  assertions.push({
    label: 'write is allowed while the session holds the execution',
    ok: afterClaim !== undefined && afterClaim.status === 'completed',
    detail: afterClaim === undefined ? 'no write call for after-claim.txt' : `status=${afterClaim.status}`,
  });
  assertions.push({
    label: 'the allowed write landed on disk',
    ok: (await exists(workdir, 'after-claim.txt')) === 'written while claimed\n',
    detail: 'after-claim.txt',
  });

  // 5. After release: refused again immediately, with nothing written.
  const afterRelease = writeCall(calls, 'after-release.txt');
  const afterReleaseBash = bashCall(calls, 'shell-after-release.txt');
  denied(assertions, afterRelease, 'write after release', 'write');
  denied(assertions, afterReleaseBash, 'bash after release', 'bash');
  assertions.push({
    label: 'the write refused after release left no file',
    ok: (await exists(workdir, 'after-release.txt')) === undefined,
    detail: 'after-release.txt',
  });
  assertions.push({
    label: 'the bash refused after release left no file',
    ok: (await exists(workdir, 'shell-after-release.txt')) === undefined,
    detail: 'shell-after-release.txt',
  });

  // 6. Task management still works with no execution.
  assertions.push({
    label: 'a task-tree write still works after release (class B)',
    ok: taskCalls[3] !== undefined && taskCalls[3].status === 'completed',
    detail: taskCalls[3] === undefined ? 'no create call after release' : `status=${taskCalls[3].status} result=${JSON.stringify(taskCalls[3].result)}`,
  });
  const read = calls.find((call) => call.tool === 'task_tree_read');
  assertions.push({
    label: 'task_tree_read still works after release (class B/C)',
    ok: read !== undefined && read.status === 'completed',
    detail: read === undefined ? 'no task_tree_read call' : `status=${read.status}`,
  });

  // The persisted tree is the fact source, not the tool echo.
  assertions.push({
    label: 'the persisted tree shows the claim stamp cleared by release',
    ok: artefacts.taskTree.present === true
      && Array.isArray(artefacts.taskTree.tree?.tasks)
      && artefacts.taskTree.tree.tasks.every((task) => task.owner === null),
    detail: artefacts.taskTree.present === true ? 'owner is null on every task' : artefacts.taskTree.reason,
  });
  assertions.push({
    label: 'the follow-up step was created under the claimed task',
    ok: artefacts.taskTree.present === true
      && Array.isArray(artefacts.taskTree.tree?.tasks)
      && artefacts.taskTree.tree.tasks.some((task) => task.title === 'Follow-up' && task.parentId === 't1'),
    detail: artefacts.taskTree.present === true ? 'Follow-up under t1' : artefacts.taskTree.reason,
  });

  return assertions;
}
