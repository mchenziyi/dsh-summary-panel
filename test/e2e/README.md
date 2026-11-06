# Real-process e2e harness

One command runs a scripted session against a **real `dsh` process** in a
throwaway profile, exports what the run actually produced, asserts the
scenario, and cleans up:

```sh
npm run test:e2e                 # the baseline scenario
npm run test:e2e -- --list       # list scenarios
npm run test:e2e -- tree-init    # any scenario by name
npm run test:e2e -- --keep       # keep the temporary directory
npm run test:e2e -- --out DIR    # copy the artefacts to DIR
```

## What it observes

Every scenario exports three artefacts under `<temp>/out` (and prints them):

| artefact | source | why |
| --- | --- | --- |
| `tool-results.json` | `dsh --json` projected session events | what the tools actually returned, call by call |
| `tool-transcript.json` | fixture probe over every `session/event` | every session's tool calls and results, subagents included |
| `task-tree.json` | `<profile>/agent-task-tree/<session>.json` on disk | the persisted Reins task tree, not the tool's echo |
| `team-board.json` | fixture probe inside the live process | Agent Team state is in-memory only, so it must be captured before exit |

A failed run keeps its temporary directory and prints `TEMP DIR KEPT: <path>`.
A passing run removes it unless `--keep` or `--out` was passed.

## Scenarios

- `baseline-write` — a session with **no** task tree: the `write` tool succeeds
  and no tree is persisted. This is the harness's own proof that it can observe
  the unconstrained baseline.
- `tree-init` — `task_tree_write` persists a tree the harness finds on disk.
- `execution-gate` — class A tools (`write`, `bash`) are refused before `claim`
  and again after `release`, with no side effect on disk; task-management tools
  keep working and an unmanaged workline stays free.
- `execution-seat` — standard-mode single execution seat: the Lead holds it,
  a real continuable subagent's claim is refused, the Lead releases and assigns
  it, the subagent claims/writes/releases, and the Lead reclaims with a NEW
  execution id; three sequential Lead tasks get three distinct ids.
- `team-board` — the profile composes the real Agent Team; a board task is
  created through the shipped `team_task_create` tool and exported.
- `team-lead` — team mode makes the Lead a pure coordinator: with no tree yet,
  while holding a task execution, and after releasing it, every class A family
  (`write`, `edit`, `bash`, `workflow`, `terminal_open`, `create_worktree`,
  `ralph`, `subagent`) is refused with the team-mode reason and leaves nothing
  on disk; `task_tree_*`, the Team task tools, `spawn_teammate` (a real
  teammate), messaging and reads keep working.

## How the profile is built

`lib/profile.mjs` writes a normal custom profile under `$DSH_HOME/profiles/e2e`:
the shipped `dsh-base` + `dsh-headless` bundles (plus the real
`dsh-experimental-agent-team-profile` in team scenarios), the plugin under test
by **absolute path** to this working tree, and five fixture plugins copied
beside it:

- `scripted-llm.js` — a `scripted` LLM provider. The real agent loop, real tool
  registry, real file tools and real session log run as normal; only the model
  text/tool-calls come from the scenario's `program`.
- `web-server-stub.js` / `connection-stub.js` — the two services the panel
  injects that a headless run does not otherwise provide. No socket is opened.
- `team-board-probe.js` — exports the live Team board at each turn end.
- `class-a-probe.js` — team profiles only: registers `terminal_open`,
  `create_worktree`, `ralph` and `subagent` with a body that writes a sentinel
  file, so a Lead refusal can be proven down to the tool body for class A tools
  the headless profile does not ship.

Isolation: `DSH_HOME` points at the temporary root (sessions, storages,
credentials), `DSH_PROFILE_DIR` points at the temporary profile (the plugin
stores its tree under it), and `DSH_PERMISSION_MODE=danger-full-access` picks
the shipped preset whose approval policy is `never` — a headless run has no
approval answerer. Nothing in the product is changed or switched on for tests.

## Limits

- The model is scripted, not a real provider: runs are deterministic and need
  no credentials, but a scenario can only see the tool calls its script makes.
- Subagents are scripted through `subagentResponses`, the `{{subagentId}}`
  placeholder and `waitForSubagentTurns`; a team scenario's teammates consume
  the same `subagentResponses` queue, but there is no `{{teammateId}}`
  placeholder or wait-for-teammate-turns helper.
- Killing a session mid-turn (crash injection) and concurrent multi-session
  scenarios are not built yet; the profile/run/export loop they need is in
  place.
- The harness assumes `dsh` is on `PATH` (override with `DSH_BIN`). It prefers
  a real PATH launcher over an npm-injected `node_modules/.bin` shim, because an
  ancestor project's older `dsh` may accept `--json` yet not resolve this
  profile's bundles.
