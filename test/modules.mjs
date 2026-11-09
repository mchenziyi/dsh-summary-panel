/**
 * Load check: every module in `host/` must import cleanly.
 *
 * Deleting a module is only half the work — a peer that still imports one of
 * its exports keeps the package unloadable, and nothing else in the suite
 * notices because `host/*.js` is only reached through the modules a test file
 * happens to import. Ticket #18 (ADR-0003) deleted the evidence layer, so this
 * check pins the whole published directory: each file is imported on its own,
 * and a stale import fails here instead of in a live profile.
 *
 * Run with `node test/modules.mjs`; it reads files and imports modules, writes
 * nothing.
 */

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = join(ROOT, 'host');

const files = (await readdir(HOST)).filter((name) => name.endsWith('.js')).sort();

// The directory is published as `host/`, so an empty or wrongly located scan
// would pass vacuously.
assert.ok(files.length > 0, `no modules found in ${HOST}; the load check would be vacuous`);

const loaded = [];
for (const file of files) {
  try {
    await import(pathToFileURL(join(HOST, file)).href);
  } catch (error) {
    assert.fail(`host/${file} does not load: ${String(error?.message ?? error)}`);
  }
  loaded.push(file);
}

console.log(`every host module loads (${loaded.length}: ${loaded.join(', ')})`);
