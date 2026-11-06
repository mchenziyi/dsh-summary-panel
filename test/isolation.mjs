/**
 * Convention check: a test that shells out to `git` must go through the shared
 * fixture helper.
 *
 * Git exports `GIT_DIR` to the processes a hook starts, so a test that spawns
 * `git` directly commits into whichever repository runs `npm test`. That bug
 * once put a stream of junk commits on the real branch. This check makes the
 * rule mechanical instead of a thing to remember.
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

if (failures > 0) {
  console.error('isolation: use test/support/isolated-git.mjs (initRepo / gitIn / cleanGitEnv)');
  process.exit(1);
}
console.log('isolation ok');
