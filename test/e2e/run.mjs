#!/usr/bin/env node
/**
 * Real-process e2e harness for the DSH Reins plugin.
 *
 * One command does the whole loop: create a throwaway DSH profile, run a
 * scripted session against it (real `dsh` process, real headless agent loop,
 * real tools, real Agent Team), export the three observed facts — tool results,
 * the task tree file on disk, the live Team board — assert the scenario, then
 * clean everything up. A failed run keeps its temporary directory and says
 * where it is.
 *
 * Only the model is scripted (a fixture adapter in the throwaway profile), so
 * runs are deterministic and need no credentials. Nothing here changes product
 * behaviour or requires a test-only product switch.
 *
 * Usage:
 *   node test/e2e/run.mjs                     # every scenario
 *   node test/e2e/run.mjs --list              # list scenarios
 *   node test/e2e/run.mjs baseline-write tree-init team-board
 *   node test/e2e/run.mjs --keep [scenario]   # keep the temporary directory
 *   node test/e2e/run.mjs --out DIR           # copy the artefacts to DIR
 */

import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildProfile } from './lib/profile.mjs';
import { runSession } from './lib/session.mjs';
import { collectArtefacts } from './lib/collect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'index.js');
const FIXTURE_DIR = join(HERE, 'fixtures', 'plugins');
const SCENARIO_DIR = join(HERE, 'scenarios');
// No scenario names means every scenario on disk: a new one must not be able to
// join the suite without running by default.
const DEFAULT_SCENARIOS = readdirSync(SCENARIO_DIR)
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => name.slice(0, -'.mjs'.length))
  .sort();
const MAX_ARTEFACT_PRINT_BYTES = 6000;

function usage() {
  return [
    'usage: node test/e2e/run.mjs [--list] [--keep] [--out DIR] [scenario...]',
    `scenarios live in ${SCENARIO_DIR}`,
  ].join('\n');
}

/** Parse the small CLI: scenario names plus three flags. */
function parseArgs(argv) {
  const options = { scenarios: [], keep: false, out: undefined, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--list') options.list = true;
    else if (argument === '--keep') options.keep = true;
    else if (argument === '--out') {
      index += 1;
      if (argv[index] === undefined) throw new Error('--out needs a directory');
      options.out = argv[index];
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option ${argument}`);
    } else {
      options.scenarios.push(argument);
    }
  }
  if (options.scenarios.length === 0) options.scenarios = [...DEFAULT_SCENARIOS];
  return options;
}

/** Resolve scenario modules, failing early on an unknown name. */
async function loadScenarios(names) {
  const scenarios = [];
  for (const name of names) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid scenario name ${JSON.stringify(name)}`);
    const modulePath = join(SCENARIO_DIR, `${name}.mjs`);
    if (!existsSync(modulePath)) throw new Error(`unknown scenario ${JSON.stringify(name)} (see --list)`);
    const module = await import(pathToFileURL(modulePath).href);
    if (typeof module.prompt !== 'string' || !Array.isArray(module.program) || typeof module.verify !== 'function') {
      throw new Error(`scenario ${name} must export prompt, program, and verify`);
    }
    scenarios.push({ ...module, name: module.name ?? name });
  }
  return scenarios;
}

async function listScenarios() {
  const names = (await readdir(SCENARIO_DIR)).filter((file) => file.endsWith('.mjs')).map((file) => file.replace(/\.mjs$/, '')).sort();
  for (const name of names) {
    const module = await import(pathToFileURL(join(SCENARIO_DIR, `${name}.mjs`)).href);
    console.log(`${name}${module.team === true ? ' [team]' : ''} — ${module.summary ?? ''}`);
  }
}

function printArtefacts(artefacts) {
  const blocks = [
    ['tool-results.json', artefacts.toolResults],
    ['tool-transcript.json', artefacts.toolTranscript],
    ['task-tree.json', artefacts.taskTree],
    ['team-board.json', artefacts.teamBoard],
  ];
  for (const [label, value] of blocks) {
    const text = JSON.stringify(value, null, 2);
    const bounded = text.length > MAX_ARTEFACT_PRINT_BYTES
      ? `${text.slice(0, MAX_ARTEFACT_PRINT_BYTES)}\n… (${text.length} bytes total; pass --out or --keep for the file)`
      : text;
    console.log(`--- ${label}`);
    console.log(bounded);
  }
}

/**
 * Run one scenario end to end.
 * @returns `{ ok, root, keep, failures }`.
 */
async function runScenario(scenario, options) {
  const root = await mkdtemp(join(tmpdir(), `dsh-e2e-${scenario.name}-`));
  let keep = false;
  try {
    const profile = await buildProfile({
      root,
      pluginRoot: PLUGIN_ROOT,
      fixtureDir: FIXTURE_DIR,
      program: scenario.program,
      subagentProgram: scenario.subagentProgram,
      team: scenario.team === true,
    });
    console.log(`== ${scenario.name} — ${scenario.summary ?? ''}`);
    console.log(`   profile  ${profile.profileDir}`);
    console.log(`   workspace ${profile.workdir}`);
    const run = runSession({ prompt: scenario.prompt, home: profile.home, profileDir: profile.profileDir, workdir: profile.workdir });
    const artefacts = await collectArtefacts({
      outDir: profile.outDir,
      run,
      taskTreeDir: profile.taskTreeDir,
      teamBoardPath: profile.teamBoardPath,
      transcriptPath: profile.transcriptPath,
      team: scenario.team === true,
    });
    let assertions = [];
    if (run.status !== 0) {
      assertions.push({
        label: 'the dsh process exited successfully',
        ok: false,
        detail: run.timedOut ? 'timed out' : `exit=${run.status}; stderr: ${run.stderr.trim().split('\n').slice(-6).join(' | ')}`,
      });
    } else {
      assertions = await scenario.verify({ artefacts, workdir: profile.workdir, sessionId: run.sessionId });
    }
    for (const assertion of assertions) {
      console.log(`   ${assertion.ok ? '✓' : '✗'} ${assertion.label}${assertion.detail === undefined ? '' : ` (${assertion.detail})`}`);
    }
    printArtefacts(artefacts);
    const failures = assertions.filter((assertion) => !assertion.ok);
    if (failures.length > 0) {
      keep = true;
      console.log(`FAIL ${scenario.name}: ${failures.length} assertion(s) failed`);
      console.log(`TEMP DIR KEPT: ${root}`);
      return { ok: false, root, keep: true, failures };
    }
    if (options.out !== undefined) {
      const destination = join(options.out, scenario.name);
      await mkdir(destination, { recursive: true });
      for (const file of await readdir(profile.outDir)) {
        await copyFile(join(profile.outDir, file), join(destination, file));
      }
      console.log(`artefacts copied to ${destination}`);
    }
    console.log(`PASS ${scenario.name} in ${run.durationMs} ms`);
    return { ok: true, root, keep: options.keep, failures: [] };
  } catch (error) {
    keep = true;
    console.log(`FAIL ${scenario.name}: ${String(error?.stack ?? error)}`);
    console.log(`TEMP DIR KEPT: ${root}`);
    return { ok: false, root, keep: true, failures: [{ label: String(error?.message ?? error), ok: false }] };
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${String(error?.message ?? error)}\n${usage()}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.list) {
    await listScenarios();
    return 0;
  }
  if (!existsSync(PLUGIN_ROOT)) {
    console.error(`plugin entry not found at ${PLUGIN_ROOT}`);
    return 2;
  }
  const scenarios = await loadScenarios(options.scenarios);
  const results = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, options));
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result.keep) await rm(result.root, { recursive: true, force: true });
    else console.log(`kept ${result.root} (${scenarios[index].name})`);
  }
  const failed = results.filter((result) => !result.ok);
  console.log(failed.length === 0 ? `\nALL ${results.length} SCENARIO(S) PASSED` : `\n${failed.length} of ${results.length} SCENARIO(S) FAILED`);
  return failed.length === 0 ? 0 : 1;
}

const code = await main();
process.exit(code);
