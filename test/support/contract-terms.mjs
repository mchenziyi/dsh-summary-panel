/**
 * One home for the vocabulary the teardown removed (ADR-0003).
 *
 * The contract checks each used to keep their own copy of "what is gone" and
 * their own idea of which lines are allowed to mention it. Three tickets of
 * deletions later those copies had drifted: a phrase added to one check stayed
 * legal in another, and a broad exemption let a live rule survive in a
 * "deprecated" block. A term is now added once, here, and every check that
 * consumes it changes together.
 */

/**
 * Surfaces ADR-0003 removed. A model-facing text that still names one is a
 * prompt advertising a call that now throws; client code that reads one renders
 * a branch the host can no longer satisfy; a doc that states one as a live rule
 * describes a product that no longer exists.
 */
export const REMOVED_SURFACES = Object.freeze([
  // The execution ledger: no execution ids, no execution state, no lost-executor
  // marker (the claim record is all the panel shows now).
  'executionId',
  'executorLost',
  'executionState',
  'ownerLost',
  'execution seat',
  'lifetime binding',
  // Ops that no longer exist.
  'resolveConflict',
  'team_task_update',
  '"force":true',
  'force: true',
  'force-release',
  'force release',
  // The gate's vocabulary.
  'class A',
]);

/**
 * The removed layer's names as a reader of the docs meets them. Kept apart from
 * `REMOVED_SURFACES` because these are prose, not payload identifiers: a doc
 * that describes one as current is selling a feature the code no longer has.
 */
export const DOC_GATE_PHRASES = Object.freeze([
  'execution gate',
  'execution ledger',
  'force release',
  '执行门禁',
  '执行位',
  '终身绑定',
  '强制释放',
  '执行账本',
  '执行号',
  '并发占位',
  '失联',
]);

/**
 * Words the maintenance prompt must not coach any more (ADR-0003 decision 3).
 * `claim` / `release` still exist as record ops in the tool schema; the prompt
 * just does not teach them. The rest are removed surfaces entirely.
 */
export const PROMPT_BANNED_TERMS = Object.freeze([
  'claim',
  'release',
  'execution seat',
  'lifetime binding',
]);

/**
 * A line that already says the thing it names is gone, or points at the
 * history. This is the one exemption: docs and contracts may name a removed
 * surface on a line that marks it removed, deprecated, or historical.
 */
export const HISTORY_LINE = /@deprecated|deprecated|已拆除|拆除|已删除|历史|老记录|旧|不再|ADR-0003/;

/** Whether `line` marks what it names as history rather than as a live rule. */
export function isHistoryLine(line) {
  return HISTORY_LINE.test(line);
}
