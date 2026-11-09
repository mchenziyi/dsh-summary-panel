# Real-process e2e harness

One command runs a scripted session against a **real `dsh` process** in a
throwaway profile, exports what the run actually produced, asserts the
scenario, and cleans up:

```sh
npm run test:e2e                 # every scenario (2 today)
npm run test:e2e -- --list       # list scenarios
npm run test:e2e -- tree-init    # any scenario by name
npm run test:e2e -- --keep       # keep the temporary directory
npm run test:e2e -- --out DIR    # copy the artefacts to DIR
```

## What it observes

Every scenario exports the artefacts below under `<temp>/out` (and prints them):

| artefact | source | why |
| --- | --- | --- |
| `tool-results.json` | `dsh --json` projected session events | what the tools actually returned, call by call |
| `tool-transcript.json` | fixture probe over every `session/event` | every session's tool calls and results, subagents included |
| `task-tree.json` | `<profile>/agent-task-tree/<session>.json` on disk | the persisted Reins task tree, not the tool's echo |
| `claim-journal.json` | `<profile>/agent-task-tree/<session>.claims.jsonl` on disk | the claim-intent journal written before a Team-board claim |
| `team-board.json` | fixture probe inside the live process | Agent Team state is in-memory only, so it must be captured before exit |

A failed run keeps its temporary directory and prints `TEMP DIR KEPT: <path>`.
A passing run removes it unless `--keep` or `--out` was passed.

## Scenarios

- `baseline-write` — a session with **no** task tree writes a file with the
  real `write` tool and the file lands: nothing refuses a workspace change
  before it runs, and no tree is created behind it. This is the reverse proof
  that turns red if a pre-execution refusal ever comes back (ADR-0003).
- `tree-init` — `task_tree_write` persists a tree the harness finds on disk.

## How the profile is built

`lib/profile.mjs` writes a normal custom profile under `$DSH_HOME/profiles/e2e`:
the shipped `dsh-base` + `dsh-headless` bundles (plus the real
`dsh-experimental-agent-team-profile` in team scenarios), the plugin under test
by **absolute path** to this working tree, and the fixture plugins copied
beside it:

- `scripted-llm.js` — a `scripted` LLM provider. The real agent loop, real tool
  registry, real file tools and real session log run as normal; only the model
  text/tool-calls come from the scenario's `program`.
- `web-server-stub.js` / `connection-stub.js` — the two services the panel
  injects that a headless run does not otherwise provide. No socket is opened.
- `team-board-probe.js` — exports the live Team board at each turn end.
- `crash-injector.js` — optional (`crash` in the scenario): SIGKILLs the process
  in its own `tools/post-execute` listener after a committed board transition.
  It is inserted before the plugin under test, so the crash lands between the
  board write and the ledger write — the window reconciliation exists for.

Isolation: `DSH_HOME` points at the temporary root (sessions, storages,
credentials), `DSH_PROFILE_DIR` points at the temporary profile (the plugin
stores its tree under it), and `DSH_PERMISSION_MODE=danger-full-access` picks
the shipped preset whose approval policy is `never` — a headless run has no
approval answerer. Nothing in the product is changed or switched on for tests.

## Restart scenarios

A scenario may export `runs` instead of `prompt`/`program`: each step drives one
real `dsh` process against the same profile, and `verify` receives them all as
`runs: [{ run, artefacts }]`.

| step field | meaning |
| --- | --- |
| `prompt`, `program`, `teamResponses` | that run's scripted model program |
| `resume: true` | adopt the first run's Session (`--session-id`), the workline and its tree |
| `expect: 'crash'` | the process must die by a signal instead of exiting 0 |
| `after({ profile, artefacts, sessionId })` | mutate the throwaway profile between runs (e.g. delete the journal) |

`run.signal` exposes the terminating signal, and the collector resolves the tree
and journal from the FIRST run's workline id, so a resumed run never looks
for the wrong file.

## Limits

- The model is scripted, not a real provider: runs are deterministic and need
  no credentials, but a scenario can only see the tool calls its script makes.
- Subagents are scripted through `subagentResponses`, the `{{subagentId}}`
  placeholder and `waitForSubagentTurns`. Named teammates use their own queues in
  `teamResponses` (resolved through the live roster) and the Lead can wait for a
  teammate's turn with `waitForTeammate: "<name>"` or
  `waitForTeammateTurns: { name, turns }`; `waitForMemberStatus: { name,
  status }` polls the member's live Agent (the scripted form of `list_agents`),
  and `holdMs` makes one model call slow so the Agent is really running while
  the Lead acts. A teammate's session id is never exposed to the model, so
  scenarios identify it from the tool transcript.
- A scripted model issues one tool call per step, so two calls can never be in
  flight at the same instant from its own turn. A crash scenario can still kill
  the whole process mid-turn with the `crash-injector` fixture.
- The harness assumes `dsh` is on `PATH` (override with `DSH_BIN`). It prefers
  a real PATH launcher over an npm-injected `node_modules/.bin` shim, because an
  ancestor project's older `dsh` may accept `--json` yet not resolve this
  profile's bundles.

## Running without a launcher (CI)

The suite cannot run where no `dsh` launcher exists. Fail loudly by default; a
runner that has no launcher opts into a visible skip instead of a silent pass:

```bash
DSH_E2E_OPTIONAL=1 npm run test:e2e    # prints "SKIPPED: no dsh launcher…" and exits 0
DSH_BIN=~/.local/bin/dsh npm run test:e2e   # or point at the launcher you use
```

`DSH_BIN` also settles the "wrong `dsh` on PATH" trap: `npm run` puts an
ancestor `node_modules/.bin` first, and an older launcher there may reject
`--json`. The harness skips a candidate that answers `unknown option '--json'`
and retries the next one, but an explicit `DSH_BIN` costs nothing.
