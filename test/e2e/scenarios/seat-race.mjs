/**
 * Concurrent execution seats in team mode (ticket #9, design v8 I14/I15, §9).
 *
 * Two claims that are truly in flight at the same instant must not both win.
 * The seat is taken synchronously in the guard, before dispatch, and released
 * only by real end-of-call evidence — never by a timer, which may only mark a
 * seat suspect.
 *
 * A scripted model issues one tool call per step and cannot make two of its own
 * calls overlap, so the harness probe performs two real `team_task_update`
 * executions at the same instant, each with a live Worker's own Agent.
 * Everything after the probe is the product: the pre-execute policy, the
 * monotonic guard, the Team board's commit, the post-execute binding and the
 * persisted tree. One real DSH process proves:
 *
 *   (a) one Worker racing for two tasks -> one win, one seat refusal, and the
 *       losing task's board entry is never touched;
 *   (b) a held seat refuses a third claim;
 *   (c) two claims for the same board task -> one win, one seat refusal;
 *   (d) the seat frees when the call ends: a claim the board refused does not
 *       block the retry that follows it;
 *   (e) two Workers contending for one task -> one winner, one owner, one
 *       execution.
 */

export const name = 'seat-race';
export const summary = 'Concurrent claim seats: one winner per executor/task, a held seat refuses a third claim, and the seat frees on the tool result';
export const team = true;
export const prompt = 'Prove concurrent execution seats: race two claims of the same Worker for two tasks, refuse a third claim, race duplicate claims for one task, show the seat frees after a refused call, and let two Workers contend for one task. Use "prove concurrent seats" as the approval basis.';

const APPROVED_TASK = (title, summary) => ({
  op: 'create',
  title,
  summary,
  executionApproval: 'approved',
  approvalBasis: 'prove concurrent seats',
});

/** One Worker's own probe call for two claims on its two dispatched tasks. */
function workerRace(member, ...claims) {
  return {
    tool: 'team_task_race',
    arguments: { calls: claims.map(([taskId, revision]) => ({
      tool: 'team_task_update',
      member,
      arguments: { task_id: taskId, expected_revision: revision, action: 'claim' },
    })) },
  };
}

export const program = [
  // 1. Six board tasks, all pending at revision 1.
  ...['one', 'two', 'three', 'four', 'five', 'six'].map((label) => ({
    tool: 'team_task_create',
    arguments: { subject: `seat ${label}`, description: `board task claimed in the seat race (${label})` },
  })),
  // 2. The tree owns the user-side tasks and the routing records that make each
  //    Worker eligible for its board task.
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'init', originalGoal: 'Prove concurrent execution seats' },
        APPROVED_TASK('Seat one', 'the winning task of the two-task race'),
        APPROVED_TASK('Seat two', 'the losing task of the two-task race'),
        APPROVED_TASK('Seat three', 'refused while the Worker holds a seat'),
        APPROVED_TASK('Seat four', 'duplicate claims for one board task'),
        APPROVED_TASK('Seat five', 'retried after a refused claim'),
        APPROVED_TASK('Seat six', 'contended by two Workers'),
      ],
    },
  },
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [
        { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
        { op: 'dispatch', id: 't2', member: 'worker-a', teamTaskId: 'task-2' },
        { op: 'dispatch', id: 't3', member: 'worker-a', teamTaskId: 'task-3' },
        { op: 'dispatch', id: 't4', member: 'worker-b', teamTaskId: 'task-4' },
        { op: 'dispatch', id: 't5', member: 'worker-c', teamTaskId: 'task-5' },
        { op: 'dispatch', id: 't6', member: 'worker-d', teamTaskId: 'task-6' },
      ],
    },
  },
  // 3. Each Worker runs its own turn and races its own claims through the probe.
  { tool: 'spawn_teammate', arguments: { name: 'worker-a', description: 'races two tasks at once', prompt: 'Race your two tasks, then try a third claim.' } },
  { waitForTeammate: 'worker-a', tool: 'spawn_teammate', arguments: { name: 'worker-b', description: 'races a duplicate claim', prompt: 'Race two claims for one task.' } },
  { waitForTeammate: 'worker-b', tool: 'spawn_teammate', arguments: { name: 'worker-c', description: 'retries after a refused claim', prompt: 'Claim the task with a stale revision, then retry.' } },
  { waitForTeammate: 'worker-c', tool: 'spawn_teammate', arguments: { name: 'worker-d', description: 'contends for task-6', prompt: 'Claim your task.' } },
  { waitForTeammate: 'worker-d', tool: 'spawn_teammate', arguments: { name: 'worker-e', description: 'contends for task-6', prompt: 'Try to claim the task that is not yours.' } },
  { waitForTeammate: 'worker-e', tool: 'task_tree_read', arguments: {} },
  { text: 'concurrent seats exercised' },
];

export const teamResponses = {
  // (a) One Worker, two tasks, one instant; then (b) a third claim.
  'worker-a': [
    workerRace('worker-a', ['task-1', 1], ['task-2', 1]),
    workerRace('worker-a', ['task-3', 1]),
    { text: 'worker-a raced its two tasks' },
  ],
  // (c) Two claims for the SAME board task at one instant.
  'worker-b': [
    workerRace('worker-b', ['task-4', 1], ['task-4', 1]),
    { text: 'worker-b raced a duplicate claim' },
  ],
  // (d) A claim the board refuses must release its seat for the retry.
  'worker-c': [
    workerRace('worker-c', ['task-5', 99]),
    workerRace('worker-c', ['task-5', 1]),
    { text: 'worker-c retried after a refused claim' },
  ],
  // (e) Two Workers contend for one board task; only the dispatched one wins.
  'worker-d': [
    { tool: 'team_task_update', arguments: { task_id: 'task-6', expected_revision: 1, action: 'claim' } },
    { text: 'worker-d claimed task-6' },
  ],
  'worker-e': [
    { tool: 'team_task_update', arguments: { task_id: 'task-6', expected_revision: 1, action: 'claim' } },
    { text: 'worker-e was refused task-6' },
  ],
};

/** Every session record from the in-process transcript. */
function sessionsOf(artefacts) {
  return artefacts.toolTranscript?.present === true ? artefacts.toolTranscript.sessions : [];
}

/** The Lead's session record: the only one that is not a subagent. */
function leadSession(artefacts) {
  return sessionsOf(artefacts).find((session) => session.header?.origin !== 'subagent');
}

/** The Worker session that ran the probe addressing these board tasks. */
function workerSession(artefacts, ...taskIds) {
  return sessionsOf(artefacts).find((session) => (session.calls ?? []).some((call) => call.tool === 'team_task_race'
    && taskIds.every((taskId) => (call.input?.calls ?? []).some((entry) => entry.arguments?.task_id === taskId))));
}

/** Calls of one tool in one session, in call order. */
function callsOf(session, tool) {
  return (session?.calls ?? []).filter((call) => call.tool === tool);
}

/** The probe calls whose inner calls address exactly these board tasks, in order. */
function raceCalls(session, ...taskIds) {
  return callsOf(session, 'team_task_race').filter((call) => Array.isArray(call.input?.calls)
    && taskIds.every((taskId) => call.input.calls.some((entry) => entry.arguments?.task_id === taskId)));
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

/** Read one Team-board task from the probe's snapshot. */
function boardTask(artefacts, id) {
  const board = artefacts.teamBoard;
  const tasks = board?.present === true && Array.isArray(board.tasks) ? board.tasks : [];
  return tasks.find((task) => task.id === id);
}

function check(assertions, label, ok, detail) {
  assertions.push({ label, ok, detail });
}

/** A seat refusal: the guard refused before the board, naming the in-flight call. */
function isSeatRefusal(result) {
  return result !== undefined
    && result.ok === false
    && typeof result.text === 'string'
    && result.text.includes('reserved by an in-flight call')
    && result.text.includes('seat');
}

export async function verify({ artefacts }) {
  const assertions = [];
  const lead = leadSession(artefacts);
  const workerA = workerSession(artefacts, 'task-1');
  const workerB = workerSession(artefacts, 'task-4');
  const workerC = workerSession(artefacts, 'task-5');
  const workerD = sessionsOf(artefacts).find((session) => (session.calls ?? []).some((call) => call.tool === 'team_task_update'
    && call.input?.task_id === 'task-6' && call.status === 'completed'));
  check(assertions, 'the run produced a Lead and five real Workers',
    lead !== undefined && workerA !== undefined && workerB !== undefined && workerC !== undefined && workerD !== undefined,
    `lead=${lead?.sessionId} a=${workerA?.sessionId} b=${workerB?.sessionId} c=${workerC?.sessionId} d=${workerD?.sessionId}`);
  if (lead === undefined || workerA === undefined || workerB === undefined || workerC === undefined || workerD === undefined) return assertions;

  // (a) One Worker, two tasks, one instant.
  const twoTaskRace = raceResults(raceCalls(workerA, 'task-1', 'task-2')[0]);
  const won = twoTaskRace?.find((result) => result.ok === true);
  const lost = twoTaskRace?.find((result) => result.ok === false);
  check(assertions, 'one Worker racing for two tasks won exactly one claim',
    Array.isArray(twoTaskRace) && twoTaskRace.length === 2
    && twoTaskRace.filter((result) => result.ok === true).length === 1,
    JSON.stringify(twoTaskRace));
  check(assertions, 'the losing concurrent claim was refused by the seat before the board',
    isSeatRefusal(lost), JSON.stringify(lost));
  check(assertions, 'the winning claim is its own board task, not the refused one',
    won?.index === 0, JSON.stringify(won));
  check(assertions, 'the winning task is claimed on the Team board and the losing task was never touched',
    boardTask(artefacts, 'task-1')?.status === 'in_progress'
    && boardTask(artefacts, 'task-1')?.ownerName === 'worker-a'
    && boardTask(artefacts, 'task-1')?.revision === 2
    && boardTask(artefacts, 'task-2')?.status === 'pending'
    && boardTask(artefacts, 'task-2')?.revision === 1
    && boardTask(artefacts, 'task-2')?.ownerName == null,
    JSON.stringify(['task-1', 'task-2'].map((id) => boardTask(artefacts, id))));

  // (b) A held seat refuses a third claim.
  const third = raceResults(raceCalls(workerA, 'task-3')[0])?.[0];
  check(assertions, 'a held seat refused a third claim', third !== undefined && third.ok === false, JSON.stringify(third));
  check(assertions, 'the refused third claim left its board task pending',
    boardTask(artefacts, 'task-3')?.status === 'pending' && boardTask(artefacts, 'task-3')?.revision === 1,
    JSON.stringify(boardTask(artefacts, 'task-3')));

  // (c) Two claims for the same board task at one instant.
  const duplicateRace = raceResults(raceCalls(workerB, 'task-4')[0]);
  check(assertions, 'two claims for the same task at one instant produced exactly one winner',
    Array.isArray(duplicateRace) && duplicateRace.length === 2
    && duplicateRace.filter((result) => result.ok === true).length === 1,
    JSON.stringify(duplicateRace));
  check(assertions, 'the duplicate claim was refused by the seat, not by a board revision error',
    duplicateRace?.some((result) => isSeatRefusal(result)), JSON.stringify(duplicateRace));
  check(assertions, 'the duplicate task is claimed exactly once on the board',
    boardTask(artefacts, 'task-4')?.status === 'in_progress'
    && boardTask(artefacts, 'task-4')?.ownerName === 'worker-b'
    && boardTask(artefacts, 'task-4')?.revision === 2,
    JSON.stringify(boardTask(artefacts, 'task-4')));

  // (d) The seat frees when the call ends.
  const taskFiveCalls = raceCalls(workerC, 'task-5');
  const doomed = raceResults(taskFiveCalls[0])?.[0];
  const retried = raceResults(taskFiveCalls[1])?.[0];
  check(assertions, 'the board refused the claim with a stale revision', doomed !== undefined && doomed.ok === false, JSON.stringify(doomed));
  check(assertions, 'after that call ended the seat was free, so the retry succeeded',
    retried !== undefined && retried.ok === true, JSON.stringify(retried));

  // (e) Two Workers contending for one task.
  const workerE = sessionsOf(artefacts).find((session) => (session.calls ?? []).some((call) => call.tool === 'team_task_update'
    && call.input?.task_id === 'task-6' && call.status === 'error'));
  const contended = callMatching(workerD, 'team_task_update', (input) => input.task_id === 'task-6');
  check(assertions, 'two Workers contending for one task produced one owner',
    contended?.status === 'completed' && boardTask(artefacts, 'task-6')?.ownerName === 'worker-d'
    && boardTask(artefacts, 'task-6')?.status === 'in_progress',
    JSON.stringify(boardTask(artefacts, 'task-6')));
  check(assertions, 'the other Worker was refused that task and no file was written',
    workerE !== undefined && typeof workerE.calls.find((call) => call.input?.task_id === 'task-6')?.result === 'string'
    && workerE.calls.find((call) => call.input?.task_id === 'task-6').result.includes('Only a Worker the Lead dispatched may claim'),
    workerE === undefined ? 'no second Worker session' : JSON.stringify(workerE.calls.map((call) => [call.tool, call.status, call.result])));

  // The persisted ledger is the index the guard consults.
  const tree = artefacts.taskTree.present === true ? artefacts.taskTree.tree : undefined;
  const executions = Array.isArray(tree?.workline?.executions) ? tree.workline.executions : [];
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];
  const active = executions.filter((execution) => execution.state !== 'ended');
  check(assertions, 'the ledger holds exactly one active team execution per winning task',
    active.length === 4
    && ['t1', 't4', 't5', 't6'].every((taskId) => active.filter((execution) => execution.taskId === taskId).length === 1)
    && active.every((execution) => execution.mode === 'team' && typeof execution.member === 'string'),
    JSON.stringify(executions.map((execution) => [execution.executionId, execution.taskId, execution.member, execution.state])));
  check(assertions, 'no execution was written for the refused tasks or for the Lead',
    active.every((execution) => !['t2', 't3'].includes(execution.taskId))
    && tasks.find((task) => task.id === 't2')?.owner === null
    && tasks.find((task) => task.id === 't3')?.owner === null
    && executions.every((execution) => execution.sessionId !== lead.sessionId),
    JSON.stringify(tasks.map((task) => [task.id, task.status, task.owner?.member ?? null])));
  check(assertions, 'the tree kept every refused task pending with its dispatch intact',
    ['t2', 't3'].every((taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      return task?.status === 'pending' && task?.dispatch !== null && task?.owner === null;
    }),
    JSON.stringify(tasks.map((task) => [task.id, task.status, task.dispatch, task.owner])));

  return assertions;
}
