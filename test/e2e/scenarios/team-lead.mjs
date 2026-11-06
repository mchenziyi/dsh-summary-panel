/**
 * Team mode: the Lead only coordinates (design v8 §3, §7, §10; ticket #5).
 *
 * When the profile composes the real Agent Team, the Lead is a pure
 * coordinator. One real process proves the whole slice:
 *
 *   1. team mode comes from the composed service, not from the task tree: with
 *      no tree yet, a class A `write` is already refused;
 *   2. the Lead still maintains the task tree (class B), and can be handed an
 *      execution (`claim`, which this ticket leaves as it was), proving the
 *      class A refusal is independent of anyone holding a seat — it is refused
 *      even then. The next slice may hold that seat through a Worker instead;
 *   3. every representative class A family is refused with one clear reason:
 *      workspace write/edit, shell, workflow, and terminal/worktree/ralph/
 *      subagent spawn (the team profile replaces or disables the shipped ones,
 *      so a fixture registers those names with a body that would leave a
 *      sentinel file — no sentinel must appear);
 *   4. coordination stays available: create/list a team task, spawn a real
 *      teammate, list members, message it, wait, interrupt it, and read;
 *   5. after the seat is released, class A is still refused.
 *
 * The refusal is observed in the Lead's real tool results and the workspace
 * (no refused call left anything behind), so it is the guard talking, not the
 * prompt.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'team-lead';
export const summary = 'In team mode the Lead coordinates only: every class A tool is refused, coordination still works';
export const team = true;
export const prompt = 'In this Agent Team, prove the Lead only coordinates: initialise a task tree, claim a task, try every kind of concrete work, then run the team coordination round. Use "prove the team lead only coordinates" as the approval basis.';

const APPROVED_TASK = {
  op: 'create',
  title: 'Lead coordination only',
  summary: 'the task whose seat the Lead holds while class A is refused',
  executionApproval: 'approved',
  approvalBasis: 'prove the team lead only coordinates',
  status: 'in_progress',
};

export const program = [
  // 1. No task tree yet: team mode is already on because the Agent Team service
  //    is composed, so the Lead may not write even before a workline exists.
  { tool: 'write', arguments: { file_path: 'lead-unmanaged.txt', content: 'must not land\n' } },
  // 2. Class B: the Lead still maintains the tree.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove the team-mode Lead only coordinates' },
        APPROVED_TASK,
      ],
    },
  },
  // 3. Class B: the Lead takes a task execution. The exception below must not
  //    depend on this seat: class A is refused WITH it held.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't1' }] } },
  // 4. Every representative class A family, with a seat held.
  { tool: 'write', arguments: { file_path: 'lead-with-seat.txt', content: 'must not land\n' } },
  { tool: 'edit', arguments: { file_path: 'lead-edit-target.txt', old_string: 'nothing', new_string: 'must not land' } },
  { tool: 'bash', arguments: { command: 'printf "must not land\\n" > shell-with-seat.txt', description: 'write a sentinel file as the Lead' } },
  { tool: 'workflow', arguments: { script: 'return 42;', meta: { name: 'lead-denied-workflow', description: 'must not run' } } },
  ...['terminal_open', 'create_worktree', 'ralph', 'subagent'].map((tool) => ({ tool, arguments: {} })),
  // 5. Coordination stays available with the seat held and after the denials.
  { tool: 'team_task_create', arguments: { subject: 'coordination smoke', description: 'the Lead coordinates while it cannot execute' } },
  { tool: 'team_task_list', arguments: {} },
  { tool: 'spawn_teammate', arguments: { name: 'worker-a', description: 'a real teammate that only stands by', prompt: 'Stand by. Do not write anything; reply that you are ready.' } },
  { tool: 'list_agents', arguments: {} },
  { tool: 'wait_agent', arguments: { timeout_ms: 10000 } },
  { tool: 'send_message', arguments: { target: 'worker-a', message: 'Stand by; the Lead is only coordinating.' } },
  { tool: 'interrupt_agent', arguments: { target: 'worker-a' } },
  { tool: 'task_tree_read', arguments: {} },
  { tool: 'glob', arguments: { pattern: '*' } },
  // 6. Release the seat: class A stays refused.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1' }] } },
  { tool: 'write', arguments: { file_path: 'lead-after-release.txt', content: 'must not land\n' } },
  { text: 'team lead exercised' },
];

// A real teammate runs through the same scripted adapter. Extra answers cover a
// pre-fix run that also spawns an ordinary subagent.
export const subagentProgram = [
  { text: 'worker-a: standing by' },
  { text: 'worker-a: still standing by' },
  { text: 'worker-a: idle' },
];

/** The Lead's session record from the in-process transcript. */
function leadSession(artefacts) {
  const sessions = artefacts.toolTranscript?.present === true ? artefacts.toolTranscript.sessions : [];
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

/** A class A refusal: one named call errored with the team-mode Lead reason. */
function refusedAsLead(assertions, call, label, tool) {
  check(assertions, `${label} was refused`, call !== undefined && call.status === 'error',
    call === undefined ? 'no such tool call in the run' : `status=${call.status} result=${JSON.stringify(call.result)}`);
  check(assertions, `${label} was told the Lead only coordinates`, call !== undefined
    && typeof call.result === 'string'
    && call.result.includes('only coordinates')
    && call.result.includes('class A')
    && call.result.includes(tool),
  call === undefined ? 'no such tool call in the run' : JSON.stringify(call.result));
}

export async function verify({ artefacts, workdir }) {
  const assertions = [];
  const lead = leadSession(artefacts);
  check(assertions, 'the run produced a Lead session', lead !== undefined, lead === undefined ? 'no Lead session recorded' : lead.sessionId);
  if (lead === undefined) return assertions;

  // 1. Team mode is on before any tree exists.
  refusedAsLead(assertions, callMatching(lead, 'write', (input) => input.file_path === 'lead-unmanaged.txt'), 'write with no task tree yet', 'write');
  check(assertions, 'the refused write left no file', (await exists(workdir, 'lead-unmanaged.txt')) === undefined, 'lead-unmanaged.txt');

  // 2. Class B: the Lead maintains the tree and holds an execution.
  const treeWrites = callsOf(lead, 'task_tree_write');
  check(assertions, 'the Lead initialised the tree and created a task (class B)', treeWrites[0]?.status === 'completed',
    treeWrites[0] === undefined ? 'no task_tree_write call' : `status=${treeWrites[0].status} result=${JSON.stringify(treeWrites[0].result)}`);
  check(assertions, 'the Lead claimed a task, so a seat is held during the denials', treeWrites[1]?.status === 'completed',
    treeWrites[1] === undefined ? 'no claim call' : `status=${treeWrites[1].status} result=${JSON.stringify(treeWrites[1].result)}`);

  // 3. Every class A family refused while the seat is held.
  const withSeat = callMatching(lead, 'write', (input) => input.file_path === 'lead-with-seat.txt');
  refusedAsLead(assertions, withSeat, 'write while holding the seat', 'write');
  check(assertions, 'the refused write left no file', (await exists(workdir, 'lead-with-seat.txt')) === undefined, 'lead-with-seat.txt');
  refusedAsLead(assertions, callMatching(lead, 'edit', (input) => input.file_path === 'lead-edit-target.txt'), 'edit while holding the seat', 'edit');
  check(assertions, 'the refused edit left its target absent', (await exists(workdir, 'lead-edit-target.txt')) === undefined, 'lead-edit-target.txt');
  refusedAsLead(assertions, callMatching(lead, 'bash', (input) => String(input.command).includes('shell-with-seat.txt')), 'bash while holding the seat', 'bash');
  check(assertions, 'the refused bash left no file', (await exists(workdir, 'shell-with-seat.txt')) === undefined, 'shell-with-seat.txt');
  refusedAsLead(assertions, callMatching(lead, 'workflow', (input) => input.meta?.name === 'lead-denied-workflow'), 'workflow while holding the seat', 'workflow');
  for (const tool of ['terminal_open', 'create_worktree', 'ralph', 'subagent']) {
    refusedAsLead(assertions, callMatching(lead, tool, () => true), `${tool} while holding the seat`, tool);
    check(assertions, `the refused ${tool} body never ran`, (await exists(workdir, `probe-ran-${tool}.txt`)) === undefined, `probe-ran-${tool}.txt`);
  }

  // 4. Coordination tools work.
  const coordination = ['team_task_create', 'team_task_list', 'spawn_teammate', 'list_agents', 'wait_agent', 'send_message', 'interrupt_agent', 'task_tree_read', 'glob'];
  for (const tool of coordination) {
    const call = callsOf(lead, tool)[0];
    check(assertions, `${tool} still works for the Lead (class B/C)`, call !== undefined && call.status === 'completed',
      call === undefined ? `no ${tool} call in the run` : `status=${call.status} result=${JSON.stringify(call.result)}`);
  }
  const spawned = callsOf(lead, 'spawn_teammate')[0];
  check(assertions, 'a real teammate was spawned', spawned !== undefined && spawned.status === 'completed',
    spawned === undefined ? 'no spawn_teammate call' : JSON.stringify(spawned.result));

  // 5. Release leaves class A refused.
  check(assertions, 'the Lead released its seat (class B)', treeWrites[2]?.status === 'completed',
    treeWrites[2] === undefined ? 'no release call' : `status=${treeWrites[2].status} result=${JSON.stringify(treeWrites[2].result)}`);
  refusedAsLead(assertions, callMatching(lead, 'write', (input) => input.file_path === 'lead-after-release.txt'), 'write after releasing the seat', 'write');
  check(assertions, 'the write refused after release left no file', (await exists(workdir, 'lead-after-release.txt')) === undefined, 'lead-after-release.txt');
  const classACalls = ['write', 'edit', 'bash', 'workflow', 'terminal_open', 'create_worktree', 'ralph', 'subagent']
    .flatMap((tool) => callsOf(lead, tool));
  check(assertions, 'the run tried every class A family and not one completed',
    classACalls.length === 10 && classACalls.every((call) => call.status === 'error'),
    `${classACalls.length} call(s): ${classACalls.map((call) => `${call.tool}:${call.status}`).join(', ')}`);

  // The persisted tree: the seat was real, and release cleared it.
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  check(assertions, 'the persisted tree kept the task in progress with no owner after release',
    (tree?.tasks ?? []).length === 1 && tree.tasks[0].status === 'in_progress' && tree.tasks[0].owner === null,
    JSON.stringify((tree?.tasks ?? []).map((task) => [task.id, task.status, task.owner])));
  const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
  check(assertions, 'the tree records the Lead\'s seat as a real execution that ended by release',
    executions.length === 1 && executions[0].state === 'ended' && executions[0].endReason === 'released',
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.state, execution.endReason])));

  // The live Team board saw the Lead and the spawned teammate.
  const board = artefacts.teamBoard;
  check(assertions, 'the live Team board was exported with the Lead and its teammate',
    board.present === true
    && Array.isArray(board.members)
    && board.members.some((member) => member.role === 'lead')
    && board.members.some((member) => member.role === 'teammate' && member.name === 'worker-a'),
    board.present === true ? JSON.stringify(board.members?.map((member) => [member.name, member.role])) : board.reason);

  return assertions;
}
