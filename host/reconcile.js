/**
 * Claim evidence and crash convergence (design v8 §6.1, §7, §8, I12, I17;
 * ticket #8).
 *
 * ## What may create an execution
 *
 * An execution exists only because a Worker's own Team-board claim committed.
 * Dispatch is routing and a board owner is not a claim, so neither ever creates
 * one. The Host must be able to prove a claim from independent facts (§7.2):
 *
 *   1. the intent journal entry written BEFORE the board call — the
 *      roster-resolved session id, the member name, and the revision the claim
 *      expected;
 *   2. the board's committed view — the revision advanced by exactly ONE, the
 *      owner is that member, and the task is `in_progress`;
 *   3. no Worker lifetime record saying that session already ended.
 *
 * Missing or contradictory facts never produce a guess. They produce a
 * workline-level conflict, which stops new claims for that task (I12) until a
 * human resolves it. A conflict is a workline record, never an execution state.
 *
 * ## Board first, ledger after
 *
 * A Team claim commits on the board inside the tool, and the ledger write
 * happens in the awaited post-execute observer. Reconciliation obeys the same
 * order: it only writes an execution for a board task the board itself shows as
 * `in_progress` with the expected owner.
 *
 * ## Convergence at restart
 *
 * The three mirrors (execution ledger, Worker lifetime record, the task's stamp)
 * are written in one atomic tree write, so they cannot disagree after a normal
 * run. A crash can still leave the board ahead of the tree, and a board
 * completion/release can outlive a ledger write. On the first tool call after a
 * (re)start the workline is reconciled once:
 *
 * - the board committed but the ledger did not → rebuild from the journal (the
 *   design's WAL), with `rebuiltFrom: "wal"`, exactly once;
 * - the board completed or released the task → end the execution, never revive
 *   it, and clear the stamp;
 * - a task that is done/deferred/archived → end whatever execution it holds
 *   (design I8);
 * - an execution whose worker session can no longer be resolved → mark it
 *   `orphaned` ("executor lost"); it keeps its stamp and is never silently
 *   released or handed to another session (design I0/I16);
 * - anything the evidence cannot prove → record a conflict and change nothing
 *   that grants permission.
 *
 * Every write is guarded by `executionId` (I17), so a stale decision about an
 * earlier round can never clear a newer one. The pass is idempotent: a second
 * restart finds nothing left to converge.
 */

import { callerOf } from './caller.js';
import { appendIntent, readJournal, unsettledIntents } from './journal.js';
import {
  bindTeamClaim, clearTaskExecution, cloneEnvelope, conflictStopReason, endExecutionRecord,
  recordConflict, unresolvedConflictFor,
} from './model.js';
import { teamMembershipOf, teamServiceOf } from './roster.js';
import { workerLifetimeOf } from './lifetime.js';

/** Whether a task may no longer hold a non-terminal execution (design I8). */
function isClosed(task) {
  return task.archived === true || task.deferred === true || task.status === 'done';
}

/** The end reason that mirrors why the task closed. */
function closureReason(task) {
  if (task.archived === true) return 'archived';
  if (task.deferred === true) return 'deferred';
  return 'completed';
}

/** The board task a tree task is associated with, when the board is readable. */
function boardTaskFor(board, task) {
  if (board === undefined || typeof task?.teamTaskId !== 'string') return undefined;
  return (Array.isArray(board.tasks) ? board.tasks : []).find((candidate) => candidate !== null
    && typeof candidate === 'object'
    && candidate.id === task.teamTaskId);
}

function messageOf(error) {
  return String(error?.message ?? error);
}

/** Replace a draft's fields in place, so callers holding the object see it. */
function settleEnvelope(target, source) {
  target.version = source.version;
  target.workline = source.workline;
  target.tasks = source.tasks;
}

/**
 * Reconcile one envelope against the board and the claim journal.
 *
 * Pure: the persisted envelope is never mutated (a clone is used), and every
 * change is described in `actions` so the caller can log what it decided.
 *
 * @param envelope - the persisted envelope.
 * @param facts - `{ now, teamMode, board, journal }`; `board` is `{ tasks }` or
 *   undefined when it could not be read, `journal` is the journal entry list.
 * @returns `{ envelope, changed, actions, conflicts, decisions }`.
 */
export function convergeWorkline(envelope, facts) {
  const now = typeof facts?.now === 'number' ? facts.now : Date.now();
  const teamMode = facts?.teamMode === true;
  const board = facts?.board !== undefined && facts.board !== null ? facts.board : undefined;
  const boardReadable = teamMode && board !== undefined;
  const journal = Array.isArray(facts?.journal) ? facts.journal : [];
  // sessionId -> 'active' | 'orphaned', resolved by the runtime before this
  // pure pass runs. A missing entry means "not resolved this time", so the
  // execution keeps the state it had. A worker whose persisted session still
  // resolves stays `active` even when it is not live: the same session can
  // resume it, and marking it orphaned would silently strip a restartable
  // worker. Only a session nothing can resolve becomes `orphaned` (executor lost).
  const sessionStates = facts?.sessionStates !== null && typeof facts?.sessionStates === 'object'
    ? facts.sessionStates
    : {};
  const state = cloneEnvelope(envelope);
  let changed = false;
  const actions = [];
  const conflicts = [];
  const decisions = [];

  // 0. Keep every non-terminal execution's lifecycle state honest (design v8
  //    I0/I16). This is what marks a lost executor WITHOUT ending its
  //    execution: the stamp stays, the worker keeps its lifetime record, and
  //    nobody else is handed the task. `orphaned` grants no class A permission;
  //    only the same session may return to `active`.
  for (const execution of state.workline.executions) {
    if (execution.state === 'ended') continue;
    const resolved = sessionStates[execution.sessionId];
    if (resolved !== 'active' && resolved !== 'orphaned') continue;
    if (execution.state === resolved) continue;
    execution.state = resolved;
    execution.updatedAt = now;
    changed = true;
    actions.push({
      kind: resolved === 'active' ? 'executor-active' : 'executor-lost',
      taskId: execution.taskId,
      executionId: execution.executionId,
      sessionId: execution.sessionId,
    });
  }

  const stop = (kind, taskId, evidence) => {
    const conflict = recordConflict(state.workline, {
      kind, taskId, scope: 'task', evidence, now,
    });
    if (conflict !== undefined) conflicts.push(conflict);
    changed = true;
    return conflict;
  };

  // A claim that provably never reached the board leaves nothing to rebuild:
  // dropping its intent is the design's "prepare, crashed, nothing written"
  // case, and it must not keep an expired intent alive forever.
  const abortIntents = (taskId, reason) => {
    for (const pending of unsettledIntents(journal, taskId)) {
      decisions.push({ requestId: pending.requestId, state: 'aborted', at: now, reason });
      actions.push({ kind: 'journal-aborted', taskId, executionId: null });
    }
  };

  // A claim whose ledger row already exists is settled, even when the crash
  // landed between the ledger write and the journal's committed entry: the
  // execution IS the proof that the intent completed.
  for (const pending of unsettledIntents(journal)) {
    const execution = state.workline.executions.find((entry) => entry.requestId === pending.requestId);
    if (execution === undefined) continue;
    decisions.push({
      requestId: pending.requestId, state: 'committed', executionId: execution.executionId, at: now,
    });
  }

  const taskIds = state.tasks
    .filter((task) => task !== null && typeof task === 'object' && typeof task.id === 'string')
    .map((task) => task.id);

  for (const taskId of taskIds) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) continue;
    const runningOf = () => state.workline.executions.filter((execution) => execution.state !== 'ended'
      && execution.taskId === taskId);

    // 1. A closed task may hold no execution (design I8). The execution is
    //    ended, never revived, and its stamp goes with it.
    if (isClosed(task)) {
      const reason = closureReason(task);
      const survivors = runningOf();
      for (const execution of survivors) {
        if (endExecutionRecord(state.workline, execution.executionId, reason, now) !== undefined) {
          actions.push({ kind: 'ended', taskId, executionId: execution.executionId, reason });
          changed = true;
        }
      }
      if (task.owner !== null && task.owner !== undefined) {
        const expected = typeof task.owner.executionId === 'string' ? task.owner.executionId : undefined;
        const cleared = clearTaskExecution(state.workline, task, { expectedExecutionId: expected, reason, now });
        actions.push({ kind: 'cleared-stamp', taskId, executionId: cleared ?? expected ?? null, reason });
        changed = true;
      }
      continue;
    }

    const running = runningOf();

    // 2. Two non-terminal executions for one task is contradictory evidence
    //    about who is working: report it and end neither.
    if (running.length > 1) {
      stop('seat-ambiguous', taskId, {
        executions: running.map((execution) => execution.executionId),
        sessions: running.map((execution) => execution.sessionId),
      });
      continue;
    }

    const execution = running[0];
    const stamp = task.owner ?? null;

    if (execution === undefined) {
      // 3. A stamp with no ledger record means the index lost the record. Fail
      //    closed: clear the stamp so nothing is granted, and stop.
      if (stamp !== null) {
        const expected = typeof stamp.executionId === 'string' ? stamp.executionId : undefined;
        clearTaskExecution(state.workline, task, { expectedExecutionId: expected, reason: 'reconciled', now });
        changed = true;
        stop('claim-without-record', taskId, {
          stamp: { sessionId: stamp.sessionId, executionId: stamp.executionId ?? null, member: stamp.member ?? null },
          executions: [],
        });
        continue;
      }
      if (!boardReadable) continue;
      const boardTask = boardTaskFor(board, task);
      // A board owner alone is not a claim: only a provable intent may rebuild.
      // Without a board owner the claim cannot have committed, so its intent is
      // stale and is dropped rather than kept as false evidence.
      if (boardTask === undefined || boardTask.status !== 'in_progress') {
        abortIntents(taskId, boardTask === undefined ? 'the board has no such task' : 'the board does not show it claimed');
        continue;
      }
      if (unresolvedConflictFor(state.workline, taskId) !== undefined) continue;
      const evidence = {
        boardRevision: boardTask.revision,
        ownerName: boardTask.ownerName ?? null,
        teamTaskId: task.teamTaskId,
      };
      const intents = unsettledIntents(journal, taskId);
      const intent = intents.length === 0 ? undefined : intents[intents.length - 1];
      if (intent === undefined) {
        stop('unproven-claim', taskId, { ...evidence, journal: 'no intent' });
        continue;
      }
      if (intent.member !== boardTask.ownerName) {
        stop('unproven-claim', taskId, { ...evidence, journalMember: intent.member ?? null, reason: 'owner mismatch' });
        continue;
      }
      const before = Number(intent.revisionBefore);
      if (!Number.isInteger(before)) {
        stop('unproven-claim', taskId, { ...evidence, revisionBefore: intent.revisionBefore ?? null, reason: 'no expected revision' });
        continue;
      }
      if (boardTask.revision === before) {
        // The claim never reached the board: drop the intent, grant nothing.
        abortIntents(taskId, 'board revision did not advance');
        continue;
      }
      if (boardTask.revision !== before + 1) {
        stop('unproven-claim', taskId, { ...evidence, revisionBefore: before, reason: 'revision moved by more than one' });
        continue;
      }
      const worker = workerLifetimeOf(state.workline, intent.sessionId);
      if (worker !== undefined && worker.state === 'ended') {
        stop('ended-but-owned', taskId, { ...evidence, sessionId: intent.sessionId, endReason: worker.endReason ?? null });
        continue;
      }
      let bound;
      try {
        bound = bindTeamClaim(state, {
          taskId,
          teamTaskId: task.teamTaskId,
          sessionId: intent.sessionId,
          member: intent.member,
          revision: boardTask.revision,
          requestId: intent.requestId,
          // The design (v8 §8.2) names the claim-intent journal the WAL and
          // this value `wal`; it only ever says where the row came from.
          rebuiltFrom: 'wal',
          now,
        });
      } catch (error) {
        stop('unproven-claim', taskId, { ...evidence, reason: messageOf(error) });
        continue;
      }
      settleEnvelope(state, bound.envelope);
      changed = true;
      actions.push({ kind: 'rebuilt', taskId, executionId: bound.executionId });
      decisions.push({ requestId: intent.requestId, state: 'committed', executionId: bound.executionId, at: now, reconciled: true });
      continue;
    }

    // 4. An execution without its stamp (or naming another one) is a broken
    //    mirror: stop instead of choosing which half to believe.
    if (stamp === null || stamp.executionId !== execution.executionId) {
      stop('claim-without-record', taskId, {
        executionId: execution.executionId,
        sessionId: execution.sessionId,
        stamp: stamp === null ? null : { sessionId: stamp.sessionId, executionId: stamp.executionId ?? null },
      });
      continue;
    }

    if (!boardReadable) continue;
    // Only a task associated with a board task has a board to agree with. A
    // standard-mode task inside a team workline is reconciled against its own
    // stamp and ledger alone.
    if (typeof task.teamTaskId !== 'string') continue;
    const boardTask = boardTaskFor(board, task);
    if (boardTask === undefined) {
      stop('claim-without-record', taskId, {
        executionId: execution.executionId,
        teamTaskId: task.teamTaskId,
        reason: 'the board has no such task',
      });
      continue;
    }
    // 5. The board is the authority for team ownership; the ledger follows it.
    if (boardTask.status === 'in_progress' && boardTask.ownerName === execution.member) continue;
    if (boardTask.status === 'completed') {
      endExecutionRecord(state.workline, execution.executionId, 'completed', now);
      clearTaskExecution(state.workline, task, { expectedExecutionId: execution.executionId, reason: 'completed', now });
      changed = true;
      actions.push({ kind: 'ended', taskId, executionId: execution.executionId, reason: 'completed' });
      continue;
    }
    if (boardTask.status === 'pending') {
      endExecutionRecord(state.workline, execution.executionId, 'board-released', now);
      clearTaskExecution(state.workline, task, { expectedExecutionId: execution.executionId, reason: 'board-released', now });
      changed = true;
      actions.push({ kind: 'ended', taskId, executionId: execution.executionId, reason: 'board-released' });
      continue;
    }
    // The board still holds it, but for someone else: contradictory evidence.
    stop('seat-ambiguous', taskId, {
      executionId: execution.executionId,
      ledgerMember: execution.member ?? null,
      boardOwner: boardTask.ownerName ?? null,
      boardRevision: boardTask.revision,
    });
  }

  // 6. An execution whose task is gone cannot be held by anyone.
  for (const execution of state.workline.executions.filter((entry) => entry.state !== 'ended')) {
    if (state.tasks.some((task) => task.id === execution.taskId)) continue;
    endExecutionRecord(state.workline, execution.executionId, 'reconciled', now);
    changed = true;
    actions.push({ kind: 'ended', taskId: execution.taskId, executionId: execution.executionId, reason: 'reconciled' });
  }

  // 7. One session may hold one execution (design I2). Two is contradictory
  //    evidence about who is working: report it, end neither.
  const bySession = new Map();
  for (const execution of state.workline.executions.filter((entry) => entry.state !== 'ended')) {
    const list = bySession.get(execution.sessionId) ?? [];
    list.push(execution);
    bySession.set(execution.sessionId, list);
  }
  for (const [sessionId, list] of bySession) {
    if (list.length < 2) continue;
    stop('seat-ambiguous', list[0].taskId, {
      sessionId,
      executions: list.map((execution) => execution.executionId),
      tasks: list.map((execution) => execution.taskId),
    });
  }

  if (changed) state.workline.updatedAt = now;
  return { envelope: state, changed, actions, conflicts, decisions };
}

/**
 * Everything reconciliation needs about one call: its workline, its Team
 * membership, and the authoritative board when this profile has one.
 *
 * The board is read through the live Lead Agent, because only a live Team
 * member may read it. When it cannot be read, the pass reconciles the tree
 * alone and the next call tries again.
 */
async function factsFor(ctx, exec, sessions, store) {
  const agentTeams = teamServiceOf(ctx);
  const membership = agentTeams === undefined ? undefined : teamMembershipOf(agentTeams, exec?.agent);
  const caller = callerOf(exec);
  let worklineId = typeof membership?.root?.id === 'string' ? membership.root.id : undefined;
  if (worklineId === undefined && caller.sessionId !== undefined) {
    try {
      worklineId = await sessions.rootSessionId(caller.sessionId, caller.header);
    } catch {
      worklineId = undefined;
    }
  }
  // Resolve every non-terminal executor before the pure pass runs: `active`
  // (live, or persisted and able to resume) or `orphaned` (unresolvable =
  // lost). The runtime, not the tree, owns this answer; when it cannot be read
  // the pass keeps the persisted state instead of guessing (fail closed).
  let sessionStates;
  if (worklineId !== undefined) {
    try {
      const envelope = await store.read(worklineId);
      const executions = Array.isArray(envelope?.workline?.executions) ? envelope.workline.executions : [];
      const states = {};
      for (const execution of executions) {
        if (execution === null || typeof execution !== 'object' || execution.state === 'ended') continue;
        const sessionId = execution.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '' || states[sessionId] !== undefined) continue;
        states[sessionId] = await sessions.resolveSession(sessionId);
      }
      sessionStates = states;
    } catch {
      sessionStates = undefined;
    }
  }
  let board;
  if (agentTeams !== undefined && typeof agentTeams.listTasks === 'function') {
    const authority = membership?.root !== null && typeof membership?.root === 'object' ? membership.root : exec?.agent;
    try {
      const tasks = agentTeams.listTasks(authority);
      if (Array.isArray(tasks)) board = { tasks };
    } catch {
      /* an unreadable board proves nothing: reconcile the tree alone */
    }
  }
  return { membership, caller, worklineId, teamMode: agentTeams !== undefined, board, sessionStates };
}

/**
 * Register the evidence pass on the plugin context:
 *
 * - `tools/pre-execute` reconciles each workline once per process (before the
 *   guard reads the tree), then journals a claim intent BEFORE the board call;
 * - `tools/post-execute` settles that intent from the real tool result and the
 *   ledger the claim binding just wrote.
 *
 * Every handler is total: observation must never rewrite a committed tool
 * result or break the agent loop.
 *
 * @param ctx - the plugin context.
 * @param deps - `{ store, sessions, logger }`.
 * @returns whether the observers were registered.
 */
export function registerEvidence(ctx, { store, sessions, logger = console } = {}) {
  if (store === undefined || typeof store.update !== 'function' || typeof store.snapshot !== 'function') return false;
  if (sessions === undefined || typeof sessions.rootSessionId !== 'function') return false;
  if (typeof ctx.on !== 'function') return false;

  /** worklineId -> reconcile promise; set only once the pass saw all evidence. */
  const reconciled = new Map();
  /** callId -> workline the intent was written for. */
  const journaled = new Map();

  const warn = (text) => {
    try {
      logger.warn(text);
    } catch {
      /* logging must never break a call */
    }
  };

  /** The claim intent that must be durable BEFORE the board call. */
  function claimIntent({ exec, membership, worklineId }) {
    if (membership === undefined || membership.role !== 'teammate') return undefined;
    if (exec.name !== 'team_task_update') return undefined;
    const args = exec.arguments;
    if (args === null || typeof args !== 'object' || args.action !== 'claim') return undefined;
    if (typeof args.task_id !== 'string' || args.task_id === '') return undefined;
    if (typeof exec.callId !== 'string' || exec.callId === '') return undefined;
    if (!Number.isInteger(args.expected_revision)) return undefined;
    let tree;
    try {
      tree = store.snapshot(worklineId);
    } catch {
      return undefined;
    }
    if (tree.present !== true) return undefined;
    const task = (Array.isArray(tree.tasks) ? tree.tasks : []).find((candidate) => candidate !== null
      && typeof candidate === 'object'
      && candidate.archived !== true
      && candidate.teamTaskId === args.task_id);
    if (task === undefined) return undefined;
    if (task.dispatch === null || task.dispatch === undefined || task.dispatch.member !== membership.name) return undefined;
    if (task.owner !== null && task.owner !== undefined) return undefined;
    if (task.deferred === true || task.status === 'done') return undefined;
    // A stopped task is refused by the guard before the board; journaling it
    // would leave false evidence behind.
    const stopped = (Array.isArray(tree.conflicts) ? tree.conflicts : []).find((conflict) => conflict !== null
      && typeof conflict === 'object'
      && conflict.resolvedAt === null
      && (conflict.taskId === task.id || conflict.scope === 'workline'));
    if (stopped !== undefined) return undefined;
    return {
      requestId: exec.callId,
      state: 'prepared',
      intent: 'claim',
      taskId: task.id,
      teamTaskId: args.task_id,
      sessionId: membership.sessionId,
      member: membership.name,
      revisionBefore: args.expected_revision,
      at: Date.now(),
    };
  }

  /** Reconcile one workline once, before the guard reads its snapshot. */
  function reconcileOnce({ worklineId, board, teamMode, sessionStates }) {
    const existing = reconciled.get(worklineId);
    if (existing !== undefined) return existing;
    let present;
    try {
      present = store.snapshot(worklineId).present === true;
    } catch {
      return Promise.resolve(undefined);
    }
    if (!present) return Promise.resolve(undefined);
    // Team mode without a readable board cannot adjudicate a claim, but the
    // tree-only rules (a closed task holds no execution, one session holds one,
    // a stamp without a record) do not need a board. Run them, and leave the
    // workline uncached so a later call with a readable board can finish the
    // job instead of the workline being marked converged too early.
    const conclusive = !teamMode || board !== undefined;
    const run = (async () => {
      const journal = readJournal(store.root, worklineId);
      let converged;
      let outcome;
      try {
        outcome = await store.update(worklineId, (current) => {
          if (current === undefined) return undefined;
          converged = convergeWorkline(current, {
            now: Date.now(), teamMode, board, journal: journal.entries, sessionStates,
          });
          if (converged.changed !== true) return undefined;
          return { envelope: converged.envelope };
        });
      } catch (error) {
        reconciled.delete(worklineId);
        warn(`[summary-panel] reconciliation of workline ${worklineId} failed: ${messageOf(error)}`);
        return undefined;
      }
      for (const decision of converged?.decisions ?? []) {
        appendIntent(store.root, worklineId, decision);
      }
      for (const conflict of converged?.conflicts ?? []) {
        if (conflict.taskId === null) continue;
        warn(`[summary-panel] workline ${worklineId}: ${conflictStopReason(conflict.taskId, conflict)}`);
      }
      for (const action of converged?.actions ?? []) {
        if (action.kind === 'rebuilt') {
          warn(`[summary-panel] workline ${worklineId}: rebuilt execution ${action.executionId} for task ${action.taskId} from the claim journal`);
        } else if (action.kind === 'journal-aborted') {
          warn(`[summary-panel] workline ${worklineId}: dropped a stale claim intent for task ${action.taskId}`);
        } else if (action.kind === 'executor-lost') {
          warn(`[summary-panel] workline ${worklineId}: executor ${action.sessionId} for task ${action.taskId}`
            + ` (execution ${action.executionId}) can no longer be resolved; the execution is marked orphaned`
            + ' (executor lost), still holds the task, and needs a Lead force release');
        }
      }
      return outcome;
    })();
    if (conclusive) reconciled.set(worklineId, run);
    return run;
  }

  /** Settle one journaled intent from the real tool result and the real ledger. */
  async function settleClaim({ exec, result }) {
    const callId = exec?.callId;
    const pending = journaled.get(callId);
    if (pending === undefined) return;
    journaled.delete(callId);
    const at = Date.now();
    if (result === null || typeof result !== 'object' || result.isError === true) {
      appendIntent(store.root, pending.worklineId, { requestId: callId, state: 'aborted', at, reason: 'the claim call failed' });
      return;
    }
    let envelope;
    try {
      envelope = await store.read(pending.worklineId);
    } catch {
      return;
    }
    const executions = Array.isArray(envelope?.workline?.executions) ? envelope.workline.executions : [];
    const execution = executions.find((entry) => entry.requestId === callId);
    // No ledger row yet: the evidence is incomplete, so the intent stays
    // prepared and a restart has to adjudicate it. Never guess here.
    if (execution === undefined) return;
    appendIntent(store.root, pending.worklineId, {
      requestId: callId, state: 'committed', executionId: execution.executionId, at,
    });
  }

  const pre = async (exec, next) => {
    try {
      const facts = await factsFor(ctx, exec, sessions, store);
      if (facts.worklineId !== undefined) {
        // Reconcile BEFORE deciding anything: the guard reads the store's
        // snapshot right after this hook, so it must see the converged state.
        await reconcileOnce({
          worklineId: facts.worklineId,
          board: facts.board,
          teamMode: facts.teamMode,
          sessionStates: facts.sessionStates,
        });
        const intent = claimIntent({ exec, membership: facts.membership, worklineId: facts.worklineId });
        if (intent !== undefined && appendIntent(store.root, facts.worklineId, intent)) {
          journaled.set(intent.requestId, { worklineId: facts.worklineId });
        }
      }
    } catch (error) {
      warn(`[summary-panel] evidence pass failed: ${messageOf(error)}`);
    }
    return next();
  };

  const post = async (exec, result, next) => {
    try {
      await settleClaim({ exec, result });
    } catch (error) {
      warn(`[summary-panel] claim journal settlement failed: ${messageOf(error)}`);
    }
    return next();
  };

  ctx.effect(() => ctx.on('tools/pre-execute', pre), 'summary-panel: claim evidence');
  ctx.effect(() => ctx.on('tools/post-execute', post), 'summary-panel: claim journal settlement');
  return true;
}
