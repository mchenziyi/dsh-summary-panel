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
| `claim-journal.json` | `<profile>/agent-task-tree/<session>.claims.jsonl` on disk | the claim-intent journal written before a Team-board claim |
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
- `team-lead` — team mode makes the Lead a pure coordinator: with no tree yet
  and with a tree present, every class A family (`write`, `edit`, `bash`,
  `workflow`, `terminal_open`, `create_worktree`, `ralph`, `subagent`) is
  refused with the team-mode reason and leaves nothing on disk; the Lead cannot
  create a team execution with `task_tree_write claim`; `task_tree_*`, the Team
  task tools, `spawn_teammate` (a real teammate), messaging and reads keep
  working.
- `seat-race` — team-mode concurrent seats: one Worker racing two board
  claims wins one and the seat refuses the other before the board, a held seat
  refuses a third claim, duplicate claims for one board task produce one
  winner, a board-refused claim frees its seat for the retry, and two Workers
  contending for one task leave exactly one owner.
- `seat-standard` — standard-mode single seat: one session racing two claims
  wins one, a held seat refuses a third, a refused call frees its seat for the
  retry, and the Lead racing a real subagent for two tasks produces one
  winner — the whole workline shares one execution seat.
- `team-bind` — claim-first binding: the Lead dispatches two tree tasks to two
  named Workers, both unbound Workers' writes are refused, each Worker claims
  its own board task and only then writes, a second member's claim of the first
  task (even with `owner: "worker-a"` in the arguments) and its write are
  refused, the tree turns both tasks `in_progress` with the roster-resolved
  executor (`worker-a`/`worker-b` plus their real session ids), and
  `team_task_update reassign` is refused without changing the board.
- `worker-lifetime` — one task per Worker in team mode: worker-a completes its
  board task and is refused a second, worker-b releases its task and is refused
  a second, the tree keeps both ended lifetime records keyed by session id, and
  a new Worker (worker-c) claims the released task with a new execution id.
- `worker-lifetime-standard` — the same rule for a standard-mode subagent: it
  releases its task, is refused a second one, a new subagent retries the same
  task with a new execution id, and the Lead (exempt) does three tasks with
  three distinct execution ids.
- `execution-evidence` — only a real claim creates an execution: one board task
  is dispatched to a Worker that never claims (no ledger row, no class A
  permission, board still pending), the other is claimed and then completed by
  its Worker (the journal records the intent before the board and the settlement
  after it; the completed task's execution ends, the stamp clears, and the
  Worker loses class A).
- `crash-reconcile` — a real SIGKILL between the board commit and the ledger
  write (run 1), then two resumed runs: the restart rebuilds exactly one
  execution from the journal plus the replayed board (`rebuiltFrom:
  "wal"`), the second restart leaves it unchanged, and the write the crashed
  Worker never reached never landed.
- `evidence-conflict` — the same crash with the journal removed before the
  restart: the board still owns the task, so the workline records one
  unresolved `unproven-claim` conflict, creates no execution, and the guard
  refuses a fresh Worker's claim before the board is touched.

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
- `class-a-probe.js` — team profiles only: registers `terminal_open`,
  `create_worktree`, `ralph` and `subagent` with a body that writes a sentinel
  file, so a Lead refusal can be proven down to the tool body for class A tools
  the headless profile does not ship.
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
  teammate's turn with `waitForTeammate: "<name>"`; a teammate's session id is
  never exposed to the model, so scenarios identify it from the tool transcript.
- A scripted model issues one tool call per step, so two calls can never be in
  flight at the same instant from its own turn. The seat scenarios therefore
  drive concurrency through `seat-race-probe.js`, a fixture tool that calls the
  real `tools.execute` pipeline twice without awaiting: pre-execute policy,
  guards, tool bodies, stores and the Team board are all the product's, only
  the dispatch instant is scripted. A crash scenario kills the whole process
  mid-turn with the `crash-injector` fixture instead.
- The harness assumes `dsh` is on `PATH` (override with `DSH_BIN`). It prefers
  a real PATH launcher over an npm-injected `node_modules/.bin` shim, because an
  ancestor project's older `dsh` may accept `--json` yet not resolve this
  profile's bundles.
