/**
 * Export the three facts the harness exists to observe:
 *
 *   tool-results.json  what the tools actually returned (from the run's NDJSON)
 *   task-tree.json     the task tree file the plugin persisted on disk
 *   team-board.json    the live Team board, when the profile composes one
 *
 * Every artefact is written under `<root>/out` even when absent, so a caller
 * never has to guess whether "missing" means "not produced" or "not collected".
 * Absent artefacts carry an explicit `present: false` and a reason.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Pair `tool_call` projection events with the `tool_result` that answered them. */
function collectToolCalls(events) {
  const byCall = new Map();
  for (const event of events) {
    if (event?.type === 'tool_call') {
      byCall.set(event.callId, { callId: event.callId, tool: event.tool, input: event.input, status: 'unanswered', result: undefined });
    } else if (event?.type === 'tool_result') {
      const call = byCall.get(event.callId);
      if (call === undefined) {
        byCall.set(event.callId, { callId: event.callId, tool: undefined, input: undefined, status: event.status, result: event.result });
        continue;
      }
      call.status = event.status;
      call.result = event.result;
    }
  }
  const final = events.find((event) => event?.type === 'final');
  return { calls: [...byCall.values()], finalText: typeof final?.text === 'string' ? final.text : undefined };
}

/** Read the persisted task tree for one workline, if the run created one. */
async function collectTaskTree({ taskTreeDir, sessionId }) {
  const attempted = sessionId === undefined ? [] : [join(taskTreeDir, `${sessionId}.json`)];
  for (const path of attempted) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    try {
      return { present: true, path, tree: JSON.parse(text) };
    } catch (error) {
      return { present: true, path, parseError: String(error?.message ?? error), raw: text };
    }
  }
  let files = [];
  try {
    files = (await readdir(taskTreeDir)).filter((name) => name.endsWith('.json'));
  } catch {
    /* no directory means no tree */
  }
  return {
    present: false,
    reason: sessionId === undefined ? 'the run reported no session id' : `no task tree file for session ${sessionId}`,
    directory: taskTreeDir,
    files,
  };
}

/** Read the fixture probe's last board snapshot, or explain why there is none. */
async function collectTeamBoard({ teamBoardPath, team }) {
  let text;
  try {
    text = await readFile(teamBoardPath, 'utf8');
  } catch {
    return {
      present: false,
      reason: team ? 'the team probe wrote no snapshot (no turn ended, or the probe failed)' : 'the profile composes no Agent Team',
    };
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return { present: false, reason: `the team probe wrote unparseable JSON: ${String(error?.message ?? error)}`, raw: text };
  }
}

/**
 * Write every artefact under `outDir`.
 * @returns the artefact bundle, also written as `run.jsonl` and `stderr.log`.
 */
export async function collectArtefacts({ outDir, run, taskTreeDir, teamBoardPath, team }) {
  await mkdir(outDir, { recursive: true });
  const tools = collectToolCalls(run.events);
  const taskTree = await collectTaskTree({ taskTreeDir, sessionId: run.sessionId });
  const teamBoard = await collectTeamBoard({ teamBoardPath, team });
  const artefacts = {
    run: {
      sessionId: run.sessionId,
      cwd: run.events.find((event) => event?.type === 'session')?.cwd,
      status: run.status,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      eventCount: run.events.length,
      unparsedLines: run.unparsed,
      finalText: tools.finalText,
    },
    toolResults: { sessionId: run.sessionId, calls: tools.calls, finalText: tools.finalText },
    taskTree,
    teamBoard,
  };
  await Promise.all([
    writeFile(join(outDir, 'tool-results.json'), `${JSON.stringify(artefacts.toolResults, null, 2)}\n`),
    writeFile(join(outDir, 'task-tree.json'), `${JSON.stringify(artefacts.taskTree, null, 2)}\n`),
    writeFile(join(outDir, 'team-board.json'), `${JSON.stringify(artefacts.teamBoard, null, 2)}\n`),
    writeFile(join(outDir, 'run.json'), `${JSON.stringify(artefacts.run, null, 2)}\n`),
    writeFile(join(outDir, 'run.jsonl'), run.stdout),
    writeFile(join(outDir, 'stderr.log'), run.stderr),
  ]);
  return artefacts;
}
