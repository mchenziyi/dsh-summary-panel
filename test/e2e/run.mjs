#!/usr/bin/env node
/**
 * Real-process e2e harness for the DSH Reins plugin.
 *
 * One command does the whole loop: create a throwaway DSH profile, run a
 * scripted session against it (real `dsh` process, real headless agent loop,
 * real tools, real Agent Team), export what the run actually produced — tool
 * results, the task tree and claim journal on disk, the live Team board —
 * assert the scenario, then clean everything up. A crash scenario runs several
 * real processes against one profile, resuming the first one's Session. A
 * failed run keeps its temporary directory and says where it is.
 *
 * Only the model is scripted (a fixture adapter in the throwaway profile), so
 * runs are deterministic and need no credentials. Nothing here changes product
 * behaviour or requires a test-only product switch.
 *
 * Usage:
 *   node test/e2e/run.mjs                     # every scenario
 *   node test/e2e/run.mjs --list              # list scenarios
 *   node test/e2e/run.mjs baseline-write tree-init
 *   node test/e2e/run.mjs --keep [scenario]   # keep the temporary directory
 *   node test/e2e/run.mjs --out DIR           # copy the artefacts to DIR
 */

import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildProfile, writeScript } from './lib/profile.mjs';
import { launcherCandidates, runSession } from './lib/session.mjs';
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
    const multi = Array.isArray(module.runs) && module.runs.length > 0;
    if (typeof module.prompt !== 'string' || typeof module.verify !== 'function' || (!multi && !Array.isArray(module.program))) {
      throw new Error(`scenario ${name} must export prompt, program (or runs), and verify`);
    }
    if (multi && module.runs.some((step) => typeof step?.prompt !== 'string' || !Array.isArray(step?.program))) {
      throw new Error(`scenario ${name}: every run needs a prompt and a program`);
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
    ['claim-journal.json', artefacts.claimJournal],
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
    // A crash/restart scenario drives several real `dsh` processes against one
    // profile and one workline; every other scenario is a single run.
    const steps = Array.isArray(scenario.runs) && scenario.runs.length > 0
      ? scenario.runs
      : [{
        prompt: scenario.prompt,
        program: scenario.program,
        subagentProgram: scenario.subagentProgram,
        teamResponses: scenario.teamResponses,
      }];
    const profile = await buildProfile({
      root,
      pluginRoot: PLUGIN_ROOT,
      fixtureDir: FIXTURE_DIR,
      program: steps[0].program,
      subagentProgram: steps[0].subagentProgram,
      teamResponses: steps[0].teamResponses,
      team: scenario.team === true,
      crash: scenario.crash,
    });
    console.log(`== ${scenario.name} — ${scenario.summary ?? ''}`);
    console.log(`   profile  ${profile.profileDir}`);
    console.log(`   workspace ${profile.workdir}`);
    const results = [];
    const failures = [];
    let worklineId;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (index > 0) await writeScript(profile, step);
      const run = runSession({
        prompt: step.prompt,
        home: profile.home,
        profileDir: profile.profileDir,
        workdir: profile.workdir,
        sessionId: step.resume === true ? worklineId : undefined,
      });
      // The workline is the FIRST run's root Session: a resumed run reports that
      // same id, and a crash leaves the tree it wrote behind.
      if (worklineId === undefined) worklineId = run.sessionId;
      const outDir = steps.length === 1 ? profile.outDir : join(profile.outDir, `run-${index + 1}`);
      const artefacts = await collectArtefacts({
        outDir,
        run,
        taskTreeDir: profile.taskTreeDir,
        teamBoardPath: profile.teamBoardPath,
        transcriptPath: profile.transcriptPath,
        team: scenario.team === true,
        worklineId,
      });
      const label = steps.length === 1 ? 'the dsh process' : `run ${index + 1}`;
      if (step.expect === 'crash') {
        if (run.status === 0) {
          failures.push({ label: `${label} was expected to crash`, ok: false, detail: 'it exited successfully' });
        } else {
          console.log(`   ✓ ${label} crashed as injected (signal ${run.signal ?? 'none'})`);
        }
      } else if (run.status !== 0) {
        failures.push({
          label: `${label} exited successfully`,
          ok: false,
          detail: run.timedOut ? 'timed out' : `exit=${run.status}; stderr: ${run.stderr.trim().split('\n').slice(-6).join(' | ')}`,
        });
      }
      results.push({ run, artefacts });
      if (typeof step.after === 'function') {
        await step.after({
          profile, artefacts, workdir: profile.workdir, sessionId: worklineId,
        });
      }
      if (failures.length > 0) break;
    }
    let assertions = failures;
    const last = results[results.length - 1]?.artefacts;
    if (failures.length === 0) {
      assertions = await scenario.verify({
        artefacts: last,
        runs: results,
        workdir: profile.workdir,
        sessionId: worklineId,
      });
    }
    for (const assertion of assertions) {
      console.log(`   ${assertion.ok ? '✓' : '✗'} ${assertion.label}${assertion.detail === undefined ? '' : ` (${assertion.detail})`}`);
    }
    if (last !== undefined) printArtefacts(last);
    const failed = assertions.filter((assertion) => !assertion.ok);
    if (failed.length > 0) {
      keep = true;
      console.log(`FAIL ${scenario.name}: ${failed.length} assertion(s) failed`);
      console.log(`TEMP DIR KEPT: ${root}`);
      return { ok: false, root, keep: true, failures: failed };
    }
    if (options.out !== undefined) {
      const destination = join(options.out, scenario.name);
      await mkdir(destination, { recursive: true });
      for (const file of await readdir(profile.outDir, { recursive: true })) {
        const source = join(profile.outDir, file);
        if (!existsSync(source) || (await stat(source)).isDirectory()) continue;
        await mkdir(dirname(join(destination, file)), { recursive: true });
        await copyFile(source, join(destination, file));
      }
      console.log(`artefacts copied to ${destination}`);
    }
    console.log(`PASS ${scenario.name} in ${results.reduce((sum, result) => sum + result.run.durationMs, 0)} ms`);
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
  // A machine without the DSH launcher cannot run this suite at all. Local runs
  // still fail loudly; a CI job that has no DSH opts in to a visible skip rather
  // than a silent pass.
  if (process.env.DSH_E2E_OPTIONAL === '1' && launcherCandidates().length === 0) {
    console.log('SKIPPED: no dsh launcher on PATH and DSH_E2E_OPTIONAL=1');
    return 0;
  }
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
