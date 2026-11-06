/**
 * Concurrent execution seats in standard mode (ticket #9, design v8 I3/I14).
 *
 * The whole workline shares ONE execution seat, so two claims that are truly in
 * flight at the same instant must not both win — whoever the executor is. The
 * seat is taken synchronously in the guard, before dispatch, and released only
 * by real end-of-call evidence; a timer may only mark a seat suspect.
 *
 * A scripted model cannot make two of its own tool calls overlap, so the
 * harness probe performs two real `task_tree_write` executions at the same
 * instant, each with a live session's own Agent. Everything after the probe is
 * the product: the pre-execute policy, the monotonic guard, the real file
 * store, the persisted tree. One real DSH process proves:
 *
 *   (a) one session racing for two tasks -> one win, one seat refusal;
 *   (b) a held seat refuses a third claim;
 *   (c) the seat frees when the call ends: a claim the model refused does not
 *       block the retry that follows it;
 *   (d) the Lead and a real subagent racing for two tasks -> one winner, so the
 *       single seat cannot be double-booked by a handover either.
 */

export const name = 'seat-standard';
export const summary = 'Standard-mode single seat: concurrent claims produce one winner, the Lead and a subagent cannot start together, and the seat frees on the tool result';
export const team = false;
export const prompt = 'Prove the standard-mode single execution seat under concurrency: race two claims, refuse a third, show the seat frees after a refused claim, then race the Lead and a real subagent. Use "prove the single seat" as the approval basis.';

const APPROVED_TASK = (title, summary, status = 'in_progress') => ({
  op: 'create',
  title,
  summary,
  executionApproval: 'approved',
  approvalBasis: 'prove the single seat',
  status,
});

/** One claim of one task, expressed as a `task_tree_write` call. */
const claim = (taskId) => ({ tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: taskId }] } });

/** One probe call for the given claim calls, all dispatched at the same instant. */
const race = (...calls) => ({ tool: 'team_task_race', arguments: { calls } });

export const program = [
  // 1. One workline; t4 stays pending so a claim on it is refused by the model.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove the standard-mode single execution seat' },
        APPROVED_TASK('Seat one', 'the winning task of the two-task race'),
        APPROVED_TASK('Seat two', 'the losing task of the two-task race'),
        APPROVED_TASK('Seat three', 'refused while the seat is held'),
        APPROVED_TASK('Seat four', 'a pending task a claim cannot start', 'pending'),
        APPROVED_TASK('Seat five', 'retried after a refused claim'),
        APPROVED_TASK('Seat six', 'raced by the Lead'),
        APPROVED_TASK('Seat seven', 'raced by the subagent'),
      ],
    },
  },
  // 2. Spawning a subagent is class A, so the Lead must hold the seat while it
  //    does that; the seat is handed back before the races begin.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't1' }] } },
  { tool: 'subagent', arguments: { description: 'seat rival', prompt: 'Stand by, then race the Lead for the seat.' } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1' }] } },
  // 3. (a) One session, two tasks, one instant.
  race(claim('t1'), claim('t2')),
  // 4. (b) The committed execution holds the seat: a third claim is refused.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't3' }] } },
  // 5. Free the seat before the next race.
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't1' }] } },
  // 6. (c) A claim the model refuses and a valid concurrent claim: the refused
  //    call must release its seat, so the retry on the next call succeeds.
  race(claim('t4'), claim('t5')),
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'claim', id: 't5' }] } },
  { tool: 'task_tree_write', arguments: { ops: [{ op: 'release', id: 't5' }] } },
  // 7. (d) The subagent owns t7; the Lead may claim t6. The subagent runs the
  //    race probe during its own second turn, so both live Agents dispatch
  //    their claim at the same instant.
  { waitForSubagentTurns: 1, tool: 'task_tree_write', arguments: { ops: [{ op: 'assign', id: 't7', member: '{{subagentId}}' }] } },
  { tool: 'send_message', arguments: { agent_id: '{{subagentId}}', message: 'Race your claim of t7 against the Lead claim of t6 now.' } },
  { waitForSubagentTurns: 2, tool: 'task_tree_read', arguments: {} },
  { text: 'single seat exercised' },
];

export const subagentProgram = [
  { text: 'standing by for the seat race' },
  race(
    claim('t7'),
    { tool: 'task_tree_write', member: 'lead', arguments: { ops: [{ op: 'claim', id: 't6' }] } },
  ),
  { text: 'raced the Lead for the seat' },
];

/** Every session record from the in-process transcript. */
function sessionsOf(artefacts) {
  return artefacts.toolTranscript?.present === true ? artefacts.toolTranscript.sessions : [];
}

/** A session by origin (`lead` or `subagent`). */
function sessionOf(artefacts, origin) {
  return sessionsOf(artefacts).find((session) => (origin === 'subagent'
    ? session.header?.origin === 'subagent'
    : session.header?.origin !== 'subagent'));
}

/** Calls of one tool in one session, in call order. */
function callsOf(session, tool) {
  return (session?.calls ?? []).filter((call) => call.tool === tool);
}

/** The probe calls whose inner calls address exactly these task ids, in order. */
function raceCalls(session, ...taskIds) {
  return callsOf(session, 'team_task_race').filter((call) => Array.isArray(call.input?.calls)
    && taskIds.every((taskId) => call.input.calls.some((entry) => entry.arguments?.ops?.some((op) => op.id === taskId))));
}

/** The parsed `{ ok, applied }` payload one task_tree_write call returned. */
function writeOutcome(call) {
  if (call === undefined || typeof call.result !== 'string') return undefined;
  try {
    return JSON.parse(call.result);
  } catch {
    return undefined;
  }
}

/** The parsed `{ results }` payload one probe call returned. */
function raceResults(call) {
  if (call === undefined || typeof call.result !== 'string') return undefined;
  try {
    const payload = JSON.parse(call.result);
    return Array.isArray(payload?.results) ? payload.results : undefined;
  } catch {
    return undefined;
  }
}

/** The one call of a tool in a session whose arguments match a predicate. */
function callMatching(session, tool, match) {
  return callsOf(session, tool).find((call) => match(call.input ?? {}));
}

function check(assertions, label, ok, detail) {
  assertions.push({ label, ok, detail });
}

/** A seat refusal: the guard refused before the tree changed, naming the in-flight call. */
function isSeatRefusal(result) {
  return result !== undefined
    && result.ok === false
    && typeof result.text === 'string'
    && result.text.includes('reserved by an in-flight call')
    && result.text.includes('seat');
}

export async function verify({ artefacts }) {
  const assertions = [];
  const lead = sessionOf(artefacts, 'lead');
  const child = sessionOf(artefacts, 'subagent');
  check(assertions, 'the run produced a real Lead session and a real subagent',
    lead !== undefined && child !== undefined,
    child === undefined ? 'no subagent session recorded' : `lead=${lead?.sessionId} child=${child.sessionId}`);
  if (lead === undefined) return assertions;

  // (a) One session, two tasks, one instant.
  const twoTaskRace = raceResults(raceCalls(lead, 't1', 't2')[0]);
  const lost = twoTaskRace?.find((result) => result.ok === false);
  check(assertions, 'one session racing for two tasks won exactly one claim',
    Array.isArray(twoTaskRace) && twoTaskRace.length === 2
    && twoTaskRace.filter((result) => result.ok === true).length === 1,
    JSON.stringify(twoTaskRace));
  check(assertions, 'the losing concurrent claim was refused by the seat before the tree changed',
    isSeatRefusal(lost), JSON.stringify(lost));
  check(assertions, 'the winning claim is its own task, not the refused one',
    twoTaskRace?.find((result) => result.ok === true)?.index === 0, JSON.stringify(twoTaskRace));

  // (b) A held seat refuses a third claim.
  const third = callMatching(lead, 'task_tree_write', (input) => Array.isArray(input.ops)
    && input.ops.some((op) => op.op === 'claim' && op.id === 't3'));
  check(assertions, 'a held seat refused a third claim',
    third?.status === 'error' && typeof third.result === 'string' && /execution|holds execution/.test(third.result),
    third === undefined ? 'no third claim call' : `status=${third.status} result=${JSON.stringify(third.result)}`);

  // (c) The seat frees when the call ends.
  const failedRace = raceResults(raceCalls(lead, 't4')[0]);
  const retryClaims = callsOf(lead, 'task_tree_write').filter((call) => Array.isArray(call.input?.ops)
    && call.input.ops.some((op) => op.op === 'claim' && op.id === 't5'));
  const retried = writeOutcome(retryClaims[retryClaims.length - 1]);
  check(assertions, 'a refused claim and its concurrent claim produced exactly one seat refusal',
    Array.isArray(failedRace) && failedRace.filter((result) => isSeatRefusal(result)).length === 1,
    JSON.stringify(failedRace));
  check(assertions, 'after that call ended the seat was free, so the retry succeeded',
    retried?.ok === true, JSON.stringify(retried));

  // (d) The Lead and a real subagent racing for two tasks: one seat, one winner.
  const handoverRace = child === undefined ? undefined : raceResults(raceCalls(child, 't7', 't6')[0]);
  check(assertions, 'the Lead and a subagent racing for two tasks produced exactly one winner',
    Array.isArray(handoverRace) && handoverRace.length === 2
    && handoverRace.filter((result) => result.ok === true).length === 1,
    JSON.stringify(handoverRace));
  check(assertions, 'the second starter was refused by the seat before it could claim',
    Array.isArray(handoverRace) && handoverRace.filter((result) => isSeatRefusal(result)).length === 1,
    JSON.stringify(handoverRace));
  check(assertions, 'the probe ran one claim through the Lead and one through the live subagent',
    Array.isArray(handoverRace)
    && handoverRace.some((result) => result.agent === child?.sessionId)
    && handoverRace.some((result) => result.agent === lead?.sessionId),
    JSON.stringify(handoverRace));

  // The persisted tree is the index the guard consults.
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];
  const active = executions.filter((execution) => execution.state !== 'ended');
  check(assertions, 'the workline kept exactly one active execution through both races',
    active.length === 1 && ['t1', 't6', 't7'].includes(active[0].taskId),
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.taskId, execution.sessionId, execution.state])));
  check(assertions, 'every losing task has no owner and no active execution',
    ['t2', 't3', 't4'].every((taskId) => tasks.find((task) => task.id === taskId)?.owner === null)
    && (tasks.find((task) => task.id === 't6')?.owner === null || tasks.find((task) => task.id === 't7')?.owner === null)
    && active.every((execution) => !['t2', 't3', 't4'].includes(execution.taskId)),
    JSON.stringify(tasks.map((task) => [task.id, task.status, task.owner?.sessionId ?? null])));
  check(assertions, 'the retried claim produced its own execution id and ended on release',
    executions.filter((execution) => execution.taskId === 't5').length === 1
    && executions.filter((execution) => execution.taskId === 't5').every((execution) => execution.state === 'ended'
      && execution.endReason === 'released'),
    JSON.stringify(executions.filter((execution) => execution.taskId === 't5')));

  return assertions;
}
