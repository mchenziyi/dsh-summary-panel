/**
 * The reverse proof: workspace changes need no task tree and no claim.
 *
 * The panel is a dashboard, not a brake (ADR-0003). Nothing may refuse a tool
 * call before it runs, so a session with no persisted tree writes a file and
 * then runs a shell command, and both must succeed: the file lands, the shell
 * output is real, no tree appears behind them, and the run ends normally.
 *
 * If a future change reintroduces a pre-execution refusal, the most basic
 * workspace write in the suite turns red.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'no-gate';
export const summary = 'No task tree and no claim: write and shell both succeed';
export const prompt = 'Write no-gate.txt with the write tool, then run a shell command that appends to it.';
export const program = [
  { tool: 'write', arguments: { file_path: 'no-gate.txt', content: 'written without a task tree\n' } },
  { tool: 'bash', arguments: { command: 'echo shell-ok >> no-gate.txt', description: 'append a line to no-gate.txt' } },
  { text: 'wrote and appended without any task tree' },
];

export async function verify({ artefacts, workdir }) {
  const calls = artefacts.toolResults.calls;
  const writeCall = calls.find((call) => call.tool === 'write');
  const shellCall = calls.find((call) => call.tool === 'bash');
  const result = [
    {
      label: 'the write tool call completed with no tree',
      ok: writeCall !== undefined && writeCall.status === 'completed',
      detail: writeCall === undefined ? 'no write tool call in the run' : `status=${writeCall.status}`,
    },
    {
      label: 'the shell tool call completed with no claim',
      ok: shellCall !== undefined && shellCall.status === 'completed',
      detail: shellCall === undefined
        ? 'no bash tool call in the run'
        : `status=${shellCall.status}${typeof shellCall.result === 'string' ? ` result=${JSON.stringify(shellCall.result.slice(0, 200))}` : ''}`,
    },
  ];
  let content;
  try {
    content = await readFile(join(workdir, 'no-gate.txt'), 'utf8');
  } catch {
    content = undefined;
  }
  result.push({
    label: 'both changes landed on disk',
    ok: content === 'written without a task tree\nshell-ok\n',
    detail: content === undefined ? 'no-gate.txt is absent' : `no-gate.txt holds ${JSON.stringify(content)}`,
  });
  result.push({
    label: 'the session created no task tree of its own',
    ok: artefacts.taskTree.present === false,
    detail: artefacts.taskTree.present === true ? `unexpected tree at ${artefacts.taskTree.path}` : artefacts.taskTree.reason ?? 'absent',
  });
  result.push({
    label: 'the run ended with the scripted final text',
    ok: artefacts.toolResults.finalText === 'wrote and appended without any task tree',
    detail: JSON.stringify(artefacts.toolResults.finalText),
  });
  return result;
}
