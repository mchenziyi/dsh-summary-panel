# Real-process e2e harness

One command runs a scripted session against a **real `dsh` process** in a
throwaway profile, exports what the run actually produced, asserts the scenario,
and cleans up:

```sh
npm run test:e2e                        # every scenario
npm run test:e2e -- --list              # list scenarios
npm run test:e2e -- tree-basics         # any scenario by name
npm run test:e2e -- --keep              # keep the temporary directory
npm run test:e2e -- --out DIR           # copy the artefacts to DIR
```

## What it observes

Every scenario exports the artefacts below under `<temp>/out` (and prints them):

| artefact | source | why |
| --- | --- | --- |
| `tool-results.json` | `dsh --json` projected session events | what the tools actually returned, call by call |
| `task-tree.json` | `<profile>/agent-task-tree/<session>.json` on disk | the persisted Reins task tree, not the tool's echo |

A failed run keeps its temporary directory and prints `TEMP DIR KEPT: <path>`.
A passing run removes it unless `--keep` or `--out` was passed.

## Scenarios

- `no-gate` — a session with **no** task tree writes a file with the real
  `write` tool and appends to it with the real `bash` tool; both succeed and no
  tree appears. This is the reverse proof that turns red if a pre-execution
  refusal ever comes back (ADR-0003).
- `tree-basics` — the workline starts from a tree written by the previous build
  (execution ledger, Worker table, conflicts, an execution stamp); a resumed
  session reads it through `task_tree_read`, records progress, creates and
  completes a step, and focuses the old task. The rewritten file must be a plain
  tree record: the ledger is ignored on read and dropped on write.
- `acceptance` — two sessions over one workline: a delivered task cannot close
  itself, and the user's next turn completes it with `confirmedByUser` and the
  quoted words.

## How the profile is built

`lib/profile.mjs` writes a normal custom profile under `$DSH_HOME/profiles/e2e`:
the shipped `dsh-base` + `dsh-headless` bundles, the fixture plugins copied
beside it, and the plugin under test by **absolute path** to this working tree.

- `scripted-llm.js` — a `scripted` LLM provider. The real agent loop, real tool
  registry, real file/shell tools and real session log run as normal; only the
  model text/tool-calls come from the scenario's `program`.
- `web-server-stub.js` / `connection-stub.js` — the two services the panel
  injects that a headless run does not otherwise provide. No socket is opened.

Isolation: `DSH_HOME` points at the temporary root (sessions, storages,
credentials), `DSH_PROFILE_DIR` points at the temporary profile (the plugin
stores its tree under it), and `DSH_PERMISSION_MODE=danger-full-access` picks
the shipped preset whose approval policy is `never` — a headless run has no
approval answerer. Nothing in the product is changed or switched on for tests.

## Multi-run scenarios

A scenario may export `runs` instead of `prompt`/`program`: each step drives one
real `dsh` process against the same profile, and `verify` receives them all as
`runs: [{ run, artefacts }]`. This is how one workline gets a second user turn
(`acceptance`) or is seeded with an old record between runs (`tree-basics`).

| step field | meaning |
| --- | --- |
| `prompt`, `program` | that run's scripted model program |
| `resume: true` | adopt the first run's Session (`--session-id`), the workline and its tree |
| `after({ profile, artefacts, sessionId })` | mutate the throwaway profile between runs (e.g. write an old tree) |

The collector resolves the tree from the FIRST run's workline id, so a resumed
run never looks for the wrong file.

## Limits

- The model is scripted, not a real provider: runs are deterministic and need
  no credentials, but a scenario can only see the tool calls its script makes.
- Scripted calls use the **real** tool schemas, so a wrong argument shape comes
  back as a tool error — read `tool-results.json` → `calls[].status: "error"`
  and its `result` text. Two shapes are in use today: `write { file_path,
  content }` and `bash { command, description }` (`description` is required).
  While iterating, run one scenario: `npm run test:e2e -- <name>`.
- The harness assumes `dsh` is on `PATH` (override with `DSH_BIN`). It prefers a
  real PATH launcher over an npm-injected `node_modules/.bin` shim, because an
  ancestor project's older `dsh` may accept `--json` yet not resolve this
  profile's bundles.

## Running without a launcher (CI)

The suite cannot run where no `dsh` launcher exists. Fail loudly by default; a
runner that has no launcher opts into a visible skip instead of a silent pass:

```bash
DSH_E2E_OPTIONAL=1 npm run test:e2e    # prints "SKIPPED: no dsh launcher…" and exits 0
DSH_BIN=~/.local/bin/dsh npm run test:e2e   # or point at the launcher you use
```
