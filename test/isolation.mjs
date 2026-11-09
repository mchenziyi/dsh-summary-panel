/**
 * Harness hygiene: the tests themselves follow two rules.
 *
 * 1. A test that shells out to `git` goes through the shared fixture helper.
 *    Git exports `GIT_DIR` to the processes a hook starts, so a test that
 *    spawns `git` directly commits into whichever repository runs `npm test`.
 *    That bug once put a stream of junk commits on the real branch.
 * 2. Every top-level `test/*.mjs` harness is wired into a `package.json` script,
 *    because a harness nobody runs is a check that silently does not exist.
 *    Ticket #18 added `test/modules.mjs` and had to remember the wiring by
 *    hand; this makes the forgetting red.
 *
 * Run with `node test/isolation.mjs`; it reads files only.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SUPPORT = join(TEST_DIR, 'support', 'isolated-git.mjs');

/** Every `.mjs` file under `test/`, excluding the helper itself. */
function testFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.endsWith('.mjs')) found.push(path);
    }
  };
  walk(TEST_DIR);
  return found.filter((path) => path !== SUPPORT);
}

/** Lines that spawn git directly instead of through the helper. */
function rawGitLines(source) {
  const offenders = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (/(?:execFileSync|execSync|spawnSync|spawn)\(\s*['"]git['"]/.test(lines[index])) {
      offenders.push({ line: index + 1, text: lines[index].trim() });
    }
  }
  return offenders;
}

let failures = 0;
for (const file of testFiles()) {
  const source = readFileSync(file, 'utf8');
  const offenders = rawGitLines(source);
  if (offenders.length === 0) continue;
  const usesHelper = new RegExp(`from ['"]\\./support/isolated-git\\.mjs['"]`).test(source)
    && /cleanGitEnv\(|initRepo\(|gitIn\(/.test(source);
  if (usesHelper) continue;
  failures += 1;
  const shown = offenders.map((entry) => `    ${relative(TEST_DIR, file)}:${entry.line}  ${entry.text}`).join('\n');
  console.error(`  ${relative(TEST_DIR, file)} spawns git without the isolation helper:\n${shown}`);
}

// ---------------------------------------------------------------------------
// 2. every top-level harness is wired into a package.json script
// ---------------------------------------------------------------------------

{
  const packageJson = JSON.parse(readFileSync(join(TEST_DIR, '..', 'package.json'), 'utf8'));
  const scripts = Object.values(packageJson.scripts ?? {}).join(' ');
  const harnesses = readdirSync(TEST_DIR).filter((name) => name.endsWith('.mjs')).sort();
  assert.ok(harnesses.length > 0, `no harness found in ${TEST_DIR}; the wiring check would be vacuous`);
  for (const name of harnesses) {
    if (scripts.includes(`test/${name}`)) continue;
    failures += 1;
    console.error(`  test/${name} is not referenced by any package.json script; add it to \`npm test\` (and a test:<suite> alias)`);
  }
}

if (failures > 0) {
  console.error('isolation: fix the harness hygiene problems above');
  process.exit(1);
}
console.log('isolation ok');
