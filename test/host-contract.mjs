/**
 * Convention check: the model-facing texts and the client stay in step with the
 * domain, mechanically.
 *
 * Ticket #17 deleted the execution ledger, the conflict record and several ops.
 * The deletion is honest in `host/model.js`, but the model-facing texts are
 * prose: `host/prompt.js` and the tool descriptions kept advertising removed
 * ops (`dispatch`, `release {force:true}`) and removed payload fields
 * (`executorLost`) after the code behind them was gone. A reviewer caught it;
 * this check makes the same mistake red instead.
 *
 * Two rules, both mechanical:
 *
 * 1. Every op named as a call in a model-facing text is a live `TASK_OPS` entry.
 * 2. No model-facing text, and no client code, mentions a surface that ADR-0003
 *    removed. The list shrinks as the teardown lands; it must never grow again.
 * 3. In `host/`, the word "execution" survives only in comments and in the
 *    retained `executionApproval` field. Ticket #19 rewrote the prompt around
 *    maintaining the tree; prose that still talks about executing work is the
 *    gate's vocabulary leaking back in.
 *
 * Run with `node test/host-contract.mjs`; reads files and registers the tools on
 * a fake context, writes nothing.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TASK_OPS } from '../host/model.js';
import { TASK_TREE_PROMPT, TASK_TREE_REMINDER, TASK_TREE_START_REMINDER } from '../host/prompt.js';
import { mountTaskTree } from '../host/mount.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Surfaces ADR-0003 removed. A model-facing text that still names one is a
 * prompt advertising a call that now throws; client code that reads one renders
 * a branch the host can no longer satisfy.
 */
const REMOVED_SURFACES = [
  // The execution ledger: no execution ids, no execution state, no lost-executor
  // marker (the claim record is all the panel shows now).
  'executionId',
  'executorLost',
  'executionState',
  'ownerLost',
  'execution seat',
  'lifetime binding',
  // Ops that no longer exist.
  'resolveConflict',
  'team_task_update',
  '"force":true',
  'force: true',
  'force-release',
  'force release',
  // The gate's vocabulary.
  'class A',
];

/** Every `{"op":"<name>"}` call shape in one text. */
function opCalls(text) {
  return [...text.matchAll(/"op"\s*:\s*"([a-zA-Z][a-zA-Z]*)"/g)].map((match) => match[1]);
}

/** Register the two tools on a fake context and return their definitions. */
function registeredTools() {
  const registered = new Map();
  const root = mkdtempSync(join(tmpdir(), 'sp-contract-'));
  mountTaskTree({
    effect: (factory) => factory(),
    get(name) {
      if (name === 'tools') {
        return { register: (definition) => { registered.set(definition.name, definition); return () => {}; } };
      }
      return undefined;
    },
  }, { root, logger: { warn() {} }, route: () => {} });
  assert.deepEqual([...registered.keys()].sort(), ['task_tree_read', 'task_tree_write'], 'both tools register');
  return registered;
}

const tools = registeredTools();
const modelFacing = {
  TASK_TREE_PROMPT,
  TASK_TREE_REMINDER,
  TASK_TREE_START_REMINDER,
  'task_tree_read.description': tools.get('task_tree_read').description,
  'task_tree_write.description': tools.get('task_tree_write').description,
};

// ---------------------------------------------------------------------------
// 1. an op named in a model-facing text must exist
// ---------------------------------------------------------------------------

{
  let checked = 0;
  for (const [where, text] of Object.entries(modelFacing)) {
    for (const op of opCalls(text)) {
      checked += 1;
      assert.equal(
        TASK_OPS.includes(op),
        true,
        `${where} tells the model to call op "${op}", which is not in TASK_OPS (${TASK_OPS.join(', ')})`,
      );
    }
  }
  // The rule is only worth keeping if the texts actually carry op examples.
  assert.ok(checked > 0, 'at least one model-facing text shows an op call shape');
}

// ---------------------------------------------------------------------------
// 2. removed surfaces must not be advertised anywhere model- or user-facing
// ---------------------------------------------------------------------------

{
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8');
  const surfaces = { ...modelFacing, 'client.js': client };
  for (const [where, text] of Object.entries(surfaces)) {
    for (const surface of REMOVED_SURFACES) {
      assert.equal(
        text.includes(surface),
        false,
        `${where} still mentions "${surface}", which ADR-0003 removed (see TASK_OPS for the live ops)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. "execution" in host source: comments and the retained approval field only
// ---------------------------------------------------------------------------

{
  const HOST = join(ROOT, 'host');
  const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
  const withoutTrailingComment = (line) => line.replace(/\s*\/\/.*$/, '');
  let checked = 0;
  for (const file of readdirSync(HOST).filter((name) => name.endsWith('.js')).sort()) {
    const lines = readFileSync(join(HOST, file), 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (isComment(line)) continue;
      checked += 1;
      // `executionApproval` is the retained field; strip it and see what is left.
      const rest = withoutTrailingComment(line).replace(/execution_?approvals?/gi, '');
      assert.equal(
        /execution/i.test(rest),
        false,
        `host/${file}:${index + 1} mentions "execution" outside a comment and the executionApproval field: ${line.trim()}`,
      );
    }
  }
  assert.ok(checked > 0, 'no host source lines checked; the rule would be vacuous');
}

console.log('host contract ok');
