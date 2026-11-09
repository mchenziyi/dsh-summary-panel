/**
 * Task-tree proof, in two runs over one workline.
 *
 * Run 1 builds the tree from zero: `init`, a task, a progress note and a focus,
 * then reads it back through `task_tree_read` (the panel's data source) — the
 * plain "create, advance, persist, read" path.
 *
 * Between runs the workline's file is replaced with a record the previous build
 * wrote (execution ledger, Worker table, conflicts, an execution stamp). Run 2
 * resumes the Session and proves the old record is read, advanced and rewritten
 * without migration: the ledger is ignored on read and dropped on write, while
 * the old claim's member name is kept for the panel.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'tree-basics';
export const summary = 'Create, advance, persist and read a tree; an old ledger record is read and dropped';
export const runs = [
  {
    prompt: '这是新工作线，开始吧：建树、开一个任务并推进它，然后读一下面板数据。',
    program: [
      { tool: 'task_tree_write', arguments: { ops: [{ op: 'init', originalGoal: '初始目标' }] } },
      {
        tool: 'task_tree_write',
        arguments: {
          ops: [{
            op: 'create',
            title: '旧任务',
            executionApproval: 'approved',
            approvalBasis: '开始吧',
            status: 'in_progress',
          }],
        },
      },
      {
        tool: 'task_tree_write',
        arguments: { ops: [{ op: 'update', id: 't1', progress: '初始进展', nextStep: '继续下一步' }] },
      },
      { tool: 'task_tree_write', arguments: { ops: [{ op: 'focus', ids: ['t1'] }] } },
      { tool: 'task_tree_read', arguments: { details: true } },
      { text: '树已建好。' },
    ],
    async after({ profile, sessionId }) {
      // Replace this workline's file with the shape the previous build wrote:
      // three ledger mirrors plus an execution stamp on the task.
      const envelope = {
        version: 1,
        workline: {
          id: sessionId,
          createdAt: 1,
          updatedAt: 2,
          goal: { original: '旧工作线的目标', current: '旧工作线的目标', changes: [] },
          outline: '',
          focus: [],
          nextSeq: 2,
          nextExecution: 3,
          executions: [{
            executionId: 'ex-1',
            taskId: 't1',
            sessionId: 'worker-session',
            attempt: 1,
            mode: 'team',
            state: 'active',
            startedAt: 1,
            updatedAt: 2,
          }],
          workers: {
            'worker-session': {
              kind: 'teammate',
              name: 'worker-a',
              state: 'bound',
              boundTaskId: 't1',
              executionId: 'ex-1',
              createdAt: 1,
              updatedAt: 2,
            },
          },
          conflicts: [{
            id: 'cf-1',
            scope: 'task',
            taskId: 't1',
            kind: 'unproven-claim',
            evidence: { boardRevision: 2 },
            createdAt: 1,
            resolvedAt: null,
          }],
        },
        tasks: [{
          id: 't1',
          worklineId: sessionId,
          parentId: null,
          order: 0,
          title: '旧任务',
          summary: '上一个版本留下的任务',
          status: 'in_progress',
          deferred: false,
          archived: false,
          progress: '',
          result: null,
          blocker: null,
          executionApproval: 'approved',
          approvalBasis: '开始吧',
          requiresUserAcceptance: true,
          owner: {
            sessionId: 'worker-session',
            executionId: 'ex-1',
            member: 'worker-a',
            since: 1,
          },
          createdAt: 1,
          updatedAt: 2,
        }],
      };
      await mkdir(profile.taskTreeDir, { recursive: true });
      await writeFile(join(profile.taskTreeDir, `${sessionId}.json`), `${JSON.stringify(envelope, null, 2)}\n`);
    },
  },
  {
    resume: true,
    prompt: '继续这条工作线：读一下任务树，把旧任务推进，再新建一个步骤。',
    program: [
      { tool: 'task_tree_read', arguments: { details: true } },
      {
        tool: 'task_tree_write',
        arguments: { ops: [{ op: 'update', id: 't1', progress: '从上一版记录接手；进展保持。', nextStep: '完成新步骤' }] },
      },
      {
        tool: 'task_tree_write',
        arguments: { ops: [{ op: 'create', title: '旧任务下的新步骤', parentId: 't1' }] },
      },
      {
        tool: 'task_tree_write',
        arguments: { ops: [{ op: 'complete', id: 't2', result: '新步骤完成' }] },
      },
      { tool: 'task_tree_write', arguments: { ops: [{ op: 'focus', ids: ['t1'] }] } },
      { text: '旧树已读取并推进。' },
    ],
  },
];

/** Parse a tool result that should be JSON, tolerating the host's wrapper. */
function jsonResult(call) {
  if (typeof call?.result !== 'string') return undefined;
  try {
    return JSON.parse(call.result);
  } catch {
    const start = call.result.indexOf('{');
    if (start === -1) return undefined;
    try {
      return JSON.parse(call.result.slice(start));
    } catch {
      return undefined;
    }
  }
}

export function verify({ runs, sessionId }) {
  const first = runs[0]?.artefacts;
  const second = runs[1]?.artefacts;
  const result = [];
  if (first === undefined || second === undefined) {
    return [{ label: 'both scripted sessions ran', ok: false, detail: `${runs.length} run(s) recorded` }];
  }

  // Run 1: the tree was created from nothing, persisted, focused and read back.
  const created = first.taskTree.present === true ? first.taskTree.tree : undefined;
  const createdTasks = Array.isArray(created?.tasks) ? created.tasks : [];
  const firstRead = jsonResult(first.toolResults.calls.find((call) => call.tool === 'task_tree_read'));
  result.push({
    label: 'the tree was created from zero and persisted',
    ok: createdTasks.length === 1
      && createdTasks[0].title === '旧任务'
      && createdTasks[0].status === 'in_progress'
      && created.workline?.goal?.original === '初始目标',
    detail: `tasks=${createdTasks.length} status=${createdTasks[0]?.status ?? 'absent'} goal=${JSON.stringify(created?.workline?.goal?.original ?? null)}`,
  });
  result.push({
    label: 'the focus was set and the read payload matches the persisted tree',
    ok: created?.workline?.focus?.[0] === 't1'
      && firstRead?.tasks?.length === createdTasks.length
      && firstRead.tasks[0].title === createdTasks[0].title,
    detail: `focus=${JSON.stringify(created?.workline?.focus ?? null)} readTasks=${firstRead?.tasks?.length ?? 'none'}`,
  });

  // Run 2: the old record is readable, then rewritten as a plain tree record.
  const read = second.toolResults.calls.find((call) => call.tool === 'task_tree_read');
  const payload = jsonResult(read);
  result.push({
    label: 'the old tree is readable through the tool (no crash on the ledger)',
    ok: read !== undefined && read.status === 'completed' && payload !== undefined,
    detail: read === undefined ? 'no task_tree_read call' : `status=${read.status}`,
  });
  result.push({
    label: 'the tool read returns the old task and its claim record (the panel\'s data source)',
    ok: payload?.tasks?.length === 1
      && payload.tasks[0].title === '旧任务'
      && payload.tasks[0].executor?.name === 'worker-a',
    detail: payload === undefined
      ? 'no readable payload'
      : `tasks=${payload.tasks?.length ?? 'none'} title=${JSON.stringify(payload.tasks?.[0]?.title)} executor=${JSON.stringify(payload.tasks?.[0]?.executor?.name)}`,
  });

  const tree = second.taskTree.present === true ? second.taskTree.tree : undefined;
  const workline = tree?.workline ?? {};
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];
  const old = tasks.find((task) => task.id === 't1') ?? {};
  const fresh = tasks.find((task) => task.id === 't2') ?? {};
  result.push({
    label: 'the old ledger fields were not read back into the file',
    ok: workline.executions === undefined
      && workline.workers === undefined
      && workline.conflicts === undefined
      && workline.nextExecution === undefined
      && old.owner?.executionId === undefined,
    detail: `executions=${workline.executions === undefined ? 'gone' : 'present'} workers=${workline.workers === undefined ? 'gone' : 'present'} conflicts=${workline.conflicts === undefined ? 'gone' : 'present'} nextExecution=${workline.nextExecution === undefined ? 'gone' : 'present'} owner.executionId=${old.owner?.executionId === undefined ? 'gone' : 'present'}`,
  });
  result.push({
    label: 'the old goal and claim member survived the rewrite',
    ok: workline.goal?.original === '旧工作线的目标'
      && workline.id === sessionId
      && old.owner?.sessionId === 'worker-session'
      && old.owner?.member === 'worker-a',
    detail: `goal=${JSON.stringify(workline.goal?.original)} owner=${JSON.stringify(old.owner ?? null)}`,
  });
  result.push({
    label: 'the new step was created, completed and focused with the old task',
    ok: fresh.title === '旧任务下的新步骤'
      && fresh.status === 'done'
      && fresh.parentId === 't1'
      && Array.isArray(workline.focus)
      && workline.focus.length === 1
      && workline.focus[0] === 't1',
    detail: `step=${fresh.status ?? 'absent'} parent=${fresh.parentId ?? 'absent'} focus=${JSON.stringify(workline.focus ?? null)}`,
  });
  return result;
}
