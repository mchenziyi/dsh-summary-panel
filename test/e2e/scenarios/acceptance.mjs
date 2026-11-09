/**
 * Acceptance proof: a delivered requirement cannot be closed by the agent, and
 * closing it later needs the user's own words.
 *
 * Two real sessions over one workline. The first creates a delivered task,
 * starts it with the user's instruction, and tries to complete it: the write is
 * rejected because a top-level task requires the user's acceptance, so the task
 * stays in progress. The second session is the user saying they accepted it; the
 * completion then carries `completion: "user-confirmed"` and the quoted words.
 */

const CREATE_LOGIN = {
  tool: 'task_tree_write',
  arguments: {
    ops: [{
      op: 'create',
      title: '登录功能',
      executionApproval: 'approved',
      approvalBasis: '开始吧',
      status: 'in_progress',
    }],
  },
};

export const name = 'acceptance';
export const summary = 'A delivered task cannot self-complete; the user\'s second turn closes it';
export const runs = [
  {
    prompt: '帮我实现登录模块，开始吧。',
    program: [
      { tool: 'task_tree_write', arguments: { ops: [{ op: 'init', originalGoal: '完成基础登录功能' }] } },
      CREATE_LOGIN,
      { tool: 'task_tree_write', arguments: { ops: [{ op: 'complete', id: 't1' }] } },
      { text: '开发与测试已完成，登录功能等待你验收。' },
    ],
  },
  {
    resume: true,
    prompt: '登录功能我验收通过了。',
    program: [
      // First a quote the user never said: the completion must be refused.
      {
        tool: 'task_tree_write',
        arguments: {
          ops: [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '用户已经同意了' }],
        },
      },
      {
        tool: 'task_tree_write',
        arguments: {
          ops: [{ op: 'complete', id: 't1', confirmedByUser: true, confirmationBasis: '我验收通过了' }],
        },
      },
      { text: '已记录你的验收。' },
    ],
  },
];

/** The last task_tree_write call whose batch carries `op`. */
function writeCall(artefacts, op) {
  return [...artefacts.toolResults.calls].reverse().find((call) => call.tool === 'task_tree_write'
    && Array.isArray(call.input?.ops)
    && call.input.ops.some((entry) => entry?.op === op));
}

export function verify({ runs }) {
  const first = runs[0]?.artefacts;
  const second = runs[1]?.artefacts;
  const result = [];
  if (first === undefined || second === undefined) {
    return [{ label: 'both scripted sessions ran', ok: false, detail: `${runs.length} run(s) recorded` }];
  }

  const refused = writeCall(first, 'complete');
  result.push({
    label: 'the agent\'s own completion was refused',
    ok: refused !== undefined && refused.status === 'error',
    detail: refused === undefined ? 'no complete call in run 1' : `status=${refused.status} result=${JSON.stringify(String(refused.result ?? '').slice(0, 200))}`,
  });
  const afterFirst = first.taskTree.present === true ? first.taskTree.tree.tasks ?? [] : [];
  result.push({
    label: 'the delivered task is still in progress after the refusal',
    ok: afterFirst.length === 1 && afterFirst[0].status === 'in_progress' && (afterFirst[0].completion ?? null) === null,
    detail: afterFirst.length === 0 ? 'no task on disk' : `status=${afterFirst[0].status} completion=${afterFirst[0].completion ?? 'null'}`,
  });

  const fabricated = second.toolResults.calls.find((call) => call.tool === 'task_tree_write'
    && Array.isArray(call.input?.ops)
    && call.input.ops.some((entry) => entry?.op === 'complete' && entry.confirmationBasis === '用户已经同意了'));
  result.push({
    label: 'a quote the user never said cannot close the task',
    ok: fabricated !== undefined
      && fabricated.status === 'error'
      && String(fabricated.result ?? '').includes('does not appear in a user message'),
    detail: fabricated === undefined ? 'no fabricated-quote call' : `status=${fabricated.status} result=${JSON.stringify(String(fabricated.result ?? '').slice(0, 200))}`,
  });

  const accepted = writeCall(second, 'complete');
  result.push({
    label: 'the user\'s acceptance completed the task',
    ok: accepted !== undefined && accepted.status === 'completed',
    detail: accepted === undefined ? 'no complete call in run 2' : `status=${accepted.status} result=${JSON.stringify(String(accepted.result ?? '').slice(0, 200))}`,
  });
  const afterSecond = second.taskTree.present === true ? second.taskTree.tree.tasks ?? [] : [];
  const login = afterSecond.find((task) => task.id === 't1');
  result.push({
    label: 'the persisted task records the user\'s acceptance and the quoted words',
    ok: login !== undefined
      && login.status === 'done'
      && login.completion === 'user-confirmed'
      && login.completionBasis === '我验收通过了',
    detail: login === undefined
      ? 'task t1 is absent'
      : `status=${login.status} completion=${login.completion ?? 'null'} basis=${JSON.stringify(login.completionBasis ?? null)}`,
  });
  return result;
}
