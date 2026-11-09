/**
 * Task-tree tests: pure model rules, the file store, and the mounted feature
 * (tools + HTTP handlers) over a fake plugin context.
 *
 * Run with `node test/tasks.mjs`; no dsh package is imported anywhere here.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyOps,
  bindTeamClaim,
  createEmptyEnvelope,
  httpSnapshot,
  normalizeConflicts,
  readSnapshot,
  statusSnapshot,
} from '../host/model.js';
import { createTaskStore } from '../host/store.js';
import { callerOf } from '../host/caller.js';
import { classifyTool, createExecutionGuard } from '../host/guard.js';
import { normalizeWorker } from '../host/lifetime.js';
import { mountTaskTree } from '../host/mount.js';
import { createSeatTable, registerSeatObservers, seatRequestFor } from '../host/reservation.js';
import { taskTreeReminderFor, TASK_TREE_REMINDER, TASK_TREE_START_REMINDER, TASK_TREE_PROMPT } from '../host/prompt.js';
import { MAX_BASIS, MIN_QUOTE, verifyUserQuote } from '../host/evidence.js';

const NOW = 1_700_000_000_000;

// The user messages this fake session "contains"; approval and acceptance
// quotes are checked against them, exactly like the live host does. Times are
// relative to NOW: instructions come before the work, acceptance after it.
const USER_SAYS = [
  { seq: 1, time: NOW - 60_000, text: '帮我实现一个 Go 短链接服务，包括创建、跳转、查询和测试。' },
  { seq: 3, time: NOW - 50_000, text: '登录功能可以做，开始吧。' },
  { seq: 5, time: NOW - 40_000, text: '我决定把纯 API 短链接服务升级为单管理员管理工具，但先讨论实施方案，不要写代码。' },
  { seq: 7, time: NOW + 5_000, text: '没问题了，验收通过。' },
  { seq: 9, time: NOW - 30_000, text: '这个先不做，下轮再说。' },
  { seq: 13, time: NOW + 6_000, text: '登录功能我验收通过了，审计日志也验收通过了。' },
  { seq: 15, time: NOW + 7_000, text: 'PDF 导出我验收通过了。' },
  { seq: 11, time: NOW - 20_000, text: '记住我那个不做了。' },
];

function fakeVerifier(quote) {
  const needle = String(quote).replace(/\s+/g, '');
  const hit = USER_SAYS.find((entry) => entry.text.replace(/\s+/g, '').includes(needle));
  return hit === undefined
    ? { ok: false, reason: 'the quote does not appear in any user message' }
    : { ok: true, seq: hit.seq, time: hit.time };
}

const CTX = {
  worklineId: 'session-root',
  now: NOW,
  actorSessionId: 'session-root',
  isLive: () => true,
  verifyUserQuote: fakeVerifier,
};

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'sp-tasks-'));
}

function envelopeAfter(envelope, ops, context = {}) {
  return applyOps(envelope, ops, { ...CTX, ...context });
}

function titles(snapshot) {
  return snapshot.tasks.map((task) => `${'  '.repeat(task.depth)}${task.title}:${task.status}`);
}

// ---------------------------------------------------------------------------
// model: shape, tree order, validation
// ---------------------------------------------------------------------------

{
  const { envelope } = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '做一个给 Agent 用的任务树', outline: '第一阶段做存储' },
    { op: 'create', title: '存储' },
    { op: 'create', title: '面板', parentId: 't1' },
    { op: 'create', title: '工具' },
  ]);
  const snapshot = readSnapshot(envelope, CTX.worklineId, true);
  assert.deepEqual(titles(snapshot), ['存储:pending', '  面板:pending', '工具:pending']);
  assert.equal(snapshot.goal.original, '做一个给 Agent 用的任务树');
  assert.equal(snapshot.tasks[1].depth, 1);
  assert.equal(snapshot.tasks[1].parentId, 't1');
}

{
  assert.throws(
    () => envelopeAfter(undefined, [{ op: 'init', originalGoal: 'x'.repeat(4001) }]),
    /originalGoal must be at most 4000/,
  );
  assert.throws(
    () => envelopeAfter(undefined, [{ op: 'create', title: 'x'.repeat(41) }]),
    /title must be at most 40/,
  );
  assert.throws(
    () => envelopeAfter(undefined, [{ op: 'create', title: 'a\nb' }]),
    /single line/,
  );
  assert.throws(
    () => envelopeAfter(undefined, [{ op: 'create', title: 'ok', status: 'done' }]),
    /cannot start done/,
  );
  assert.throws(
    () => envelopeAfter(undefined, [{ op: 'nope' }]),
    /unknown op/,
  );
  assert.throws(
    () => envelopeAfter(undefined, [{ op: 'create', title: 'ok', nope: 1 }]),
    /unsupported field/,
  );
}

// ---------------------------------------------------------------------------
// model: completion and parent invariants
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '父' },
    { op: 'create', title: '子', parentId: 't1' },
  ]).envelope;

  // A child counts as delivery work once it is approved or has started; an
  // unapproved idea does not (that rule has its own block further down).
  const started = envelopeAfter(base, [
    { op: 'update', id: 't2', executionApproval: 'approved', approvalBasis: '开始吧' , requiresUserAcceptance: false },
    { op: 'update', id: 't2', status: 'in_progress' },
  ]).envelope;
  assert.throws(
    () => envelopeAfter(started, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '验收通过' }]),
    /any work below it is unfinished/,
  );
  // A normal implementation task may be finished on the agent's own verification.
  const selfDone = envelopeAfter(base, [{ op: 'complete', id: 't2', result: '子完成' }]).envelope;
  assert.equal(selfDone.tasks[1].completion, 'self');
  assert.equal(selfDone.tasks[1].completionBasis, null);

  // Recording the user's acceptance needs a quote they actually wrote.
  assert.throws(
    () => envelopeAfter(base, [{ op: 'complete', id: 't2', confirmedByUser: true }]),
    /needs confirmationBasis/,
  );
  assert.throws(
    () => envelopeAfter(base, [{ op: 'complete', id: 't2', confirmedByUser: true, confirmationBasis: '全部通过' }]),
    /does not appear in a user message/,
  );

  // The top-level task is the delivered requirement, so it waits for the user;
  // its child is an implementation step and may self-complete.
  assert.throws(
    () => envelopeAfter(base, [{ op: 'complete', id: 't2' }, { op: 'complete', id: 't1' }]),
    /needs the user's acceptance/,
  );
  assert.equal(readSnapshot(envelopeAfter(base, [{ op: 'complete', id: 't2' }]).envelope, CTX.worklineId).tasks[1].status, 'done');
  const done = envelopeAfter(base, [
    { op: 'complete', id: 't2', result: '子完成' },
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '验收通过' },
  ]).envelope;
  const snapshot = readSnapshot(done, CTX.worklineId);
  assert.deepEqual(snapshot.tasks.map((task) => task.status), ['done', 'done']);
  assert.equal(done.tasks[1].completion, 'self');
  assert.equal(done.tasks[0].completion, 'user-confirmed');
  assert.equal(done.tasks[0].completionBasis, '验收通过');
  assert.equal(done.workline.goal.current, 'g');
}

// ---------------------------------------------------------------------------
// model: defer / focus / claim
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: 'A', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', title: 'B' },
  ]).envelope;

  const focused = envelopeAfter(base, [{ op: 'focus', ids: ['t1'] }]).envelope;
  assert.deepEqual(focused.workline.focus, ['t1']);
  assert.equal(focused.tasks[0].status, 'in_progress');

  const deferred = envelopeAfter(focused, [{ op: 'defer', id: 't1', deferredReason: '先做别的', userBasis: '开始吧' }]).envelope;
  assert.equal(deferred.tasks[0].deferred, true);
  assert.deepEqual(deferred.workline.focus, []);
  assert.equal(deferred.tasks[0].status, 'in_progress');

  assert.throws(
    () => envelopeAfter(deferred, [{ op: 'focus', ids: ['t1'] }]),
    /deferred and cannot be focused/,
  );
  assert.throws(
    () => envelopeAfter(deferred, [{ op: 'claim', id: 't1' }]),
    /deferred and cannot be claimed/,
  );

  const resumed = envelopeAfter(deferred, [{ op: 'resume', id: 't1' }]).envelope;
  assert.equal(resumed.tasks[0].deferred, false);

  const claimed = envelopeAfter(resumed, [{ op: 'claim', id: 't1' }]).envelope;
  assert.equal(claimed.tasks[0].owner.sessionId, 'session-root');
  // The claim stamp and the ledger entry are written together, and the id is
  // monotonic from ex-1.
  assert.equal(claimed.tasks[0].owner.executionId, 'ex-1');
  assert.equal(claimed.workline.executions.at(-1).executionId, 'ex-1');
  assert.equal(claimed.workline.executions.at(-1).state, 'active');

  // Standard mode has ONE execution seat for the whole workline: another session
  // cannot steal it, and neither can a session whose owner is no longer live —
  // ending that execution needs an explicit release.
  assert.throws(
    () => envelopeAfter(claimed, [{ op: 'claim', id: 't1' }], {
      actorSessionId: 'session-other',
      isLive: () => true,
    }),
    /one execution seat, held by session session-root/,
  );
  assert.throws(
    () => envelopeAfter(claimed, [{ op: 'claim', id: 't1' }], {
      actorSessionId: 'session-other',
      isLive: () => false,
    }),
    /one execution seat/,
  );
  // I2: the same session cannot hold a second seat on another task.
  const twoTasks = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: 'A', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'create', title: 'B', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'claim', id: 't1' },
  ]).envelope;
  assert.throws(
    () => envelopeAfter(twoTasks, [{ op: 'claim', id: 't2' }]),
    /already holds execution ex-1 on task t1/,
  );
  // Team mode never creates an execution from the tree: only the Worker's own
  // Team-board claim does (dispatch + claim-first binding, ticket #6).
  assert.throws(
    () => envelopeAfter(twoTasks, [{ op: 'claim', id: 't2' }], { standardMode: false }),
    /Team-board claim/,
  );
  // A claim is not idempotent: re-claiming the held task is a mistake, not a
  // silent second execution.
  assert.throws(
    () => envelopeAfter(claimed, [{ op: 'claim', id: 't1' }]),
    /already holds execution ex-1/,
  );
  // Only the holder ends the execution, and the next claim gets a NEW id.
  assert.throws(
    () => envelopeAfter(claimed, [{ op: 'release', id: 't1' }], { actorSessionId: 'session-other' }),
    /only its holder can release it/,
  );
  const released = envelopeAfter(claimed, [{ op: 'release', id: 't1' }]).envelope;
  assert.equal(released.tasks[0].owner, null);
  assert.equal(released.workline.executions.at(-1).state, 'ended');
  assert.equal(released.workline.executions.at(-1).endReason, 'released');
  const reclaim = envelopeAfter(released, [{ op: 'claim', id: 't1' }]).envelope;
  assert.equal(reclaim.tasks[0].owner.executionId, 'ex-2');
  assert.notEqual(reclaim.tasks[0].owner.executionId, claimed.tasks[0].owner.executionId);

  assert.throws(
    () => envelopeAfter(base, [{ op: 'claim', id: 't1' }]),
    /must be in_progress/,
  );
}

// ---------------------------------------------------------------------------
// model: standard-mode handover — assign is routing, claim is the execution
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: 'A', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'create', title: 'B', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
  ]).envelope;
  const claimed = envelopeAfter(base, [{ op: 'claim', id: 't1' }]).envelope;

  // Only the lead assigns, and not while the task is held.
  assert.throws(
    () => envelopeAfter(base, [{ op: 'assign', id: 't1', member: 'session-child' }], { actorSessionId: 'session-child' }),
    /assign is reserved for the lead session/,
  );
  assert.throws(
    () => envelopeAfter(claimed, [{ op: 'assign', id: 't1', member: 'session-child' }]),
    /holds an active execution/,
  );

  // Release -> assign: the subagent id is routing only, no execution is made.
  const released = envelopeAfter(claimed, [{ op: 'release', id: 't1' }]).envelope;
  const assigned = envelopeAfter(released, [{ op: 'assign', id: 't1', member: 'session-child' }]).envelope;
  assert.equal(assigned.tasks[0].assignee, 'session-child');
  assert.equal(assigned.tasks[0].owner, null);
  assert.equal(assigned.workline.executions.length, 1, 'assignment creates no execution record');

  // Assignment is not a claim: the lead cannot claim it back, and another
  // subagent cannot claim it either.
  assert.throws(
    () => envelopeAfter(assigned, [{ op: 'claim', id: 't1' }]),
    /assigned to subagent session-child/,
  );
  assert.throws(
    () => envelopeAfter(assigned, [{ op: 'claim', id: 't1' }], { actorSessionId: 'session-other' }),
    /not to session session-other/,
  );

  // The assigned subagent claims (ex-2), and the seat is now its own.
  const childClaim = envelopeAfter(assigned, [{ op: 'claim', id: 't1' }], { actorSessionId: 'session-child' }).envelope;
  assert.equal(childClaim.tasks[0].owner.sessionId, 'session-child');
  assert.equal(childClaim.tasks[0].owner.executionId, 'ex-2');
  assert.throws(
    () => envelopeAfter(childClaim, [{ op: 'claim', id: 't2' }], { actorSessionId: 'session-child' }),
    /already holds execution ex-2/,
  );
  // The lead cannot end someone else's execution: release, complete and
  // status=done are all refused while the subagent holds it.
  assert.throws(
    () => envelopeAfter(childClaim, [{ op: 'release', id: 't1' }]),
    /only its holder can release it/,
  );
  assert.throws(
    () => envelopeAfter(childClaim, [{ op: 'complete', id: 't1' }]),
    /held by session session-child; only its holder can complete it/,
  );
  assert.throws(
    () => envelopeAfter(childClaim, [{ op: 'update', id: 't1', status: 'done' }]),
    /held by session session-child; only its holder can complete it/,
  );

  // The subagent releases; the lead takes it back only after assigning it to
  // itself, and that claim is a new execution id (ex-3), never ex-1/ex-2.
  const childReleased = envelopeAfter(childClaim, [{ op: 'release', id: 't1' }], { actorSessionId: 'session-child' }).envelope;
  assert.equal(childReleased.workline.executions.at(-1).endReason, 'released');
  assert.throws(
    () => envelopeAfter(childReleased, [{ op: 'claim', id: 't1' }]),
    /assigned to subagent session-child/,
  );
  const handedBack = envelopeAfter(childReleased, [{ op: 'assign', id: 't1', member: 'lead' }]).envelope;
  const reclaim = envelopeAfter(handedBack, [{ op: 'claim', id: 't1' }]).envelope;
  assert.equal(reclaim.tasks[0].owner.executionId, 'ex-3');
  assert.deepEqual(
    reclaim.workline.executions.filter((execution) => execution.taskId === 't1').map((execution) => execution.state),
    ['ended', 'ended', 'active'],
  );
}

{
  // Completion, deferral and archive each end the execution, so no terminal
  // task (I8) can keep a non-terminal execution alive.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: 'A', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'create', title: 'B', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'create', title: 'C', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'claim', id: 't1' },
  ]).envelope;
  const completed = envelopeAfter(base, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '没问题了，验收通过' }]).envelope;
  assert.equal(completed.tasks[0].owner, null);
  assert.equal(completed.workline.executions.at(-1).endReason, 'completed');
  assert.equal(completed.workline.executions.at(-1).state, 'ended');
  // Re-claiming after completion is impossible; the ended id is not reused.
  assert.throws(() => envelopeAfter(completed, [{ op: 'claim', id: 't1' }]), /must be in_progress/);
  const next = envelopeAfter(completed, [{ op: 'claim', id: 't2' }]).envelope;
  assert.equal(next.tasks[1].owner.executionId, 'ex-2');

  const deferred = envelopeAfter(completed, [
    { op: 'claim', id: 't2' },
    { op: 'defer', id: 't2', deferredReason: '先做别的', userBasis: '开始吧' },
  ]).envelope;
  assert.equal(deferred.tasks[1].owner, null);
  assert.equal(deferred.workline.executions.at(-1).endReason, 'deferred');

  const archived = envelopeAfter(completed, [
    { op: 'claim', id: 't3' },
    { op: 'archive', id: 't3', reason: '不做了', userBasis: '记住我那个不做了' },
  ]).envelope;
  assert.equal(archived.workline.executions.at(-1).endReason, 'archived');
  assert.equal(archived.workline.executions.at(-1).state, 'ended');
}

// ---------------------------------------------------------------------------
// defer / archive cannot strip another session's execution
// ---------------------------------------------------------------------------

{
  // Deferring or archiving ends the task's execution AND its Worker's one
  // lifetime binding, which is exactly what the interrupt-then-force-release
  // path exists for (design v8 I2b/I16). A caller may not do it behind the
  // holder's back, not even with the user's decision in hand.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: 'Worker 任务', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'assign', id: 't1', member: 'session-child' },
  ]).envelope;
  const held = envelopeAfter(base, [{ op: 'claim', id: 't1' }], { actorSessionId: 'session-child' }).envelope;
  assert.equal(held.tasks[0].owner.sessionId, 'session-child');
  assert.throws(
    () => envelopeAfter(held, [{ op: 'defer', id: 't1', deferredReason: '放一放', userBasis: '这个先不做' }]),
    /held by session session-child; only its holder can defer it/,
  );
  assert.throws(
    () => envelopeAfter(held, [{ op: 'archive', id: 't1', reason: '不做了', userBasis: '这个先不做' }]),
    /held by session session-child; only its holder can archive it/,
  );
  // The refusals wrote nothing: the execution is still active and stamped.
  assert.equal(held.tasks[0].owner.executionId, 'ex-1');
  assert.equal(held.workline.executions.at(-1).state, 'active');

  // Archiving a parent cannot launder a held descendant out of the delivery.
  const tree = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '父' },
    { op: 'create', parentId: 't1', title: '子', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'assign', id: 't2', member: 'session-child' },
  ]).envelope;
  const subtreeHeld = envelopeAfter(tree, [{ op: 'claim', id: 't2' }], { actorSessionId: 'session-child' }).envelope;
  assert.throws(
    () => envelopeAfter(subtreeHeld, [{ op: 'archive', id: 't1', reason: '整组不做', userBasis: '这个先不做' }]),
    /held by session session-child; only its holder can archive it/,
  );
  // The holder itself may end its own execution through either path.
  const ownDefer = envelopeAfter(tree, [
    { op: 'claim', id: 't2' },
    { op: 'defer', id: 't2', deferredReason: '先放一放', userBasis: '这个先不做' },
  ], { actorSessionId: 'session-child' }).envelope;
  assert.equal(ownDefer.tasks[1].owner, null);
  assert.equal(ownDefer.workline.executions.at(-1).endReason, 'deferred');
}

// ---------------------------------------------------------------------------
// conflicts: exposed to the reader, and resolvable only by the Lead
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '冲突' },
    { op: 'create', title: '被停住的任务', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
  ]).envelope;
  base.workline.conflicts = normalizeConflicts([{
    id: 'cf-1',
    scope: 'task',
    taskId: 't1',
    kind: 'unproven-claim',
    evidence: { boardRevision: 2, ownerName: 'worker-a' },
    createdAt: NOW,
    resolvedAt: null,
    resolution: null,
  }]);

  // The stop is visible to the reader and to the panel, with its evidence.
  const read = readSnapshot(base, CTX.worklineId);
  assert.deepEqual(read.conflicts, [{
    id: 'cf-1',
    scope: 'task',
    taskId: 't1',
    kind: 'unproven-claim',
    evidence: { boardRevision: 2, ownerName: 'worker-a' },
    createdAt: NOW,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  }]);
  assert.deepEqual(httpSnapshot(base, CTX.worklineId).conflicts, read.conflicts);
  // An unresolved conflict stops the claim, in either mode.
  assert.throws(() => envelopeAfter(base, [{ op: 'claim', id: 't1' }]), /stopped by conflict cf-1/);

  // Only the Lead resolves one, and the record keeps who, when and why.
  assert.throws(
    () => envelopeAfter(base, [{ op: 'resolveConflict', conflictId: 'cf-1', reason: 'board re-read' }], { actorSessionId: 'session-child' }),
    /reserved for the Lead session/,
  );
  assert.throws(
    () => envelopeAfter(base, [{ op: 'resolveConflict', conflictId: 'cf-9', reason: 'board re-read' }]),
    /unknown conflict "cf-9"/,
  );
  assert.throws(() => envelopeAfter(base, [{ op: 'resolveConflict', conflictId: 'cf-1' }]), /reason/);
  const resolved = envelopeAfter(base, [
    { op: 'resolveConflict', conflictId: 'cf-1', reason: 'board re-read; the claim was a crash artefact' },
  ]).envelope;
  const record = resolved.workline.conflicts.find((conflict) => conflict.id === 'cf-1');
  assert.equal(record.resolvedAt, NOW);
  assert.equal(record.resolvedBy, 'session-root');
  assert.equal(record.resolution, 'board re-read; the claim was a crash artefact');
  // After the resolution the task can be worked again.
  const claimed = envelopeAfter(resolved, [{ op: 'claim', id: 't1' }]).envelope;
  assert.equal(claimed.tasks[0].owner.sessionId, 'session-root');
  // The resolution travels through the read model too.
  const after = readSnapshot(resolved, CTX.worklineId);
  assert.equal(after.conflicts[0].resolvedAt, NOW);
  assert.equal(after.conflicts[0].resolvedBy, 'session-root');
  assert.equal(after.conflicts[0].resolution, 'board re-read; the claim was a crash artefact');
  // One conflict is resolved once.
  assert.throws(
    () => envelopeAfter(resolved, [{ op: 'resolveConflict', conflictId: 'cf-1', reason: 'again' }]),
    /already resolved/,
  );
}

// ---------------------------------------------------------------------------
// model: archive is recursive, goal revisions are recorded
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '原始目标' },
    { op: 'create', title: '父' },
    { op: 'create', title: '子', parentId: 't1' },
    { op: 'create', title: '另一个' },
  ]).envelope;
  const archived = envelopeAfter(base, [{ op: 'archive', id: 't1', reason: '不做了' }]).envelope;
  const snapshot = httpSnapshot(archived, CTX.worklineId, { isLive: () => true });
  assert.deepEqual(snapshot.tasks.map((task) => task.title), ['另一个']);
  assert.equal(snapshot.archivedCount, 2);
  assert.deepEqual(snapshot.archived.map((task) => task.title).sort(), ['子', '父']);

  const revised = envelopeAfter(base, [{ op: 'reviseGoal', current: '新目标', reason: '用户确认调整' }]).envelope;
  assert.equal(revised.workline.goal.original, '原始目标');
  assert.equal(revised.workline.goal.current, '新目标');
  assert.equal(revised.workline.goal.changes.length, 1);
  assert.equal(revised.workline.goal.changes[0].previous, '原始目标');
  assert.throws(
    () => envelopeAfter(base, [{ op: 'init', originalGoal: 'again' }]),
    /already has a goal/,
  );
}

// ---------------------------------------------------------------------------
// model: cycles and move
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '父' },
    { op: 'create', title: '子', parentId: 't1' },
  ]).envelope;
  assert.throws(
    () => envelopeAfter(base, [{ op: 'move', id: 't1', parentId: 't2' }]),
    /own descendant/,
  );
  assert.throws(
    () => envelopeAfter(base, [{ op: 'move', id: 't1', parentId: 't1' }]),
    /own parent/,
  );
  const moved = envelopeAfter(base, [{ op: 'move', id: 't2', parentId: null }]).envelope;
  assert.equal(moved.tasks[1].parentId, null);
}

// ---------------------------------------------------------------------------
// status snapshot for the entry light
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '当前', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'focus', ids: ['t1'] },
  ]).envelope;
  const status = statusSnapshot(base, CTX.worklineId);
  assert.equal(status.focus.length, 1);
  assert.deepEqual(status.focus[0], { id: 't1', title: '当前', status: 'in_progress', blocked: false });
  assert.deepEqual(statusSnapshot(undefined, 'session-root').focus, []);
}

// ---------------------------------------------------------------------------
// store: persistence, cache reload, corrupt quarantine
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  await store.update('session-root', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: '持久化' },
      { op: 'create', title: '落盘' },
    ]).envelope,
  }));
  assert.equal(store.available() instanceof Promise, true);
  assert.equal(await store.available(), true);

  const reopened = createTaskStore({ root, logger: { warn() {} } });
  const loaded = await reopened.read('session-root');
  assert.equal(loaded.workline.goal.original, '持久化');
  assert.equal(loaded.tasks.length, 1);
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.json')), ['session-root.json']);

  // A corrupt record is quarantined, not deleted silently.
  writeFileSync(join(root, 'session-corrupt.json'), '{ not json');
  const corrupt = await reopened.read('session-corrupt');
  assert.equal(corrupt, undefined);
  assert.equal(readdirSync(root).some((name) => name.includes('.corrupt-')), true);

  await assert.rejects(() => reopened.read('../escape'), /invalid workline id/);
}

// ---------------------------------------------------------------------------
// store: the synchronous snapshot the execution gate decides on
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  // An absent file is an empty workline. The snapshot only reports the fact;
  // the gate denies class A on it (ADR-0001), so absence is not permission.
  assert.deepEqual(store.snapshot('session-cold'), { present: false, tasks: [] });

  await store.update('session-root', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: '门禁' },
      { op: 'create', title: '落盘', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
      { op: 'claim', id: 't1' },
    ]).envelope,
  }));

  // A write refreshes the cache before it returns, so the next decision sees it.
  const warm = store.snapshot('session-root');
  assert.equal(warm.present, true);
  assert.equal(warm.tasks[0].owner.sessionId, 'session-root');

  // A restarted host has an empty cache: the snapshot reads one small file
  // synchronously instead of awaiting, so a claim written before this process
  // started is still visible.
  const reopened = createTaskStore({ root, logger: { warn() {} } });
  const cold = reopened.snapshot('session-root');
  assert.equal(cold.present, true);
  assert.equal(cold.tasks[0].title, '落盘');
  assert.equal(cold.tasks[0].owner.sessionId, 'session-root');

  // Fail closed: a present-but-unreadable tree reports no tasks, which denies
  // class A, rather than inventing a tree that might grant something.
  writeFileSync(join(root, 'session-corrupt.json'), '{ not json');
  const corrupt = reopened.snapshot('session-corrupt');
  assert.equal(corrupt.present, true);
  assert.deepEqual(corrupt.tasks, []);

  // An invalid workline id can never map to a file, so it reports the empty
  // workline — which the gate denies, it never frees a class A call.
  assert.deepEqual(reopened.snapshot('../escape'), { present: false, tasks: [] });
}

// ---------------------------------------------------------------------------
// caller resolution: one module shared by the gate, the tools and recovery
// ---------------------------------------------------------------------------

{
  const header = { id: 'session-header', parentSession: 'session-parent' };
  assert.deepEqual(
    callerOf({ agent: { id: 'agent-1', session: { id: 'session-id', header } } }),
    { sessionId: 'session-header', header },
    'the session header is the caller identity',
  );
  assert.deepEqual(
    callerOf({ agent: { session: { id: 'session-id' } } }),
    { sessionId: 'session-id', header: undefined },
    'a session without a header still names itself',
  );
  assert.deepEqual(callerOf({ agent: { id: 'agent-1' } }), { sessionId: 'agent-1', header: undefined });
  assert.deepEqual(callerOf(undefined), { sessionId: undefined, header: undefined });
  assert.equal(
    callerOf({ agent: { id: 'agent-1', session: { id: 'session-id', header: { id: '' } } } }).sessionId,
    'session-id',
    'an empty header id never wins over a real session id',
  );

  // A Worker lifetime record has exactly the two states the model acts on; a
  // state this build cannot name fails closed as `ended`, never as claimable.
  assert.equal(normalizeWorker({ state: 'bound' }).state, 'bound');
  assert.equal(normalizeWorker({ state: 'ended' }).state, 'ended');
  assert.equal(normalizeWorker({ state: 'created' }).state, 'ended');
  assert.equal(normalizeWorker({ state: 'whatever' }).state, 'ended');
}

// ---------------------------------------------------------------------------
// execution gate: tool classification is default-deny
// ---------------------------------------------------------------------------

{
  // Class A: workspace modification and code execution, by default.
  for (const name of ['write', 'edit', 'str_replace_editor', 'apply_patch', 'bash', 'terminal_open', 'pwsh_run', 'create_worktree', 'working_directory', 'run_code', 'workflow', 'ralph', 'subagent_spawn', 'plugin_manager']) {
    assert.equal(classifyTool(name), 'A', `${name} modifies the workspace and must be class A`);
  }
  // A tool a later plugin registers is class A too: no short blacklist can hide it.
  assert.equal(classifyTool('some_future_plugin_tool'), 'A');
  assert.equal(classifyTool(undefined), 'A');
  // Class B: task management and execution control, which never needs an execution.
  for (const name of ['task_tree_read', 'task_tree_write', 'team_task_create', 'team_task_update', 'spawn_teammate', 'send_message', 'interrupt_agent', 'list_agents', 'ask_user_question', 'todo_write', 'schedule_create', 'session_search', 'present', 'create_goal']) {
    assert.equal(classifyTool(name), 'B', `${name} is task management or execution control and must be class B`);
  }
  // Class C: read-only, always allowed.
  for (const name of ['read', 'grep', 'glob', 'read_image', 'web_fetch', 'web_search', 'job_output', 'skill', 'cordis_inspect_list', 'plugin_market', 'load_workspace_dependencies']) {
    assert.equal(classifyTool(name), 'C', `${name} is read-only and must be class C`);
  }

  // The guard itself is a pure synchronous decision: every class A call needs
  // the calling session's claim stamp, in a workline with a tree and in one
  // with no tree at all (ADR-0001).
  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  const sessions = new Map([
    ['session-root', { header: { id: 'session-root' } }],
    ['session-branch', { header: { id: 'session-branch', parentSession: 'session-root' } }],
    ['session-other', { header: { id: 'session-other' } }],
  ]);
  const ctx = { get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined) };
  const guard = createExecutionGuard({ ctx, store });
  const exec = (sessionId, parentSession, tool = 'write') => ({
    name: tool,
    agent: {
      id: sessionId,
      session: { header: parentSession === undefined ? { id: sessionId } : { id: sessionId, parentSession } },
    },
  });

  // No tree yet: refused like any other unclaimed workline, and the reason has
  // to carry the bootstrap path because there is nothing to claim.
  const cold = guard(exec('session-root'));
  assert.match(cold, /holds no active execution/, 'no tree yet: class A is refused, the absent tree is not permission');
  assert.match(cold, /no task tree yet/, 'the cold refusal names the missing tree');
  assert.match(cold, /"op":"init"/, 'the cold refusal gives the bootstrap path');
  assert.match(cold, /"op":"create"/);
  assert.match(cold, /"op":"claim"/);
  await store.update('session-root', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: '门禁' },
      { op: 'create', title: '任务', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    ]).envelope,
  }));
  assert.match(guard(exec('session-root')), /holds no active execution/);
  assert.equal(guard(exec('session-root', undefined, 'task_tree_write')), undefined, 'class B never needs an execution');
  assert.equal(guard(exec('session-root', undefined, 'read')), undefined, 'class C is always allowed');
  // A branch/subagent session resolves to its workline root, not to itself.
  assert.match(guard(exec('session-branch', 'session-root')), /holds no active execution/);
  // A claim in one workline never grants anything in another: that workline
  // has no tree, so it is denied on its own empty-tree reason.
  assert.match(guard(exec('session-other')), /no task tree yet/);

  await store.update('session-root', (current) => ({
    envelope: envelopeAfter(current, [{ op: 'claim', id: 't1' }]).envelope,
  }));
  assert.equal(guard(exec('session-root')), undefined, 'the claim holder is allowed');
  assert.match(guard(exec('session-branch', 'session-root')), /holds no active execution/, 'a different session in the same workline is denied');

  await store.update('session-root', (current) => ({
    envelope: envelopeAfter(current, [{ op: 'release', id: 't1' }]).envelope,
  }));
  assert.match(guard(exec('session-root')), /holds no active execution/, 'release denies the same session immediately');
}

// ---------------------------------------------------------------------------
// execution gate: a missing ledger grants nothing (fail closed)
// ---------------------------------------------------------------------------

{
  // A record written before the execution ledger existed: the task still
  // carries a claim stamp and the workline has no `executions` array at all.
  // The stamp is an index, never the truth, so this grants no permission.
  const legacy = {
    version: 1,
    workline: {
      id: 'session-root', createdAt: 1, updatedAt: 2, goal: { original: 'g', current: 'g', changes: [] }, outline: '', focus: [], nextSeq: 2,
    },
    tasks: [{
      id: 't1',
      worklineId: 'session-root',
      parentId: null,
      order: 0,
      title: '旧任务',
      status: 'in_progress',
      executionApproval: 'approved',
      owner: { sessionId: 'session-root', since: 3 },
      createdAt: 1,
      updatedAt: 3,
    }],
  };
  const root = tempRoot();
  writeFileSync(join(root, 'session-root.json'), JSON.stringify(legacy));
  const store = createTaskStore({ root, logger: { warn() {} } });
  const sessions = new Map([['session-root', { header: { id: 'session-root' } }]]);
  const ctx = { get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined) };
  const guard = createExecutionGuard({ ctx, store });
  const denied = guard({
    name: 'write',
    agent: { id: 'session-root', session: { header: { id: 'session-root' } } },
  });
  // The read model already calls that execution `missing`; the gate must say
  // so per task, instead of falling back to the workline-level refusal.
  assert.equal(readSnapshot(legacy, 'session-root').tasks[0].executionState, 'missing');
  assert.match(denied, /execution ledger has no record/);
  assert.match(denied, /fail closed/);

  // An explicitly empty ledger is the same absent index.
  writeFileSync(join(root, 'session-empty-ledger.json'), JSON.stringify({
    version: 1,
    workline: { ...legacy.workline, id: 'session-empty-ledger', executions: [] },
    tasks: [{ ...legacy.tasks[0], worklineId: 'session-empty-ledger', owner: { sessionId: 'session-empty-ledger', since: 3 } }],
  }));
  const emptyCtx = { get: (name) => (name === 'sessions' ? { get: () => undefined } : undefined) };
  const emptyDenied = createExecutionGuard({ ctx: emptyCtx, store })({
    name: 'write',
    agent: { id: 'session-empty-ledger', session: { header: { id: 'session-empty-ledger' } } },
  });
  assert.match(emptyDenied, /execution ledger has no record/);
}

// ---------------------------------------------------------------------------
// execution gate: team mode makes the Lead a pure coordinator
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  const sessions = new Map([
    ['team-lead', { header: { id: 'team-lead' } }],
    ['team-worker', { header: { id: 'team-worker', parentSession: 'team-lead' } }],
    ['plain-child', { header: { id: 'plain-child', parentSession: 'team-lead', origin: 'subagent' } }],
  ]);
  // The real roster resolves membership from the live Agent; this stand-in does
  // the same by id. A provider-owned subagent is not a Team member.
  const members = new Map([
    ['team-lead', { id: 'team-lead', role: 'lead', name: 'lead', root: { id: 'team-lead' } }],
    ['team-worker', { id: 'team-worker', role: 'teammate', name: 'worker-a', root: { id: 'team-lead' } }],
  ]);
  const agentTeams = { tryMembership: (agent) => members.get(agent.id) };
  const ctx = {
    get: (name) => {
      if (name === 'sessions') return { get: (id) => sessions.get(id) };
      if (name === 'agentTeams') return agentTeams;
      return undefined;
    },
  };
  const guard = createExecutionGuard({ ctx, store });
  const exec = (sessionId, parentSession, tool = 'write') => ({
    name: tool,
    agent: {
      id: sessionId,
      session: { header: parentSession === undefined ? { id: sessionId } : { id: sessionId, parentSession } },
    },
  });

  // Team mode is decided by composition: even before any tree exists, the Lead
  // may not touch the workspace.
  const noTree = guard(exec('team-lead'));
  assert.match(noTree, /only coordinates/, 'a Team Lead is refused before any tree exists');
  assert.match(noTree, /class A/, 'the reason names the tool class');
  assert.match(noTree, /team-lead/, 'the reason names the calling session');

  // Class B and C stay open: the Lead still maintains the tree and coordinates.
  assert.equal(guard(exec('team-lead', undefined, 'task_tree_write')), undefined);
  assert.equal(guard(exec('team-lead', undefined, 'team_task_update')), undefined);
  assert.equal(guard(exec('team-lead', undefined, 'spawn_teammate')), undefined);
  assert.equal(guard(exec('team-lead', undefined, 'send_message')), undefined);
  assert.equal(guard(exec('team-lead', undefined, 'read')), undefined);
  const future = guard(exec('team-lead', undefined, 'some_future_plugin_tool'));
  assert.match(future, /some_future_plugin_tool is a class A tool/, 'an unclassified tool is class A for the Lead');
  assert.match(future, /only coordinates/);

  await store.update('team-lead', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: '团队模式' },
      { op: 'create', title: '协调', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    ], { worklineId: 'team-lead', actorSessionId: 'team-lead', standardMode: false }).envelope,
  }));
  // A tree does not widen the Lead's permission either.
  assert.match(guard(exec('team-lead')), /only coordinates/, 'a Lead with a tree is still refused');
  // The Lead cannot create an execution from the tree in team mode; the
  // Worker's board claim is the only way (ticket #6).
  assert.throws(
    () => envelopeAfter(store.snapshot('team-lead').present === true
      ? { version: 1, workline: { id: 'team-lead' }, tasks: store.snapshot('team-lead').tasks }
      : undefined, [{ op: 'claim', id: 't1' }],
    { worklineId: 'team-lead', actorSessionId: 'team-lead', standardMode: false }),
    /Team-board claim/,
  );

  // An unbound teammate holds no execution yet, and the provider-owned
  // subagent is not mistaken for the Lead.
  assert.match(guard(exec('team-worker', 'team-lead')), /holds no active execution/);
  assert.match(guard(exec('plain-child', 'team-lead')), /holds no active execution/);

  // A service exposing only the strict resolver is detected the same way.
  const strictCtx = {
    get: (name) => {
      if (name === 'sessions') return { get: (id) => sessions.get(id) };
      if (name === 'agentTeams') return { membership: (agent) => { if (agent.id !== 'team-lead') throw new Error('not a member'); return { id: 'team-lead', role: 'lead', name: 'lead', root: { id: 'team-lead' } }; } };
      return undefined;
    },
  };
  assert.match(createExecutionGuard({ ctx: strictCtx, store })(exec('team-lead')), /only coordinates/);

  // No Agent Team service: standard mode keeps its seat rule untouched.
  const standardCtx = { get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined) };
  assert.match(createExecutionGuard({ ctx: standardCtx, store })(exec('team-lead')), /holds no active execution/);
  await store.update('team-lead', (current) => ({
    envelope: envelopeAfter(current, [{ op: 'claim', id: 't1' }], {
      worklineId: 'team-lead', actorSessionId: 'team-lead', standardMode: true,
    }).envelope,
  }));
  assert.equal(createExecutionGuard({ ctx: standardCtx, store })(exec('team-lead')), undefined, 'a standard-mode claim still grants class A');
}

// ---------------------------------------------------------------------------
// team mode: dispatch is routing, the Worker's board claim is the binding
// ---------------------------------------------------------------------------

{
  const TEAM = { standardMode: false };
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '团队模式派工' },
    { op: 'create', title: '任务', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
  ], TEAM).envelope;
  assert.equal(base.tasks[0].status, 'pending', 'dispatch is routing: it does not start the task');
  assert.deepEqual(base.tasks[0].dispatch, { member: 'worker-a', at: NOW });
  assert.equal(base.tasks[0].teamTaskId, 'task-1');
  assert.equal(base.workline.executions.length, 0, 'dispatch creates no execution');
  assert.equal(base.tasks[0].owner, null);

  // Dispatch exists only in team mode, only for the Lead, and only for an
  // approved, open task.
  assert.throws(
    () => envelopeAfter(undefined, [
      { op: 'init', originalGoal: '标准模式' },
      { op: 'create', title: '任务', executionApproval: 'approved', approvalBasis: '开始吧' },
      { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
    ], { standardMode: true }),
    /team-mode operation/,
  );
  assert.throws(
    () => envelopeAfter(base, [{ op: 'dispatch', id: 't1', member: 'worker-b', teamTaskId: 'task-1' }],
      { ...TEAM, actorSessionId: 'session-other' }),
    /reserved for the Lead/,
  );
  const pending = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '团队模式派工' },
    { op: 'create', title: '未批准' },
  ], TEAM).envelope;
  assert.throws(
    () => envelopeAfter(pending, [{ op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' }], TEAM),
    /not approved for execution/,
  );
  const clashBase = envelopeAfter(base, [
    { op: 'create', title: '第二', executionApproval: 'approved', approvalBasis: '开始吧' },
  ], TEAM).envelope;
  assert.throws(
    () => envelopeAfter(clashBase, [{ op: 'dispatch', id: 't2', member: 'worker-b', teamTaskId: 'task-1' }], TEAM),
    /already associated/,
  );
  assert.throws(
    () => envelopeAfter(base, [{ op: 'claim', id: 't1' }], TEAM),
    /Team-board claim/,
    'the tree never creates a team execution',
  );

  // The Worker's claim binds the roster-resolved identity.
  const bound = bindTeamClaim(base, {
    taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW + 1,
  });
  assert.equal(bound.executionId, 'ex-1');
  assert.equal(bound.envelope.tasks[0].status, 'in_progress');
  assert.equal(bound.envelope.tasks[0].dispatch, null, 'the dispatch is consumed by the binding');
  assert.equal(bound.envelope.tasks[0].teamTaskId, 'task-1');
  assert.deepEqual(bound.envelope.tasks[0].owner, {
    sessionId: 'worker-session', executionId: 'ex-1', member: 'worker-a', since: NOW + 1,
  });
  const execution = bound.envelope.workline.executions[0];
  assert.equal(execution.mode, 'team');
  assert.equal(execution.teamTaskId, 'task-1');
  assert.equal(execution.member, 'worker-a');
  assert.equal(execution.sessionId, 'worker-session');
  assert.equal(execution.claimRevision, 2);
  assert.equal(execution.state, 'active');
  assert.deepEqual(readSnapshot(bound.envelope, 'session-root').tasks[0].executor, {
    kind: 'teammate', name: 'worker-a', sessionId: 'worker-session',
  });
  assert.equal(httpSnapshot(bound.envelope, 'session-root', { isLive: () => true }).tasks[0].ownerName, 'worker-a');

  // Evidence that does not match dispatches nothing.
  assert.throws(
    () => bindTeamClaim(base, {
      taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-b-session', member: 'worker-b', revision: 2, now: NOW + 1,
    }),
    /dispatched to worker-a/,
    'a model-supplied identity cannot claim another Worker\'s dispatch',
  );
  assert.throws(
    () => bindTeamClaim(base, {
      taskId: 't1', teamTaskId: 'task-2', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW + 1,
    }),
    /not associated with team task/,
  );
  assert.throws(
    () => bindTeamClaim(bound.envelope, {
      taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW + 1,
    }),
    /dispatched to nobody/,
    'a consumed dispatch cannot be replayed',
  );

  // I1/I2: one task and one Worker hold at most one non-terminal execution.
  const twoTasks = envelopeAfter(base, [
    { op: 'create', title: '第二个', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'dispatch', id: 't2', member: 'worker-a', teamTaskId: 'task-2' },
  ], TEAM).envelope;
  const first = bindTeamClaim(twoTasks, {
    taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW + 1,
  }).envelope;
  assert.throws(
    () => bindTeamClaim(first, {
      taskId: 't2', teamTaskId: 'task-2', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW + 2,
    }),
    /already holds execution ex-1/,
    'one session may hold only one execution',
  );
  const held = bindTeamClaim(twoTasks, {
    taskId: 't1', teamTaskId: 'task-1', sessionId: 'worker-session', member: 'worker-a', revision: 2, now: NOW + 1,
  }).envelope;
  assert.throws(
    () => bindTeamClaim(held, {
      taskId: 't1', teamTaskId: 'task-1', sessionId: 'other-session', member: 'worker-a', revision: 3, now: NOW + 2,
    }),
    /dispatched to nobody/,
  );

  // Release ends the team execution and clears the stamp; it never revives it.
  const released = envelopeAfter(bound.envelope, [{ op: 'release', id: 't1' }],
    { ...TEAM, actorSessionId: 'worker-session' }).envelope;
  assert.equal(released.tasks[0].owner, null);
  assert.equal(released.workline.executions[0].state, 'ended');
  assert.equal(released.workline.executions[0].endReason, 'released');
  assert.equal(released.tasks[0].status, 'in_progress', 'release does not complete the task');
}

{
  // The guard refuses reassign and a claim that does not match the tree
  // dispatch, using the roster identity rather than any argument field.
  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  const members = new Map([
    ['team-lead', { id: 'team-lead', role: 'lead', name: 'lead', root: { id: 'team-lead' } }],
    ['session-a', { id: 'session-a', role: 'teammate', name: 'worker-a', root: { id: 'team-lead' } }],
    ['session-b', { id: 'session-b', role: 'teammate', name: 'worker-b', root: { id: 'team-lead' } }],
  ]);
  const agentTeams = { tryMembership: (agent) => members.get(agent.id) };
  const ctx = {
    get: (name) => {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'agentTeams') return agentTeams;
      return undefined;
    },
  };
  const guard = createExecutionGuard({ ctx, store });
  const exec = (sessionId, tool, args) => ({
    name: tool,
    arguments: args,
    agent: { id: sessionId, session: { header: { id: sessionId, parentSession: 'team-lead' } } },
  });
  const claim = (sessionId, taskId, extra = {}) => exec(sessionId, 'team_task_update', {
    task_id: taskId, expected_revision: 1, action: 'claim', ...extra,
  });

  // No tree yet: no dispatch, so no claim.
  assert.match(guard(claim('session-a', 'task-1')), /no dispatch can exist/);

  await store.update('team-lead', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: '团队模式派工' },
      { op: 'create', title: '任务', executionApproval: 'approved', approvalBasis: '开始吧' },
      { op: 'dispatch', id: 't1', member: 'worker-a', teamTaskId: 'task-1' },
    ], { worklineId: 'team-lead', standardMode: false, actorSessionId: 'team-lead' }).envelope,
  }));
  assert.equal(guard(claim('session-a', 'task-1')), undefined, 'the dispatched Worker may claim');
  assert.match(guard(claim('session-b', 'task-1', { owner: 'worker-a' })),
    /dispatched to worker-a, not worker-b/,
    'a model-supplied owner field never decides identity');
  assert.match(guard(claim('team-lead', 'task-1')), /Team Lead coordinates/);

  // reassign is refused for both roles (I18).
  const reassign = (sessionId) => exec(sessionId, 'team_task_update', {
    task_id: 'task-1', expected_revision: 1, action: 'reassign', owner: 'worker-b',
  });
  assert.match(guard(reassign('team-lead')), /reassign is refused/);
  assert.match(guard(reassign('session-a')), /reassign is refused/);
  assert.match(guard(reassign('team-lead')), /claim only start from pending|can never be combined/);
  // A non-claim Team action is still class B.
  assert.equal(guard(exec('team-lead', 'team_task_update', { task_id: 'task-1', expected_revision: 1, action: 'complete' })), undefined);

  // Once bound, the Worker holds class A; another member does not.
  const snapshot = store.snapshot('team-lead');
  const bound = bindTeamClaim(snapshot.present === true ? { version: 1, workline: { id: 'team-lead' }, tasks: snapshot.tasks } : undefined, {
    taskId: 't1', teamTaskId: 'task-1', sessionId: 'session-a', member: 'worker-a', revision: 2, now: NOW,
  });
  await store.update('team-lead', () => ({ envelope: bound.envelope }));
  assert.equal(guard(exec('session-a', 'write')), undefined, 'the bound Worker may write');
  assert.match(guard(exec('session-b', 'write')), /holds no active execution/);
  // It can no longer claim another task: the session already holds one.
  await store.update('team-lead', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'create', title: '第二', executionApproval: 'approved', approvalBasis: '开始吧' },
      { op: 'dispatch', id: 't2', member: 'worker-a', teamTaskId: 'task-2' },
    ], { worklineId: 'team-lead', standardMode: false, actorSessionId: 'team-lead' }).envelope,
  }));
  assert.match(guard(claim('session-a', 'task-2')), /already holds an execution/);
  assert.match(guard(claim('session-b', 'task-2')), /dispatched to worker-a, not worker-b/);
}

// ---------------------------------------------------------------------------
// mount: tools and HTTP handlers against a fake context
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const routes = new Map();
  const registeredTools = new Map();
  const sections = [];
  const contexts = [];
  const liveSessions = new Map([
    ['session-root', { id: 'session-root', header: { id: 'session-root' } }],
    ['session-branch', { id: 'session-branch', header: { id: 'session-branch', parentSession: 'session-root', isSeeded: true } }],
  ]);
  const ctx = {
    effect(factory) {
      return factory();
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => liveSessions.get(id) };
      if (name === 'tools') {
        return { register: (definition) => { registeredTools.set(definition.name, definition); return () => registeredTools.delete(definition.name); } };
      }
      if (name === 'systemPrompt') {
        return {
          section: (section) => { sections.push(section); return () => {}; },
          context: (context) => { contexts.push(context); return () => {}; },
        };
      }
      return undefined;
    },
  };

  const mounted = mountTaskTree(ctx, {
    root,
    logger: { warn() {} },
    route: (target, path, handler) => {
      assert.equal(target, ctx);
      routes.set(path, handler);
    },
  });
  assert.equal(mounted.tools, true);
  assert.equal(mounted.prompt, true);
  assert.deepEqual([...registeredTools.keys()].sort(), ['task_tree_read', 'task_tree_write']);
  assert.deepEqual([...routes.keys()].sort(), ['/tasks', '/tasks/status']);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'agent-task-tree');
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].name, 'agent-task-tree:reminder');
  assert.equal(typeof contexts[0].text, 'function');

  const exec = {
    agent: {
      id: 'session-root',
      session: { header: { id: 'session-root' } },
    },
  };

  const empty = await registeredTools.get('task_tree_read').execute({}, exec);
  assert.deepEqual(empty, { worklineId: 'session-root', goal: null, focus: [], conflicts: [], tasks: [] });

  const written = await registeredTools.get('task_tree_write').execute({
    ops: [
      { op: 'init', originalGoal: '做任务树' },
      { op: 'create', title: '存储' },
      { op: 'create', title: '面板', parentId: 't1' },
      { op: 'focus', ids: ['t2'] },
    ],
  }, exec);
  assert.equal(written.ok, true);
  assert.equal(written.worklineId, 'session-root');
  assert.equal(written.applied.length, 4);

  // A branch shares the root workline.
  const branchExec = { agent: { id: 'session-branch', session: { header: { id: 'session-branch', parentSession: 'session-root', isSeeded: true } } } };
  const branchRead = await registeredTools.get('task_tree_read').execute({}, branchExec);
  assert.equal(branchRead.worklineId, 'session-root');
  assert.equal(branchRead.tasks.length, 2);

  const tasksHandler = routes.get('/tasks');
  const payload = await tasksHandler(ctx, { id: 'session-root', header: { id: 'session-root' } }, new URL('http://x/?sessionId=session-root'));
  assert.equal(payload.available, true);
  assert.equal(payload.goal.original, '做任务树');
  assert.deepEqual(payload.focus, ['t2']);
  assert.equal(payload.tasks[1].parentId, 't1');

  const status = await routes.get('/tasks/status')(ctx, { id: 'session-root', header: { id: 'session-root' } }, new URL('http://x/?sessionId=session-root'));
  assert.deepEqual(status.focus.map((row) => row.id), ['t2']);

  // Unknown session degrades to no-storage rather than throwing.
  const unknown = await tasksHandler(ctx, { id: 'session-unknown', header: { id: 'session-unknown' } }, new URL('http://x/?sessionId=session-unknown'));
  assert.equal(unknown.available, true);
  assert.equal(unknown.worklineId, 'session-unknown');
}

// ---------------------------------------------------------------------------
// tools: write denial for subagent callers
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const registeredTools = new Map();
  const ctx = {
    effect: (factory) => factory(),
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'tools') return { register: (definition) => { registeredTools.set(definition.name, definition); return () => {}; } };
      if (name === 'systemPrompt') return undefined;
      return undefined;
    },
  };
  mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  await assert.rejects(
    registeredTools.get('task_tree_write').execute(
      { ops: [{ op: 'init', originalGoal: 'g' }] },
      { agent: { id: 'session-child', session: { header: { id: 'session-child', parentSession: 'session-root', origin: 'subagent' } } } },
    ),
    /reserved for the lead session/,
  );
}

// ---------------------------------------------------------------------------
// tools: the standard-mode handover through the real tool path
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const registeredTools = new Map();
  let registeredGuard;
  const headers = new Map([
    ['session-root', { id: 'session-root' }],
    ['session-child', { id: 'session-child', parentSession: 'session-root', origin: 'subagent' }],
  ]);
  const ctx = {
    effect: (factory) => factory(),
    get(name) {
      if (name === 'sessions') {
        return {
          get: (id) => (headers.has(id) ? { header: headers.get(id) } : undefined),
        };
      }
      if (name === 'tools') {
        return {
          register: (definition) => { registeredTools.set(definition.name, definition); return () => {}; },
          guard: (fn) => { registeredGuard = fn; return () => {}; },
        };
      }
      if (name === 'systemPrompt') return undefined;
      return undefined;
    },
  };
  mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  const write = registeredTools.get('task_tree_write');
  const userMessage = (text) => [{
    type: 'user/message',
    seq: 1,
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }];
  const sessionFor = (header) => ({ id: header.id, header, seq: 2, snapshotEvents: () => userMessage('开始吧') });
  const lead = { agent: { id: 'session-root', session: sessionFor(headers.get('session-root')) } };
  const child = { agent: { id: 'session-child', session: sessionFor(headers.get('session-child')) } };
  const classified = (sessionId) => (tool) => ({ name: tool, agent: { id: sessionId, session: sessionFor(headers.get(sessionId)) } });

  // The Lead sets up and claims.
  await write.execute({
    ops: [
      { op: 'init', originalGoal: '交接' },
      { op: 'create', title: '交接任务', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
      { op: 'claim', id: 't1' },
    ],
  }, lead);
  assert.match(registeredGuard(classified('session-child')('write')), /holds no active execution/);

  // Release and assign to the child, using the session id from the spawn result.
  await write.execute({ ops: [{ op: 'release', id: 't1' }] }, lead);
  const assigned = await write.execute({ ops: [{ op: 'assign', id: 't1', member: 'session-child' }] }, lead);
  assert.equal(assigned.applied[0].op, 'assign');
  // A non-subagent or unknown member is refused.
  await assert.rejects(
    () => write.execute({ ops: [{ op: 'assign', id: 't1', member: 'session-root' }] }, lead),
    /is not a subagent session/,
  );
  await assert.rejects(
    () => write.execute({ ops: [{ op: 'assign', id: 't1', member: 'session-ghost' }] }, lead),
    /is not a known session/,
  );

  // The subagent claims through the same tool; only claim/release are allowed.
  const childClaim = await write.execute({ ops: [{ op: 'claim', id: 't1' }] }, child);
  assert.equal(childClaim.applied[0].executionId, 'ex-2');
  assert.equal(registeredGuard(classified('session-child')('write')), undefined, 'the subagent may now write');
  assert.match(registeredGuard(classified('session-root')('write')), /holds no active execution/, 'the lead may not');
  await assert.rejects(
    () => write.execute({ ops: [{ op: 'init', originalGoal: 'again' }] }, child),
    /reserved for the lead session/,
  );
  await assert.rejects(
    () => write.execute({ ops: [{ op: 'assign', id: 't1', member: 'lead' }] }, child),
    /reserved for the lead session/,
  );
  await write.execute({ ops: [{ op: 'release', id: 't1' }] }, child);

  // The lead takes it back with a fresh execution id.
  await write.execute({ ops: [{ op: 'assign', id: 't1', member: 'lead' }] }, lead);
  const reclaim = await write.execute({ ops: [{ op: 'claim', id: 't1' }] }, lead);
  assert.equal(reclaim.applied[0].executionId, 'ex-3');
}

// ---------------------------------------------------------------------------
// mount: the execution gate is registered through the tool registry's guard
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const registeredTools = new Map();
  let registeredGuard;
  const ctx = {
    effect: (factory) => factory(),
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'tools') {
        return {
          register: (definition) => { registeredTools.set(definition.name, definition); return () => {}; },
          guard: (fn) => { registeredGuard = fn; return () => {}; },
        };
      }
      return undefined;
    },
  };
  const mounted = mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  assert.equal(mounted.guard, true, 'the execution gate is registered');
  assert.equal(typeof registeredGuard, 'function');
  const session = {
    id: 'session-gate',
    header: { id: 'session-gate' },
    seq: 2,
    snapshotEvents: () => [{ type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: '开始吧' }] } }],
  };
  const exec = (tool) => ({ name: tool, agent: { id: 'session-gate', session } });

  // No tree: refused, with the bootstrap path (ADR-0001).
  assert.match(registeredGuard(exec('write')), /no task tree yet/);

  const write = registeredTools.get('task_tree_write');
  const writeExec = { agent: { id: 'session-gate', session } };
  await write.execute({
    ops: [
      { op: 'init', originalGoal: '门禁' },
      { op: 'create', title: '任务', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    ],
  }, writeExec);
  assert.match(registeredGuard(exec('write')), /holds no active execution/);
  assert.match(registeredGuard(exec('bash')), /holds no active execution/);
  assert.equal(registeredGuard(exec('task_tree_write')), undefined, 'the gate never blocks the tool that creates the execution');

  await write.execute({ ops: [{ op: 'claim', id: 't1' }] }, writeExec);
  assert.equal(registeredGuard(exec('write')), undefined);

  await write.execute({ ops: [{ op: 'release', id: 't1' }] }, writeExec);
  assert.match(registeredGuard(exec('write')), /holds no active execution/);
}

// ---------------------------------------------------------------------------
// storage failure degrades instead of throwing
// ---------------------------------------------------------------------------

{
  mkdirSync(join(tempRoot(), 'not-a-dir'));
  const fileAsRoot = join(tempRoot(), 'file');
  writeFileSync(fileAsRoot, 'x');
  const store = createTaskStore({ root: fileAsRoot, logger: { warn() {} } });
  assert.equal(await store.available(), false);
}


// ---------------------------------------------------------------------------
// archived queries: opt-in, bounded, and scoped to one workline
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '父' },
    { op: 'create', title: '子', parentId: 't1', progress: '做到一半' },
    { op: 'create', title: '另一个' },
  ]).envelope;
  const archived = envelopeAfter(base, [{ op: 'archive', id: 't1', reason: '不做了' }]).envelope;

  const plain = readSnapshot(archived, CTX.worklineId);
  assert.equal(plain.archived, undefined);
  assert.deepEqual(plain.tasks.map((task) => task.title), ['另一个']);

  const withArchived = readSnapshot(archived, CTX.worklineId, true, { includeArchived: true });
  assert.equal(withArchived.archivedTotal, 2);
  assert.equal(withArchived.tasks.length, 1);
  const child = withArchived.archived.find((task) => task.id === 't2');
  assert.equal(child.archiveReason, '不做了');
  assert.equal(typeof child.archivedAt, 'number');
  assert.deepEqual(child.path, ['父']);
  assert.equal(child.progress, '做到一半');
  const parentRow = withArchived.archived.find((task) => task.id === 't1');
  assert.deepEqual(parentRow.path, []);

  const limited = readSnapshot(archived, CTX.worklineId, false, { includeArchived: true, archivedLimit: 1 });
  assert.equal(limited.archived.length, 1);
  assert.equal(limited.archivedTotal, 2);

  const empty = readSnapshot(undefined, 'session-empty', false, { includeArchived: true });
  assert.deepEqual(empty.archived, []);
  assert.equal(empty.archivedTotal, 0);
}

{
  // Workline isolation: one workline's archive is invisible through another.
  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  await store.update('session-a', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: 'A' },
      { op: 'create', title: 'A 的任务' },
      { op: 'archive', id: 't1', reason: 'A 取消' },
    ]).envelope,
  }));
  await store.update('session-b', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: 'B' },
      { op: 'create', title: 'B 的任务' },
    ]).envelope,
  }));
  const a = await store.read('session-a');
  const b = await store.read('session-b');
  const aSnapshot = readSnapshot(a, 'session-a', false, { includeArchived: true });
  const bSnapshot = readSnapshot(b, 'session-b', false, { includeArchived: true });
  assert.equal(aSnapshot.archivedTotal, 1);
  assert.equal(aSnapshot.archived[0].title, 'A 的任务');
  assert.equal(bSnapshot.archivedTotal, 0);
  assert.deepEqual(bSnapshot.tasks.map((task) => task.title), ['B 的任务']);
}

// ---------------------------------------------------------------------------
// a completed task can receive new unfinished children
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '用户登录' },
    { op: 'create', title: '登录功能', executionApproval: 'approved', approvalBasis: '登录功能可以做，开始吧。' },
    { op: 'create', title: '登录接口', parentId: 't1' },
    { op: 'complete', id: 't2', result: '接口完成' },
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '验收通过', result: '登录完成' },
  ]).envelope;
  const doneAt = base.tasks[0].completedAt;
  assert.equal(doneAt, NOW);

  const withChild = envelopeAfter(base, [
    { op: 'create', title: '修复 Token 过期', parentId: 't1', summary: '上线后发现' },
  ]).envelope;
  const parent = withChild.tasks.find((task) => task.id === 't1');
  const followUp = withChild.tasks.find((task) => task.title === '修复 Token 过期');
  assert.equal(parent.status, 'done');
  assert.equal(parent.completedAt, doneAt);
  assert.equal(parent.completion, 'user-confirmed');
  assert.equal(followUp.status, 'pending');
  assert.equal(followUp.parentId, 't1');

  // The follow-up can be progressed and completed on its own.
  const progressed = envelopeAfter(withChild, [
    { op: 'update', id: followUp.id, status: 'in_progress', progress: '定位中' },
    { op: 'focus', ids: [followUp.id] },
  ]).envelope;
  assert.equal(progressed.workline.focus[0], followUp.id);
  assert.equal(progressed.tasks.find((task) => task.id === 't1').status, 'done');

  // Moving an existing task under a completed parent keeps the parent done.
  const moved = envelopeAfter(base, [
    { op: 'create', title: '后续优化' },
    { op: 'move', id: 't3', parentId: 't1' },
  ]).envelope;
  assert.equal(moved.tasks.find((task) => task.id === 't1').status, 'done');
  assert.equal(moved.tasks.find((task) => task.id === 't3').parentId, 't1');

  // First-completion still rejects unfinished children, and re-completing a
  // done parent stays rejected.
  assert.throws(
    () => envelopeAfter(base, [{ op: 'complete', id: 't1', confirmedByUser: true }]),
    /already done/,
  );
  const read = readSnapshot(withChild, CTX.worklineId, true);
  const childRow = read.tasks.find((task) => task.title === '修复 Token 过期');
  assert.equal(childRow.parentId, 't1');
  assert.equal(childRow.status, 'pending');
}

// ---------------------------------------------------------------------------
// restore archived work: id/history preserved, subtree consistent
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '短信登录' },
    { op: 'create', title: '验证码', parentId: 't1', progress: '已做一半' },
    { op: 'create', title: '其他' },
  ]).envelope;
  const archived = envelopeAfter(base, [{ op: 'archive', id: 't1', reason: '先不做' }]).envelope;

  const restored = envelopeAfter(archived, [{ op: 'restore', id: 't1' }]).envelope;
  const parent = restored.tasks.find((task) => task.id === 't1');
  const child = restored.tasks.find((task) => task.id === 't2');
  assert.equal(parent.archived, false);
  assert.equal(parent.archiveReason, null);
  assert.equal(parent.archiveHistory.length, 1);
  assert.equal(parent.archiveHistory[0].reason, '先不做');
  assert.equal(child.archived, false);
  assert.equal(child.parentId, 't1');
  assert.equal(child.progress, '已做一半');
  assert.equal(restored.tasks.filter((task) => task.id === 't1').length, 1);

  const read = readSnapshot(restored, CTX.worklineId);
  assert.deepEqual(read.tasks.map((task) => task.title).sort(), ['其他', '短信登录', '验证码'].sort());

  // Restoring twice is rejected, and a non-archived task cannot be restored.
  assert.throws(
    () => envelopeAfter(restored, [{ op: 'restore', id: 't1' }]),
    /is not archived/,
  );
  assert.throws(
    () => envelopeAfter(base, [{ op: 'restore', id: 't2' }]),
    /is not archived/,
  );
  assert.throws(
    () => envelopeAfter(archived, [{ op: 'restore', id: 't99' }]),
    /unknown task/,
  );
}

{
  // A child restored while its parent is still archived goes to the nearest
  // active ancestor instead of creating an orphan under an archived node.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '模块' },
    { op: 'create', title: '功能', parentId: 't1' },
    { op: 'create', title: '细节', parentId: 't2' },
  ]).envelope;
  const archived = envelopeAfter(base, [{ op: 'archive', id: 't2', reason: '取消功能' }]).envelope;
  const restoredChild = envelopeAfter(archived, [{ op: 'restore', id: 't3' }]).envelope;
  const detail = restoredChild.tasks.find((task) => task.id === 't3');
  assert.equal(detail.archived, false);
  assert.equal(detail.parentId, 't1');
  assert.equal(restoredChild.tasks.find((task) => task.id === 't2').archived, true);
  const tree = readSnapshot(restoredChild, CTX.worklineId);
  const parentRow = tree.tasks.find((task) => task.id === 't1');
  assert.equal(parentRow.depth, 0);
  const detailRow = tree.tasks.find((task) => task.id === 't3');
  assert.equal(detailRow.depth, 1);
}


// ---------------------------------------------------------------------------
// tools: archived query and restore through the mounted feature
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const registeredTools = new Map();
  const ctx = {
    effect: (factory) => factory(),
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'tools') return { register: (definition) => { registeredTools.set(definition.name, definition); return () => {}; } };
      if (name === 'systemPrompt') return undefined;
      return undefined;
    },
  };
  mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  const exec = { agent: { id: 'session-tools', session: { header: { id: 'session-tools' } } } };
  const write = registeredTools.get('task_tree_write');
  const read = registeredTools.get('task_tree_read');

  await write.execute({
    ops: [
      { op: 'init', originalGoal: '工具测试' },
      { op: 'create', title: '父' },
      { op: 'create', title: '子', parentId: 't1' },
      { op: 'archive', id: 't1', reason: '工具层归档' },
    ],
  }, exec);

  const plain = await read.execute({}, exec);
  assert.equal(plain.archived, undefined);
  assert.equal(plain.tasks.length, 0);

  const withArchived = await read.execute({ includeArchived: true }, exec);
  assert.equal(withArchived.archivedTotal, 2);
  assert.equal(withArchived.archived.length, 2);
  assert.equal(withArchived.archived[0].archiveReason, '工具层归档');

  const restored = await write.execute({ ops: [{ op: 'restore', id: 't1' }] }, exec);
  assert.equal(restored.ok, true);
  const afterRestore = await read.execute({}, exec);
  assert.deepEqual(afterRestore.tasks.map((task) => task.title).sort(), ['子', '父']);
}


// ---------------------------------------------------------------------------
// per-turn reminder: nudge until the newest user request has a tree write
// ---------------------------------------------------------------------------

{
  const userEvent = (seq, text, kind = 'user') => ({
    type: 'user/message',
    seq,
    data: { source: { kind }, content: [{ type: 'text', text }] },
  });
  const writeEvent = (seq) => ({ type: 'tool/call', seq, data: { name: 'task_tree_write' } });
  const sessionOf = (id, events, header = { id }) => ({
    id,
    header,
    seq: events.length === 0 ? 0 : events[events.length - 1].seq + 1,
    snapshotEvents: (from = 0) => events.filter((event) => event.seq >= from),
  });

  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  await store.update('session-root', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: 'g' },
      { op: 'create', title: '任务' },
    ]).envelope,
  }));

  const live = new Map([['session-root', sessionOf('session-root', [])]]);
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: (id) => live.get(id) };
      return undefined;
    },
  };

  // No tree file yet: a new session is nudged to create one instead of waiting.
  const stranger = sessionOf('session-stranger', [userEvent(1, '帮我改个 bug')]);
  assert.equal(taskTreeReminderFor(ctx, store, stranger), TASK_TREE_START_REMINDER);

  // A real user message with no write after it -> reminder.
  const pending = sessionOf('session-root', [userEvent(5, '实现这三个功能')]);
  assert.equal(taskTreeReminderFor(ctx, store, pending), TASK_TREE_REMINDER);

  // A write after the message clears it.
  const settled = sessionOf('session-root', [userEvent(5, '实现这三个功能'), writeEvent(6)]);
  assert.equal(taskTreeReminderFor(ctx, store, settled), '');

  // Runtime-context refreshes and skill reminders are not user requests.
  const refreshed = sessionOf('session-root', [
    userEvent(5, '实现这三个功能'),
    writeEvent(6),
    userEvent(7, 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.', 'runtime-context'),
    userEvent(8, '<system-reminder>skills</system-reminder>', 'skill-catalog'),
    userEvent(9, 'Time sampled while preparing turn 2, step 1', 'time-context'),
  ]);
  assert.equal(taskTreeReminderFor(ctx, store, refreshed), '');

  // A brand-new request after a write triggers it again.
  const nextTurn = sessionOf('session-root', [userEvent(5, 'a'), writeEvent(6), userEvent(9, 'b')]);
  assert.equal(taskTreeReminderFor(ctx, store, nextTurn), TASK_TREE_REMINDER);

  // Subagent sessions never receive the reminder; the lead owns the tree.
  const child = sessionOf('session-child', [userEvent(2, '做子任务')], { id: 'session-child', origin: 'subagent' });
  assert.equal(taskTreeReminderFor(ctx, store, child), '');

  // A branch resolves to the live parent's workline and is reminded there.
  live.set('session-root', sessionOf('session-root', []));
  const branch = sessionOf('session-branch', [userEvent(3, '继续这个功能')], { id: 'session-branch', parentSession: 'session-root' });
  assert.equal(taskTreeReminderFor(ctx, store, branch), TASK_TREE_REMINDER);

  // A branch of a workline without a tree is nudged to create one.
  const plainBranch = sessionOf('session-plain', [userEvent(3, '你好')], { id: 'session-plain', parentSession: 'session-unused' });
  assert.equal(taskTreeReminderFor(ctx, store, plainBranch), TASK_TREE_START_REMINDER);

  // Injected context alone never counts as a user request.
  const injectedOnly = sessionOf('session-fresh', [
    userEvent(1, 'Current runtime context. Snapshot.', 'runtime-context'),
    userEvent(2, '<system-reminder>skills</system-reminder>', 'skill-catalog'),
  ]);
  assert.equal(taskTreeReminderFor(ctx, store, injectedOnly), '');
}


// ---------------------------------------------------------------------------
// restore when the original parent is still archived
// ---------------------------------------------------------------------------

{
  // Parent archived: the restored child falls back to the nearest active
  // ancestor, appends to its sibling order, and the parent stays archived.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '模块' },
    { op: 'create', title: '功能', parentId: 't1' },
    { op: 'create', title: '细节', parentId: 't2' },
    { op: 'create', title: '兄弟', parentId: 't1' },
  ]).envelope;
  const archived = envelopeAfter(base, [{ op: 'archive', id: 't2', reason: '取消功能' }]).envelope;
  const restored = envelopeAfter(archived, [{ op: 'restore', id: 't3' }]).envelope;
  const detail = restored.tasks.find((task) => task.id === 't3');
  const feature = restored.tasks.find((task) => task.id === 't2');
  assert.equal(detail.archived, false);
  assert.equal(detail.parentId, 't1');
  assert.equal(detail.order, 2, 'restored child appends after the active sibling');
  assert.equal(feature.archived, true, 'the archived parent is not resurrected');
  assert.equal(restored.tasks.filter((task) => task.id === 't3').length, 1);
  assert.equal(detail.archiveHistory.length, 1);
  assert.equal(detail.archiveHistory[0].reason, '取消功能');
}

{
  // Every ancestor archived: the restored task becomes a root.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: 'A' },
    { op: 'create', title: 'B', parentId: 't1' },
    { op: 'create', title: 'C', parentId: 't2' },
  ]).envelope;
  const archived = envelopeAfter(base, [{ op: 'archive', id: 't1', reason: '整组取消' }]).envelope;
  const restored = envelopeAfter(archived, [{ op: 'restore', id: 't3' }]).envelope;
  const c = restored.tasks.find((task) => task.id === 't3');
  assert.equal(c.archived, false);
  assert.equal(c.parentId, null, 'no active ancestor left, so the task becomes a root');
  const tree = readSnapshot(restored, CTX.worklineId);
  assert.equal(tree.tasks.find((task) => task.id === 't3').depth, 0);
  assert.equal(restored.tasks.find((task) => task.id === 't1').archived, true);
  assert.equal(restored.tasks.find((task) => task.id === 't2').archived, true);
}

{
  // A descendant cancelled separately earlier must NOT come back when its
  // parent is restored later; restoring that descendant afterwards returns it
  // to the now-active original parent.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '模块' },
    { op: 'create', title: '功能', parentId: 't1' },
    { op: 'create', title: '旧细节', parentId: 't2' },
  ]).envelope;
  const childArchivedFirst = envelopeAfter(base, [{ op: 'archive', id: 't3', reason: '细节先取消' }]).envelope;
  const parentArchivedLater = envelopeAfter(childArchivedFirst, [{ op: 'archive', id: 't2', reason: '功能后取消' }]).envelope;

  const parentRestored = envelopeAfter(parentArchivedLater, [{ op: 'restore', id: 't2' }]).envelope;
  assert.equal(parentRestored.tasks.find((task) => task.id === 't2').archived, false);
  assert.equal(
    parentRestored.tasks.find((task) => task.id === 't3').archived,
    true,
    'a separately archived descendant stays archived',
  );
  assert.deepEqual(readSnapshot(parentRestored, CTX.worklineId).tasks.map((task) => task.title).sort(), ['模块', '功能'].sort());

  const childRestored = envelopeAfter(parentRestored, [{ op: 'restore', id: 't3' }]).envelope;
  const oldDetail = childRestored.tasks.find((task) => task.id === 't3');
  assert.equal(oldDetail.archived, false);
  assert.equal(oldDetail.parentId, 't2', 'the now-active original parent is used');
  assert.equal(oldDetail.archiveHistory[0].reason, '细节先取消');
  assert.equal(childRestored.tasks.find((task) => task.id === 't2').archiveHistory[0].reason, '功能后取消');
}

{
  // Restoring a parent whose batch included children brings the batch back
  // once; a child restored earlier is not duplicated or moved.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '模块' },
    { op: 'create', title: '功能', parentId: 't1' },
    { op: 'create', title: '细节', parentId: 't2' },
    { op: 'create', title: '另一细节', parentId: 't2' },
  ]).envelope;
  const archived = envelopeAfter(base, [{ op: 'archive', id: 't2', reason: '取消功能' }]).envelope;
  const partial = envelopeAfter(archived, [{ op: 'restore', id: 't3' }]).envelope;
  const full = envelopeAfter(partial, [{ op: 'restore', id: 't2' }]).envelope;
  const ids = full.tasks.map((task) => task.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate task ids');
  const feature = full.tasks.find((task) => task.id === 't2');
  const detail = full.tasks.find((task) => task.id === 't3');
  assert.equal(feature.archived, false);
  assert.equal(detail.parentId, 't1', 'the earlier restoration keeps its placement');
  assert.equal(full.tasks.find((task) => task.id === 't4').archived, false, 'same-batch sibling comes back');
}


// ---------------------------------------------------------------------------
// execution approval: permission is separate from status
// ---------------------------------------------------------------------------

{
  // A new task is an idea until the user approves it.
  const created = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '短链接服务' },
    { op: 'create', title: 'Web 管理后台' },
  ]).envelope;
  assert.equal(created.tasks[0].executionApproval, 'pending');
  assert.equal(created.tasks[0].approvalBasis, null);

  // Approving a top-level task needs the user's own words.
  assert.throws(
    () => envelopeAfter(created, [{ op: 'update', id: 't1', executionApproval: 'approved' }]),
    /requires approvalBasis/,
  );
  assert.throws(
    () => envelopeAfter(created, [{ op: 'update', id: 't1', executionApproval: 'approved', approvalBasis: '用户说要做' }]),
    /does not appear in a user message/,
  );
  const approved = envelopeAfter(created, [
    { op: 'update', id: 't1', executionApproval: 'approved', approvalBasis: '登录功能可以做，开始吧', requiresUserAcceptance: true },
  ]).envelope;
  assert.equal(approved.tasks[0].executionApproval, 'approved');
  assert.equal(approved.tasks[0].approvalBasis, '登录功能可以做，开始吧');
  assert.equal(approved.tasks[0].approvalAt, NOW);

  // A basis without the approval flag is a caller mistake, not a silent no-op.
  assert.throws(
    () => envelopeAfter(created, [{ op: 'update', id: 't1', approvalBasis: '开始吧' }]),
    /only applies together with executionApproval/,
  );
  assert.throws(
    () => envelopeAfter(created, [{ op: 'update', id: 't1', executionApproval: 'yes-please' }]),
    /executionApproval must be one of approved, pending/,
  );

  // Withdrawing approval clears its evidence.
  const revoked = envelopeAfter(approved, [{ op: 'update', id: 't1', executionApproval: 'pending' }]).envelope;
  assert.equal(revoked.tasks[0].executionApproval, 'pending');
  assert.equal(revoked.tasks[0].approvalBasis, null);
  assert.equal(revoked.tasks[0].approvalAt, null);
}

{
  // Inheritance: normal steps inside an approved scope are covered, an invented
  // extra feature is not, and approval never flows through a pending parent.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '短链接服务' },
    { op: 'create', title: '登录', executionApproval: 'approved', approvalBasis: '登录功能可以做，开始吧。' },
  ]).envelope;
  const inherited = envelopeAfter(base, [
    { op: 'create', title: '登录接口', parentId: 't1' },
    { op: 'create', title: '登录页', parentId: 't1' },
  ]).envelope;
  assert.deepEqual(inherited.tasks.slice(1).map((task) => task.executionApproval), ['approved', 'approved']);
  assert.equal(inherited.tasks[1].approvalBasis, null, 'inherited approval cites no new quote');

  // Scope the user never agreed to stays pending even under an approved parent.
  const extra = envelopeAfter(inherited, [
    { op: 'create', title: 'OAuth 第三方登录', parentId: 't1', executionApproval: 'pending' },
  ]).envelope;
  assert.equal(extra.tasks.find((task) => task.title === 'OAuth 第三方登录').executionApproval, 'pending');

  // Approving that unrelated child needs its own quote: an existing task never
  // inherits approval, only a step created inside the approved scope does.
  assert.throws(
    () => envelopeAfter(extra, [{ op: 'update', id: 't4', executionApproval: 'approved' }]),
    /approving an existing task requires approvalBasis/,
  );
  assert.throws(
    () => envelopeAfter(extra, [{
      op: 'update',
      id: 't4',
      executionApproval: 'approved',
      approvalBasis: '顺便把 OAuth 也做了',
    }]),
    /does not appear in a user message/,
  );

  // A pending parent does not approve its children.
  const pendingParent = envelopeAfter(base, [
    { op: 'create', title: '多用户系统', executionApproval: 'pending' },
    { op: 'create', title: '邀请码', parentId: 't2' },
  ]).envelope;
  assert.equal(pendingParent.tasks.find((task) => task.title === '邀请码').executionApproval, 'pending');

  // A pending step inside an approved scope must not be tunnelled through: the
  // direct parent decides, so one more level down stays unapproved too.
  const nested = envelopeAfter(base, [
    { op: 'create', title: '多用户系统', parentId: 't1', executionApproval: 'pending' },
    { op: 'create', title: '邀请码', parentId: 't2' },
    { op: 'create', title: '邀请码校验', parentId: 't3' },
  ]).envelope;
  assert.equal(
    nested.tasks.find((task) => task.title === '邀请码').executionApproval,
    'pending',
    'a pending parent blocks inheritance even under an approved ancestor',
  );
  assert.equal(
    nested.tasks.find((task) => task.title === '邀请码校验').executionApproval,
    'pending',
    'inheritance never walks past the direct parent',
  );

  // Creating a task already in progress is the same gate as updating it.
  assert.throws(
    () => envelopeAfter(base, [{ op: 'create', title: '偷偷开工', status: 'in_progress' }]),
    /is not approved for execution/,
  );
}

{
  // An unapproved task may be discussed and focused, but not started.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '短链接服务' },
    { op: 'create', title: '访问看板' },
  ]).envelope;

  const focused = envelopeAfter(base, [{ op: 'focus', ids: ['t1'] }]).envelope;
  assert.deepEqual(focused.workline.focus, ['t1']);
  assert.equal(focused.tasks[0].status, 'pending', 'focus is attention, not execution');

  assert.throws(
    () => envelopeAfter(base, [{ op: 'update', id: 't1', status: 'in_progress' }]),
    /is not approved for execution/,
  );
  assert.throws(
    () => envelopeAfter(base, [{ op: 'claim', id: 't1' }]),
    /is not approved for execution/,
  );

  // Recording progress on work that already started is never blocked.
  const running = envelopeAfter(base, [{ op: 'update', id: 't1', progress: '记录进展' }]).envelope;
  assert.equal(running.tasks[0].progress, '记录进展');
  assert.equal(running.tasks[0].executionApproval, 'pending');

  // Once approved the same transitions succeed.
  const ready = envelopeAfter(base, [
    { op: 'update', id: 't1', executionApproval: 'approved', approvalBasis: '开始吧', requiresUserAcceptance: true },
    { op: 'update', id: 't1', status: 'in_progress' },
    { op: 'claim', id: 't1' },
  ]).envelope;
  assert.equal(ready.tasks[0].status, 'in_progress');
  assert.equal(ready.tasks[0].owner.sessionId, 'session-root');
}

// ---------------------------------------------------------------------------
// completion: self-verification now, the user's acceptance when they say so
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'Web 管理后台' },
    { op: 'create', title: '管理后台', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', title: '后台页面', parentId: 't1' },
  ]).envelope;
  // An implementation step may self-complete; the delivered requirement may not.
  const self = envelopeAfter(base, [{ op: 'complete', id: 't2', result: '实现并自测通过' }]).envelope;
  assert.equal(self.tasks[1].status, 'done');
  assert.equal(self.tasks[1].completion, 'self');
  assert.equal(self.tasks[1].completionBasis, null);
  assert.throws(
    () => envelopeAfter(self, [{ op: 'complete', id: 't1', result: '实现并自测通过' }]),
    /needs the user's acceptance/,
  );

  // Delivering does not close the requirement: the work is recorded and the
  // task stays open with the delivery note.
  const delivered = envelopeAfter(self, [
    { op: 'update', id: 't1', status: 'in_progress' },
    { op: 'update', id: 't1', progress: '开发与测试已完成，等待用户验收。', result: '后台页面已上线' },
  ]).envelope;
  assert.equal(delivered.tasks[0].status, 'in_progress');
  assert.equal(delivered.tasks[0].completion, null);
  assert.equal(delivered.tasks[0].result, '后台页面已上线');

  // The user accepts later: the same task records acceptance without reopening.
  const accepted = envelopeAfter(delivered, [
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '没问题了，验收通过' },
  ]).envelope;
  assert.equal(accepted.tasks[0].status, 'done');
  assert.equal(accepted.tasks[0].completion, 'user-confirmed');
  assert.equal(accepted.tasks[0].completionBasis, '没问题了，验收通过');

  // An implementation step completed on its own can be accepted afterwards,
  // and acceptance keeps the completion time.
  const stepAccepted = envelopeAfter(self, [
    { op: 'update', id: 't2', confirmedByUser: true, confirmationBasis: '验收通过' },
  ]).envelope;
  assert.equal(stepAccepted.tasks[1].completion, 'user-confirmed');
  assert.equal(stepAccepted.tasks[1].completedAt, self.tasks[1].completedAt, 'acceptance keeps the completion time');

  assert.throws(
    () => envelopeAfter(self, [{ op: 'update', id: 't2', confirmedByUser: true, confirmationBasis: '全都通过了' }]),
    /does not appear in a user message/,
  );
  assert.throws(
    () => envelopeAfter(accepted, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '验收通过' }]),
    /already done/,
  );

  // Reopening clears the completion record.
  const reopened = envelopeAfter(accepted, [{ op: 'update', id: 't1', status: 'in_progress' }]).envelope;
  assert.equal(reopened.tasks[0].completion, null);
  assert.equal(reopened.tasks[0].completionBasis, null);
  assert.equal(reopened.tasks[0].completedAt, null);
}

// ---------------------------------------------------------------------------
// legacy records keep loading and are never assumed approved
// ---------------------------------------------------------------------------

{
  const legacy = {
    version: 1,
    workline: { id: 'session-root', createdAt: 1, updatedAt: 2, goal: null, outline: '', focus: [], nextSeq: 3 },
    tasks: [
      { id: 't1', worklineId: 'session-root', parentId: null, order: 0, title: '旧任务', status: 'done', completion: 'user-confirmed', createdAt: 1, updatedAt: 2 },
      { id: 't2', worklineId: 'session-root', parentId: 't1', order: 0, title: '旧子任务', status: 'pending', createdAt: 1, updatedAt: 2 },
    ],
  };
  const snapshot = readSnapshot(legacy, CTX.worklineId, true);
  assert.equal(snapshot.tasks[0].approval, 'pending');
  assert.equal(snapshot.tasks[0].completion, 'user-confirmed', 'the historic claim is kept, but it carries no basis');
  assert.equal(snapshot.tasks[0].approvalBasis, null);
  const http = httpSnapshot(legacy, CTX.worklineId, { isLive: () => false });
  assert.deepEqual(http.tasks.map((task) => task.executionApproval), ['pending', 'pending']);
  assert.equal(http.tasks[0].completion, 'user-confirmed', 'an explicitly recorded completion kind survives');
  assert.equal(http.tasks[0].completionBasis, null);
  // The legacy record can still be approved and continued.
  const resumed = envelopeAfter(legacy, [
    { op: 'update', id: 't2', executionApproval: 'approved', approvalBasis: '开始吧' , requiresUserAcceptance: false },
    { op: 'focus', ids: ['t2'] },
  ]).envelope;
  assert.equal(resumed.tasks[1].status, 'in_progress');
}

// ---------------------------------------------------------------------------
// snapshots expose approval to the agent and the panel
// ---------------------------------------------------------------------------

{
  const envelope = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '想法', summary: '待讨论' },
    { op: 'create', title: '已批', executionApproval: 'approved', approvalBasis: '开始吧' },
  ]).envelope;
  const read = readSnapshot(envelope, CTX.worklineId, true);
  assert.deepEqual(read.tasks.map((task) => task.approval), ['pending', 'approved']);
  assert.equal(read.tasks[1].approvalBasis, '开始吧');
  const http = httpSnapshot(envelope, CTX.worklineId, { isLive: () => false });
  assert.deepEqual(http.tasks.map((task) => task.executionApproval), ['pending', 'approved']);
  assert.equal(http.tasks[1].approvalBasis, '开始吧');
  assert.equal(http.tasks[0].approvalAt, null);
}

// ---------------------------------------------------------------------------
// user evidence: only messages a person submitted can justify a quote
// ---------------------------------------------------------------------------

{
  const events = [
    { type: 'user/message', seq: 1, time: 1000, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context. cwd is /tmp' }] } },
    { type: 'user/message', seq: 2, time: 2000, data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '帮我实现一个 Go 短链接服务，\n包括创建、跳转、查询和测试。' }] } },
    { type: 'user/message', seq: 3, time: 2500, data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }] } },
    { type: 'user/message', seq: 4, time: 5000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '好的，验收通过' }] } },
  ];
  const session = { id: 'session-root', header: { id: 'session-root' }, seq: 10, snapshotEvents: (from = 0) => events.filter((event) => event.seq >= from) };

  assert.deepEqual(verifyUserQuote(session, '短链接服务'), { ok: true, seq: 2, time: 2000 });
  assert.deepEqual(verifyUserQuote(session, '包括创建、 跳转、查询和测试。'), { ok: true, seq: 2, time: 2000 }, 'whitespace is ignored');
  assert.deepEqual(verifyUserQuote(session, '验收通过'), { ok: true, seq: 4, time: 5000 });
  assert.equal(verifyUserQuote(session, 'cwd is /tmp').ok, false, 'injected context is not user evidence');
  assert.equal(verifyUserQuote(session, '<system-reminder>').ok, false);
  assert.equal(verifyUserQuote(session, '').ok, false);
  // The floor rejects single-character noise, not short but real answers: "ok",
  // "同意" and two-character phrases are how people actually accept work.
  assert.equal(verifyUserQuote(session, '的').ok, false, 'a single character is not a quote');
  assert.deepEqual(verifyUserQuote(session, '服务'), { ok: true, seq: 2, time: 2000 }, 'two characters are a real quote');
  assert.equal(verifyUserQuote(session, 'x'.repeat(201)).ok, false);
  assert.equal(verifyUserQuote({}, '短链接服务').ok, false, 'a session without a log proves nothing');
}

{
  // The mounted write tool wires the verifier, so an invented quote is refused
  // even when the model asks for it directly.
  const root = tempRoot();
  const registeredTools = new Map();
  const events = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '帮我实现一个 Go 短链接服务' }] } },
  ];
  const ctx = {
    effect: (factory) => factory(),
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'tools') return { register: (definition) => { registeredTools.set(definition.name, definition); return () => {}; } };
      return undefined;
    },
  };
  mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  const session = { header: { id: 'session-live' }, seq: 5, snapshotEvents: (from = 0) => events.filter((event) => event.seq >= from) };
  const exec = { agent: { id: 'session-live', session } };
  const write = registeredTools.get('task_tree_write');

  await assert.rejects(
    () => write.execute({ ops: [{ op: 'init', originalGoal: '短链接' }, { op: 'create', title: '管理后台', executionApproval: 'approved', approvalBasis: '你说要做管理后台' }] }, exec),
    /does not appear in a user message/,
  );
  const ok = await write.execute({
    ops: [
      { op: 'init', originalGoal: '短链接' },
      { op: 'create', title: '短链接服务', executionApproval: 'approved', approvalBasis: '帮我实现一个 Go 短链接服务' },
    ],
  }, exec);
  assert.equal(ok.ok, true);
  const read = await registeredTools.get('task_tree_read').execute({ details: true }, exec);
  assert.equal(read.tasks[0].approval, 'approved');
  assert.equal(read.tasks[0].approvalBasis, '帮我实现一个 Go 短链接服务');
}

// ---------------------------------------------------------------------------
// the prompt teaches the lifecycle, not just the coding moments
// ---------------------------------------------------------------------------

{
  for (const needle of ['executionApproval', 'approvalBasis', 'confirmationBasis', 'confirmedByUser', 'reviseGoal', 'pending']) {
    assert.equal(TASK_TREE_PROMPT.includes(needle), true, `prompt should mention ${needle}`);
  }
  assert.equal(TASK_TREE_PROMPT.includes('Record work that is worth tracking as soon as it appears'), true);
  // Team mode is model-facing too: the prompt says the Lead only coordinates.
  assert.equal(TASK_TREE_PROMPT.includes('the lead only coordinates'), true);
  assert.notEqual(TASK_TREE_REMINDER, TASK_TREE_START_REMINDER);
  assert.equal(TASK_TREE_START_REMINDER.includes('no task tree yet'), true);
  assert.equal(TASK_TREE_REMINDER.includes('task_tree_write'), true);
  // "不需要任务" may cover read-only work only: a command still needs an
  // execution (ADR-0001), so no prompt sentence may exempt one-off commands.
  assert.equal(TASK_TREE_PROMPT.includes('one-off commands'), false);
  assert.equal(TASK_TREE_REMINDER.includes('trivial single-step work'), false);
  assert.equal(TASK_TREE_PROMPT.includes('read-only inspection'), true);
}

// ---------------------------------------------------------------------------
// final acceptance: a delivered requirement cannot be closed by the agent
// ---------------------------------------------------------------------------

{
  // A user request authorises the work but does not waive the final acceptance.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '用 Go 实现一个 Todo REST API' },
    { op: 'create', title: 'Go Todo REST API', executionApproval: 'approved', approvalBasis: '帮我实现一个 Go 短链接服务' },
    { op: 'create', title: '存储层', parentId: 't1' },
    { op: 'create', title: 'HTTP 层', parentId: 't1' },
  ]).envelope;
  assert.equal(base.tasks[0].requiresUserAcceptance, true, 'a top-level request needs acceptance');
  assert.equal(base.tasks[1].requiresUserAcceptance, false, 'implementation steps do not');
  assert.equal(base.tasks[2].requiresUserAcceptance, false);

  // 2. Implementation steps still self-complete, without asking the user.
  const steps = envelopeAfter(base, [
    { op: 'focus', ids: ['t2'] },
    { op: 'complete', id: 't2', result: '内存 Store 完成，go test 通过' },
    { op: 'focus', ids: ['t3'] },
    { op: 'complete', id: 't3', result: 'CRUD 路由完成，go test -race 通过' },
  ]).envelope;
  assert.deepEqual(steps.tasks.slice(1).map((task) => task.completion), ['self', 'self']);

  // 3. The delivered requirement cannot be closed by the agent.
  assert.throws(
    () => envelopeAfter(steps, [{ op: 'complete', id: 't1', result: '全部完成' }]),
    /needs the user's acceptance before it can be completed/,
  );
  assert.throws(
    () => envelopeAfter(steps, [{ op: 'update', id: 't1', status: 'done' }]),
    /needs the user's acceptance before it can be completed/,
  );

  // 4. Delivery without acceptance keeps the task open and keeps the result.
  const delivered = envelopeAfter(steps, [
    { op: 'update', id: 't1', status: 'in_progress', progress: '开发与测试已完成，等待用户验收。', result: 'CRUD + 单测，94% 覆盖率' },
  ]).envelope;
  const waiting = delivered.tasks[0];
  assert.equal(waiting.status, 'in_progress');
  assert.equal(waiting.completion, null);
  assert.equal(waiting.progress, '开发与测试已完成，等待用户验收。');
  assert.equal(waiting.result, 'CRUD + 单测，94% 覆盖率');

  // 5. The user's acceptance closes it, as user-confirmed.
  const accepted = envelopeAfter(delivered, [
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '验收通过' },
  ]).envelope;
  assert.equal(accepted.tasks[0].status, 'done');
  assert.equal(accepted.tasks[0].completion, 'user-confirmed');
  assert.equal(accepted.tasks[0].completionBasis, '验收通过');

  // 6. The instruction that started the work is not the user's acceptance.
  assert.throws(
    () => envelopeAfter(steps, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '开始吧' }]),
    /predates this task's authorisation/,
  );
  assert.throws(
    () => envelopeAfter(steps, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '帮我实现一个 Go 短链接服务' }]),
    /predates this task's authorisation/,
  );

  // 7. The agent cannot waive the requirement to get around it.
  assert.throws(
    () => envelopeAfter(steps, [{ op: 'update', id: 't1', requiresUserAcceptance: false }]),
    /dropping the user-acceptance requirement needs acceptanceBasis/,
  );
  assert.throws(
    () => envelopeAfter(steps, [{ op: 'update', id: 't1', requiresUserAcceptance: false, acceptanceBasis: '不再验收' }]),
    /does not appear in a user message/,
  );
  assert.throws(
    () => envelopeAfter(steps, [{ op: 'update', id: 't1', acceptanceBasis: '开始吧' }]),
    /only applies together with requiresUserAcceptance/,
  );
  // Only a real user instruction waives it, and then the task may self-complete.
  const waived = envelopeAfter(steps, [
    { op: 'update', id: 't1', requiresUserAcceptance: false, acceptanceBasis: '开始吧' },
    { op: 'complete', id: 't1', result: '用户同意不单独验收' },
  ]).envelope;
  assert.equal(waived.tasks[0].requiresUserAcceptance, false);
  assert.equal(waived.tasks[0].acceptanceBasis, '开始吧');
  assert.equal(waived.tasks[0].completion, 'self');
  // Tightening again is always allowed.
  const tightened = envelopeAfter(waived, [{ op: 'update', id: 't1', requiresUserAcceptance: true }]).envelope;
  assert.equal(tightened.tasks[0].requiresUserAcceptance, true);
  assert.equal(tightened.tasks[0].acceptanceBasis, null);
}

{
  // A child that is itself a user-visible deliverable can require acceptance.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '登录' },
    { op: 'create', title: '登录功能', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', title: '登录页面', parentId: 't1', requiresUserAcceptance: true },
  ]).envelope;
  assert.equal(base.tasks[1].requiresUserAcceptance, true);
  assert.throws(
    () => envelopeAfter(base, [{ op: 'complete', id: 't2' }]),
    /needs the user's acceptance/,
  );
  const accepted = envelopeAfter(base, [
    { op: 'complete', id: 't2', confirmedByUser: true, confirmationBasis: '验收通过' },
  ]).envelope;
  assert.equal(accepted.tasks[1].completion, 'user-confirmed');
}

{
  // Legacy worklines keep loading: no field means "top level needs it, a child
  // does not", and history is never rewritten.
  const legacy = {
    version: 1,
    workline: { id: 'session-root', createdAt: 1, updatedAt: 2, goal: { original: 'g', current: 'g', changes: [] }, outline: '', focus: [], nextSeq: 4 },
    tasks: [
      { id: 't1', worklineId: 'session-root', parentId: null, order: 0, title: '旧交付', status: 'done', completion: 'self', completedAt: 5, createdAt: 1, updatedAt: 5 },
      { id: 't2', worklineId: 'session-root', parentId: 't1', order: 0, title: '旧子任务', status: 'pending', createdAt: 1, updatedAt: 2 },
      { id: 't3', worklineId: 'session-root', parentId: null, order: 1, title: '旧待办', status: 'pending', createdAt: 1, updatedAt: 2 },
    ],
  };
  const http = httpSnapshot(legacy, 'session-root', { isLive: () => false });
  assert.equal(http.tasks[0].requiresUserAcceptance, true);
  assert.equal(http.tasks[1].requiresUserAcceptance, false);
  assert.equal(http.tasks[2].requiresUserAcceptance, true);
  assert.equal(http.tasks[0].status, 'done', 'a historic completion is not rewritten');
  assert.equal(http.tasks[0].completion, 'self');

  // The old pending top-level task now waits for acceptance, and the old
  // pending child may still self-complete.
  assert.throws(
    () => envelopeAfter(legacy, [{ op: 'complete', id: 't3' }]),
    /needs the user's acceptance/,
  );
  const child = envelopeAfter(legacy, [{ op: 'complete', id: 't2' }]).envelope;
  assert.equal(child.tasks[1].completion, 'self');

  // Archive and restore keep working on legacy rows.
  const archived = envelopeAfter(legacy, [{ op: 'archive', id: 't3', reason: '不做了' }]).envelope;
  assert.equal(readSnapshot(archived, 'session-root').tasks.length, 2);
  const restored = envelopeAfter(archived, [{ op: 'restore', id: 't3' }]).envelope;
  assert.equal(readSnapshot(restored, 'session-root').tasks.length, 3);
  assert.equal(restored.tasks[2].requiresUserAcceptance, true);
}

{
  // The read snapshot exposes the requirement so the agent can plan around it.
  const envelope = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '交付', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', title: '步骤', parentId: 't1' },
  ]).envelope;
  const read = readSnapshot(envelope, CTX.worklineId, true);
  assert.deepEqual(read.tasks.map((task) => task.requiresUserAcceptance), [true, false]);
  const http = httpSnapshot(envelope, CTX.worklineId, { isLive: () => false });
  assert.deepEqual(http.tasks.map((task) => task.requiresUserAcceptance), [true, false]);
}

// ---------------------------------------------------------------------------
// focus: the prompt and the tool description teach the actual sequence
// ---------------------------------------------------------------------------

{
  // Order: take the real id, set in_progress, then focus before the first edit.
  for (const needle of [
    'take its real id from the tree',
    'before the first file edit or command',
    '**Focus, status, and claim are three different writes.**',
    'replaces the whole focus set rather than adding to it',
    'still needs the `focus` call',
    'attention, not permission',
    'not every `in_progress` task',
    'Completing a task removes it from the focus',
  ]) {
    assert.equal(TASK_TREE_PROMPT.includes(needle), true, `prompt should mention: ${needle}`);
  }
  // The example shows the operation shape without hard-coding the id.
  assert.equal(TASK_TREE_PROMPT.includes('{"op":"focus","ids":["<id>"]}'), true);
  assert.equal(TASK_TREE_PROMPT.includes('always use the id `create` or `task_tree_read` returned'), true);
}

{
  // The tool description carries the same instruction, with the example.
  const root = tempRoot();
  const registeredTools = new Map();
  const ctx = {
    effect: (factory) => factory(),
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'tools') return { register: (definition) => { registeredTools.set(definition.name, definition); return () => {}; } };
      return undefined;
    },
  };
  mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  const write = registeredTools.get('task_tree_write');
  for (const needle of [
    'Starting to execute is its own sequence',
    'before the first file edit or command',
    '{"op":"focus","ids":["<id>"]}',
    'COMPLETE focus set',
    'does not set the focus',
    'not permission',
    'clears it from the focus',
  ]) {
    assert.equal(write.description.includes(needle), true, `tool description should mention: ${needle}`);
  }
  const idsDescription = write.parameters.properties.ops.items.properties.ids.description;
  assert.equal(idsDescription.includes('replaces the whole set'), true);
  assert.equal(idsDescription.includes('[] to clear it'), true);
}

{
  // Behaviour the instructions rely on: focus is a complete set, it grants no
  // approval, and it does not claim the task.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '已批任务', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', title: '讨论中的任务' },
  ]).envelope;
  const focused = envelopeAfter(base, [
    { op: 'focus', ids: ['t1'] },
    { op: 'focus', ids: ['t2'] },
  ]).envelope;
  assert.deepEqual(focused.workline.focus, ['t2'], 'focus replaces the set instead of adding to it');
  assert.equal(focused.tasks[1].executionApproval, 'pending', 'focus does not approve a task');
  assert.equal(focused.tasks[1].status, 'pending', 'focus does not start an unapproved task');
  assert.equal(focused.tasks[1].owner, null, 'focus does not claim the task');
  const cleared = envelopeAfter(focused, [{ op: 'focus', ids: [] }]).envelope;
  assert.deepEqual(cleared.workline.focus, []);
}

// ---------------------------------------------------------------------------
// placement: new work goes under the task that owns it
// ---------------------------------------------------------------------------

{
  // The prompt asks for a placement decision before creating, and keeps that
  // decision independent from permission and acceptance.
  for (const needle of [
    '**Before you create a task, decide what it belongs to.**',
    'is it the next step of an existing feature, a bug in an existing task',
    'pass its real `parentId` to `create`',
    'leave `parentId` out',
    'Never invent a parent',
    'never create an empty theme task',
    'never nest unrelated work only to keep the tree short',
    '`task_tree_read` first. Prefer extending an existing task over creating a near-duplicate',
    '**Placement never changes permission or acceptance.**',
    'must be created with `executionApproval: "pending"` even when it sits under an approved parent',
    'A child that the user will judge on its own needs an explicit `requiresUserAcceptance: true`',
    'Never hoist work to the top level to keep its acceptance',
    'Do not reorganize existing tasks',
    '"Accept it separately" is not a reason to lift the work out of the feature it belongs to',
    'A top-level task is for work with no owner, not for work with its own acceptance',
    'Never move, archive or defer a task only to unblock a completion',
    'restructuring the tree to close a task is not maintenance',
  ]) {
    assert.equal(TASK_TREE_PROMPT.includes(needle), true, `prompt should mention: ${needle}`);
  }
  // A top-level task is still allowed when nothing owns the work.
  assert.equal(TASK_TREE_PROMPT.includes('a new direction, a separate deliverable — leave `parentId` out'), true);
}

{
  // The tool description and the parentId parameter carry the same rule.
  const root = tempRoot();
  const registeredTools = new Map();
  const ctx = {
    effect: (factory) => factory(),
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'tools') return { register: (definition) => { registeredTools.set(definition.name, definition); return () => {}; } };
      return undefined;
    },
  };
  mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  const write = registeredTools.get('task_tree_write');
  for (const needle of [
    'Before creating a task, decide what it belongs to',
    'pass the owning task as parentId',
    'Leave parentId out only when nothing owns the work',
    'never invent a parent, an empty theme task',
    'task_tree_read first instead of guessing',
    'Placement changes neither permission nor acceptance',
    'new scope under an approved parent must be created pending',
    'requiresUserAcceptance: true just like a top-level task',
    'move is not part of normal maintenance',
    '"Accept it separately" is not a reason to lift work out of the feature it belongs to',
    'never move, archive or defer a task only to unblock a completion',
  ]) {
    assert.equal(write.description.includes(needle), true, `tool description should mention: ${needle}`);
  }
  const parentDescription = write.parameters.properties.ops.items.properties.parentId.description;
  for (const needle of ['Prefer the task that actually owns this work', 'Leave it out only when no existing task owns the work', 'Placement does not grant execution approval', 'does not decide who accepts the result']) {
    assert.equal(parentDescription.includes(needle), true, `parentId description should mention: ${needle}`);
  }
}

{
  // Behaviour the rule relies on: placement is only placement. A child of an
  // approved parent still needs an explicit approval for new scope, a child can
  // carry its own acceptance obligation, and a completed parent keeps its record.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '登录功能' },
    { op: 'create', title: '登录功能', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', title: '登录接口', parentId: 't1' },
  ]).envelope;
  // Inherited approval only covers the step created inside the scope…
  assert.equal(base.tasks[1].executionApproval, 'approved');
  // …new scope under the same parent must be created pending.
  const bug = envelopeAfter(base, [
    { op: 'create', title: '修复 Token 过期', parentId: 't1', executionApproval: 'pending' },
  ]).envelope;
  assert.equal(bug.tasks[2].executionApproval, 'pending');
  assert.equal(bug.tasks[2].requiresUserAcceptance, false, 'a step defaults to no separate acceptance');
  // A nested deliverable keeps its own acceptance obligation.
  const nestedDelivery = envelopeAfter(bug, [
    { op: 'create', title: '登录审计日志', parentId: 't1', requiresUserAcceptance: true },
  ]).envelope;
  assert.equal(nestedDelivery.tasks[3].requiresUserAcceptance, true);
  assert.throws(
    () => envelopeAfter(nestedDelivery, [{ op: 'complete', id: 't4' }]),
    /needs the user's acceptance/,
  );
  // A completed parent keeps its record when follow-up work is attached.
  const done = envelopeAfter(nestedDelivery, [
    { op: 'complete', id: 't2' },
    { op: 'complete', id: 't3' },
    { op: 'complete', id: 't4', confirmedByUser: true, confirmationBasis: '审计日志也验收通过了' },
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
    { op: 'create', title: '登录页样式错位', parentId: 't1' },
  ]).envelope;
  const parent = done.tasks[0];
  assert.equal(parent.status, 'done');
  assert.equal(parent.completion, 'user-confirmed');
  assert.equal(parent.completionBasis, '登录功能我验收通过了');
  assert.equal(parent.completedAt, NOW);
  const followUp = done.tasks[4];
  assert.equal(followUp.parentId, 't1');
  assert.equal(followUp.status, 'pending');
  assert.equal(followUp.requiresUserAcceptance, false);
}

// ---------------------------------------------------------------------------
// subtree completion: only finished or archived work stops blocking
// ---------------------------------------------------------------------------

{
  // Login feature with finished steps and an idea nobody approved yet.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '登录功能' },
    { op: 'create', title: '实现登录功能', executionApproval: 'approved', approvalBasis: '登录功能可以做，开始吧。' },
    { op: 'create', parentId: 't1', title: '实现登录 API' },
    { op: 'create', parentId: 't1', title: '编写单元测试' },
    { op: 'create', parentId: 't1', title: '登录审计日志', executionApproval: 'pending' },
  ]).envelope;
  const stepsDone = envelopeAfter(base, [
    { op: 'complete', id: 't2' },
    { op: 'complete', id: 't3' },
  ]).envelope;
  assert.equal(stepsDone.tasks[3].status, 'pending');
  // An unfinished idea still blocks: the tree records every unfinished thing.
  assert.throws(
    () => envelopeAfter(stepsDone, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' }]),
    /any work below it is unfinished: t4 "登录审计日志" is pending/,
  );
  // The idea keeps its parent, its status and its pending approval.
  assert.equal(stepsDone.tasks[3].parentId, 't1');
  assert.equal(stepsDone.tasks[3].status, 'pending');
  assert.equal(stepsDone.tasks[3].executionApproval, 'pending');
  // Archiving it (the user's decision to drop it) unblocks the parent, and the
  // archived record stays in the tree's history.
  const archived = envelopeAfter(stepsDone, [
    { op: 'archive', id: 't4', reason: '用户决定不做', userBasis: '这个先不做' },
  ]).envelope;
  const accepted = envelopeAfter(archived, [
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
  ]).envelope;
  assert.equal(accepted.tasks[0].status, 'done');
  assert.equal(accepted.tasks[0].completion, 'user-confirmed');
  assert.equal(accepted.tasks[0].completionBasis, '登录功能我验收通过了');
  assert.equal(accepted.tasks[3].archived, true);
  assert.equal(accepted.tasks[3].parentId, 't1');
}

{
  // Authorised work still blocks, through both completion paths.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '交付', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '实施步骤', executionApproval: 'approved', approvalBasis: '开始吧' },
  ]).envelope;
  const running = envelopeAfter(base, [{ op: 'update', id: 't2', status: 'in_progress' }]).envelope;
  assert.throws(
    () => envelopeAfter(running, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '验收通过' }]),
    /any work below it is unfinished/,
  );
  assert.throws(
    () => envelopeAfter(running, [{ op: 'update', id: 't1', status: 'done', confirmedByUser: true, confirmationBasis: '验收通过' }]),
    /any work below it is unfinished/,
  );
}

{
  // A nested deliverable that is finished but not accepted still blocks.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '父交付', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '子交付', requiresUserAcceptance: true },
  ]).envelope;
  const delivered = envelopeAfter(base, [
    { op: 'update', id: 't2', executionApproval: 'approved', approvalBasis: '开始吧', requiresUserAcceptance: true },
    { op: 'update', id: 't2', status: 'in_progress' },
    { op: 'update', id: 't2', progress: '开发与测试已完成，等待用户验收。' },
  ]).envelope;
  assert.throws(
    () => envelopeAfter(delivered, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '验收通过' }]),
    /any work below it is unfinished: t2 .* is in_progress/,
  );
  // A sub-delivery that is finished but not accepted (legacy records can carry
  // this shape) still holds the parent open.
  const legacyDone = {
    version: 1,
    workline: { id: 'session-root', createdAt: 1, updatedAt: 2, goal: { original: 'g', current: 'g', changes: [] }, outline: '', focus: [], nextSeq: 3 },
    tasks: [
      { id: 't1', worklineId: 'session-root', parentId: null, order: 0, title: '父交付', status: 'in_progress', executionApproval: 'approved', createdAt: 1, updatedAt: 2 },
      { id: 't2', worklineId: 'session-root', parentId: 't1', order: 0, title: '子交付', status: 'done', completion: 'self', completedAt: 2, requiresUserAcceptance: true, createdAt: 1, updatedAt: 2 },
    ],
  };
  // Only the status matters now: a legacy child that is already done no longer
  // blocks, even though its completion is not a user acceptance.
  const legacyClosed = envelopeAfter(legacyDone, [
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
  ]).envelope;
  assert.equal(legacyClosed.tasks[0].status, 'done');
  assert.equal(legacyClosed.tasks[1].completion, 'self');
  // Once the sub-delivery is accepted the parent may close.
  const subAccepted = envelopeAfter(delivered, [
    { op: 'complete', id: 't2', confirmedByUser: true, confirmationBasis: '审计日志也验收通过了' },
  ]).envelope;
  const closed = envelopeAfter(subAccepted, [
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
  ]).envelope;
  assert.equal(closed.tasks[0].status, 'done');
  assert.equal(closed.tasks[1].completion, 'user-confirmed');
}

{
  // Deferring is a pause, not a cancellation: the task keeps blocking its parent.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '登录功能', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '记住我', executionApproval: 'approved', approvalBasis: '开始吧' },
  ]).envelope;
  const deferred = envelopeAfter(base, [
    { op: 'defer', id: 't2', deferredReason: '这轮先不做', resumeCondition: '下轮再做', userBasis: '开始吧' },
  ]).envelope;
  assert.equal(deferred.tasks[1].deferred, true);
  assert.throws(
    () => envelopeAfter(deferred, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' }]),
    /any work below it is unfinished: t2 "记住我" is pending/,
  );
}

{
  // Legacy records: a started child without the approval field still blocks.
  const legacy = {
    version: 1,
    workline: { id: 'session-root', createdAt: 1, updatedAt: 2, goal: { original: 'g', current: 'g', changes: [] }, outline: '', focus: [], nextSeq: 4 },
    tasks: [
      { id: 't1', worklineId: 'session-root', parentId: null, order: 0, title: '老交付', status: 'in_progress', createdAt: 1, updatedAt: 2 },
      { id: 't2', worklineId: 'session-root', parentId: 't1', order: 0, title: '老步骤', status: 'in_progress', progress: '做了一半', createdAt: 1, updatedAt: 2 },
    ],
  };
  assert.throws(
    () => envelopeAfter(legacy, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '验收通过' }]),
    /any work below it is unfinished/,
  );
  // The acceptance obligation of the legacy records is unchanged by the read.
  const http = httpSnapshot(legacy, 'session-root', { isLive: () => false });
  assert.equal(http.tasks[0].requiresUserAcceptance, true);
  assert.equal(http.tasks[1].requiresUserAcceptance, false);
}

{
  // Deeper nesting: an authorised grandchild still holds the delivery open.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '交付', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '模块' },
    { op: 'create', parentId: 't2', title: '模块内的实施', executionApproval: 'approved', approvalBasis: '开始吧' },
  ]).envelope;
  const running = envelopeAfter(base, [{ op: 'update', id: 't3', status: 'in_progress' }]).envelope;
  assert.throws(
    () => envelopeAfter(running, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '验收通过' }]),
    /any work below it is unfinished/,
  );
}

{
  // Bypass paths: an in-flight task cannot leave the delivery by withdrawing
  // approval or by moving, while a pending idea may still be moved.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '交付', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '进行中步骤', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '未来想法', executionApproval: 'pending' },
  ]).envelope;
  const running = envelopeAfter(base, [{ op: 'update', id: 't2', status: 'in_progress' }]).envelope;
  assert.throws(
    () => envelopeAfter(running, [{ op: 'update', id: 't2', executionApproval: 'pending' }]),
    /withdrawing its approval would hide unfinished work/,
  );
  assert.throws(
    () => envelopeAfter(running, [{ op: 'move', id: 't2', parentId: null }]),
    /part of the current delivery and cannot be moved/,
  );
  // A never-started idea is not delivery work: it may be moved or approved.
  const moved = envelopeAfter(running, [{ op: 'move', id: 't3', parentId: null }]).envelope;
  assert.equal(moved.tasks[2].parentId, null);
  // Archiving is the documented cancellation path, and it takes the idea with it.
  const archived = envelopeAfter(running, [
    { op: 'archive', id: 't2', reason: '这轮不做了', userBasis: '开始吧' },
    { op: 'archive', id: 't3', reason: '想法一起归档' },
  ]).envelope;
  const closed = envelopeAfter(archived, [
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
  ]).envelope;
  assert.equal(closed.tasks[0].status, 'done');
  assert.equal(closed.tasks[1].archived, true);
  assert.equal(closed.tasks[1].archiveReason, '这轮不做了');
}

// ---------------------------------------------------------------------------
// delivery scope: the prompt and the tool description teach the same rule
// ---------------------------------------------------------------------------

{
  for (const needle of [
    '**A parent is complete only when nothing unfinished remains below it.**',
    '`pending`, `in_progress`, `blocked` and deferred children all block the parent, whether or not they were approved',
    'A completed parent that later gains an unfinished child is no longer complete',
    'the parent becomes complete again without a second acceptance',
    'A new deliverable under it still needs its own acceptance',
    '**One confirmation closes one task.**',
  ]) {
    assert.equal(TASK_TREE_PROMPT.includes(needle), true, `prompt should mention: ${needle}`);
  }
}

{
  const root = tempRoot();
  const registeredTools = new Map();
  const ctx = {
    effect: (factory) => factory(),
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'tools') return { register: (definition) => { registeredTools.set(definition.name, definition); return () => {}; } };
      return undefined;
    },
  };
  mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  const write = registeredTools.get('task_tree_write');
  for (const needle of [
    'A parent is complete only when nothing unfinished remains below it',
    'pending, in_progress, blocked and deferred children all block it',
    'one acceptance quote closes one task',
    'never replay the same quote for another task',
  ]) {
    assert.equal(write.description.includes(needle), true, `tool description should mention: ${needle}`);
  }
  const deferDescription = write.parameters.properties.ops.items.properties.deferredReason.description;
  assert.equal(deferDescription.includes('still blocks the parent task from being completed'), true);
}

// ---------------------------------------------------------------------------
// lifecycle boundaries
// ---------------------------------------------------------------------------

{
  // (1) Notes are not execution evidence — but an unfinished task blocks anyway.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '登录功能' },
    { op: 'create', title: '登录功能', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '登录审计日志', executionApproval: 'pending' },
    { op: 'update', id: 't2', progress: '讨论中：倾向结构化事件 + 可替换 sink，待用户决定' },
  ]).envelope;
  assert.throws(
    () => envelopeAfter(base, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' }]),
    /any work below it is unfinished: t2 .* is pending/,
  );
  // Notes do not turn the idea into authorised work: it can still be tidied and
  // moved without asking the user for a basis.
  const archived = envelopeAfter(base, [{ op: 'archive', id: 't2', reason: '不做了' }]).envelope;
  assert.equal(archived.tasks[1].archived, true);
  assert.equal(archived.tasks[1].archiveBasis, null);
  const moved = envelopeAfter(base, [{ op: 'move', id: 't2', parentId: null }]).envelope;
  assert.equal(moved.tasks[1].parentId, null);
}

{
  // (2) Approving a recorded idea is also a decision about acceptance.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '登录功能' },
    { op: 'create', title: '登录功能', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '登录审计日志', executionApproval: 'pending' },
  ]).envelope;
  assert.throws(
    () => envelopeAfter(base, [{ op: 'update', id: 't2', executionApproval: 'approved', approvalBasis: '开始吧' }]),
    /also decides who accepts it/,
  );
  const asDelivery = envelopeAfter(base, [
    { op: 'update', id: 't2', executionApproval: 'approved', approvalBasis: '开始吧', requiresUserAcceptance: true },
  ]).envelope;
  assert.equal(asDelivery.tasks[1].requiresUserAcceptance, true);
  assert.equal(asDelivery.tasks[1].id, 't2', 'the original task keeps its id and its history');
  assert.equal(asDelivery.tasks[1].progress, '', 'the discussion record is untouched');
  // A delivery cannot close itself once the user must accept it.
  const started = envelopeAfter(asDelivery, [{ op: 'update', id: 't2', status: 'in_progress' }]).envelope;
  assert.throws(
    () => envelopeAfter(started, [{ op: 'complete', id: 't2' }]),
    /needs the user's acceptance/,
  );
  // An ordinary implementation step may be approved as one.
  const asStep = envelopeAfter(base, [
    { op: 'update', id: 't2', executionApproval: 'approved', approvalBasis: '开始吧', requiresUserAcceptance: false },
  ]).envelope;
  assert.equal(asStep.tasks[1].requiresUserAcceptance, false);
}

{
  // (3) In-flight delivery work cannot leave the delivery without the user.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '登录功能' },
    { op: 'create', title: '登录功能', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '记住我', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'update', id: 't2', status: 'in_progress' },
  ]).envelope;
  assert.throws(
    () => envelopeAfter(base, [{ op: 'defer', id: 't2', deferredReason: '先放放' }]),
    /quoting the user's decision/,
  );
  assert.throws(
    () => envelopeAfter(base, [{ op: 'archive', id: 't2', reason: '不做了' }]),
    /quoting the user's decision/,
  );
  // The user's own words make both paths work and are recorded.
  const deferred = envelopeAfter(base, [
    { op: 'defer', id: 't2', deferredReason: '这轮先不做', userBasis: '这个先不做' },
  ]).envelope;
  assert.equal(deferred.tasks[1].deferred, true);
  assert.equal(deferred.tasks[1].deferredBasis, '这个先不做');
  const archived = envelopeAfter(base, [
    { op: 'archive', id: 't2', reason: '用户取消', userBasis: '不做了' },
  ]).envelope;
  assert.equal(archived.tasks[1].archived, true);
  assert.equal(archived.tasks[1].archiveBasis, '不做了');
  assert.equal(archived.tasks[1].archiveHistory[0].basis, '不做了');
  // Ideas that never started and finished work are ordinary tidying.
  const ideaDeferred = envelopeAfter(base, [
    { op: 'create', parentId: 't1', title: '未来想法', executionApproval: 'pending' },
    { op: 'defer', id: 't3', deferredReason: '先讨论' },
  ]).envelope;
  assert.equal(ideaDeferred.tasks[2].deferred, true, 'an unapproved idea is tidied without a basis');
  const doneArchived = envelopeAfter(base, [
    { op: 'complete', id: 't2' },
    { op: 'archive', id: 't2', reason: '交付后归档' },
  ]).envelope;
  assert.equal(doneArchived.tasks[1].archived, true, 'finished work is archived without a basis');

  // Archiving a container must not launder an in-flight child out of the
  // delivery: the whole subtree leaves, so the decision covers all of it.
  const container = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '登录功能' },
    { op: 'create', title: '这轮整理' },
    { op: 'create', parentId: 't1', title: '记住我', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'update', id: 't2', status: 'in_progress' },
  ]).envelope;
  assert.throws(
    () => envelopeAfter(container, [{ op: 'archive', id: 't1', reason: '不做了' }]),
    /quoting the user's decision/,
    'an in-flight descendant makes the whole archive a delivery change',
  );
  const containerArchived = envelopeAfter(container, [
    { op: 'archive', id: 't1', reason: '用户取消', userBasis: '不做了' },
  ]).envelope;
  assert.equal(containerArchived.tasks[1].archived, true);
  assert.equal(containerArchived.tasks[1].archiveBasis, '不做了', 'the decision reaches the descendants it archived');
}

// ---------------------------------------------------------------------------
// lifecycle boundaries: the prompt and the tool description say the same thing
// ---------------------------------------------------------------------------

{
  for (const needle of [
    '**Notes are not execution.**',
    'Writing a discussion record or a progress note does not start a task',
    '**Starting work on a recorded idea** is not a new task: approve the existing one and keep its id',
    'Approving it also settles who accepts the result',
    '**Taking authorised work out of the delivery needs the user.**',
    'needs `userBasis` quoting the user',
    'An idea that never started, and work that is already finished, are ordinary tidying and need no quote',
  ]) {
    assert.equal(TASK_TREE_PROMPT.includes(needle), true, `prompt should mention: ${needle}`);
  }
}

{
  const root = tempRoot();
  const registeredTools = new Map();
  const ctx = {
    effect: (factory) => factory(),
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'tools') return { register: (definition) => { registeredTools.set(definition.name, definition); return () => {}; } };
      return undefined;
    },
  };
  mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  const write = registeredTools.get('task_tree_write');
  for (const needle of [
    'Notes are not execution',
    'starting work on a recorded idea reuses that task',
    'approving it also decides requiresUserAcceptance',
    'needs userBasis quoting',
  ]) {
    assert.equal(write.description.includes(needle), true, `tool description should mention: ${needle}`);
  }
  const userBasis = write.parameters.properties.ops.items.properties.userBasis;
  assert.equal(typeof userBasis === 'object', true, 'userBasis must be a documented parameter');
  assert.equal(userBasis.description.includes("the user's own words deciding it"), true);

  // The four quote parameters must render their range from the evidence.js
  // constants, so a boundary change cannot leave a stale hardcoded number in
  // the model-facing schema.
  const quoteParameters = {
    approvalBasis: write.parameters.properties.ops.items.properties.approvalBasis,
    userBasis,
    acceptanceBasis: write.parameters.properties.ops.items.properties.acceptanceBasis,
    confirmationBasis: write.parameters.properties.ops.items.properties.confirmationBasis,
  };
  const quoteRange = `${MIN_QUOTE} to ${MAX_BASIS}`;
  for (const [name, parameter] of Object.entries(quoteParameters)) {
    assert.equal(typeof parameter === 'object' && parameter !== null, true, `${name} must be a documented parameter`);
    assert.equal(
      typeof parameter.description === 'string' && parameter.description.includes(quoteRange),
      true,
      `${name} description must include the "${quoteRange}" range rendered from evidence.js constants`,
    );
  }
  // Guard the exact value this repo migrated away from. A literal that happens
  // to equal the current constants renders identically, so only a known-stale
  // value can be told apart from the interpolated one.
  if (MIN_QUOTE !== 3) {
    const staleParameterNames = Object.entries(quoteParameters)
      .filter(([, parameter]) => typeof parameter?.description === 'string' && parameter.description.includes('3 to'))
      .map(([name]) => name);
    assert.deepEqual(
      staleParameterNames,
      [],
      `quote parameter descriptions must not repeat the legacy hardcoded "3 to" range; found in: ${staleParameterNames.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// subtree completion and task-scoped acceptance
// ---------------------------------------------------------------------------

{
  // A completed parent that gains unfinished children shows as unfinished again,
  // keeps its acceptance record, and recovers without a second acceptance.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '登录功能' },
    { op: 'create', title: '登录功能', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '登录接口' },
    { op: 'complete', id: 't2' },
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
  ]).envelope;
  const accepted = readSnapshot(base, CTX.worklineId, false);
  assert.equal(accepted.tasks[0].status, 'done');
  assert.equal(accepted.tasks[0].settled, true);
  const withIdea = envelopeAfter(base, [
    { op: 'create', parentId: 't1', title: '登录审计日志', executionApproval: 'pending' },
  ]).envelope;
  const afterIdea = readSnapshot(withIdea, CTX.worklineId, false);
  assert.equal(afterIdea.tasks[0].status, 'done', 'the record stays');
  assert.equal(afterIdea.tasks[0].settled, false, 'the current state turns unfinished');
  const parent = withIdea.tasks[0];
  assert.equal(parent.completion, 'user-confirmed');
  assert.equal(parent.completionBasis, '登录功能我验收通过了');
  assert.equal(parent.completedAt, NOW);
  assert.throws(
    () => envelopeAfter(withIdea, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' }]),
    /already done/,
  );
  // Finishing the new child restores the parent, without another acceptance.
  const finished = envelopeAfter(withIdea, [{ op: 'complete', id: 't3' }]).envelope;
  const afterFinish = readSnapshot(finished, CTX.worklineId, false);
  assert.equal(afterFinish.tasks[0].settled, true);
  assert.equal(finished.tasks[0].completedAt, NOW);
}

{
  // Restoring an archived child puts the parent back to unfinished.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '父', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'create', parentId: 't1', title: '想法', executionApproval: 'pending' },
    { op: 'archive', id: 't2', reason: '不做' },
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
  ]).envelope;
  assert.equal(readSnapshot(base, CTX.worklineId, false).tasks[0].status, 'done');
  const back = envelopeAfter(base, [{ op: 'restore', id: 't2' }]).envelope;
  const after = readSnapshot(back, CTX.worklineId, false);
  assert.equal(after.tasks[0].settled, false, 'a restored child re-opens the parent');
  assert.equal(after.tasks[0].status, 'done');
}

{
  // One acceptance quote closes one task.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: '登录' },
    { op: 'create', title: '登录功能', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
    { op: 'create', parentId: 't1', title: '登录审计日志' },
    { op: 'update', id: 't2', executionApproval: 'approved', approvalBasis: '开始吧', requiresUserAcceptance: true },
    { op: 'update', id: 't2', status: 'in_progress' },
  ]).envelope;
  // The parent's quote cannot be replayed for the nested deliverable.
  assert.throws(
    () => envelopeAfter(base, [
      { op: 'complete', id: 't2', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
    ]),
    /already recorded the user's acceptance of task t1/,
  );
  // A single sentence naming both tasks still closes both, clause by clause.
  const both = envelopeAfter(base, [
    { op: 'complete', id: 't2', confirmedByUser: true, confirmationBasis: '审计日志也验收通过了' },
  ]).envelope;
  assert.equal(both.tasks[1].completionBasis, '审计日志也验收通过了');
  assert.equal(both.tasks[0].completionBasis, '登录功能我验收通过了');
  assert.equal(readSnapshot(both, CTX.worklineId, false).tasks[0].settled, true);
  // The whole sentence cannot be reused for a second task either.
  assert.throws(
    () => envelopeAfter(both, [
      { op: 'create', title: '第二个交付', executionApproval: 'approved', approvalBasis: '开始吧' },
      { op: 'complete', id: 't3', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
    ]),
    /already recorded the user's acceptance/,
  );
}

{
  // The panel payload carries the same settlement flag.
  const envelope = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '父', executionApproval: 'approved', approvalBasis: '开始吧' },
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
    { op: 'create', parentId: 't1', title: '后续想法', executionApproval: 'pending' },
  ]).envelope;
  const http = httpSnapshot(envelope, CTX.worklineId, { isLive: () => false });
  assert.equal(http.tasks[0].status, 'done');
  assert.equal(http.tasks[0].settled, false);
  assert.equal(http.tasks[0].completion, 'user-confirmed');
}

// ---------------------------------------------------------------------------
// the reported regression: a pending idea must keep the parent unfinished
// ---------------------------------------------------------------------------

{
  // The exact manual-test shape: Go Todo API (in progress, needs acceptance) with
  // an unauthorized "labels" idea under it.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'Go Todo REST API' },
    { op: 'create', title: 'Go Todo REST API', executionApproval: 'approved', approvalBasis: '开始吧', requiresUserAcceptance: true },
    { op: 'update', id: 't1', status: 'in_progress' },
    { op: 'create', parentId: 't1', title: 'Todo 标签与筛选', executionApproval: 'pending', requiresUserAcceptance: true },
  ]).envelope;
  assert.equal(base.tasks[0].status, 'in_progress');
  assert.equal(base.tasks[1].status, 'pending');
  assert.equal(base.tasks[1].executionApproval, 'pending');
  assert.equal(base.tasks[1].archived, false);

  // Both completion paths must refuse, and the refusal must not change anything.
  assert.throws(
    () => envelopeAfter(base, [
      { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
    ]),
    /any work below it is unfinished: t2 "Todo 标签与筛选" is pending/,
  );
  assert.throws(
    () => envelopeAfter(base, [
      { op: 'update', id: 't1', status: 'done', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
    ]),
    /any work below it is unfinished/,
  );
  // Deferring the idea is not a way out either.
  const deferred = envelopeAfter(base, [
    { op: 'defer', id: 't2', deferredReason: '先不做' },
  ]).envelope;
  assert.throws(
    () => envelopeAfter(deferred, [
      { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
    ]),
    /any work below it is unfinished/,
  );
  // Archiving it (the user's decision) is.
  const archived = envelopeAfter(base, [
    { op: 'archive', id: 't2', reason: '用户决定不做' },
  ]).envelope;
  const closed = envelopeAfter(archived, [
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
  ]).envelope;
  assert.equal(closed.tasks[0].status, 'done');
  assert.equal(closed.tasks[0].completionBasis, '登录功能我验收通过了');
  assert.equal(closed.tasks[1].archived, true);
  assert.equal(closed.tasks[1].parentId, 't1');
  // Finishing it is too.
  const finished = envelopeAfter(base, [
    { op: 'complete', id: 't2', confirmedByUser: true, confirmationBasis: '审计日志也验收通过了' },
  ]).envelope;
  const closed2 = envelopeAfter(finished, [
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能我验收通过了' },
  ]).envelope;
  assert.equal(closed2.tasks[0].status, 'done');
  // Every surface reports the same settlement.
  const read = readSnapshot(base, CTX.worklineId, false);
  assert.equal(read.tasks[0].status, 'in_progress');
  assert.equal(read.tasks[0].settled, false);
  assert.equal(read.tasks[1].parentId, 't1');
  const http = httpSnapshot(base, CTX.worklineId, { isLive: () => false });
  assert.equal(http.tasks[0].settled, false);
  assert.equal(http.tasks[1].status, 'pending');
}

// ---------------------------------------------------------------------------
// the tools' real output must match the schema they registered
// ---------------------------------------------------------------------------

/** Validate one value against a registered JSON Schema subset. Throws on mismatch. */
function assertSchema(schema, value, path = 'value') {
  if (schema === undefined || schema === null) return;
  if (schema.oneOf !== undefined) {
    const failures = [];
    for (const option of schema.oneOf) {
      try {
        assertSchema(option, value, path);
        return;
      } catch (error) {
        failures.push(String(error?.message ?? error));
      }
    }
    throw new Error(`${path}: no oneOf branch matched (${failures.join(' | ')})`);
  }
  const type = schema.type;
  if (type !== undefined) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok = type === actual
      || (type === 'integer' && Number.isInteger(value))
      || (type === 'number' && typeof value === 'number');
    if (!ok) throw new Error(`${path}: expected ${type}, got ${actual}`);
  }
  if (Array.isArray(schema.enum) && schema.enum.includes(value) !== true) {
    throw new Error(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) {
      if (Object.prototype.hasOwnProperty.call(value, key) !== true) throw new Error(`${path}.${key}: missing required property`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key] === undefined) {
        if (schema.additionalProperties === false) throw new Error(`${path}.${key}: is not a declared property`);
        continue;
      }
      assertSchema(properties[key], child, `${path}.${key}`);
    }
    return;
  }
  if (type === 'array') {
    const items = schema.items;
    for (let index = 0; index < value.length; index += 1) assertSchema(items, value[index], `${path}[${index}]`);
  }
}

{
  // Drive the mounted tools and validate both read modes plus the write result.
  const root = tempRoot();
  const registeredTools = new Map();
  const ctx = {
    effect: (factory) => factory(),
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'tools') return { register: (definition) => { registeredTools.set(definition.name, definition); return () => {}; } };
      return undefined;
    },
  };
  mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  const read = registeredTools.get('task_tree_read');
  const write = registeredTools.get('task_tree_write');

  const events = [
    { type: 'user/message', seq: 1, time: Date.now() - 60_000, data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '帮我实现一个登录功能。' }] } },
    { type: 'user/message', seq: 2, time: Date.now() + 60_000, data: { source: { kind: 'user', rpcId: 'r2' }, content: [{ type: 'text', text: '登录功能验收通过了。' }] } },
  ];
  const exec = {
    agent: {
      id: 'session-schema',
      session: { header: { id: 'session-schema' }, seq: 5, snapshotEvents: (from = 0) => events.filter((event) => event.seq >= from) },
    },
  };

  const created = await write.execute({ ops: [
    { op: 'init', originalGoal: '登录功能' },
    { op: 'create', title: '登录功能', executionApproval: 'approved', approvalBasis: '帮我实现一个登录功能。' },
    { op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '登录功能验收通过了' },
    { op: 'create', parentId: 't1', title: '登录审计日志', executionApproval: 'pending' },
    { op: 'create', title: '归档项' },
    { op: 'archive', id: 't3', reason: '不做了' },
  ] }, exec);
  assertSchema(write.output.schema, created, 'write');

  // settled=false on the reopened parent, settled=true on the archived one is not listed
  const detailed = await read.execute({ details: true, includeArchived: true }, exec);
  assertSchema(read.output.schema, detailed, 'read');
  const parent = detailed.tasks.find((task) => task.id === 't1');
  assert.equal(parent.status, 'done', 'the completion record stays');
  assert.equal(parent.settled, false, 'the current state is unfinished');
  assert.equal(detailed.archived.length, 1);
  assert.equal(detailed.archived[0].archiveReason, '不做了');
  // archived rows are not listed among the active tasks
  assert.equal(detailed.tasks.some((task) => task.id === 't3'), false);

  // plain mode is equally valid
  const plain = await read.execute({}, exec);
  assertSchema(read.output.schema, plain, 'read-plain');

  // archiving the child settles the parent again
  await write.execute({ ops: [{ op: 'archive', id: 't2', reason: '用户决定不做' }] }, exec);
  const settledRead = await read.execute({ details: true }, exec);
  assertSchema(read.output.schema, settledRead, 'read-settled');
  assert.equal(settledRead.tasks.find((task) => task.id === 't1').settled, true);

  // an empty workline is equally valid (goal null, no tasks, archived list present)
  const emptyView = await read.execute({ details: true, includeArchived: true }, {
    agent: { id: 'session-empty', session: { header: { id: 'session-empty' }, seq: 0, snapshotEvents: () => [] } },
  });
  assertSchema(read.output.schema, emptyView, 'read-empty');
  assert.deepEqual(emptyView.tasks, []);

  // legacy record: the stored task has no settled field at all
  const legacy = {
    version: 1,
    workline: { id: 'session-legacy', createdAt: 1, updatedAt: 2, goal: { original: 'g', current: 'g', changes: [] }, outline: '', focus: [], nextSeq: 2 },
    tasks: [{ id: 't1', worklineId: 'session-legacy', parentId: null, order: 0, title: '老任务', status: 'done', completion: 'self', createdAt: 1, updatedAt: 2 }],
  };
  const legacyView = readSnapshot(legacy, 'session-legacy', true);
  assertSchema(read.output.schema, legacyView, 'read-legacy');
  assert.equal(legacyView.tasks[0].settled, true, 'a legacy done leaf is settled');

  // A recorded conflict is part of the read model, so the host's output schema
  // must declare it: an undeclared field is rejected.
  assert.ok(read.output.schema.properties.conflicts, 'the read schema declares conflicts');
  assert.equal(write.parameters.properties.ops.items.properties.op.enum.includes('resolveConflict'), true);
  assert.ok(write.parameters.properties.ops.items.properties.conflictId, 'the write schema declares the conflict target');
  writeFileSync(join(root, 'session-conflict.json'), JSON.stringify({
    version: 1,
    workline: {
      id: 'session-conflict',
      createdAt: 1,
      updatedAt: 2,
      goal: { original: 'g', current: 'g', changes: [] },
      outline: '',
      focus: [],
      nextSeq: 2,
      conflicts: [{
        id: 'cf-1', scope: 'task', taskId: 't1', kind: 'unproven-claim', evidence: { boardRevision: 2 }, createdAt: 1, resolvedAt: null, resolution: null,
      }],
    },
    tasks: [{
      id: 't1', worklineId: 'session-conflict', parentId: null, order: 0, title: '冲突任务', status: 'in_progress', executionApproval: 'approved', createdAt: 1, updatedAt: 2,
    }],
  }));
  const conflictView = await read.execute({}, {
    agent: { id: 'session-conflict', session: { header: { id: 'session-conflict' } } },
  });
  assertSchema(read.output.schema, conflictView, 'read-conflict');
  assert.equal(conflictView.conflicts.length, 1);
  assert.equal(conflictView.conflicts[0].id, 'cf-1');
  assert.equal(conflictView.conflicts[0].resolvedAt, null);
}

// ---------------------------------------------------------------------------
// execution seats: the three synchronous keys, suspicion, and real evidence
// ---------------------------------------------------------------------------

{
  // Which keys one call takes: standard mode books the workline, the executor
  // and the task; team mode books executor and task only, because Workers run
  // in parallel on different tasks.
  const standard = seatRequestFor({ tool: 'task_tree_write', args: { ops: [{ op: 'claim', id: 't1' }] }, mode: 'standard', worklineId: 'wl-root', sessionId: 's1' });
  assert.deepEqual(standard, { keys: ['wl:wl-root', 'wk:s1', 'tk:t1'], action: 'claim', taskId: 't1', sessionId: 's1', worklineId: 'wl-root' });
  assert.deepEqual(seatRequestFor({ tool: 'team_task_update', args: { action: 'claim', task_id: 'task-1' }, mode: 'team', worklineId: 'wl-root', sessionId: 'w1' }),
    { keys: ['wk:w1', 'tk:task-1'], action: 'claim', taskId: 'task-1', sessionId: 'w1', worklineId: 'wl-root' });
  // Ownership-changing ops take a seat even when they end an execution.
  assert.deepEqual(seatRequestFor({ tool: 'task_tree_write', args: { ops: [{ op: 'release', id: 't1' }, { op: 'complete', id: 't2' }] }, mode: 'standard', worklineId: 'wl-root', sessionId: 's1' })?.keys,
    ['wl:wl-root', 'wk:s1', 'tk:t1', 'tk:t2']);
  assert.deepEqual(seatRequestFor({ tool: 'team_task_update', args: { action: 'reopen', task_id: 'task-2' }, mode: 'team', worklineId: 'wl-root', sessionId: 'w1' })?.keys,
    ['wk:w1', 'tk:task-2']);
  // Structural changes and other tools hold no seat.
  assert.equal(seatRequestFor({ tool: 'task_tree_write', args: { ops: [{ op: 'create', title: 'x' }, { op: 'focus', ids: [] }] }, mode: 'standard', worklineId: 'wl-root', sessionId: 's1' }), undefined);
  assert.equal(seatRequestFor({ tool: 'team_task_update', args: { action: 'edit', task_id: 'task-1' }, mode: 'team', worklineId: 'wl-root', sessionId: 'w1' }), undefined);
  assert.equal(seatRequestFor({ tool: 'read', args: {}, mode: 'standard', worklineId: 'wl-root', sessionId: 's1' }), undefined);
  assert.equal(seatRequestFor({ tool: 'task_tree_write', args: { ops: [{ op: 'claim', id: 't1' }] }, mode: 'standard', worklineId: 'wl-root', sessionId: undefined }), undefined);

  // The standard workline seat: one claim at a time for the whole workline.
  const seats = createSeatTable({ ttlMs: 1000, now: () => 0 });
  const claim = (requestId, sessionId, taskId, mode = 'standard', worklineId = 'wl-root') => seats.reserve({
    requestId,
    mode,
    sessionId,
    worklineId,
    ...seatRequestFor({ tool: 'task_tree_write', args: { ops: [{ op: 'claim', id: taskId }] }, mode, worklineId, sessionId }),
  });
  assert.equal(claim('c1', 's1', 't1').ok, true);
  const worklineBlocked = claim('c2', 's2', 't2');
  assert.equal(worklineBlocked.ok, false, 'a second in-flight claim sees the first');
  assert.equal(worklineBlocked.holder.dimension, 'workline');
  assert.equal(worklineBlocked.holder.requestId, 'c1');
  // Repeating the very same request id is idempotent, not a self-conflict.
  assert.equal(claim('c1', 's1', 't1').ok, true);
  // No timer releases a seat: only real end-of-call evidence does.
  assert.equal(seats.sweep(999).length, 0, 'before the TTL nothing is suspect');
  const suspect = seats.sweep(1000);
  assert.equal(suspect.length, 1, 'the TTL only marks the reservation suspect');
  assert.equal(seats.size(), 1, 'a suspect seat is still held');
  const suspectBlocked = claim('c3', 's3', 't3');
  assert.equal(suspectBlocked.ok, false, 'a suspect seat still refuses new claims');
  assert.equal(suspectBlocked.holder.state, 'suspect');
  assert.equal(seats.release('c1'), true, 'a matching tool result releases it');
  assert.equal(claim('c3', 's3', 't3').ok, true, 'the freed seat can be taken again');
  assert.equal(seats.release('c3'), true);
  assert.equal(seats.size(), 0);

  // The team seats: one executor, one task.
  const team = createSeatTable();
  const board = (requestId, sessionId, taskId) => team.reserve({
    requestId,
    ...seatRequestFor({ tool: 'team_task_update', args: { action: 'claim', task_id: taskId }, mode: 'team', worklineId: 'wl-root', sessionId }),
  });
  assert.equal(board('d1', 'w1', 'task-1').ok, true);
  const executorBlocked = board('d2', 'w1', 'task-2');
  assert.equal(executorBlocked.ok, false, 'one executor cannot claim two tasks');
  assert.equal(executorBlocked.holder.dimension, 'executor');
  const taskBlocked = board('d3', 'w2', 'task-1');
  assert.equal(taskBlocked.ok, false, 'one task cannot be claimed twice');
  assert.equal(taskBlocked.holder.dimension, 'task');
  assert.equal(board('d4', 'w2', 'task-2').ok, true, 'different executors on different tasks stay parallel');
  // E2: an idle Agent proves none of its calls can still be in flight.
  assert.equal(team.releaseSession('w1'), 1);
  assert.equal(team.size(), 1, 'only the idle agent\'s own reservation was cleared');
  assert.equal(board('d5', 'w1', 'task-3').ok, true, 'the executor seat is free after its agent went idle');
  assert.equal(team.size(), 2);
}

{
  // The guard takes the seat synchronously, before dispatch, and E1 releases it.
  const root = tempRoot();
  const store = createTaskStore({ root, logger: { warn() {} } });
  const sessions = new Map([
    ['session-root', { header: { id: 'session-root' } }],
    ['session-branch', { header: { id: 'session-branch', parentSession: 'session-root' } }],
  ]);
  const ctx = { get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined) };
  await store.update('session-root', (current) => ({
    envelope: envelopeAfter(current, [
      { op: 'init', originalGoal: '并发占位' },
      { op: 'create', title: '任务一', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
      { op: 'create', title: '任务二', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    ]).envelope,
  }));
  const seats = createSeatTable();
  const guard = createExecutionGuard({ ctx, store, seats });
  const claimExec = (callId, sessionId, parentSession, id) => ({
    callId,
    name: 'task_tree_write',
    arguments: { ops: [{ op: 'claim', id }] },
    agent: {
      id: sessionId,
      session: { header: parentSession === undefined ? { id: sessionId } : { id: sessionId, parentSession } },
    },
  });
  assert.equal(guard(claimExec('call-1', 'session-root', undefined, 't1')), undefined);
  assert.equal(seats.size(), 1, 'an admitted claim holds its seat before dispatch');
  const blocked = guard(claimExec('call-2', 'session-branch', 'session-root', 't2'));
  assert.match(blocked, /reserved by an in-flight call/);
  assert.match(blocked, /in-flight call \(task_tree_write claim for wl:session-root/);
  // E1: the matching tool result frees the seat, and the retry is admitted.
  seats.release('call-1');
  assert.equal(guard(claimExec('call-2', 'session-branch', 'session-root', 't2')), undefined);
  // E2: the owning agent going idle frees whatever it still holds.
  seats.releaseSession('session-branch');
  assert.equal(seats.size(), 0);
  // Without a seat table the guard behaves exactly as before (regression).
  const plain = createExecutionGuard({ ctx, store });
  assert.equal(plain(claimExec('call-9', 'session-branch', 'session-root', 't2')), undefined);
}

{
  // The evidence wiring: a seat is released by the matching tool result (E1) or
  // by the owning Agent going idle (E2), and by nothing else.
  const seats = createSeatTable();
  const listeners = new Map();
  const disposers = [];
  const ctx = {
    on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event); },
    effect: (factory, _label) => { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
  };
  assert.equal(registerSeatObservers(ctx, { seats, logger: { warn() {} }, intervalMs: 60_000 }), true);
  const take = (requestId, sessionId) => seats.reserve({
    requestId,
    ...seatRequestFor({ tool: 'task_tree_write', args: { ops: [{ op: 'claim', id: 't1' }] }, mode: 'standard', worklineId: 'wl-root', sessionId }),
  });
  assert.equal(take('r1', 's1').ok, true);
  listeners.get('tools/result')({ callId: 'r1' });
  assert.equal(seats.size(), 0, 'E1: the matching tool result releases the seat');
  assert.equal(take('r2', 's2').ok, true);
  assert.equal(take('r3', 's2').ok, false);
  listeners.get('agent/status')({ agent: { id: 's2' }, status: 'running' });
  assert.equal(seats.size(), 1, 'a running Agent proves nothing');
  listeners.get('agent/status')({ agent: { id: 's2' }, status: 'idle' });
  assert.equal(seats.size(), 0, 'E2: an idle Agent releases what it still held');
  for (const dispose of disposers) dispose();
}

console.log('tasks ok');
