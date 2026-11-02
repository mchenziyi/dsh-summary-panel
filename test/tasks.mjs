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
        return { section: (section) => { sections.push(section); return () => {}; } };
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

console.log('tasks ok');
