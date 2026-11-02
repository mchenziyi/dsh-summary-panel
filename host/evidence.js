/**
 * Real user evidence: the messages a person actually typed, and the
 * verification of a quoted basis against them.
 *
 * A session log mixes human messages with host-injected context (runtime-context
 * snapshots, the skill catalogue, time samples, goal continuations, subagent
 * notices, ...). Every injected message carries its own `source.kind`, so
 * `source.kind === "user"` is the strongest provenance signal the harness
 * exposes to a plugin: it marks the prompt a client submitted.
 *
 * This module is deliberately small and side-effect free. It never decides what
 * to write; it only answers "did a real user message say this?".
 */

/** Longest accepted quote, matching `LIMITS.basis` in `host/model.js`. */
export const MAX_BASIS = 200;

/** How many trailing events a scan looks at. */
const SCAN_LIMIT = 1000;

/** Text of one message's text blocks. */
function contentText(content) {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

/**
 * The text a human submitted through one event, or `''` when the event is not a
 * real user message.
 * @param event - a `user/message` event from `session.snapshotEvents()`.
 */
export function userMessageText(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'user/message') return '';
  const source = event.data?.source;
  if (source === null || typeof source !== 'object' || source.kind !== 'user') return '';
  const text = contentText(event.data?.content).trim();
  if (text === '') return '';
  // Belt and braces: earlier builds identified injected context by its prefix.
  if (text.startsWith('Current runtime context')) return '';
  if (text.startsWith('<system-reminder>')) return '';
  return text;
}

/**
 * Every real user message in the trailing window, oldest first.
 * @param session - the assembling agent's session.
 * @param limit - how many trailing events to scan.
 */
export function realUserMessages(session, limit = SCAN_LIMIT) {
  if (session === null || typeof session !== 'object' || typeof session.snapshotEvents !== 'function') return [];
  const end = Number(session.seq) || 0;
  let events;
  try {
    events = session.snapshotEvents(Math.max(0, end - limit));
  } catch {
    return [];
  }
  if (!Array.isArray(events)) return [];
  const rows = [];
  for (const event of events) {
    const text = userMessageText(event);
    if (text === '') continue;
    rows.push({ seq: Number(event.seq) || 0, time: Number(event.time) || 0, text });
  }
  return rows;
}

/**
 * Comparison form for quotes and messages: every run of whitespace is dropped,
 * so a quote copied across a line break still matches the user's sentence.
 */
function normalize(text) {
  return String(text).replace(/\s+/g, '');
}

/**
 * Whether `quote` appears verbatim (ignoring whitespace) in a real user message.
 *
 * This is a provenance check, not a permission system: it can prove that the
 * user wrote the quoted words, not that those words meant what the agent claims.
 *
 * @param session - the assembling agent's session.
 * @param quote - the agent-supplied basis, e.g. the user's instruction.
 * @returns `{ ok: true, seq, time }` or `{ ok: false, reason }`; `time` lets the
 *   caller reject a quote the user said before the work existed.
 */
export function verifyUserQuote(session, quote) {
  const raw = typeof quote === 'string' ? quote.trim() : '';
  if (raw === '') return { ok: false, reason: 'the quote is empty' };
  if (Array.from(raw).length > MAX_BASIS) {
    return { ok: false, reason: `the quote is longer than ${MAX_BASIS} characters` };
  }
  const needle = normalize(raw);
  const messages = realUserMessages(session);
  if (messages.length === 0) return { ok: false, reason: 'no user message is available to compare against' };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (normalize(messages[index].text).includes(needle)) {
      return { ok: true, seq: messages[index].seq, time: messages[index].time };
    }
  }
  return { ok: false, reason: 'the quote does not appear in any user message' };
}

/**
 * The newest request and the newest tree write in the session tail.
 *
 * The newest request is the later of the newest real user message and the newest
 * `turn/start`: the harness commits the user message while it assembles the first
 * request of a turn, so a prompt evaluated from the committed log alone would
 * still see the previous turn's message. `turn/start` is committed before that.
 */
export function latestRequestAndWrite(session) {
  const end = Number(session?.seq) || 0;
  const events = session.snapshotEvents(Math.max(0, end - 80));
  let lastUser = -1;
  let lastWrite = -1;
  let lastTurnStart = -1;
  for (const event of events) {
    if (event.type === 'user/message') {
      // Host-injected runtime context, skill reminders, and teammate notices are
      // not typed by the user; only a real request should trigger the reminder.
      if (userMessageText(event) === '') continue;
      lastUser = Math.max(lastUser, Number(event.seq));
    } else if (event.type === 'turn/start') {
      lastTurnStart = Math.max(lastTurnStart, Number(event.seq));
    } else if (event.type === 'tool/call' && event.data?.name === 'task_tree_write') {
      lastWrite = Math.max(lastWrite, Number(event.seq));
    }
  }
  return { lastUser, lastTurnStart, lastWrite, lastRequest: Math.max(lastUser, lastTurnStart) };
}
