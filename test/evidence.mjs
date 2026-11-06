/**
 * Claim-evidence tests: the intent journal, crash convergence, conflicts, and
 * the executionId guard (design v8 §7, §8, I12, I17; ticket #8).
 *
 * These are regression guards over the pure pieces; the functional proof lives
 * in the real-process e2e scenarios (`crash-reconcile`, `evidence-conflict`,
 * `execution-evidence`). Run with `node test/evidence.mjs`.
 */

import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyOps, bindTeamClaim, cloneEnvelope, forceReleaseReadiness, httpSnapshot, markInterrupted,
  readSnapshot, recordConflict, unresolvedConflictFor,
} from '../host/model.js';
import { appendIntent, journalPath, readJournal, unsettledIntents } from '../host/journal.js';
import { convergeWorkline } from '../host/reconcile.js';
import { createTaskStore } from '../host/store.js';
import { createExecutionGuard } from '../host/guard.js';
import { endWorkerLifetime, workerLifetimeOf } from '../host/lifetime.js';

const NOW = 1_700_000_000_000;
const CTX = {
  worklineId: 'session-root',
  now: NOW,
  actorSessionId: 'session-root',
  isLive: () => true,
  verifyUserQuote: () => ({ ok: true, seq: 1, time: NOW - 60_000 }),
};
const TEAM = { standardMode: false };

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'sp-evidence-'));
}

function envelopeAfter(envelope, ops, context = {}) {
  return applyOps(envelope, ops, { ...CTX, ...context });
}

/** A team workline with one task dispatched to worker-a on board task-1. */
function dispatchedWorkline() {
  return envelopeAfter(undefined, [
    { op: 'init', originalGoal: '证据' },
    { op: 'create', title: '任务', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
  ], TEAM).envelope;
}

const BOARD_CLAIMED = { tasks: [{ id: 'task-1', status: 'in_progress', ownerName: 'worker-a', revision: 2 }] };

const INTENT = {
  requestId: 'call-1',
  state: 'prepared',
  intent: 'claim',
  taskId: 't1',
  teamTaskId: 'task-1',
  sessionId: 'worker-session',
  member: 'worker-a',
  revisionBefore: 1,
  at: NOW,
};

// ---------------------------------------------------------------------------
// journal: durable, append-only, torn lines ignored
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  assert.equal(journalPath(root, '../escape'), undefined, 'a bad workline id has no journal file');
  const empty = readJournal(root, 'session-root');
  assert.equal(empty.present, false, 'no journal yet');
  assert.deepEqual(empty.entries, []);

  assert.equal(appendIntent(root, 'session-root', INTENT), true, 'the intent was appended');
  assert.equal(appendIntent(root, 'session-root', INTENT), true, 'a second entry is allowed');
  const read = readJournal(root, 'session-root');
  assert.equal(read.present, true);
  assert.equal(read.entries.length, 2);
  assert.equal(read.entries[0].requestId, 'call-1');
  assert.equal(unsettledIntents(read.entries, 't1').length, 1, 'the same intent is returned once');
  assert.deepEqual(unsettledIntents(read.entries, 't2'), [], 'another task has no intent');

  // A torn final line (the crash this journal exists for) is ignored, and does
  // not hide the entries that were fully written.
  appendFileSync(journalPath(root, 'session-root'), '{"requestId":"call-2","sta');
  const torn = readJournal(root, 'session-root');
  assert.equal(torn.entries.length, 2);
  assert.equal(torn.unparsed.length, 1);

  // Settling by request id settles exactly that claim.
  appendIntent(root, 'session-root', { requestId: 'call-1', state: 'committed', executionId: 'ex-1', at: NOW });
  const settled = readJournal(root, 'session-root');
  assert.deepEqual(unsettledIntents(settled.entries), [], 'a settled intent is not pending');
  assert.equal(settled.entries.at(-1).state, 'committed');
  // A claim that cannot be written is reported, never thrown.
  assert.equal(appendIntent(undefined, 'session-root', INTENT), false);
  assert.equal(appendIntent(root, 'session-root', { state: 'prepared' }), false, 'an entry without a request id is not a record');
}

// ---------------------------------------------------------------------------
// convergence: an intent + the board's revision advance rebuild exactly one
// execution, and the three mirrors agree
// ---------------------------------------------------------------------------

{
  const before = dispatchedWorkline();
  const converged = convergeWorkline(before, {
    now: NOW, teamMode: true, board: BOARD_CLAIMED, journal: [INTENT],
  });
  assert.equal(converged.changed, true);
  assert.deepEqual(converged.conflicts, [], 'a provable claim is not a conflict');
  const executions = converged.envelope.workline.executions;
  assert.equal(executions.length, 1, 'exactly one execution was rebuilt');
  assert.equal(executions[0].executionId, 'ex-1');
  assert.equal(executions[0].state, 'active');
  assert.equal(executions[0].mode, 'team');
  assert.equal(executions[0].claimRevision, 2);
  assert.equal(executions[0].sessionId, 'worker-session');
  assert.equal(executions[0].member, 'worker-a');
  assert.equal(executions[0].requestId, 'call-1');
  assert.equal(executions[0].rebuiltFrom, 'wal', 'the design value for a rebuilt row is wal');
  const task = converged.envelope.tasks[0];
  assert.equal(task.status, 'in_progress', 'the rebuilt claim starts the task');
  assert.equal(task.owner.executionId, 'ex-1', 'the stamp is the third mirror');
  assert.equal(task.owner.sessionId, 'worker-session');
  assert.equal(task.dispatch, null, 'the dispatch is consumed by the claim');
  const worker = workerLifetimeOf(converged.envelope.workline, 'worker-session');
  assert.equal(worker.state, 'bound', 'the lifetime record is the second mirror');
  assert.equal(worker.executionId, 'ex-1');
  assert.deepEqual(converged.decisions, [{ requestId: 'call-1', state: 'committed', executionId: 'ex-1', at: NOW, reconciled: true }]);

  // The same pass over the converged record changes nothing: convergence is
  // idempotent, which is what a second restart relies on.
  const again = convergeWorkline(converged.envelope, {
    now: NOW + 1, teamMode: true, board: BOARD_CLAIMED, journal: [],
  });
  assert.equal(again.changed, false, 'a second restart finds nothing left to converge');
  assert.equal(again.envelope.workline.executions.length, 1);
}

// ---------------------------------------------------------------------------
// convergence: an intent whose ledger row already exists is settled, even when
// the crash landed between the ledger write and the journal's committed entry
// ---------------------------------------------------------------------------

{
  const bound = bindTeamClaim(dispatchedWorkline(), {
    taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-a', revision: 2,
    requestId: 'call-9', now: NOW,
  }).envelope;
  const settled = convergeWorkline(bound, {
    now: NOW + 5,
    teamMode: true,
    board: BOARD_CLAIMED,
    journal: [{ ...INTENT, requestId: 'call-9' }],
  });
  assert.equal(settled.changed, false, 'a consistent workline is not rewritten');
  assert.deepEqual(settled.decisions, [{ requestId: 'call-9', state: 'committed', executionId: 'ex-1', at: NOW + 5 }]);
  assert.deepEqual(settled.conflicts, []);
}

// ---------------------------------------------------------------------------
// convergence: the board owns a task that no intent proves -> conflict
// ---------------------------------------------------------------------------

{
  const before = dispatchedWorkline();
  const converged = convergeWorkline(before, {
    now: NOW, teamMode: true, board: BOARD_CLAIMED, journal: [],
  });
  assert.equal(converged.envelope.workline.executions.length, 0, 'no execution is invented');
  assert.equal(converged.conflicts.length, 1);
  const conflict = converged.conflicts[0];
  assert.equal(conflict.kind, 'unproven-claim');
  assert.equal(conflict.taskId, 't1');
  assert.equal(conflict.scope, 'task');
  assert.equal(conflict.resolvedAt, null);
  assert.equal(conflict.evidence.boardRevision, 2);
  assert.equal(conflict.evidence.ownerName, 'worker-a');
  assert.equal(conflict.evidence.journal, 'no intent');
  assert.equal(converged.envelope.tasks[0].owner, null, 'the task stays unowned');
  assert.equal(converged.envelope.tasks[0].status, 'pending');

  // A second pass records the SAME conflict instead of a new one.
  const again = convergeWorkline(converged.envelope, {
    now: NOW + 1, teamMode: true, board: BOARD_CLAIMED, journal: [],
  });
  assert.equal(again.envelope.workline.conflicts.length, 1, 'the identical contradiction is recorded once');
  assert.equal(again.conflicts.length, 0, 'no new conflict is reported');
}

// ---------------------------------------------------------------------------
// convergence: a revision jump, an owner mismatch, and an ended Worker are all
// contradictory; a revision that did not advance is a stale intent
// ---------------------------------------------------------------------------

{
  const jumped = convergeWorkline(dispatchedWorkline(), {
    now: NOW,
    teamMode: true,
    board: { tasks: [{ id: 'task-1', status: 'in_progress', ownerName: 'worker-a', revision: 4 }] },
    journal: [INTENT],
  });
  assert.equal(jumped.envelope.workline.executions.length, 0, 'a jump of more than one is never rebuilt');
  assert.match(jumped.conflicts[0].evidence.reason, /revision moved by more than one/);

  const otherOwner = convergeWorkline(dispatchedWorkline(), {
    now: NOW,
    teamMode: true,
    board: { tasks: [{ id: 'task-1', status: 'in_progress', ownerName: 'worker-b', revision: 2 }] },
    journal: [INTENT],
  });
  assert.equal(otherOwner.envelope.workline.executions.length, 0);
  assert.match(otherOwner.conflicts[0].evidence.reason, /owner mismatch/);

  const endedWorker = convergeWorkline({
    ...dispatchedWorkline(),
    workline: {
      ...dispatchedWorkline().workline,
      workers: {
        'worker-session': {
          kind: 'teammate', name: 'worker-a', state: 'ended', boundTaskId: null, executionId: null,
        },
      },
    },
  }, {
    now: NOW, teamMode: true, board: BOARD_CLAIMED, journal: [INTENT],
  });
  assert.equal(endedWorker.envelope.workline.executions.length, 0, 'an ended Worker is never revived');
  assert.equal(endedWorker.conflicts[0].kind, 'ended-but-owned');

  const stale = convergeWorkline(dispatchedWorkline(), {
    now: NOW,
    teamMode: true,
    board: { tasks: [{ id: 'task-1', status: 'in_progress', ownerName: 'worker-a', revision: 1 }] },
    journal: [INTENT],
  });
  assert.equal(stale.envelope.workline.executions.length, 0);
  assert.deepEqual(stale.conflicts, [], 'a claim that never reached the board is not a conflict');
  assert.deepEqual(stale.decisions, [{ requestId: 'call-1', state: 'aborted', at: NOW, reason: 'board revision did not advance' }]);
}

// ---------------------------------------------------------------------------
// convergence: closed tasks and board completions end their execution
// ---------------------------------------------------------------------------

{
  // A done task may keep no non-terminal execution (design I8). The tree rules
  // already refuse to close a held task, so this record is the safety net for
  // one that reached that state by another path (an older build, a repaired
  // file): reconciliation ends the execution instead of granting it.
  const bound = bindTeamClaim(dispatchedWorkline(), {
    taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW,
  }).envelope;
  const closed = cloneEnvelope(bound);
  closed.tasks[0].status = 'done';
  closed.tasks[0].completion = 'self';
  const converged = convergeWorkline(closed, {
    now: NOW + 1, teamMode: true, board: BOARD_CLAIMED, journal: [],
  });
  assert.equal(converged.envelope.workline.executions[0].state, 'ended', 'a closed task cannot hold an execution');
  assert.equal(converged.envelope.tasks[0].owner, null);
  assert.equal(workerLifetimeOf(converged.envelope.workline, 'worker-session').state, 'ended');
}

{
  // The board completed the task but the ledger write never happened (the same
  // crash window in the other direction).
  const bound = bindTeamClaim(dispatchedWorkline(), {
    taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW,
  }).envelope;
  const converged = convergeWorkline(bound, {
    now: NOW + 2,
    teamMode: true,
    board: { tasks: [{ id: 'task-1', status: 'completed', ownerName: 'worker-a', revision: 3 }] },
    journal: [],
  });
  assert.equal(converged.envelope.workline.executions[0].state, 'ended');
  assert.equal(converged.envelope.workline.executions[0].endReason, 'completed');
  assert.equal(converged.envelope.tasks[0].owner, null, 'the stale stamp is cleared');
  assert.equal(converged.envelope.tasks[0].status, 'in_progress', 'accepting the delivery is still the Lead\'s act');
}

// ---------------------------------------------------------------------------
// I17: reconciliation never clears a newer round
// ---------------------------------------------------------------------------

{
  // Round ex-1 is the one reconciliation inspects (the board completed it), but
  // the Worker's lifetime record has already moved on to a newer round. Ending
  // ex-1 must not end the current binding.
  const bound = bindTeamClaim(dispatchedWorkline(), {
    taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW,
  }).envelope;
  const carried = cloneEnvelope(bound);
  carried.workline.workers['worker-session'] = {
    ...carried.workline.workers['worker-session'],
    state: 'bound',
    executionId: 'ex-9',
    boundTaskId: 't1',
  };
  const converged = convergeWorkline(carried, {
    now: NOW + 3,
    teamMode: true,
    board: { tasks: [{ id: 'task-1', status: 'completed', ownerName: 'worker-a', revision: 3 }] },
    journal: [],
  });
  const worker = converged.envelope.workline.workers['worker-session'];
  assert.equal(worker.state, 'bound', 'the newer round keeps its binding');
  assert.equal(worker.executionId, 'ex-9');
  // The old ledger row is still ended; only the worker record is protected.
  assert.equal(converged.envelope.workline.executions[0].executionId, 'ex-1');
  assert.equal(converged.envelope.workline.executions[0].state, 'ended');
}

{
  // The same guard at its own seam: an end for an older execution is a no-op.
  const workline = dispatchedWorkline().workline;
  workline.workers = {
    'worker-session': {
      kind: 'teammate', name: 'worker-a', state: 'bound', boundTaskId: 't1', executionId: 'ex-2',
    },
  };
  assert.equal(endWorkerLifetime(workline, {
    sessionId: 'worker-session', leadSessionId: 'session-root', reason: 'reconciled', executionId: 'ex-1', now: NOW,
  }), undefined, 'a stale end does not touch the newer execution');
  assert.equal(workline.workers['worker-session'].state, 'bound');
  assert.equal(workline.workers['worker-session'].executionId, 'ex-2');
}

// ---------------------------------------------------------------------------
// conflicts stop claims in both models, and survive a ledger rewrite
// ---------------------------------------------------------------------------

{
  const before = dispatchedWorkline();
  recordConflict(before.workline, {
    kind: 'unproven-claim', taskId: 't1', evidence: { boardRevision: 2 }, now: NOW,
  });
  assert.equal(unresolvedConflictFor(before.workline, 't1')?.kind, 'unproven-claim');
  assert.equal(unresolvedConflictFor(before.workline, 't2'), undefined, 'another task is not stopped');
  assert.throws(
    () => bindTeamClaim(before, {
      taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW,
    }),
    /stopped by conflict/,
    'a proven claim is still refused while the evidence is contradictory',
  );

  // A workline-scoped conflict stops every task.
  const wide = dispatchedWorkline();
  recordConflict(wide.workline, { kind: 'seat-ambiguous', scope: 'workline', now: NOW });
  assert.equal(unresolvedConflictFor(wide.workline, 't1')?.kind, 'seat-ambiguous');

  // A standard-mode claim is stopped too.
  const standard = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '标准' },
    { op: 'create', title: '任务', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
  ]).envelope;
  recordConflict(standard.workline, { kind: 'claim-without-record', taskId: 't1', now: NOW });
  assert.throws(
    () => envelopeAfter(standard, [{ op: 'claim', id: 't1' }]),
    /stopped by conflict/,
  );

  // The record survives normalization (a ledger rewrite must not erase the
  // reason a task is stopped) and an unknown kind is dropped rather than
  // silently stopping the workline forever.
  const carried = cloneEnvelope(standard);
  assert.equal(carried.workline.conflicts.length, 1);
  assert.equal(carried.workline.conflicts[0].resolvedAt, null);
  const unknown = cloneEnvelope({
    ...standard,
    workline: { ...standard.workline, conflicts: [{ id: 'cf-9', kind: 'made-up', taskId: 't1' }] },
  });
  assert.deepEqual(unknown.workline.conflicts, []);
}

// ---------------------------------------------------------------------------
// the store exposes unresolved conflicts to the synchronous guard
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  await store.update('session-root', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: '门禁' },
      { op: 'create', title: '任务', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    ]).envelope,
  }));
  assert.equal(store.snapshot('session-root').conflicts, undefined, 'no conflict is omitted from the common shape');
  await store.update('session-root', (current) => {
    const next = cloneEnvelope(current);
    recordConflict(next.workline, { kind: 'unproven-claim', taskId: 't1', evidence: { boardRevision: 2 }, now: NOW });
    return { envelope: next };
  });
  const snapshot = store.snapshot('session-root');
  assert.equal(snapshot.conflicts.length, 1, 'the guard can see the stop without awaiting storage');
  assert.equal(snapshot.conflicts[0].taskId, 't1');
}

// ---------------------------------------------------------------------------
// the guard refuses a stopped Team claim before the board is even consulted
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  const sessions = new Map([['team-lead', { header: { id: 'team-lead' } }]]);
  const members = new Map([
    ['team-lead', { id: 'team-lead', role: 'lead', name: 'lead', root: { id: 'team-lead' } }],
    ['team-worker', { id: 'team-worker', role: 'teammate', name: 'worker-a', root: { id: 'team-lead' } }],
  ]);
  const ctx = {
    get: (name) => {
      if (name === 'sessions') return { get: (id) => sessions.get(id) ?? (id === 'team-worker' ? { header: { id: 'team-worker', parentSession: 'team-lead' } } : undefined) };
      if (name === 'agentTeams') return { tryMembership: (agent) => members.get(agent.id) };
      return undefined;
    },
  };
  const guard = createExecutionGuard({ ctx, store });
  const exec = (sessionId, tool, args) => ({
    name: tool,
    arguments: args,
    agent: { id: sessionId, session: { header: { id: sessionId, ...(sessionId === 'team-worker' ? { parentSession: 'team-lead' } : {}) } } },
  });

  await store.update('team-lead', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: '团队' },
      { op: 'create', title: '任务', executionApproval: 'approved', approvalBasis: '开始吧' },
      { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
    ], { worklineId: 'team-lead', actorSessionId: 'team-lead', standardMode: false }).envelope,
  }));
  assert.equal(guard(exec('team-worker', 'team_task_update', { task_id: 'task-1', action: 'claim' })), undefined,
    'a dispatched Worker may claim when the evidence is consistent');

  await store.update('team-lead', (current) => {
    const next = cloneEnvelope(current);
    recordConflict(next.workline, { kind: 'unproven-claim', taskId: 't1', evidence: { boardRevision: 2 }, now: NOW });
    return { envelope: next };
  });
  const denial = guard(exec('team-worker', 'team_task_update', { task_id: 'task-1', action: 'claim' }));
  assert.match(denial, /stopped by conflict cf-1 \(unproven-claim\)/);
  assert.match(denial, /no claim may start on it until a human resolves the conflict/);
}

// ---------------------------------------------------------------------------
// the journal file is ordinary JSON text on disk
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  appendIntent(root, 'session-root', INTENT);
  const text = readFileSync(journalPath(root, 'session-root'), 'utf8');
  assert.equal(text.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(text.trim()), INTENT);
  // Writing a fresh entry never rewrites history.
  appendIntent(root, 'session-root', { requestId: 'call-3', state: 'prepared', taskId: 't1', member: 'worker-b', revisionBefore: 5 });
  const lines = readFileSync(journalPath(root, 'session-root'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'the journal is append-only');
  // An unreadable journal proves nothing: it is reported as absent instead of
  // being interpreted.
  writeFileSync(journalPath(root, 'session-root'), 'not json\n');
  const unreadable = readJournal(root, 'session-root');
  assert.equal(unreadable.entries.length, 0);
  assert.equal(unreadable.unparsed.length, 1);
}


// ---------------------------------------------------------------------------
// executor lifecycle: a lost executor is marked, keeps the task, and grants no
// permission; only an explicit Lead force release ends it (ticket #10, I0/I16)
// ---------------------------------------------------------------------------

/** A Team workline whose dispatched task was claimed and bound to worker-a. */
function claimedTeamWorkline() {
  return bindTeamClaim(dispatchedWorkline(), {
    taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW,
  }).envelope;
}

{
  const claimed = claimedTeamWorkline();
  const orphaned = convergeWorkline(claimed, {
    now: NOW + 1, teamMode: true, board: BOARD_CLAIMED, journal: [], sessionStates: { 'worker-session': 'orphaned' },
  });
  assert.equal(orphaned.changed, true);
  assert.equal(orphaned.envelope.workline.executions[0].state, 'orphaned', 'the lost executor is marked orphaned');
  assert.equal(orphaned.envelope.tasks[0].owner.executionId, 'ex-1', 'the stamp is NOT silently cleared');
  assert.equal(orphaned.conflicts.length, 0, 'a lost executor is an execution state, not a conflict');
  assert.deepEqual(orphaned.actions.map((action) => action.kind), ['executor-lost']);

  const row = readSnapshot(orphaned.envelope, 'session-root').tasks[0];
  assert.equal(row.executorLost, true, 'the tool snapshot says "executor lost"');
  assert.equal(row.executionState, 'orphaned');
  assert.equal(row.owner, true, 'the task still records who held it');
  assert.equal(httpSnapshot(orphaned.envelope, 'session-root', { isLive: () => false }).tasks[0].executorLost, true,
    'the panel snapshot says "executor lost" too');

  // Idempotent: a second restart does not invent a new state or release it.
  const again = convergeWorkline(orphaned.envelope, {
    now: NOW + 2, teamMode: true, board: BOARD_CLAIMED, journal: [], sessionStates: { 'worker-session': 'orphaned' },
  });
  assert.equal(again.changed, false);

  // A running worker is NEVER marked lost: "active" is the live answer.
  const active = convergeWorkline(claimed, {
    now: NOW + 1, teamMode: true, board: BOARD_CLAIMED, journal: [], sessionStates: { 'worker-session': 'active' },
  });
  assert.equal(active.envelope.workline.executions[0].state, 'active');
  assert.equal(readSnapshot(active.envelope, 'session-root').tasks[0].executorLost, false,
    'an idle worker between turns is not lost');

  // Not live, but the persisted session still resolves: the same session can
  // resume, so the execution stays `active` (a restart must not strip a
  // provable worker, and a session that is not live cannot call a tool at all).
  const persistedOnly = convergeWorkline(claimed, {
    now: NOW + 1, teamMode: true, board: BOARD_CLAIMED, journal: [], sessionStates: { 'worker-session': 'active' },
  });
  assert.equal(persistedOnly.envelope.workline.executions[0].state, 'active');
  assert.equal(readSnapshot(persistedOnly.envelope, 'session-root').tasks[0].executorLost, false);

  // A board that completed the task still ends an orphaned execution; a board
  // that still owns it keeps the execution untouched (design I8/I16).
  const boardCompleted = convergeWorkline(orphaned.envelope, {
    now: NOW + 3,
    teamMode: true,
    board: { tasks: [{ id: 'task-1', status: 'completed', ownerName: 'worker-a', revision: 3 }] },
    journal: [],
  });
  assert.equal(boardCompleted.envelope.workline.executions[0].state, 'ended');
  assert.equal(boardCompleted.envelope.workline.executions[0].endReason, 'completed');
  assert.equal(boardCompleted.envelope.tasks[0].owner, null);
}

// ---------------------------------------------------------------------------
// force release: interrupt + proof it stopped, then the Lead ends it; a
// refused release never reaches the board, and the ended worker cannot return
// ---------------------------------------------------------------------------

{
  const claimed = claimedTeamWorkline();
  const leadCtx = { ...CTX, standardMode: false };

  // 1. Still running -> refused, even with the interrupt recorded.
  const interrupted = markInterrupted(claimed, { sessionId: 'worker-session', now: NOW + 10 });
  assert.equal(interrupted.changed, true);
  assert.equal(interrupted.envelope.workline.executions[0].interruptedAt, NOW + 10);
  assert.throws(
    () => applyOps(interrupted.envelope, [{ op: 'release', id: 't1', force: true }], {
      ...leadCtx, now: NOW + 11, isRunning: () => true,
    }),
    /still running/,
  );
  const runningCheck = forceReleaseReadiness(interrupted.envelope, {
    taskId: 't1', actorSessionId: 'session-root', isRunning: () => true,
  });
  assert.equal(runningCheck.ok, false);
  assert.match(runningCheck.reason, /still running/);

  // 2. Stopped but never interrupted -> refused: a stopped worker alone is not
  //    proof that the Lead asked it to stop.
  assert.throws(
    () => applyOps(claimed, [{ op: 'release', id: 't1', force: true }], {
      ...leadCtx, now: NOW + 11, isRunning: () => false,
    }),
    /recorded no interrupt/,
  );

  // 3. Only the Lead may force-release, and only with a recorded interrupt.
  assert.throws(
    () => applyOps(interrupted.envelope, [{ op: 'release', id: 't1', force: true }], {
      ...leadCtx, now: NOW + 11, actorSessionId: 'worker-session', isRunning: () => false,
    }),
    /reserved for the Lead/,
  );

  // 4. Interrupt + not running -> the Lead ends the execution, ends the
  //    Worker's lifetime record, and clears the stamp in one atomic write.
  const outcome = applyOps(interrupted.envelope, [
    { op: 'release', id: 't1', force: true, reason: 'worker crashed and never came back' },
  ], { ...leadCtx, now: NOW + 12, isRunning: () => false });
  const released = outcome.envelope;
  const execution = released.workline.executions[0];
  assert.equal(outcome.applied[0].executionId, 'ex-1');
  assert.equal(execution.state, 'ended');
  assert.equal(execution.endReason, 'force-terminated');
  assert.equal(execution.note, 'worker crashed and never came back');
  assert.equal(released.tasks[0].owner, null, 'the board ownership is cleared');
  assert.equal(released.tasks[0].status, 'in_progress', 'the task itself stays open for a new Worker');
  const lifetime = workerLifetimeOf(released.workline, 'worker-session');
  assert.equal(lifetime.state, 'ended');
  assert.equal(lifetime.endReason, 'force-terminated');
  assert.equal(workerLifetimeOf(released.workline, 'session-root'), undefined, 'the Lead has no lifetime record');

  // 5. The force-terminated worker can never claim again: its lifetime binding
  //    ended, and a reprocessed claim fails closed.
  const redispatched = applyOps(released, [{ op: 'dispatch', id: 't1', member: 'worker-b', teamTaskId: 'task-1' }], {
    ...leadCtx, now: NOW + 13, actorSessionId: 'session-root',
  }).envelope;
  assert.throws(
    () => bindTeamClaim(redispatched, {
      taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-b', revision: 3, now: NOW + 14,
    }),
    /one task in its lifetime/,
  );

  // 6. A missing runtime answer fails closed: the pure model treats the worker
  //    as running when no isRunning function was supplied.
  assert.throws(
    () => applyOps(interrupted.envelope, [{ op: 'release', id: 't1', force: true }], { ...leadCtx, now: NOW + 11 }),
    /still running/,
  );

  // 7. Non-owners cannot force-release through a plain release either.
  assert.throws(
    () => applyOps(interrupted.envelope, [{ op: 'release', id: 't1' }], {
      ...leadCtx, now: NOW + 11, actorSessionId: 'other-session',
    }),
    /only its holder can release it/,
  );
}

// ---------------------------------------------------------------------------
// the execution gate: a lost or force-terminated executor grants no class A
// permission, and the stamp's missing ledger record fails closed
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  const worklineId = 'session-root';
  const live = new Set(['session-root']);
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return { get: (id) => (live.has(id) ? { header: { id, ...(id === 'worker-session' ? { parentSession: 'session-root' } : {}) } } : undefined) };
      }
      if (name === 'agents') return { get: () => undefined };
      return undefined;
    },
  };
  const guard = createExecutionGuard({ ctx, store });
  const call = (sessionId, tool = 'write') => ({
    name: tool,
    callId: 'call-guard',
    agent: { id: sessionId, session: { header: { id: sessionId, ...(sessionId === 'worker-session' ? { parentSession: 'session-root' } : {}) } } },
  });

  const claimed = claimedTeamWorkline();
  await store.update(worklineId, () => ({ envelope: claimed }));
  assert.equal(guard(call('worker-session')), undefined, 'an active execution grants class A');

  await store.update(worklineId, () => ({
    envelope: convergeWorkline(claimed, {
      now: NOW + 1, teamMode: true, board: BOARD_CLAIMED, journal: [], sessionStates: { 'worker-session': 'orphaned' },
    }).envelope,
  }));
  const lost = guard(call('worker-session'));
  assert.match(lost, /can no longer be resolved \(executor lost\)/);
  assert.match(lost, /Only an `active` execution grants class A permission/);
  assert.match(lost, /force-release/);

  // Force-terminated: no stamp at all, but the lifetime record explains why.
  const released = applyOps(markInterrupted(claimed, { sessionId: 'worker-session', now: NOW + 2 }).envelope, [
    { op: 'release', id: 't1', force: true, reason: 'gone' },
  ], { ...CTX, standardMode: false, now: NOW + 3, isRunning: () => false }).envelope;
  await store.update(worklineId, () => ({ envelope: released }));
  const terminated = guard(call('worker-session'));
  assert.match(terminated, /was force-terminated/);
  assert.match(terminated, /never write for this workline again/);

  // A stamp whose ledger record is missing fails closed instead of granting.
  const broken = cloneEnvelope(claimed);
  broken.tasks[0].owner.executionId = 'ex-missing';
  await store.update(worklineId, () => ({ envelope: broken }));
  const missing = guard(call('worker-session'));
  assert.match(missing, /the execution ledger has no record/);
}

console.log('evidence ok');
