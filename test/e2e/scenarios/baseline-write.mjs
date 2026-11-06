/**
 * Baseline proof for the harness itself: in a session with NO task tree, a
 * file-writing tool is not constrained by anything and succeeds.
 *
 * This asserts the harness can observe the unconstrained baseline — the run
 * really executes the shipped `write` tool, the tool really reports
 * `completed`, the file really lands on disk, and no task tree was persisted.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'baseline-write';
export const summary = 'No task tree: the write tool succeeds, unconstrained';
export const team = false;
export const prompt = 'Write baseline.txt with the write tool, then say what you did.';
export const program = [
  { tool: 'write', arguments: { file_path: 'baseline.txt', content: 'unconstrained baseline\n' } },
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
  } catch (error) {
    content = undefined;
    result.push({ label: 'baseline.txt exists in the session workspace', ok: false, detail: String(error?.message ?? error) });
  }
  if (content !== undefined) {
    result.push({
      label: 'baseline.txt exists with the scripted content',
      ok: content === 'unconstrained baseline\n',
      detail: `${Buffer.byteLength(content)} bytes`,
    });
  }
  result.push({
    label: 'no task tree was persisted (the unconstrained baseline)',
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
