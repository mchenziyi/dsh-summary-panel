# Coding standards

What a reviewer should enforce here. Every rule below is a judgement call — the
mechanical ones already have a check, and duplicating a check as prose just
gives it somewhere to go stale.

The mechanical checks, for reference: `npm test` (harness suites plus the test
isolation check) and `npm run test:e2e` (real processes). Both run in CI and in
the pre-commit hook.

## Review focus

Two defect shapes have shipped from this repo more than once. Check for both on
every change that adds a guard or a terminal action.

**1. A guard's default when its data is missing.** For each new permission check
ask what happens when the record it reads is absent, empty, or unreadable, and
require the deny direction. The execution gate once allowed every workspace
write when the ledger array was absent; the fix was a single normalizer with a
fail-closed default. A guard that grants on missing data is worse than no guard,
because the read model still reports the execution as missing.

**2. A terminal action reachable from another entry point.** For each new way to
end something, enumerate the other operations that can reach the same state, and
require the caller to prove they cannot bypass it. `defer` and `archive` could
end another session's execution without an interrupt, straight through the
force-termination flow the design put in place.

Two more that cost real time:

- **A comment states the invariant the code keeps now.** When a rule changes,
  the comment above it changes in the same commit; the review caught a comment
  still describing the rule it had just replaced.
- **Two modules must not hold the same truth.** Before adding a record, find out
  whether something already normalizes it. Two normalizers of one field with
  opposite defaults is how the fail-open above arrived.

## Working agreements

**Ticket slicing follows file ownership, not just capability.** A vertical slice
that has to edit the same core module as another slice cannot run in parallel
with it. When a feature has a shared core — a ledger, a state machine, a gate —
land that core as its own ticket first, then let the slices fan out. Slicing
`#7` and `#8` by capability put two independent worker/ledger layers in flight at
once and cost a full rebuild of one ticket.

**A ticket's acceptance is a user-visible fact**, not an internal call. "The
second claim was refused" is acceptable; "`applyClaim` returned an error" is not.
