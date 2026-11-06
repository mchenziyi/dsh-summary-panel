/**
 * Class-A probe tools for the team-mode scenario.
 *
 * The headless team profile does not register every class A tool the design
 * names: `tool-subagent` is replaced by the Team tools, `ralph` is disabled in
 * the base bundle, and terminal/worktree tools belong to the Web and harness
 * compositions. The guard classifies by NAME and defaults to deny, so this
 * fixture registers tools under those exact names with a real body: each one
 * writes a sentinel file if it ever runs and returns `{ ran: true }`.
 *
 * A scenario can therefore prove two things end to end — that the Lead's call
 * was refused, and that the refusal happened BEFORE the tool body (the
 * sentinel is absent). Only the names the profile does not ship are used, so
 * this fixture is inserted for team profiles only and never shadows a real
 * tool.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'e2e-class-a-probe';

/** Tool names the design lists as class A, with the sentinel each body would write. */
const PROBES = Object.freeze([
  'terminal_open',
  'create_worktree',
  'ralph',
  'subagent',
]);

const PARAMETERS = Object.freeze({ type: 'object', additionalProperties: false, properties: {} });

/** One plain ToolDefinition: a real body with an observable side effect. */
function probe(toolName) {
  return {
    name: toolName,
    description: `Probe standing in for the class A tool "${toolName}"; running it writes a sentinel file.`,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ran: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      writeFileSync(join(process.cwd(), `probe-ran-${toolName}.txt`), `${toolName} ran\n`);
      return { ran: true };
    },
  };
}

export function apply(ctx) {
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.register !== 'function') return;
  for (const toolName of PROBES) {
    ctx.effect(() => tools.register(probe(toolName)), `e2e-class-a-probe: ${toolName}`);
  }
}
