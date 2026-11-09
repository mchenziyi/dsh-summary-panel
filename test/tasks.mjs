/**
 * Task-tree tests: pure model rules, the file store, and the mounted feature
 * (tools + HTTP handlers) over a fake plugin context.
 *
 * Run with `node test/tasks.mjs`; no dsh package is imported anywhere here.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyOps,
  createEmptyEnvelope,
  httpSnapshot,
  readSnapshot,
  statusSnapshot,
  TASK_OPS,
} from '../host/model.js';
import { createTaskStore } from '../host/store.js';
import { callerOf } from '../host/session.js';
import { mountTaskTree } from '../host/mount.js';
import { taskTreeReminderFor, TASK_TREE_REMINDER, TASK_TREE_START_REMINDER, TASK_TREE_PROMPT } from '../host/prompt.js';
import { MAX_BASIS, MIN_QUOTE, verifyUserQuote } from '../host/evidence.js';
import { PROMPT_BANNED_TERMS } from './support/contract-terms.mjs';

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
// model: expected outcome and next step (right-sidebar fields, REQ:364/369)
// ---------------------------------------------------------------------------

{
  const { envelope } = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    {
      op: 'create',
      title: '登录',
      expectedOutcome: '  用户能用邮箱登录  ',
      nextStep: '补失败提示',
    },
    { op: 'create', title: '补测试', parentId: 't1' },
  ]);

  // Free text is trimmed, exactly like summary/progress.
  const details = readSnapshot(envelope, CTX.worklineId, true).tasks[0];
  assert.equal(details.expectedOutcome, '用户能用邮箱登录');
  assert.equal(details.nextStep, '补失败提示');

  // The compact read stays compact: only the interrupt relation rides along.
  const compact = readSnapshot(envelope, CTX.worklineId).tasks[0];
  assert.equal(compact.expectedOutcome, undefined);
  assert.equal(compact.nextStep, undefined);

  // The panel reads the HTTP payload, so both fields must be there.
  const http = httpSnapshot(envelope, CTX.worklineId).tasks[0];
  assert.equal(http.expectedOutcome, '用户能用邮箱登录');
  assert.equal(http.nextStep, '补失败提示');

  // Updating either field is a partial write; an empty string clears it.
  const updated = envelopeAfter(envelope, [
    { op: 'update', id: 't1', expectedOutcome: '用户能登录并看到错误提示' },
    { op: 'update', id: 't1', nextStep: '' },
  ]).envelope;
  const afterUpdate = httpSnapshot(updated, CTX.worklineId).tasks[0];
  assert.equal(afterUpdate.expectedOutcome, '用户能登录并看到错误提示');
  assert.equal(afterUpdate.nextStep, '');

  // Same shape rules as summary: one line, bounded length.
  assert.throws(
    () => envelopeAfter(envelope, [{ op: 'update', id: 't1', expectedOutcome: 'a\nb' }]),
    /expectedOutcome must be a single line/,
  );
  assert.throws(
    () => envelopeAfter(envelope, [{ op: 'create', title: 'x', expectedOutcome: 'x'.repeat(241) }]),
    /expectedOutcome must be at most 240/,
  );
  assert.throws(
    () => envelopeAfter(envelope, [{ op: 'update', id: 't1', nextStep: 'a\nb' }]),
    /nextStep must be a single line/,
  );
  assert.throws(
    () => envelopeAfter(envelope, [{ op: 'create', title: 'x', nextStep: 'x'.repeat(241) }]),
    /nextStep must be at most 240/,
  );
}

// ---------------------------------------------------------------------------
// model: temporary tasks and the interrupt relation (REQ:107, §6.3, §16.18)
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: '主线 A' },
    { op: 'create', title: '主线 B' },
  ]).envelope;

  // A temporary task names the mainline task it interrupted.
  const withTemporary = envelopeAfter(base, [
    { op: 'create', title: '紧急修复', temporary: true, temporaryFor: 't1' },
  ]).envelope;
  const created = withTemporary.tasks.find((task) => task.title === '紧急修复');
  assert.equal(created.temporary, true);
  assert.equal(created.temporaryFor, 't1');
  const createdRow = readSnapshot(withTemporary, CTX.worklineId).tasks.find((task) => task.id === created.id);
  assert.equal(createdRow.temporary, true);
  assert.equal(createdRow.temporaryFor, 't1');
  const createdHttp = httpSnapshot(withTemporary, CTX.worklineId).tasks.find((task) => task.id === created.id);
  assert.equal(createdHttp.temporary, true);
  assert.equal(createdHttp.temporaryFor, 't1');

  // Naming the interrupted task is the actionable write: it makes the task
  // temporary by itself, so one field is enough.
  const namedOnly = envelopeAfter(base, [
    { op: 'create', title: '临时排查', temporaryFor: 't2' },
  ]).envelope;
  const namedTask = namedOnly.tasks.find((task) => task.title === '临时排查');
  assert.equal(namedTask.temporary, true);
  assert.equal(namedTask.temporaryFor, 't2');

  // A temporary task without its source is refused: it would be a detour with
  // no way back to the mainline work.
  assert.throws(
    () => envelopeAfter(base, [{ op: 'create', title: '临时', temporary: true }]),
    /must name the task it interrupted/,
  );
  // Explicitly dropping the source makes the task ordinary again.
  const orphaned = envelopeAfter(withTemporary, [{ op: 'update', id: 't3', temporaryFor: null }]).envelope;
  const orphanedTask = orphaned.tasks.find((task) => task.id === 't3');
  assert.equal(orphanedTask.temporary, false);
  assert.equal(orphanedTask.temporaryFor, null);

  // The source must exist.
  assert.throws(
    () => envelopeAfter(base, [{ op: 'create', title: '临时', temporary: true, temporaryFor: 't99' }]),
    /unknown task/,
  );

  // A task cannot interrupt itself.
  assert.throws(
    () => envelopeAfter(withTemporary, [{ op: 'update', id: 't3', temporaryFor: 't3' }]),
    /cannot be a temporary task for itself/,
  );

  // And the interrupt chain cannot loop back to the task.
  assert.throws(
    () => envelopeAfter(withTemporary, [{ op: 'update', id: 't1', temporaryFor: 't3' }]),
    /cycle of temporary tasks/,
  );
  const chain = envelopeAfter(withTemporary, [
    { op: 'create', title: '二级临时', temporaryFor: 't3' },
  ]).envelope;
  assert.throws(
    () => envelopeAfter(chain, [{ op: 'update', id: 't1', temporaryFor: 't4' }]),
    /cycle of temporary tasks/,
  );

  // The interrupted task must still be active: an archived task is history and
  // cannot be the mainline work that is being paused.
  const archivedBase = envelopeAfter(base, [{ op: 'archive', id: 't2', reason: '不要了' }]).envelope;
  assert.throws(
    () => envelopeAfter(archivedBase, [{ op: 'create', title: '临时', temporary: true, temporaryFor: 't2' }]),
    /temporaryFor must name an active task/,
  );

  // Same workline only: a task record carrying another workline's id cannot be
  // the interrupted mainline task.
  const foreign = JSON.parse(JSON.stringify(base));
  foreign.tasks.push({ id: 'tx', worklineId: 'other-workline', title: '别的工作线', order: 9 });
  assert.throws(
    () => envelopeAfter(foreign, [{ op: 'create', title: '临时', temporary: true, temporaryFor: 'tx' }]),
    /temporaryFor must name a task in the same workline/,
  );

  // Dropping the marker clears the link; keeping a source on an ordinary task
  // is a contradiction the model refuses instead of half-applying.
  const cleared = envelopeAfter(withTemporary, [{ op: 'update', id: 't3', temporary: false }]).envelope;
  const clearedTask = cleared.tasks.find((task) => task.id === 't3');
  assert.equal(clearedTask.temporary, false);
  assert.equal(clearedTask.temporaryFor, null);
  assert.throws(
    () => envelopeAfter(withTemporary, [{ op: 'update', id: 't3', temporary: false, temporaryFor: 't1' }]),
    /not temporary cannot name/,
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

  // A claim records who is working on the task; it allocates no execution and
  // writes no ledger.
  const claimed = envelopeAfter(resumed, [{ op: 'claim', id: 't1' }]).envelope;
  assert.deepEqual(claimed.tasks[0].owner, { sessionId: 'session-root', member: null, since: NOW });
  assert.equal(claimed.workline.executions, undefined, 'the execution ledger is gone');
  assert.equal(claimed.workline.nextExecution, undefined);

  // The one compare-and-set: another session cannot claim the same task, so two
  // sessions never work on it at once.
  assert.throws(
    () => envelopeAfter(claimed, [{ op: 'claim', id: 't1' }], { actorSessionId: 'session-other' }),
    /already claimed by session session-root/,
  );
  // The same session claiming again only refreshes the record.
  const reclaimed = envelopeAfter(claimed, [{ op: 'claim', id: 't1' }], { now: NOW + 5 }).envelope;
  assert.equal(reclaimed.tasks[0].owner.sessionId, 'session-root');
  assert.equal(reclaimed.tasks[0].owner.since, NOW + 5);

  // claim and release are records, not credentials: any session may clear a
  // claim and no holder check stands in the way.
  const released = envelopeAfter(claimed, [{ op: 'release', id: 't1' }], { actorSessionId: 'session-other' }).envelope;
  assert.equal(released.tasks[0].owner, null);
  const other = envelopeAfter(released, [{ op: 'claim', id: 't1' }], { actorSessionId: 'session-other' }).envelope;
  assert.equal(other.tasks[0].owner.sessionId, 'session-other');

  // One session may hold several tasks: the old single execution seat is gone.
  const twoTasks = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: 'A', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'create', title: 'B', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'claim', id: 't1' },
    { op: 'claim', id: 't2' },
  ]).envelope;
  assert.equal(twoTasks.tasks[0].owner.sessionId, 'session-root');
  assert.equal(twoTasks.tasks[1].owner.sessionId, 'session-root');

  assert.throws(
    () => envelopeAfter(base, [{ op: 'claim', id: 't1' }]),
    /must be in_progress/,
  );
}

{
  // Completion, deferral and archive clear the claim record, so no finished or
  // parked task keeps naming a session that is working on it.
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: 'A', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'create', title: 'B', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'create', title: 'C', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
    { op: 'claim', id: 't1' },
  ]).envelope;
  const completed = envelopeAfter(base, [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '没问题了，验收通过' }]).envelope;
  assert.equal(completed.tasks[0].owner, null);
  // Re-claiming a done task is impossible for the task-domain reason (a done
  // task is not in_progress), not because a gate refuses the call.
  assert.throws(() => envelopeAfter(completed, [{ op: 'claim', id: 't1' }]), /must be in_progress/);
  const next = envelopeAfter(completed, [{ op: 'claim', id: 't2' }]).envelope;
  assert.equal(next.tasks[1].owner.sessionId, 'session-root');

  const deferred = envelopeAfter(completed, [
    { op: 'claim', id: 't2' },
    { op: 'defer', id: 't2', deferredReason: '先做别的', userBasis: '开始吧' },
  ]).envelope;
  assert.equal(deferred.tasks[1].owner, null);

  const archived = envelopeAfter(completed, [
    { op: 'claim', id: 't3' },
    { op: 'archive', id: 't3', reason: '不做了', userBasis: '记住我那个不做了' },
  ]).envelope;
  assert.equal(archived.tasks[2].owner, null);
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
// caller resolution: the tools read the calling session from the live agent
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
  assert.deepEqual(empty, { worklineId: 'session-root', goal: null, focus: [], tasks: [] });

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
// tools: the tree is written by whoever is working, and claim is a record
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
  // "Only the lead maintains the tree" is a prompt convention, not a refusal:
  // a subagent's write is accepted (ADR-0003 decision 8).
  const written = await registeredTools.get('task_tree_write').execute(
    { ops: [{ op: 'init', originalGoal: 'g' }] },
    { agent: { id: 'session-child', session: { header: { id: 'session-child', parentSession: 'session-root', origin: 'subagent' } } } },
  );
  assert.equal(written.ok, true);
  assert.equal(written.worklineId, 'session-root');
}

// ---------------------------------------------------------------------------
// tools: claim / release through the real tool path
// ---------------------------------------------------------------------------

{
  const root = tempRoot();
  const registeredTools = new Map();
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
        };
      }
      if (name === 'systemPrompt') return undefined;
      return undefined;
    },
  };
  mountTaskTree(ctx, { root, logger: { warn() {} }, route: () => {} });
  const write = registeredTools.get('task_tree_write');
  const read = registeredTools.get('task_tree_read');
  const userMessage = (text) => [{
    type: 'user/message',
    seq: 1,
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }];
  const sessionFor = (header) => ({ id: header.id, header, seq: 2, snapshotEvents: () => userMessage('开始吧') });
  const lead = { agent: { id: 'session-root', session: sessionFor(headers.get('session-root')) } };
  const child = { agent: { id: 'session-child', session: sessionFor(headers.get('session-child')) } };

  // The Lead sets up and claims; the claim records the session.
  await write.execute({
    ops: [
      { op: 'init', originalGoal: '记录' },
      { op: 'create', title: '记录任务', executionApproval: 'approved', approvalBasis: '开始吧', status: 'in_progress' },
      { op: 'claim', id: 't1' },
    ],
  }, lead);
  const held = await read.execute({ details: true }, lead);
  assert.deepEqual(held.tasks[0].executor, { kind: 'lead', name: 'lead', sessionId: 'session-root' });

  // A second session cannot claim the same task (the compare-and-set), and its
  // call is the only thing refused — not its other tool calls.
  await assert.rejects(
    () => write.execute({ ops: [{ op: 'claim', id: 't1' }] }, child),
    /already claimed by session session-root/,
  );

  // Release by another session is allowed: the record is not a credential.
  const released = await write.execute({ ops: [{ op: 'release', id: 't1' }] }, child);
  assert.equal(released.applied[0].op, 'release');
  const claimedByChild = await write.execute({ ops: [{ op: 'claim', id: 't1' }] }, child);
  assert.equal(claimedByChild.applied[0].op, 'claim');
  const readBack = await read.execute({ details: true }, lead);
  assert.equal(readBack.tasks[0].executor.sessionId, 'session-child');
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
// approval: permission is separate from status
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
    /is not approved/,
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
    /is not approved/,
  );
  assert.throws(
    () => envelopeAfter(base, [{ op: 'claim', id: 't1' }]),
    /is not approved/,
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
  // A legacy claim stamp names the session and (for a Team worker) the member.
  // A re-claim by that same session keeps the name for the panel; the execution
  // id on the stamp is ignored.
  const legacyClaim = {
    version: 1,
    workline: { id: 'session-root', createdAt: 1, updatedAt: 2, goal: null, outline: '', focus: [], nextSeq: 2 },
    tasks: [{
      id: 't1', worklineId: 'session-root', parentId: null, order: 0, title: '旧认领', status: 'in_progress',
      executionApproval: 'approved',
      owner: { sessionId: 'worker-session', executionId: 'ex-7', member: 'worker-a', since: 1 },
      createdAt: 1, updatedAt: 2,
    }],
  };
  const reclaimed = envelopeAfter(legacyClaim, [{ op: 'claim', id: 't1' }], { actorSessionId: 'worker-session' }).envelope;
  assert.deepEqual(reclaimed.tasks[0].owner, { sessionId: 'worker-session', member: 'worker-a', since: NOW });
  const takeover = envelopeAfter(legacyClaim, [
    { op: 'release', id: 't1' },
    { op: 'claim', id: 't1' },
  ], { actorSessionId: 'session-other' }).envelope;
  assert.equal(takeover.tasks[0].owner.member, null, 'a new claim does not inherit another session\'s name');

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
  for (const needle of ['executionApproval', 'approvalBasis', 'confirmationBasis', 'confirmedByUser', 'reviseGoal', 'pending',
    'expectedOutcome', 'nextStep', 'temporaryFor']) {
    assert.equal(TASK_TREE_PROMPT.includes(needle), true, `prompt should mention ${needle}`);
  }
  assert.equal(TASK_TREE_PROMPT.includes('Record work that is worth tracking as soon as it appears'), true);
  // Interruptions are model-facing: the prompt says to record the source task.
  assert.equal(TASK_TREE_PROMPT.includes('temporary: true'), true);
  // Who maintains the tree is model-facing too: the prompt says only the lead
  // keeps it, as a convention rather than a refusal (ADR-0003 decision 8).
  assert.equal(TASK_TREE_PROMPT.includes('Only the lead session maintains the tree'), true);
  assert.equal(TASK_TREE_PROMPT.includes('by convention, not by force'), true);
  // ADR-0003 decision 3: the prompt is about keeping the tree current, and the
  // reminder says what a missing tree costs the user. The claim apparatus is a
  // record in the tool schema, not prompt coaching.
  assert.equal(TASK_TREE_PROMPT.includes('leaves their panel empty'), true);
  for (const gone of PROMPT_BANNED_TERMS) {
    assert.equal(
      TASK_TREE_PROMPT.includes(gone) || TASK_TREE_START_REMINDER.includes(gone),
      false,
      `the prompt must not coach "${gone}" any more (ADR-0003)`,
    );
  }
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
    '**Focus and status are different writes.**',
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
  for (const needle of ['Prefer the task that actually owns this work', 'Leave it out only when no existing task owns the work', 'Placement does not grant approval', 'does not decide who accepts the result']) {
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
    '**Notes are not work.**',
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
    'Notes are not work',
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

  // A temporary task survives the real file store and comes back with the task
  // it interrupted: the interrupt relation is persisted, not a render-time flag.
  const tempWrite = await write.execute({ ops: [
    { op: 'create', title: '主线工作' },
    { op: 'create', title: '临时修复', temporary: true, temporaryFor: 't4' },
  ] }, exec);
  assert.equal(tempWrite.ok, true);
  const tempRead = await read.execute({ details: true }, exec);
  assertSchema(read.output.schema, tempRead, 'read-temporary');
  const tempTask = tempRead.tasks.find((task) => task.title === '临时修复');
  assert.equal(tempTask.temporary, true);
  assert.equal(tempTask.temporaryFor, 't4');

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

  // The write schema accepts exactly the surviving ops and none of the torn-out
  // fields; the read schema declares no ledger or conflict state.
  assert.deepEqual(write.parameters.properties.ops.items.properties.op.enum, [...TASK_OPS]);
  for (const removed of ['assign', 'dispatch', 'resolveConflict']) {
    assert.equal(TASK_OPS.includes(removed), false, `op ${removed} is gone`);
    assert.equal(write.parameters.properties.ops.items.properties.op.enum.includes(removed), false,
      `the write schema no longer declares op ${removed}`);
  }
  for (const gone of ['member', 'teamTaskId', 'conflictId', 'force']) {
    assert.equal(write.parameters.properties.ops.items.properties[gone], undefined,
      `the write schema no longer declares ${gone}`);
  }
  for (const gone of ['conflicts', 'executorLost', 'executionState']) {
    assert.equal(read.output.schema.properties[gone], undefined, `the read schema no longer declares ${gone}`);
    assert.equal(read.output.schema.properties.tasks.items.properties[gone], undefined,
      `the read schema no longer declares task.${gone}`);
  }
  assert.equal(write.output.schema.properties.applied.items.properties.executionId, undefined,
    'the write result no longer reports an execution id');
  // The right-sidebar fields and the interrupt relation are model-facing: the
  // tool schema must declare every one of them or the host rejects the call.
  for (const field of ['expectedOutcome', 'nextStep', 'temporary', 'temporaryFor']) {
    assert.ok(write.parameters.properties.ops.items.properties[field], `the write schema declares ${field}`);
  }
  for (const field of ['expectedOutcome', 'nextStep', 'temporary', 'temporaryFor']) {
    assert.ok(read.output.schema.properties.tasks.items.properties[field], `the read schema declares ${field}`);
  }

  // Old JSON is readable: a record written by the previous build still carries
  // the execution ledger, Worker lifetimes, conflicts and an execution stamp.
  // All of it is ignored (no migration, no rewrite) and the tree reads normally.
  writeFileSync(join(root, 'session-old.json'), JSON.stringify({
    version: 1,
    workline: {
      id: 'session-old',
      createdAt: 1,
      updatedAt: 2,
      goal: { original: 'g', current: 'g', changes: [] },
      outline: '',
      focus: [],
      nextSeq: 2,
      nextExecution: 3,
      executions: [{
        executionId: 'ex-1', taskId: 't1', sessionId: 'worker-session', attempt: 1, mode: 'team',
        state: 'active', startedAt: 1, updatedAt: 2,
      }],
      workers: { 'worker-session': { kind: 'teammate', name: 'worker-a', state: 'bound', boundTaskId: 't1', executionId: 'ex-1' } },
      conflicts: [{
        id: 'cf-1', scope: 'task', taskId: 't1', kind: 'unproven-claim', evidence: { boardRevision: 2 }, createdAt: 1, resolvedAt: null,
      }],
    },
    tasks: [{
      id: 't1', worklineId: 'session-old', parentId: null, order: 0, title: '老任务', status: 'in_progress',
      executionApproval: 'approved', owner: { sessionId: 'worker-session', executionId: 'ex-1', member: 'worker-a', since: 1 },
      createdAt: 1, updatedAt: 2,
    }],
  }));
  const oldView = await read.execute({}, {
    agent: { id: 'session-old', session: { header: { id: 'session-old' } } },
  });
  assertSchema(read.output.schema, oldView, 'read-old');
  assert.equal(oldView.conflicts, undefined, 'the conflict list is not part of the read model any more');
  assert.equal(oldView.tasks[0].title, '老任务');
  assert.equal(oldView.tasks[0].executor.name, 'worker-a', 'the old stamp still names the executor for the panel');
  assert.deepEqual(oldView.tasks[0].owner, true);

  // Writing to that old record drops the ledger instead of migrating it: the
  // next read is a plain tree record, and the claim stamp keeps only the record.
  await write.execute({ ops: [{ op: 'release', id: 't1' }] }, {
    agent: { id: 'session-old', session: { header: { id: 'session-old' } } },
  });
  const rewritten = JSON.parse(readFileSync(join(root, 'session-old.json'), 'utf8'));
  assert.equal(rewritten.workline.executions, undefined, 'the ledger is not written again');
  assert.equal(rewritten.workline.workers, undefined);
  assert.equal(rewritten.workline.conflicts, undefined);
  assert.equal(rewritten.tasks[0].owner, null, 'release cleared the record');
}

{
  // The panel payload (HTTP projection) is built from the same old record: it
  // must render a ledger-bearing tree with no ledger and no crash (#20 item ④).
  const legacy = {
    version: 1,
    workline: {
      id: 'session-panel-old',
      createdAt: 1,
      updatedAt: 2,
      goal: { original: '旧目标', current: '旧目标', changes: [] },
      outline: '',
      focus: [],
      nextSeq: 2,
      nextExecution: 3,
      executions: [{
        executionId: 'ex-1', taskId: 't1', sessionId: 'worker-session', attempt: 1, mode: 'team',
        state: 'active', startedAt: 1, updatedAt: 2,
      }],
      workers: { 'worker-session': { kind: 'teammate', name: 'worker-a', state: 'bound', boundTaskId: 't1', executionId: 'ex-1' } },
      conflicts: [{
        id: 'cf-1', scope: 'task', taskId: 't1', kind: 'unproven-claim', evidence: { boardRevision: 2 }, createdAt: 1, resolvedAt: null,
      }],
    },
    tasks: [{
      id: 't1', worklineId: 'session-panel-old', parentId: null, order: 0, title: '老任务', status: 'in_progress',
      executionApproval: 'approved', owner: { sessionId: 'worker-session', executionId: 'ex-1', member: 'worker-a', since: 1 },
      createdAt: 1, updatedAt: 2,
    }],
  };
  const http = httpSnapshot(legacy, 'session-panel-old', { isLive: () => false });
  assert.equal(http.available, true);
  assert.equal(http.tasks.length, 1);
  assert.equal(http.tasks[0].title, '老任务');
  assert.equal(http.tasks[0].status, 'in_progress');
  assert.equal(http.tasks[0].ownerSessionId, 'worker-session');
  assert.equal(http.tasks[0].ownerName, 'worker-a', 'the old member name still shows in the panel');
  assert.equal(http.tasks[0].ownerLive, false, 'a session that cannot be resolved shows as offline');
  assert.equal('conflicts' in http, false, 'the panel payload has no conflicts list');
}

console.log('tasks ok');
