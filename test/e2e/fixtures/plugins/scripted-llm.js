/**
 * Scripted model adapter for the real-process e2e harness.
 *
 * It registers the `scripted` provider on the real `llm` service, so the real
 * agent loop, real tool registry and real tools run exactly as they do with a
 * provider; only the model text/tool-calls come from `script.json` instead of
 * the network. One scripted response is consumed per ordinary model call;
 * auxiliary calls (session title, compaction) answer deterministically and do
 * not consume the program.
 *
 * The response shape is `{ tool, arguments }` for one tool call or `{ text }`
 * for a final answer. This is test infrastructure that exists only in the
 * throwaway profile — the product is untouched.
 *
 * Scenarios that drive a real subagent use three small extensions, all of them
 * model-side behaviour a real model performs by reading its own tool results:
 *
 * - `subagentResponses` gives the child session its own program, so the parent
 *   and child do not race over one shared queue.
 * - `{{subagentId}}` in a tool argument is replaced with the id the parent
 *   read from its latest `subagent` tool result (a model copies that id).
 * - `waitForSubagentTurns: n` holds the parent's next request until the child's
 *   session log contains n completed turns, which is the scripted form of
 *   polling `list_agents` until the child is inactive.
 *
 * A Team scenario needs named teammates, whose ids the model never sees. More
 * extensions cover that:
 *
 * - `teamResponses` maps a roster name to its own program, resolved through the
 *   live Agent Team membership of the calling session.
 * - `waitForTeammate: "<name>"` holds the Lead's next request until that
 *   teammate has completed one turn, resolved through `listMembers` (the roster
 *   is the same authority the product uses); `waitForTeammateTurns: { name,
 *   turns }` waits for a later turn of the same teammate.
 * - `waitForMemberStatus: { name, status: "running"|"inactive" }` holds the
 *   next request until the roster member's live Agent is in that state. A real
 *   model would poll `list_agents`; this scripted form removes the race from
 *   "interrupt a worker that is definitely still running" and "confirm it
 *   stopped".
 * - `holdMs: n` makes one model call take that long, the scripted form of a
 *   slow turn: the Agent really is running until the wait ends or the Lead
 *   interrupts it.
 */

import { readFileSync } from 'node:fs';

export const name = 'e2e-scripted-llm';
export const inject = ['llm'];

/** Chunks for one scripted response, in the adapter's raw streaming protocol. */
function chunksFor(response, serial, finishKind) {
  const start = { type: 'block-start', index: 0, blockType: finishKind === 'tool-calls' ? 'tool-call' : 'text' };
  const usage = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
  const finish = { type: 'finish', reason: { kind: finishKind } };
  if (finishKind === 'tool-calls') {
    const id = `call-${serial}`;
    const args = JSON.stringify(response.arguments ?? {});
    return [
      start,
      { type: 'tool-call-delta', index: 0, id, name: response.tool, argumentsDelta: args },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: response.tool, arguments: args } },
      usage,
      finish,
    ];
  }
  const text = typeof response.text === 'string' ? response.text : '';
  return [
    start,
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    usage,
    finish,
  ];
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The most recent subagent id a parent read from its own tool results. */
function lastSubagentId(messages) {
  const text = JSON.stringify(Array.isArray(messages) ? messages : []);
  const matches = [...text.matchAll(/started subagent ([A-Za-z0-9_-]+)/g)];
  return matches.length === 0 ? undefined : matches[matches.length - 1][1];
}

/** Replace the model-visible `{{subagentId}}` placeholder in one argument tree. */
function resolveArguments(value, messages) {
  const id = lastSubagentId(messages);
  if (typeof value === 'string') {
    if (value === '{{subagentId}}') return id ?? value;
    return id === undefined ? value : value.split('{{subagentId}}').join(id);
  }
  if (Array.isArray(value)) return value.map((entry) => resolveArguments(entry, messages));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveArguments(entry, messages);
    return out;
  }
  return value;
}

export function apply(ctx, config = {}) {
  if (typeof config.script !== 'string') throw new Error('e2e-scripted-llm needs config.script');
  const program = JSON.parse(readFileSync(config.script, 'utf8'));
  const leadQueue = Array.isArray(program.responses) ? [...program.responses] : [];
  const subagentQueue = Array.isArray(program.subagentResponses) ? [...program.subagentResponses] : undefined;
  const teamQueues = program.teamResponses !== null && typeof program.teamResponses === 'object'
    ? Object.fromEntries(Object.entries(program.teamResponses).map(([key, value]) => [key, Array.isArray(value) ? [...value] : []]))
    : undefined;
  let serial = 0;
  // Child sessions may already be disposed (or not yet live) when the parent
  // watches for their turn boundary, so their progress is counted from the
  // session events instead of the live registry.
  const turnEnds = new Map();
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end' || typeof session?.id !== 'string') return;
    turnEnds.set(session.id, (turnEnds.get(session.id) ?? 0) + 1);
  });

  /** The live session behind one request, when the registry already knows it. */
  function sessionOf(sessionId) {
    if (typeof sessionId !== 'string') return undefined;
    try {
      return ctx.get('sessions')?.get?.(sessionId);
    } catch {
      return undefined;
    }
  }

  /** Whether this request belongs to a subagent (it has its own program). */
  function isSubagentRequest(options) {
    const header = sessionOf(options?.sessionId)?.header;
    return header !== undefined && header !== null && header.origin === 'subagent';
  }

  /** The roster membership of one calling session, when it is a Team member. */
  function teamMembershipOf(options) {
    try {
      const agent = agentsOf().get?.(options?.sessionId);
      const teams = ctx.get('agentTeams');
      return agent === undefined ? undefined : teams?.tryMembership?.(agent);
    } catch {
      return undefined;
    }
  }

  function agentsOf() {
    try {
      return ctx.get('agents') ?? {};
    } catch {
      return {};
    }
  }

  /** The roster id of one named teammate, resolved through the Lead's roster. */
  async function rosterMemberId(name, options) {
    const deadline = Date.now() + 40_000;
    while (true) {
      try {
        const lead = agentsOf().get?.(options?.sessionId);
        const teams = ctx.get('agentTeams');
        const row = teams?.listMembers?.(lead)?.find?.((member) => member.name === name);
        if (typeof row?.id === 'string' && row.id !== '') return row.id;
      } catch {
        /* the roster may not be published yet */
      }
      if (Date.now() > deadline) throw new Error(`scripted wait: teammate ${JSON.stringify(name)} never joined the roster`);
      await delay(20);
    }
  }

  /** Hold until one named teammate has completed `turns` turn(s). */
  async function waitForTeammateTurns(name, turns, options) {
    const memberId = await rosterMemberId(name, options);
    const deadline = Date.now() + 40_000;
    while (turnEndsOf(memberId) < turns) {
      if (Date.now() > deadline) {
        throw new Error(`scripted wait: teammate ${JSON.stringify(name)} did not finish ${turns} turn(s) in 40s`);
      }
      await delay(20);
    }
  }

  /** Completed turns of one named teammate, resolved through the Team roster. */
  async function waitForTeammateTurn(name, options) {
    await waitForTeammateTurns(name, 1, options);
  }

  /** Hold until the named teammate's live Agent is running or inactive. */
  async function waitForMemberStatus(name, status, options) {
    const memberId = await rosterMemberId(name, options);
    const deadline = Date.now() + 40_000;
    const wantRunning = status === 'running';
    while (true) {
      const running = agentsOf().get?.(memberId)?.status === 'running';
      if (running === wantRunning) return;
      if (Date.now() > deadline) {
        throw new Error(`scripted wait: teammate ${JSON.stringify(name)} never became ${status} in 40s`);
      }
      await delay(20);
    }
  }

  /** Completed turns seen for one child session. */
  function turnEndsOf(sessionId) {
    return turnEnds.get(sessionId) ?? 0;
  }

  async function waitForSubagentTurns(turns, options) {
    const childId = lastSubagentId(options?.messages);
    if (childId === undefined) throw new Error('scripted wait: the conversation names no subagent id');
    const deadline = Date.now() + 30_000;
    while (turnEndsOf(childId) < turns) {
      if (Date.now() > deadline) {
        throw new Error(`scripted wait: subagent ${childId} did not finish ${turns} turn(s) in 30s`);
      }
      await delay(20);
    }
  }

  const adapter = {
    providerInfo: (provider) => ({ id: provider, name: 'Scripted (e2e)' }),
    providerRetryPolicy: () => undefined,
    async listModels(provider) {
      return [{ provider, id: 'scripted-1', name: 'scripted-1' }];
    },
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    },
    async prepareCall(provider, model) {
      return { model: { provider, id: model, name: model }, stream: (options) => adapter.stream(options) };
    },
    stream(options) {
      serial += 1;
      const subagent = isSubagentRequest(options);
      const membership = subagent ? teamMembershipOf(options) : undefined;
      const teammateName = membership?.role === 'teammate' ? membership.name : undefined;
      const teamQueue = teammateName === undefined ? undefined : teamQueues?.[teammateName];
      const queue = teamQueue ?? (subagent && subagentQueue !== undefined ? subagentQueue : leadQueue);
      const response = options?.purpose === 'session-title'
        ? { text: 'e2e session' }
        : (queue.length > 0 ? queue.shift() : { text: '[e2e script exhausted]' });
      const finishKind = typeof response.tool === 'string' ? 'tool-calls' : 'stop';
      const enriched = typeof response.tool === 'string'
        ? { ...response, arguments: resolveArguments(response.arguments ?? {}, options?.messages) }
        : response;
      return (async function* stream() {
        if (Number.isInteger(response.waitForSubagentTurns)) {
          await waitForSubagentTurns(response.waitForSubagentTurns, options);
        }
        if (typeof response.waitForTeammate === 'string') {
          await waitForTeammateTurn(response.waitForTeammate, options);
        }
        if (Number.isInteger(response.holdMs) && response.holdMs > 0) {
          await delay(Math.min(response.holdMs, 60_000));
        }
        if (Number.isInteger(response.waitForTeammateTurns?.turns)
          && typeof response.waitForTeammateTurns?.name === 'string') {
          await waitForTeammateTurns(response.waitForTeammateTurns.name, response.waitForTeammateTurns.turns, options);
        }
        if (typeof response.waitForMemberStatus?.name === 'string'
          && (response.waitForMemberStatus.status === 'running' || response.waitForMemberStatus.status === 'inactive')) {
          await waitForMemberStatus(response.waitForMemberStatus.name, response.waitForMemberStatus.status, options);
        }
        for (const chunk of chunksFor(enriched, serial, finishKind)) yield chunk;
      })();
    },
  };
  ctx.effect(() => ctx.llm.registerAdapter(['scripted'], adapter));
}
