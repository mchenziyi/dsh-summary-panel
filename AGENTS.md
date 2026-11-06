# DSH Reins（缰绳）

A DSH summary panel: named markdown summaries of a session, plus the agent-maintained task tree. Host half runs inside the DSH process (`index.js`, `host/`); client half runs in the browser (`client.js`).

## Where things are

- `docs/implementation-status.md` — what ships in v0.3.7, the module map, test coverage, and the known limits. **Read this before exploring the code**, including the plugin-reload rule after Host changes.
- `docs/CONTRACT.md` — the Host/Client interface contract; it wins when it disagrees with the requirements doc (which stays in `~/Desktop/AI-TodoList/REQUIREMENTS.md`).
- `GLOSSARY.md` — the project's domain vocabulary. Use its words in names, comments and issues.
- `docs/plans/` — frozen designs that are not implemented yet.
- `CODING_STANDARDS.md` — what a reviewer enforces here, and how work is sliced. Read it before reviewing or planning tickets.
- `docs/agents/` — how the engineering skills consume this repo (issue tracker, triage labels, domain docs).

## Checks

`npm test` runs the harness suites and the test-isolation check; `npm run test:e2e` runs the real-process scenarios (needs a `dsh` launcher, see `test/e2e/README.md`). CI runs both. The pre-commit hook runs `npm test`; enable it once per clone with `git config core.hooksPath .githooks`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to same-name labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
