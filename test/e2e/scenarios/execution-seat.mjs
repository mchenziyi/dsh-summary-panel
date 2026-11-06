/**
 * The standard-mode execution seat: one seat per workline, handed over to a
 * real subagent and taken back (design v8 §3 invariants, §5).
 *
 * One real DSH process, one Lead session and one real continuable subagent:
 *
 *   1. the Lead claims `t1` and writes while holding the seat;
 *   2. the subagent tries to claim while the Lead holds -> refused, and its
 *      `write` is refused too (the seat is occupied, so no execution is given);
 *   3. the Lead releases and assigns `t1` to the subagent (the session id it
 *      read from the `subagent` tool result) without claiming it. Assignment is
 *      not a claim: the Lead still cannot write;
 *   4. the subagent claims, writes, and releases; the Lead cannot write during
 *      the handover;
 *   5. the Lead reassigns `t1` to itself and claims again -> a NEW execution id;
 *   6. three sequential tasks by the Lead produce three distinct execution ids.
 *
 * The refusals are observed in each session's real tool results (the harness
 * exporter follows every session, not just the Lead's), and the execution ids
 * come from both the tool results and the tree file on disk.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'execution-seat';
export const summary = 'One execution seat: the Lead holds, hands over to a subagent, and reclaims with a new execution id';
export const team = false;
export const prompt = 'Prove the standard-mode execution seat: hold it, hand it to a subagent, take it back, and do three tasks in a row. Use "prove the execution seat" as the approval basis.';

export const program = [
  // 1. The Lead opens the workline and claims the one execution seat.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove the standard-mode execution seat' },
        {
          op: 'create',
          title: 'Handover task',
          summary: 'the task whose seat is handed to a subagent',
          executionApproval: 'approved',
          approvalBasis: 'prove the execution seat',
          status: 'in_progress',
        },
      ],
    },
  },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't1' }] } },
  { tool: 'write', arguments: { file_path: 'lead-holds.txt', content: 'the lead holds the seat\n' } },
  // 2. A real continuable subagent whose first turn tries to claim while the Lead holds.
  {
    tool: 'subagent',
    arguments: {
      description: 'seat probe',
      prompt: 'Try to claim task t1 and write child-before-assign.txt. Then report what the tools answered.',
    },
  },
  // 3. The Lead releases (ending ex-1) and assigns the task to the subagent id
  //    it read from the spawn result. Assignment is not a claim.
  { waitForSubagentTurns: 1, tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1' }] } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'assign', id: 't1', member: '{{subagentId}}' }] } },
  // 4. The subagent claims, writes, and releases. The Lead has no execution.
  {
    tool: 'send_message',
    arguments: {
      agent_id: '{{subagentId}}',
      message: 'The seat is free and t1 is assigned to you. Claim t1, write child-work.txt, then release t1 and report.',
    },
  },
  { tool: 'write', arguments: { file_path: 'lead-after-handover.txt', content: 'the lead must not write\n' } },
  // 5. Once the subagent's turn ends, assigning back to the lead and claiming
  //    again must produce a NEW execution id, never the ended one.
  { waitForSubagentTurns: 2, tool: 'task_tree_write', arguments: { ops: [{ op: 'assign', id: 't1', member: 'lead' }] } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't1' }] } },
  { tool: 'write', arguments: { file_path: 'lead-reclaimed.txt', content: 'the lead holds the seat again\n' } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1' }] } },
  // 6. Three sequential tasks by the Lead: each claim needs its own new id.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'create', title: 'Second task', executionApproval: 'approved', approvalBasis: 'prove the execution seat', status: 'in_progress' }] } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't2' }] } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't2' }] } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'create', title: 'Third task', executionApproval: 'approved', approvalBasis: 'prove the execution seat', status: 'in_progress' }] } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't3' }] } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't3' }] } },
  { text: 'execution seat exercised' },
];

export const subagentProgram = [
  // Turn 1, while the Lead still holds the seat.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't1' }] } },
  { tool: 'write', arguments: { file_path: 'child-before-assign.txt', content: 'must not land\n' } },
  { text: 'claim refused while the lead held the seat' },
  // Turn 2, after the Lead released and assigned the task to this session.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't1' }] } },
  { tool: 'write', arguments: { file_path: 'child-work.txt', content: 'the subagent wrote while holding the seat\n' } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1' }] } },
  { text: 'claimed, wrote, released' },
];

/** One session record from the in-process transcript, by origin. */
function sessionOf(artefacts, origin) {
  const sessions = artefacts.toolTranscript?.present === true ? artefacts.toolTranscript.sessions : [];
  return sessions.find((session) => (origin === 'subagent'
    ? session.header?.origin === 'subagent'
    : session.header?.origin !== 'subagent'));
}

/** Calls of one tool in one session, in call order. */
function callsOf(session, tool) {
  return (session?.calls ?? []).filter((call) => call.tool === tool);
}

/** Calls carrying one task-tree op for one task. */
function opCalls(session, op, id) {
  return callsOf(session, 'task_tree_write')
    .filter((call) => Array.isArray(call.input?.ops) && call.input.ops.some((entry) => entry.op === op && entry.id === id));
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

/** The execution id a claim/assign call returned, if any. */
function executionIdOf(call) {
  const outcome = outcomeOf(call);
  const applied = Array.isArray(outcome?.applied) ? outcome.applied : [];
  return applied.find((entry) => typeof entry.executionId === 'string')?.executionId;
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
  const lead = sessionOf(artefacts, 'lead');
  const child = sessionOf(artefacts, 'subagent');
  const leadCalls = artefacts.toolResults.calls;

  check(assertions, 'the run produced a Lead session and a real subagent session', lead !== undefined && child !== undefined,
    child === undefined ? 'no subagent session recorded' : `lead=${lead?.sessionId} child=${child.sessionId}`);

  // 1. The Lead holds the seat and writes.
  const leadFirstClaim = opCalls(lead, 'claim', 't1')[0];
  const leadHolds = callsOf(lead, 'write').find((call) => call.input?.file_path === 'lead-holds.txt');
  check(assertions, 'the Lead claimed t1 and holds the seat', leadFirstClaim?.status === 'completed',
    leadFirstClaim === undefined ? 'no claim call' : `status=${leadFirstClaim.status} result=${JSON.stringify(leadFirstClaim.result)}`);
  check(assertions, 'the Lead wrote while holding the seat', leadHolds?.status === 'completed' && (await exists(workdir, 'lead-holds.txt')) === 'the lead holds the seat\n',
    leadHolds === undefined ? 'no write call' : `status=${leadHolds.status}`);

  // 2. While the Lead holds the seat, the subagent's claim and write are refused.
  const childBlockedClaim = opCalls(child, 'claim', 't1')[0];
  const childBlockedWrite = callsOf(child, 'write').find((call) => call.input?.file_path === 'child-before-assign.txt');
  check(assertions, 'the subagent claim was refused while the Lead held the seat',
    childBlockedClaim?.status === 'error'
    && typeof childBlockedClaim.result === 'string'
    && childBlockedClaim.result.includes('execution seat')
    && childBlockedClaim.result.includes('held by'),
    childBlockedClaim === undefined ? 'no subagent claim call' : `status=${childBlockedClaim?.status} result=${JSON.stringify(childBlockedClaim?.result)}`);
  check(assertions, 'the subagent write was refused with no execution',
    childBlockedWrite?.status === 'error'
    && typeof childBlockedWrite.result === 'string'
    && childBlockedWrite.result.includes('holds no active execution'),
    childBlockedWrite === undefined ? 'no subagent write call' : `status=${childBlockedWrite?.status} result=${JSON.stringify(childBlockedWrite?.result)}`);
  check(assertions, 'the refused subagent write left no file', (await exists(workdir, 'child-before-assign.txt')) === undefined, 'child-before-assign.txt');

  // 3. Release + assign happen without creating an execution; assignment is not a claim.
  const release = opCalls(lead, 'release', 't1')[0];
  const assign = opCalls(lead, 'assign', 't1')[0];
  check(assertions, 'the Lead released the seat', release?.status === 'completed', `status=${release?.status} result=${JSON.stringify(release?.result)}`);
  check(assertions, 'the Lead assigned t1 to the subagent session id from the spawn result',
    assign?.status === 'completed'
    && assign.input.ops.some((entry) => entry.op === 'assign' && entry.member === child?.sessionId),
    assign === undefined ? 'no assign call' : `member=${JSON.stringify(assign.input?.ops)} child=${child?.sessionId}`);
  check(assertions, 'assignment created no execution (it is not a claim)',
    executionIdOf(assign) === undefined && (outcomeOf(assign)?.applied ?? []).every((entry) => entry.executionId === undefined),
    JSON.stringify(outcomeOf(assign)));

  // 4. Handover: the subagent claims and writes; the Lead still cannot write.
  const childClaim = opCalls(child, 'claim', 't1')[1];
  const childWrite = callsOf(child, 'write').find((call) => call.input?.file_path === 'child-work.txt');
  const leadBlockedWrite = callsOf(lead, 'write').find((call) => call.input?.file_path === 'lead-after-handover.txt');
  check(assertions, 'the subagent claimed t1 after assignment', childClaim?.status === 'completed',
    childClaim === undefined ? 'no second subagent claim call' : `status=${childClaim?.status} result=${JSON.stringify(childClaim?.result)}`);
  check(assertions, 'the subagent wrote while holding the seat', childWrite?.status === 'completed'
    && (await exists(workdir, 'child-work.txt')) === 'the subagent wrote while holding the seat\n',
    childWrite === undefined ? 'no subagent write call' : `status=${childWrite?.status}`);
  check(assertions, 'the Lead could not write during the handover',
    leadBlockedWrite?.status === 'error'
    && typeof leadBlockedWrite.result === 'string'
    && leadBlockedWrite.result.includes('holds no active execution'),
    leadBlockedWrite === undefined ? 'no lead write call' : `status=${leadBlockedWrite?.status} result=${JSON.stringify(leadBlockedWrite?.result)}`);
  check(assertions, 'the refused Lead write left no file', (await exists(workdir, 'lead-after-handover.txt')) === undefined, 'lead-after-handover.txt');
  const childRelease = opCalls(child, 'release', 't1')[0];
  check(assertions, 'the subagent released the seat at the end of its turn', childRelease?.status === 'completed', `status=${childRelease?.status}`);

  // 5. The Lead takes the seat back with a NEW execution id.
  const reclaim = opCalls(lead, 'claim', 't1')[1];
  const firstId = executionIdOf(leadFirstClaim);
  const reclaimId = executionIdOf(reclaim);
  check(assertions, 'the Lead reclaimed t1 after the subagent ended', reclaim?.status === 'completed',
    reclaim === undefined ? 'no reclaim call' : `status=${reclaim?.status} result=${JSON.stringify(reclaim?.result)}`);
  check(assertions, 'the reclaim produced a NEW execution id, not the ended one',
    typeof firstId === 'string' && typeof reclaimId === 'string' && firstId !== reclaimId,
    `first=${JSON.stringify(firstId)} reclaim=${JSON.stringify(reclaimId)}`);
  check(assertions, 'the Lead wrote again after reclaiming', (await exists(workdir, 'lead-reclaimed.txt')) === 'the lead holds the seat again\n', 'lead-reclaimed.txt');

  // 6. Three sequential tasks: three distinct execution ids.
  const secondClaim = opCalls(lead, 'claim', 't2')[0];
  const thirdClaim = opCalls(lead, 'claim', 't3')[0];
  const ids = [leadFirstClaim, secondClaim, thirdClaim].map(executionIdOf);
  check(assertions, 'three sequential tasks got three distinct execution ids',
    ids.every((id) => typeof id === 'string') && new Set(ids).size === 3,
    JSON.stringify(ids));

  // The persisted tree is the fact source for the execution ledger.
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
  const t1Executions = executions.filter((execution) => execution.taskId === 't1');
  check(assertions, 'the tree file records every execution with its own id',
    t1Executions.length >= 3 && new Set(executions.map((execution) => execution.executionId)).size === executions.length,
    `${executions.length} execution(s): ${executions.map((execution) => execution.executionId).join(', ')}`);
  check(assertions, 'an ended execution is terminal and keeps its end reason',
    t1Executions.length >= 3
    && t1Executions.every((execution) => execution.state === 'ended' && typeof execution.endedAt === 'number' && typeof execution.endReason === 'string'),
    JSON.stringify(t1Executions.map((execution) => [execution.executionId, execution.state, execution.endReason])));
  check(assertions, 'no execution is left active after the final releases',
    executions.every((execution) => execution.state === 'ended'),
    JSON.stringify(executions.filter((execution) => execution.state !== 'ended')));
  check(assertions, 'the reclaim id is the child-claimed and newly created id',
    t1Executions.some((execution) => execution.executionId === reclaimId && execution.sessionId === lead?.sessionId)
    && t1Executions.some((execution) => execution.executionId === firstId && execution.endReason === 'released'),
    JSON.stringify(t1Executions.map((execution) => [execution.executionId, execution.sessionId, execution.endReason])));
  check(assertions, 'the persisted tasks stayed in progress and t1 ends assigned back to the Lead',
    (tree?.tasks ?? []).every((task) => task.status === 'in_progress')
    && (tree?.tasks ?? []).find((task) => task.id === 't1')?.assignee === 'lead',
    JSON.stringify((tree?.tasks ?? []).map((task) => [task.id, task.status, task.assignee])));

  return assertions;
}
