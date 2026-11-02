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
  createEmptyEnvelope,
  httpSnapshot,
  readSnapshot,
  statusSnapshot,
} from '../host/model.js';
import { createTaskStore } from '../host/store.js';
import { mountTaskTree } from '../host/mount.js';
import { taskTreeReminderFor, TASK_TREE_REMINDER, TASK_TREE_START_REMINDER, TASK_TREE_PROMPT } from '../host/prompt.js';
import { verifyUserQuote } from '../host/evidence.js';

const NOW = 1_700_000_000_000;

// The user messages this fake session "contains"; approval and acceptance
// quotes are checked against them, exactly like the live host does. Times are
// relative to NOW: instructions come before the work, acceptance after it.
const USER_SAYS = [
  { seq: 1, time: NOW - 60_000, text: '帮我实现一个 Go 短链接服务，包括创建、跳转、查询和测试。' },
  { seq: 3, time: NOW - 50_000, text: '登录功能可以做，开始吧。' },
  { seq: 5, time: NOW - 40_000, text: '我决定把纯 API 短链接服务升级为单管理员管理工具，但先讨论实施方案，不要写代码。' },
  { seq: 7, time: NOW + 5_000, text: '没问题了，验收通过。' },
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

  assert.throws(
    () => envelopeAfter(base, [{ op: 'complete', id: 't1', confirmedByUser: true }]),
    /child tasks are unfinished/,
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

  const deferred = envelopeAfter(focused, [{ op: 'defer', id: 't1', deferredReason: '先做别的' }]).envelope;
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

  // Another live session cannot steal the claim.
  assert.throws(
    () => envelopeAfter(claimed, [{ op: 'claim', id: 't1' }], {
      actorSessionId: 'session-other',
      isLive: () => true,
    }),
    /claimed by live session/,
  );
  // A dead owner can be replaced.
  const taken = envelopeAfter(claimed, [{ op: 'claim', id: 't1' }], {
    actorSessionId: 'session-other',
    isLive: () => false,
  }).envelope;
  assert.equal(taken.tasks[0].owner.sessionId, 'session-other');

  assert.throws(
    () => envelopeAfter(base, [{ op: 'claim', id: 't1' }]),
    /must be in_progress/,
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
    { op: 'update', id: 't1', executionApproval: 'approved', approvalBasis: '登录功能可以做，开始吧' },
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
    { op: 'update', id: 't1', executionApproval: 'approved', approvalBasis: '开始吧' },
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
    { op: 'update', id: 't2', executionApproval: 'approved', approvalBasis: '开始吧' },
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
  assert.notEqual(TASK_TREE_REMINDER, TASK_TREE_START_REMINDER);
  assert.equal(TASK_TREE_START_REMINDER.includes('no task tree yet'), true);
  assert.equal(TASK_TREE_REMINDER.includes('task_tree_write'), true);
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

console.log('tasks ok');
