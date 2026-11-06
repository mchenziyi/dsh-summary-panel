/**
 * Prove the task-tree artefact: a scripted session writes a real tree through
 * the plugin's own `task_tree_write` tool, and the harness finds the persisted
 * file on disk (not an echo of the tool's reply).
 */

export const name = 'tree-init';
export const summary = 'task_tree_write persists a tree the harness can export';
export const team = false;
export const prompt = 'Initialise the task tree for this workline with the task_tree_write tool.';
export const program = [
  {
    tool: 'task_tree_write',
    arguments: {
      ops: [{ op: 'init', originalGoal: 'Prove the harness can export a persisted task tree', outline: 'One scripted init call.' }],
    },
  },
  { text: 'tree initialised' },
];

export function verify({ artefacts, sessionId }) {
  const call = artefacts.toolResults.calls.find((candidate) => candidate.tool === 'task_tree_write');
  const result = [
    {
      label: 'the task_tree_write tool call completed',
      ok: call !== undefined && call.status === 'completed',
      detail: call === undefined ? 'no task_tree_write call in the run' : `status=${call.status}`,
    },
    {
      label: 'the plugin persisted a task tree file for the session workline',
      ok: artefacts.taskTree.present === true,
      detail: artefacts.taskTree.present === true ? artefacts.taskTree.path : artefacts.taskTree.reason,
    },
  ];
  if (artefacts.taskTree.present === true) {
    const tree = artefacts.taskTree.tree ?? {};
    result.push({
      label: 'the persisted file is the workline envelope keyed by the session id',
      ok: tree.version === 1 && tree.workline?.id === sessionId && Array.isArray(tree.tasks),
      detail: `version=${tree.version} workline=${tree.workline?.id ?? 'none'} tasks=${Array.isArray(tree.tasks) ? tree.tasks.length : 'none'}`,
    });
    result.push({
      label: 'the persisted goal is the scripted one',
      ok: tree.workline?.goal?.original === 'Prove the harness can export a persisted task tree',
      detail: JSON.stringify(tree.workline?.goal?.original),
    });
  }
  return result;
}
