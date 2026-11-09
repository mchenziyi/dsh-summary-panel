# DSH Reins（缰绳）

A DSH summary panel: named markdown summaries of a session, plus the agent-maintained task tree. Host half runs inside the DSH process (`index.js`, `host/`); client half runs in the browser (`client.js`).

## Where things are

- `docs/implementation-status.md` — what ships in v0.3.7, the module map, test coverage, and the known limits. **Read this before exploring the code**, including the plugin-reload rule after Host changes.
- `docs/requirements/REQUIREMENTS.md` — the product's promise, in the repo: what this panel is for (§1.3 "not a goal") and what v1 explicitly does not build (§14). Read this before judging whether a change is worth making; the one-screen summary at the top is enough to orient.
- `docs/CONTRACT.md` — the Host/Client **interface** contract only. It does not decide what the product does; where the two documents do not overlap, each governs its own area.
- `GLOSSARY.md` — the project's domain vocabulary. Use its words in names, comments and issues.
- `docs/plans/archive/` — finished historical designs (v8 is fully implemented, 10/10 slices); not a to-do list. Do not continue them; new direction comes from `docs/requirements/REQUIREMENTS.md`.
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
