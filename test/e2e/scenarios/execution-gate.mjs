/**
 * The execution gate: every class A tool needs an active execution (design v8
 * §3, amended by ADR-0001 — the no-tree exemption is gone).
 *
 * One scripted session proves the whole slice in order:
 *
 *   1. no task tree yet        -> `write` and `bash` are refused, nothing lands,
 *                                 and the refusal names the bootstrap path:
 *                                 init -> create -> claim
 *   2. tree initialised        -> `task_tree_write` still works (class B)
 *   3. tree exists, no claim   -> `write` and `bash` are refused, and nothing
 *                                 lands on disk
 *   4. after `claim`           -> the SAME write refused in step 1 succeeds
 *   5. after `release`         -> `write`, `edit` and `bash` are refused again
 *                                 immediately, and the edit leaves its real
 *                                 target untouched
 *   6. still no execution      -> task-management calls keep working
 *
 * Step 4 is the bootstrap proof: the workline starts with nothing but a
 * refusal, and the model has to build a tree, create a task and claim it
 * before the identical call is accepted.
 *
 * The denial is observed through the tool result (`status: "error"`, a reason
 * naming the missing execution) and through the workspace, which together show
 * the call was denied before any side effect. A refused call is proven to have
 * written nothing by a sentinel path that is never written again in the run —
 * `boot.txt` cannot carry that proof, because a later call writes it on
 * purpose.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'execution-gate';
export const summary = 'Class A is refused with no tree and before claim, and refused again after release';
export const team = false;
export const prompt = 'Prove the execution gate: try a workspace change with no task tree, then bootstrap a tree and claim a task, then try the same change again. Use "prove the execution gate" as the approval basis.';
export const program = [
  // 1. No tree yet: nothing to claim, so nothing may be written either. The
  //    sentinel is never touched again, so its absence later is the proof.
  { tool: 'write', arguments: { file_path: 'must-not-land.txt', content: 'no tree yet\n' } },
  { tool: 'bash', arguments: { command: 'printf "no tree yet\\n" > shell-no-tree.txt', description: 'write a sentinel file before the tree exists' } },
  // 2. The same write the scenario retries in step 5, refused once with no
  //    tree at all: this is the call that has to become allowed after bootstrap.
  { tool: 'write', arguments: { file_path: 'boot.txt', content: 'bootstrapped\n' } },
  // 3. Class B works with no execution: init the tree and create an approved,
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
  // 4. Tree present, no execution: class A is still refused.
  { tool: 'write', arguments: { file_path: 'before-claim.txt', content: 'must not land\n' } },
  { tool: 'bash', arguments: { command: 'printf "must not land\\n" > shell-before-claim.txt', description: 'write a sentinel file before claiming' } },
  // 5. Claim is class B: it needs no execution of its own.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't1' }] } },
  // 6. Holding the execution: the identical call refused in step 2 is allowed.
  { tool: 'write', arguments: { file_path: 'boot.txt', content: 'bootstrapped\n' } },
  // 7. A real file for the post-release edit refusal to leave untouched.
  { tool: 'write', arguments: { file_path: 'target.txt', content: 'original\n' } },
  // 8. Releasing drops the execution immediately.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1' }] } },
  { tool: 'write', arguments: { file_path: 'after-release.txt', content: 'must not land either\n' } },
  { tool: 'bash', arguments: { command: 'printf "must not land\\n" > shell-after-release.txt', description: 'write a sentinel file after releasing' } },
  { tool: 'edit', arguments: { file_path: 'target.txt', old_string: 'original', new_string: 'must not land' } },
  // 9. Task management still works with no execution: add a follow-up step and read.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'create', title: 'Follow-up', parentId: 't1' }] } },
  { tool: 'task_tree_read', arguments: {} },
  { text: 'execution gate exercised' },
];

/** Every write call for one path, in call order. */
function writeCalls(calls, path) {
  return calls.filter((call) => call.tool === 'write' && call.input?.file_path === path);
}
/** The first write call for one path. */
function writeCall(calls, path) {
  return writeCalls(calls, path)[0];
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

/** The model-readable reason of one call, or an empty string. */
function reasonOf(call) {
  return typeof call?.result === 'string' ? call.result : '';
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

  // 1. No tree: refused, and the reason has to teach the bootstrap path.
  const bootstrapWrite = writeCall(calls, 'must-not-land.txt');
  const bootstrapBash = bashCall(calls, 'shell-no-tree.txt');
  denied(assertions, bootstrapWrite, 'write with no task tree', 'write');
  denied(assertions, bootstrapBash, 'bash with no task tree', 'bash');
  assertions.push({
    label: 'the no-tree refusal names the bootstrap path (init, create, claim)',
    ok: bootstrapWrite !== undefined && reasonOf(bootstrapWrite).includes('no task tree')
      && reasonOf(bootstrapWrite).includes('init')
      && reasonOf(bootstrapWrite).includes('create')
      && reasonOf(bootstrapWrite).includes('claim'),
    detail: bootstrapWrite === undefined ? 'no write call for must-not-land.txt' : JSON.stringify(bootstrapWrite.result),
  });
  assertions.push({
    label: 'the refused no-tree write left no file',
    ok: (await exists(workdir, 'must-not-land.txt')) === undefined,
    detail: 'must-not-land.txt (never written again in this run)',
  });
  assertions.push({
    label: 'the refused no-tree bash left no file',
    ok: (await exists(workdir, 'shell-no-tree.txt')) === undefined,
    detail: 'shell-no-tree.txt',
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

  // 3. Tree present, no execution: class A refused, with nothing written.
  const beforeWrite = writeCall(calls, 'before-claim.txt');
  const beforeBash = bashCall(calls, 'shell-before-claim.txt');
  denied(assertions, beforeWrite, 'write before claim', 'write');
  denied(assertions, beforeBash, 'bash before claim', 'bash');
  // A workline that HAS a tree points the model at claim instead of bootstrap.
  assertions.push({
    label: 'the before-claim refusal says to claim a task',
    ok: beforeWrite !== undefined && reasonOf(beforeWrite).includes('Claim a task first'),
    detail: beforeWrite === undefined ? 'no write call for before-claim.txt' : JSON.stringify(beforeWrite.result),
  });
  assertions.push({
    label: 'the refused write left no file (denied before any side effect)',
    ok: (await exists(workdir, 'before-claim.txt')) === undefined,
    detail: 'before-claim.txt',
  });
  assertions.push({
    label: 'the refused bash command left no file',
    ok: (await exists(workdir, 'shell-before-claim.txt')) === undefined,
    detail: 'shell-before-claim.txt',
  });

  // 4. After claim: the identical call refused in step 2 is accepted.
  const bootWrite = writeCalls(calls, 'boot.txt');
  assertions.push({
    label: 'the same write refused with no tree succeeds once the task is claimed',
    ok: bootWrite.length === 2 && bootWrite[0].status === 'error' && bootWrite[1].status === 'completed',
    detail: bootWrite.length === 2
      ? `first=${bootWrite[0].status} second=${bootWrite[1].status}`
      : `${bootWrite.length} boot.txt write calls in the run`,
  });
  assertions.push({
    label: 'the allowed write landed on disk',
    ok: (await exists(workdir, 'boot.txt')) === 'bootstrapped\n',
    detail: 'boot.txt',
  });

  // 5. After release: refused again immediately, with nothing written.
  const afterRelease = writeCall(calls, 'after-release.txt');
  const afterReleaseBash = bashCall(calls, 'shell-after-release.txt');
  const afterReleaseEdit = calls.find((call) => call.tool === 'edit' && call.input?.file_path === 'target.txt');
  denied(assertions, afterRelease, 'write after release', 'write');
  denied(assertions, afterReleaseBash, 'bash after release', 'bash');
  denied(assertions, afterReleaseEdit, 'edit after release', 'edit');
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
  assertions.push({
    label: 'the refused edit left its real target unchanged',
    ok: (await exists(workdir, 'target.txt')) === 'original\n',
    detail: 'target.txt',
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
