/**
 * Concurrency probe for the execution-seat scenario (ticket #9).
 *
 * The real agent loop dispatches a tool that does not declare itself
 * concurrency-safe one call at a time, and two scripted agents' turns are
 * ordered by the scenario, so a purely model-driven run cannot produce two
 * tool calls that are truly in flight at the same instant. Two claims racing
 * for one seat cannot be observed that way.
 *
 * This fixture closes that gap without touching the product: its body calls the
 * real `tools.execute` pipeline twice without awaiting, so both calls pass the
 * real pre-execute policy, the real monotonic guard, the real tool body, the
 * real store and the real Team board at the same time. Each inner call carries
 * the live Agent named by the scenario, so the Host resolves the caller's
 * identity exactly as it does for a model-issued call.
 *
 * It is test infrastructure of the throwaway profile only: the tool name starts
 * with `team_task_` because the guard classifies tools by name and this probe
 * must be callable by a Lead in team mode (class B), where class A is refused.
 */

export const name = 'e2e-seat-race-probe';
export const inject = ['tools'];


/** The probe's model-facing name; class B by the guard's name table. */
const TOOL_NAME = 'team_task_race';

const PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['calls'],
  properties: {
    calls: {
      type: 'array',
      description: 'Tool calls to dispatch at the same instant; each one runs with the named live Agent.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tool', 'arguments'],
        properties: {
          tool: { type: 'string', description: 'Registered tool name to execute.' },
          member: { type: 'string', description: 'Team roster name whose live Agent must run the call.' },
          sessionId: { type: 'string', description: 'Exact live session id whose Agent must run the call.' },
          arguments: { type: 'object', additionalProperties: true, description: 'Arguments for that tool.' },
        },
      },
    },
  },
});

const OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'tool', 'ok', 'text'],
        properties: {
          index: { type: 'integer' },
          tool: { type: 'string' },
          ok: { type: 'boolean' },
          text: { type: 'string' },
          agent: { type: 'string' },
          unresolved: { type: 'boolean' },
        },
      },
    },
  },
});

/** Flatten one materialized tool result's model-visible text. */
function resultText(result) {
  const blocks = result !== null && typeof result === 'object' && Array.isArray(result.content) ? result.content : [];
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function liveAgents(ctx) {
  const agents = ctx.get('agents');
  if (agents === undefined) return [];
  if (typeof agents.list === 'function') {
    const list = agents.list();
    if (Array.isArray(list)) return list;
  }
  return [];
}

/** The live Agent for one exact id, or undefined when it is not live any more. */
function liveAgentById(ctx, id) {
  if (typeof id !== 'string' || id === '') return undefined;
  const agents = ctx.get('agents');
  let agent;
  try {
    agent = typeof agents?.get === 'function' ? agents.get(id) : undefined;
  } catch {
    agent = undefined;
  }
  if (agent !== undefined) return agent;
  return liveAgents(ctx).find((candidate) => candidate.id === id || candidate.session?.id === id);
}

/** The root session id of one live Agent's own session chain. */
function rootSessionOf(ctx, agent) {
  let header = agent?.session?.header;
  let currentId = typeof header?.id === 'string' ? header.id : (typeof agent?.id === 'string' ? agent.id : undefined);
  const sessionId = currentId;
  for (let depth = 0; depth < 50; depth += 1) {
    const parent = typeof header?.parentSession === 'string' ? header.parentSession : '';
    if (parent === '' || parent === currentId) return currentId;
    currentId = parent;
    try {
      header = ctx.get('sessions')?.get?.(parent)?.header;
    } catch {
      return currentId;
    }
    if (header === undefined) return currentId;
  }
  return currentId ?? sessionId;
}

/** The Lead's live Agent, resolved through the roster or the caller's session root. */
function leadAgentFor(ctx, caller) {
  try {
    const row = ctx.get('agentTeams')?.listMembers?.(caller)?.find?.((candidate) => candidate.role === 'lead');
    if (row?.id !== undefined) {
      const byRoster = liveAgentById(ctx, row.id);
      if (byRoster !== undefined) return byRoster;
    }
  } catch {
    /* a standard profile has no roster */
  }
  return liveAgentById(ctx, rootSessionOf(ctx, caller));
}

/** Resolve one probe spec to a live Agent, never to a model-supplied identity. */
function agentFor(ctx, spec, caller) {
  const bySession = typeof spec?.sessionId === 'string' && spec.sessionId !== '' ? spec.sessionId : undefined;
  if (bySession !== undefined) {
    const agent = liveAgentById(ctx, bySession);
    return agent === undefined ? { agent: undefined, unresolved: true } : { agent };
  }
  const member = typeof spec?.member === 'string' && spec.member !== '' ? spec.member : undefined;
  if (member === undefined) return { agent: caller };
  if (member === 'lead') {
    const agent = leadAgentFor(ctx, caller);
    return agent === undefined ? { agent: undefined, unresolved: true } : { agent };
  }
  let memberId;
  try {
    const teams = ctx.get('agentTeams');
    const row = teams?.listMembers?.(caller)?.find?.((candidate) => candidate.name === member);
    memberId = row?.id;
  } catch {
    memberId = undefined;
  }
  const agent = liveAgentById(ctx, memberId);
  return agent === undefined ? { agent: undefined, unresolved: true } : { agent };
}

export function apply(ctx) {
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.register !== 'function' || typeof tools.execute !== 'function') return;

  const probe = {
    name: TOOL_NAME,
    description: 'Harness probe: run two or more real tool calls at the same instant and report every result. Test infrastructure of the e2e profile only.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT,
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }];
      },
    },
    async execute(args, exec) {
      const calls = Array.isArray(args?.calls) ? args.calls : [];
      const results = await Promise.all(calls.map(async (spec, index) => {
        const resolved = agentFor(ctx, spec, exec.agent);
        const row = { index, tool: String(spec?.tool ?? '') };
        if (resolved.unresolved === true || resolved.agent === undefined) {
          return { ...row, ok: false, text: `the probe could not resolve a live Agent for call ${index}`, unresolved: true };
        }
        row.agent = typeof resolved.agent.id === 'string' ? resolved.agent.id : undefined;
        try {
          const outcome = await tools.execute({
            callId: `${String(exec.callId)}:race-${index}`,
            name: row.tool,
            arguments: spec?.arguments ?? {},
            agent: resolved.agent,
            signal: exec.signal,
          });
          return { ...row, ok: outcome?.isError !== true, text: resultText(outcome) };
        } catch (error) {
          return { ...row, ok: false, text: String(error?.message ?? error) };
        }
      }));
      return { results };
    },
  };

  ctx.effect(() => tools.register(probe), 'e2e-seat-race-probe');
}
