/**
 * One temporary git repository, isolated from the repo running the tests.
 *
 * Git exports `GIT_DIR` and friends to every process it starts — including a
 * pre-commit hook. A fixture that shells out to `git` without scrubbing those
 * variables commits into the *caller's* repository: this happened once, and it
 * produced a stream of junk commits on the real branch before anyone noticed.
 * Every fixture must go through here.
 */

import { execFileSync } from 'node:child_process';

/** A copy of `env` with every `GIT_*` variable removed. */
export function cleanGitEnv(env = process.env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith('GIT_')) delete next[key];
  }
  return next;
}

/**
 * Run one git command against `dir` with the caller's repository invisible.
 * @param dir - the throwaway repository.
 * @returns a `(args) => stdout` runner bound to that directory.
 */
export function gitIn(dir) {
  return (...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
}

/**
 * Create a throwaway repository at `dir` and return its runner.
 * @param dir - an existing, empty directory.
 * @param identity - committer identity to record locally.
 * @returns `(args) => stdout` for that repository.
 */
export function initRepo(dir, identity = { name: 'Fixture', email: 'fixture@example.invalid' }) {
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: cleanGitEnv() });
  const git = gitIn(dir);
  git('config', 'user.name', identity.name);
  git('config', 'user.email', identity.email);
  git('config', 'commit.gpgsign', 'false');
  return git;
}
