/**
 * Drive one scripted DSH session in the throwaway profile.
 *
 * The child is the real `dsh` launcher booting a real headless run: real agent
 * loop, real tool registry, real file tools, real session log. Only the model
 * is scripted (the fixture adapter), so the tool calls and their results are
 * deterministic. `--json` projects the committed session events, which is how
 * the harness observes what the tools actually returned.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

let resolvedBin;

/**
 * Launchers to try, in PATH order. `--json` is an app arg, so the top-level
 * `--help` cannot advertise it: the capability is proven by the first real run
 * that does not answer "unknown option '--json'". Under `npm run` an ancestor
 * `node_modules/.bin` can put an older launcher first; when that launcher still
 * accepts `--json` but cannot resolve this profile's bundles, the retry cannot
 * notice, so a real PATH launcher is preferred over a dependency shim.
 * @returns candidate paths, deduplicated and existing.
 */
function launcherCandidates() {
  if (resolvedBin !== undefined) return [resolvedBin];
  if (process.env.DSH_BIN !== undefined && process.env.DSH_BIN !== '') return [process.env.DSH_BIN];
  const candidates = [];
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, 'dsh');
    if (!candidates.includes(candidate) && existsSync(candidate)) candidates.push(candidate);
  }
  const isDependencyShim = (candidate) => candidate.includes(`${sep}node_modules${sep}.bin${sep}`);
  return [
    ...candidates.filter((candidate) => !isDependencyShim(candidate)),
    ...candidates.filter((candidate) => isDependencyShim(candidate)),
  ];
}

/** Whether a launcher rejected the flag this harness depends on. */
function rejectsJsonFlag(result) {
  return /unknown option '?--json'?/.test(String(result.stderr ?? ''));
}

/** Hard cap for one scripted session; a scripted model should finish in seconds. */
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Run one session and project its NDJSON event stream.
 * @param options - `{ prompt, home, profileDir, workdir, name, timeoutMs, bin }`.
 * @returns `{ status, timedOut, stdout, stderr, events, unparsed, sessionId }`.
 */
export function runSession({ prompt, home, profileDir, workdir, name = 'e2e', timeoutMs = DEFAULT_TIMEOUT_MS, bin }) {
  const startedAt = Date.now();
  const candidates = bin === undefined ? launcherCandidates() : [bin];
  if (candidates.length === 0) {
    throw new Error('no dsh launcher on PATH; set DSH_BIN to the launcher you use');
  }
  const attempt = (executable) => spawnSync(
    executable,
    ['--profile', name, '--json', prompt],
    {
      cwd: workdir,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        // One isolated DSH home: sessions, storages, and credentials stay here.
        DSH_HOME: home,
        // The plugin stores the task tree beside the profile it runs in.
        DSH_PROFILE_DIR: profileDir,
        // No approval answerer exists in a headless run, so the run must not ask;
        // this is a real shipped permission preset, not a test-only switch.
        DSH_PERMISSION_MODE: 'danger-full-access',
      },
    },
  );
  let result;
  const rejected = [];
  for (const candidate of candidates) {
    result = attempt(candidate);
    if (!rejectsJsonFlag(result)) { resolvedBin = candidate; break; }
    rejected.push(candidate);
  }
  if (result === undefined || rejectsJsonFlag(result)) {
    throw new Error(
      `no dsh launcher accepts --json; tried: ${rejected.join(', ')}. `
      + 'Set DSH_BIN to the launcher you use (for example ~/.local/bin/dsh).',
    );
  }
  const events = [];
  const unparsed = [];
  for (const line of String(result.stdout ?? '').split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    try {
      events.push(JSON.parse(text));
    } catch {
      unparsed.push(text);
    }
  }
  const session = events.find((event) => event?.type === 'session');
  return {
    status: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    events,
    unparsed,
    sessionId: typeof session?.sessionId === 'string' ? session.sessionId : undefined,
    durationMs: Date.now() - startedAt,
  };
}
