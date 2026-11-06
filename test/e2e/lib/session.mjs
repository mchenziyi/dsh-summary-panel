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

/** Hard cap for one scripted session; a scripted model should finish in seconds. */
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Run one session and project its NDJSON event stream.
 * @param options - `{ prompt, home, profileDir, workdir, name, timeoutMs, bin }`.
 * @returns `{ status, timedOut, stdout, stderr, events, unparsed, sessionId }`.
 */
export function runSession({ prompt, home, profileDir, workdir, name = 'e2e', timeoutMs = DEFAULT_TIMEOUT_MS, bin = process.env.DSH_BIN ?? 'dsh' }) {
  const startedAt = Date.now();
  const result = spawnSync(
    bin,
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
