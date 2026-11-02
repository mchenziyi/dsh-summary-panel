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
import { taskTreeReminderFor, TASK_TREE_REMINDER } from '../host/prompt.js';

const NOW = 1_700_000_000_000;
const CTX = { worklineId: 'session-root', now: NOW, actorSessionId: 'session-root', isLive: () => true };

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
  assert.throws(
    () => envelopeAfter(base, [{ op: 'complete', id: 't2' }]),
    /confirmedByUser: true/,
  );

  const done = envelopeAfter(base, [
    { op: 'complete', id: 't2', confirmedByUser: true, result: '子完成' },
    { op: 'complete', id: 't1', confirmedByUser: true },
  ]).envelope;
  const snapshot = readSnapshot(done, CTX.worklineId);
  assert.deepEqual(snapshot.tasks.map((task) => task.status), ['done', 'done']);
  assert.equal(done.tasks[1].completion, 'user-confirmed');
  assert.equal(done.workline.goal.current, 'g');
}

// ---------------------------------------------------------------------------
// model: defer / focus / claim
// ---------------------------------------------------------------------------

{
  const base = envelopeAfter(undefined, [
    { op: 'init', originalGoal: 'g' },
    { op: 'create', title: 'A' },
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
    { op: 'create', title: '当前' },
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
    { op: 'create', title: '登录功能' },
    { op: 'create', title: '登录接口', parentId: 't1' },
    { op: 'complete', id: 't2', confirmedByUser: true, result: '接口完成' },
    { op: 'complete', id: 't1', confirmedByUser: true, result: '登录完成' },
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
  const userEvent = (seq, text) => ({ type: 'user/message', seq, data: { content: [{ type: 'text', text }] } });
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

  // No tree file yet: never nags sessions that never used the task tree.
  const stranger = sessionOf('session-stranger', [userEvent(1, '帮我改个 bug')]);
  assert.equal(taskTreeReminderFor(ctx, store, stranger), '');

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
    userEvent(7, 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'),
    userEvent(8, '<system-reminder>skills</system-reminder>'),
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

  // A branch of a never-initialised workline stays quiet.
  const plainBranch = sessionOf('session-plain', [userEvent(3, '你好')], { id: 'session-plain', parentSession: 'session-unused' });
  assert.equal(taskTreeReminderFor(ctx, store, plainBranch), '');
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

console.log('tasks ok');
