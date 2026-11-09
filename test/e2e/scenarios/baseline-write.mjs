/**
 * Baseline proof, inverted: a session with NO task tree cannot write at all.
 *
 * Every class A tool needs an active execution, and an execution only exists
 * after a claim, which needs a task, which needs a tree. A workline with no
 * persisted tree therefore has nothing to grant and must refuse — the absent
 * tree is not permission.
 *
 * This stays the most basic counter-example in the suite: the shipped `write`
 * tool is called for real, it reports an error, nothing lands on disk, and no
 * tree appears behind the refusal. The refusal has to teach the bootstrap
 * sequence (init -> create -> claim), because the model cannot reach `claim`
 * without being told that a tree comes first.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'baseline-write';
export const summary = 'No task tree: the write tool is refused, and nothing lands';
export const team = false;
export const prompt = 'Write baseline.txt with the write tool, then say what you did.';
export const program = [
  { tool: 'write', arguments: { file_path: 'baseline.txt', content: 'must not land\n' } },
  { text: 'refused: this workline has no execution' },
];

export async function verify({ artefacts, workdir }) {
  const writeCall = artefacts.toolResults.calls.find((call) => call.tool === 'write');
  const result = [];
  result.push({
    label: 'the write tool call was refused',
    ok: writeCall !== undefined && writeCall.status === 'error',
    detail: writeCall === undefined ? 'no write tool call in the run' : `status=${writeCall.status}`,
  });
  const reason = typeof writeCall?.result === 'string' ? writeCall.result : '';
  result.push({
    label: 'the refusal says class A needs an active execution',
    ok: reason.includes('class A') && reason.includes('no active execution'),
    detail: writeCall === undefined ? 'no write tool call in the run' : JSON.stringify(writeCall.result),
  });
  // The model has to be able to walk out of the refusal on its own: a workline
  // with no tree has nothing to claim, so the reason must name the whole
  // bootstrap path, not just "claim a task".
  result.push({
    label: 'the refusal names the bootstrap path (init, create, claim)',
    ok: reason.includes('no task tree') && reason.includes('init') && reason.includes('create') && reason.includes('claim'),
    detail: writeCall === undefined ? 'no write tool call in the run' : JSON.stringify(writeCall.result),
  });
  let content;
  try {
    content = await readFile(join(workdir, 'baseline.txt'), 'utf8');
  } catch {
    content = undefined;
  }
  result.push({
    label: 'nothing landed on disk (denied before any side effect)',
    ok: content === undefined,
    detail: content === undefined ? 'baseline.txt is absent' : `baseline.txt holds ${JSON.stringify(content)}`,
  });
  result.push({
    label: 'the refusal created no task tree of its own',
    ok: artefacts.taskTree.present === false,
    detail: artefacts.taskTree.present === true ? `unexpected tree at ${artefacts.taskTree.path}` : artefacts.taskTree.reason ?? 'absent',
  });
  result.push({
    label: 'the run ended with the scripted final text',
    ok: artefacts.toolResults.finalText === 'refused: this workline has no execution',
    detail: JSON.stringify(artefacts.toolResults.finalText),
  });
  return result;
}
