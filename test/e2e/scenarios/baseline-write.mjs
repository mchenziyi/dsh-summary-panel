/**
 * Baseline proof: an agent can change the workspace without a task tree.
 *
 * The panel is a dashboard, not a brake (ADR-0003). Nothing may refuse a tool
 * call before it runs, so the shipped `write` tool is called for real on a
 * workline that has no persisted tree, and it must succeed: the file lands on
 * disk, no task tree appears behind it, and the run ends normally.
 *
 * This is the reverse proof that keeps the removed gate from coming back: if a
 * future change reintroduces a pre-execution refusal, the most basic workspace
 * write in the suite turns red.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'baseline-write';
export const summary = 'No task tree: the write tool succeeds, and the file lands';
export const team = false;
export const prompt = 'Write baseline.txt with the write tool, then say what you did.';
export const program = [
  { tool: 'write', arguments: { file_path: 'baseline.txt', content: 'landed without a task tree\n' } },
  { text: 'wrote baseline.txt' },
];

export async function verify({ artefacts, workdir }) {
  const writeCall = artefacts.toolResults.calls.find((call) => call.tool === 'write');
  const result = [];
  result.push({
    label: 'the write tool call completed',
    ok: writeCall !== undefined && writeCall.status === 'completed',
    detail: writeCall === undefined ? 'no write tool call in the run' : `status=${writeCall.status}`,
  });
  let content;
  try {
    content = await readFile(join(workdir, 'baseline.txt'), 'utf8');
  } catch {
    content = undefined;
  }
  result.push({
    label: 'the write landed on disk without a claim',
    ok: content === 'landed without a task tree\n',
    detail: content === undefined ? 'baseline.txt is absent' : `baseline.txt holds ${JSON.stringify(content)}`,
  });
  result.push({
    label: 'the write created no task tree of its own',
    ok: artefacts.taskTree.present === false,
    detail: artefacts.taskTree.present === true ? `unexpected tree at ${artefacts.taskTree.path}` : artefacts.taskTree.reason ?? 'absent',
  });
  result.push({
    label: 'the run ended with the scripted final text',
    ok: artefacts.toolResults.finalText === 'wrote baseline.txt',
    detail: JSON.stringify(artefacts.toolResults.finalText),
  });
  return result;
}
