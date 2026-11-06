/**
 * Record every session's tool calls and their real results while the run is
 * alive.
 *
 * The harness only projects the root session's events, and a completed
 * subagent's conversation is not part of the parent's stream. The execution
 * seat is exercised by a real subagent, so its refusals must be observed where
 * they happened: this fixture follows `session/event` for every session and
 * writes one row per call, exactly as the tool returned it.
 *
 * It also carries each session's header, which is how a scenario proves the
 * refusals belong to the subagent and not to the lead.
 */

import { writeFileSync } from 'node:fs';

export const name = 'e2e-tool-transcript';

/** Flatten a tool result message's model-visible text blocks. */
function resultText(message) {
  const blocks = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function apply(ctx, config = {}) {
  const sessions = new Map();
  const write = () => {
    try {
      writeFileSync(config.out, `${JSON.stringify([...sessions.values()], null, 2)}\n`);
    } catch {
      /* the transcript must never break the run */
    }
  };
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    if (typeof id !== 'string' || event === null || typeof event !== 'object') return;
    let record = sessions.get(id);
    if (record === undefined) {
      record = { sessionId: id, header: session.header ?? null, calls: [] };
      sessions.set(id, record);
    }
    const data = event.data ?? {};
    if (event.type === 'tool/call') {
      let input;
      try {
        input = JSON.parse(data.arguments);
      } catch {
        input = data.arguments;
      }
      record.calls.push({
        callId: data.callId,
        tool: data.name,
        input,
        status: 'unanswered',
        result: undefined,
      });
    } else if (event.type === 'tool/result') {
      const message = data.message ?? {};
      const callId = message.toolCallId;
      const call = record.calls.find((candidate) => candidate.callId === callId)
        ?? record.calls.find((candidate) => candidate.status === 'unanswered');
      if (call !== undefined) {
        call.status = message.isError === true ? 'error' : 'completed';
        call.result = resultText(message);
        if (data.error !== undefined) call.error = data.error;
      }
    }
    if (event.type === 'tool/result' || event.type === 'turn/end') write();
  });
}
