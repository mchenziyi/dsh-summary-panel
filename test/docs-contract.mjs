/**
 * Convention check: the interface docs stay in step with the code.
 *
 * `docs/CONTRACT.md` is the Host/Client contract, so a doc that drifts is the
 * same defect as wrong code. Ticket #17 deleted three ops (`assign`, `dispatch`,
 * `resolveConflict`) and left the contract's op list advertising them; ticket
 * #18 then had to hand-sync §1–§4. A reviewer caught the drift both times. This
 * check makes the same mistakes red instead.
 *
 * Five rules, all mechanical:
 *
 * 1. The op list in `docs/CONTRACT.md` §3 is exactly `TASK_OPS`, in order.
 * 2. Every `host/<module>.js` named by the reader-facing docs exists, unless the
 *    same line marks it removed (ADRs and history sections may name dead files).
 * 3. A surface the teardown removed (`executions`, `conflicts`, ...) appears in
 *    the contract only on a line that marks it historical, or inside the
 *    deprecated record definitions. A rule stated as live must not survive in
 *    that block.
 * 4. The shipped, user-facing docs (README, requirements, implementation
 *    status, contract, glossary, AGENTS, manual acceptance) do not describe the
 *    removed gate, and a line marked as history is allowed to name it. CHANGELOG
 *    and ADRs keep the history; the teardown's own spec names the layer it
 *    removes, so it is a working record rather than a shipped surface.
 * 5. The version anchors in README / AGENTS / requirements / implementation
 *    status equal `package.json`. A release bumps the version in one place and
 *    the docs are caches of it; #19 landed with two of them still on 0.3.7.
 *
 * Run with `node test/docs-contract.mjs`; it reads files only, writes nothing.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TASK_OPS } from '../host/model.js';
import { DOC_GATE_PHRASES, isHistoryLine } from './support/contract-terms.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// ---------------------------------------------------------------------------
// 1. the contract's op list is the live op list
// ---------------------------------------------------------------------------

{
  const contract = read('docs/CONTRACT.md');
  const start = contract.indexOf("op: 'init'");
  assert.ok(start > 0, 'docs/CONTRACT.md §3 must list the `task_tree_write` op enum');
  const end = contract.indexOf('id?: string', start);
  assert.ok(end > start, 'docs/CONTRACT.md §3 op enum must be followed by the op fields');
  const documented = [...contract.slice(start, end).matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]);
  assert.ok(documented.length > 0, 'the contract op list parsed as empty; the check would be vacuous');
  assert.deepEqual(
    documented,
    [...TASK_OPS],
    'docs/CONTRACT.md §3 and TASK_OPS disagree; update the contract in the same commit as the code',
  );
}

// ---------------------------------------------------------------------------
// 2. reader-facing docs point at modules that exist
// ---------------------------------------------------------------------------

{
  const docs = ['docs/CONTRACT.md', 'GLOSSARY.md', 'AGENTS.md', 'README.md', 'docs/implementation-status.md'];
  let checked = 0;
  for (const doc of docs) {
    if (!existsSync(join(ROOT, doc))) continue;
    read(doc).split('\n').forEach((line, index) => {
      for (const match of line.matchAll(/`(host\/([a-z0-9-]+)\.js)`/g)) {
        checked += 1;
        if (isHistoryLine(line)) continue;
        assert.ok(
          existsSync(join(ROOT, match[1])),
          `${doc}:${index + 1} points at ${match[1]}, which does not exist — update the pointer or mark the line as history`,
        );
      }
    });
  }
  assert.ok(checked > 0, 'no host module is referenced by the docs; the check would be vacuous');
}

// ---------------------------------------------------------------------------
// 3. removed surfaces are not stated as live rules
// ---------------------------------------------------------------------------

{
  const REMOVED = ['executions', 'executionId', 'executionState', 'executorLost', 'conflicts', 'resolveConflict'];
  const lines = read('docs/CONTRACT.md').split('\n');
  let insideDeprecatedBlock = false;
  let sawConflictRecord = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // The three dead records are kept as one documented block. Everything in
    // it is shape-only, so a removed word there is not a live rule.
    if (line.includes('已拆除的证据层')) insideDeprecatedBlock = true;
    if (insideDeprecatedBlock && line.startsWith('ConflictRecord = {')) sawConflictRecord = true;
    if (insideDeprecatedBlock && sawConflictRecord && line.trim() === '```') insideDeprecatedBlock = false;
    if (insideDeprecatedBlock || isHistoryLine(line)) continue;
    for (const surface of REMOVED) {
      assert.equal(
        new RegExp(`\\b${surface}\\b`).test(line),
        false,
        `docs/CONTRACT.md:${index + 1} still states "${surface}" as a live rule; ADR-0003 removed it`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. shipped docs do not describe the removed gate as a live feature
// ---------------------------------------------------------------------------

{
  const shipped = [
    'README.md',
    'AGENTS.md',
    'GLOSSARY.md',
    'docs/CONTRACT.md',
    'docs/requirements/REQUIREMENTS.md',
    'docs/implementation-status.md',
    'docs/testing/manual-acceptance.md',
  ];
  for (const doc of shipped) {
    if (!existsSync(join(ROOT, doc))) continue;
    read(doc).split('\n').forEach((line, index) => {
      if (isHistoryLine(line)) return;
      for (const phrase of DOC_GATE_PHRASES) {
        assert.equal(
          line.includes(phrase),
          false,
          `${doc}:${index + 1} still describes "${phrase}"; ADR-0003 removed it (CHANGELOG and ADRs keep the history)`,
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 5. the version anchors in the docs follow package.json
// ---------------------------------------------------------------------------

{
  const version = JSON.parse(read('package.json')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/, `package.json version looks wrong: ${version}`);
  const anchors = [
    ['README.md', `当前代码版本：v${version}`],
    ['AGENTS.md', `ships in v${version}`],
    ['docs/requirements/REQUIREMENTS.md', `已实现到 v${version}`],
    ['docs/implementation-status.md', `# 实现现状（v${version}）`],
    ['docs/implementation-status.md', `| 版本 | ${version} |`],
  ];
  for (const [doc, anchor] of anchors) {
    assert.equal(
      read(doc).includes(anchor),
      true,
      `${doc} does not say "${anchor}"; a version bump updates package.json and every anchor together`,
    );
  }
}

console.log('docs contract ok');
