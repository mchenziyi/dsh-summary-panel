# Coding standards

What a reviewer should enforce here. Every rule below is a judgement call — the
mechanical ones already have a check, and duplicating a check as prose just
gives it somewhere to go stale.

The mechanical checks, for reference: `npm test` (harness suites, harness
hygiene, the docs-contract check) and `npm run test:e2e` (real processes). Both
run in CI and in the pre-commit hook.

## Review focus

Three defect shapes have shipped from this repo more than once. Check each one
where its shape still exists.

**1. Human visibility.** Every change must either make the panel better at showing
"where the work stands now", or say in the PR/report why this change does not
touch that. The test is whether a **person** can see the fact by opening the panel
or reading the README — not whether an agent can be blocked. A ticket that only
adds a denial path makes the machine stricter without making the product clearer,
so it needs the extra sentence saying why.

**2. A guard's default when its data is missing.** The gate from v0.3.x is gone, so
this now covers the checks that still exist — the `claim` compare-and-set and
`executionApproval` — and any new one. Ask what happens when the record it reads
is absent, empty, or unreadable, and require the deny direction: a guard that
grants on missing data is worse than no guard. (The gate once allowed every
workspace write when the ledger array was absent.)

**3. A terminal action reachable from another entry point.** Execution lifecycles
and force release are gone; the remaining terminal actions are `complete`,
`defer` and `archive`. For each new way to end something, enumerate the other
operations that can reach the same state, and require the caller to prove they
cannot bypass it. (`defer` and `archive` once ended another session's execution
without an interrupt.)

A few more that cost real time:

- **A comment states the invariant the code keeps now.** When a rule changes,
  the comment above it changes in the same commit; the review caught a comment
  still describing the rule it had just replaced.
- **Two modules must not hold the same truth.** Before adding a record, find out
  whether something already normalizes it. Two normalizers of one field with
  opposite defaults is how the fail-open above arrived.
- **Approval and acceptance guidance must agree.** When either rule changes,
  compare the Agent prompt and reminders, the tool description and field
  descriptions, the rejection message, and the interface contract. Check when
  work stays pending, when an existing user quote applies, and when to ask.
  Keep dialogue decisions in the Agent guidance. Use the contract's invariants
  for Host checks and refer to them from operation summaries.
- **A document does not cache a count the repo can report.** The e2e scenario
  count was restated in three docs and drifted (18 → "12 deleted"); the
  environment already answers it (`npm run test:e2e -- --list`). Point at the
  command instead of writing the number.

## Working agreements

**Ticket slicing follows file ownership, not just capability.** A vertical slice
that has to edit the same core module as another slice cannot run in parallel
with it. When a feature has a shared core — a ledger, a state machine, a gate —
land that core as its own ticket first, then let the slices fan out. Slicing
`#7` and `#8` by capability put two independent worker/ledger layers in flight at
once and cost a full rebuild of one ticket.

**A ticket's acceptance is a user-visible fact**, not an internal call. "The
second claim was refused" is acceptable; "`applyClaim` returned an error" is not.
For a panel product, a user-visible fact means first of all **what a person can
see in the panel**: a row, a colour, a hover summary, a screenshot in the README.
An agent's experience of being blocked is not by itself the user's experience.
