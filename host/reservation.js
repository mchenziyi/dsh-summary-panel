/**
 * The execution seat table (design v8 I14/I15, §9).
 *
 * An execution is committed to the task tree, but a claim is not atomic with
 * the tree write: the guard decides before dispatch, `store.update` commits
 * later, and a Team-board claim binds only in `tools/post-execute`. Two claims
 * that are in flight at the same instant would therefore both pass the coarse
 * checks. This module is the synchronous middle layer: the guard takes the seat
 * on the way in, so the second request sees the first one's uncommitted claim.
 *
 * Three keys, matching the three ways an execution can be double-booked:
 *
 * - `wl:<worklineId>` — the standard-mode single execution seat (I3);
 * - `wk:<sessionId>`  — one executor holds at most one execution (I2);
 * - `tk:<taskId>`     — one task is claimed by at most one executor (I1).
 *
 * A reservation is `inflight` from the moment the guard admits the call until
 * real end-of-call evidence releases it:
 *
 * - E1: the matching `tools/result` — the registry publishes one for every call
 *   that enters it, refusals, errors, aborts and timeouts included;
 * - E2: the owning Agent reports `idle` — a running Agent awaits its tool
 *   calls, so an idle Agent can have none in flight.
 *
 * A timer NEVER releases a seat: it only marks a reservation that outlived its
 * TTL as `suspect`, which still refuses new claims. Interruption, a failed
 * board write, and a refused claim are not end-of-call evidence either; they
 * release only when their own tool result arrives (and it always does).
 *
 * A call the host cannot correlate (`exec.callId` missing) is not reserved:
 * without an id there is no evidence to release it with, and a reservation
 * that can never be released would wedge the seat for the whole process. The
 * tree store still serializes such a call, so only the in-flight window is
 * lost.
 */

/** How long an unproven reservation stays `inflight` before it is marked suspect. */
export const SEAT_TTL_MS = 120_000;

/** How often the suspect sweep runs while the plugin is mounted. */
export const SEAT_SWEEP_MS = 30_000;

/** Task-tree ops that change who holds an execution (design v8 §9, I14). */
const TREE_SEAT_OPS = Object.freeze(new Set(['claim', 'release', 'complete']));

/** Team-board actions that change who holds an execution (design v8 §9, I14). */
const BOARD_SEAT_OPS = Object.freeze(new Set(['claim', 'release', 'complete', 'reopen']));

/** The three seat dimensions, in the order they are reported back. */
const DIMENSION_LABEL = Object.freeze({
  workline: 'the workline execution seat',
  executor: 'the executor seat',
  task: 'the task seat',
});

/**
 * The seat keys one call must hold, or undefined when the call changes no
 * execution ownership (design v8 §9: every ownership op takes `tk:`).
 *
 * `tool` is the registered tool name; `mode` is `standard` or `team`; the
 * caller's own workline is only used outside team mode, where the whole
 * workline shares one seat (an unknown mode keeps the seat: fail closed). The
 * task key is the tree task for `task_tree_write` and the board task for
 * `team_task_update` — the identifier the claim names.
 *
 * @param options - `{ tool, args, mode, worklineId, sessionId }`.
 * @returns `{ keys, action, taskId, sessionId, worklineId }`, or undefined.
 */
export function seatRequestFor({ tool, args, mode, worklineId, sessionId }) {
  if (typeof tool !== 'string' || tool === '') return undefined;
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  const keys = [];
  if (mode !== 'team' && typeof worklineId === 'string' && worklineId !== '') keys.push(`wl:${worklineId}`);
  keys.push(`wk:${sessionId}`);
  let action;
  if (tool === 'task_tree_write') {
    const ops = Array.isArray(args?.ops) ? args.ops : [];
    const ownership = ops.filter((op) => op !== null && typeof op === 'object' && TREE_SEAT_OPS.has(op.op));
    if (ownership.length === 0) return undefined;
    for (const op of ownership) {
      if (typeof op.id === 'string' && op.id !== '') keys.push(`tk:${op.id}`);
    }
    action = ownership.map((op) => op.op).join(',');
  } else if (tool === 'team_task_update') {
    action = args?.action;
    if (typeof action !== 'string' || !BOARD_SEAT_OPS.has(action)) return undefined;
    if (typeof args?.task_id === 'string' && args.task_id !== '') keys.push(`tk:${args.task_id}`);
  } else {
    return undefined;
  }
  return {
    keys,
    action,
    taskId: keys.filter((key) => key.startsWith('tk:')).map((key) => key.slice(3)).join(',') || undefined,
    sessionId,
    worklineId: typeof worklineId === 'string' ? worklineId : '',
  };
}

/**
 * Create the in-process seat table.
 *
 * `ttlMs` only decides when an unproven reservation becomes `suspect`; the
 * table never drops a key by time. `now` is injectable so the sweep can be
 * exercised without waiting.
 *
 * @param options - `{ ttlMs, now }`.
 * @returns the seat API: `{ reserve, release, releaseSession, sweep, size, entries }`.
 */
export function createSeatTable(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : SEAT_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  /** @type {Map<string, object>} keyed by requestId (the registry's call id). */
  const reservations = new Map();

  /** The dimension one blocked key belongs to, for the refusal reason. */
  function dimensionOf(key) {
    if (key.startsWith('wl:')) return 'workline';
    if (key.startsWith('wk:')) return 'executor';
    return 'task';
  }

  /**
   * Take the seat for one call.
   * @param request - `{ requestId, keys, tool, action, sessionId, worklineId }`.
   * @returns `{ ok: true, entry }` or `{ ok: false, holder }`.
   */
  function reserve(request) {
    const requestId = typeof request?.requestId === 'string' && request.requestId !== '' ? request.requestId : undefined;
    const keys = Array.isArray(request?.keys) ? request.keys.filter((key) => typeof key === 'string' && key !== '') : [];
    if (requestId === undefined || keys.length === 0) return { ok: true, skipped: true };
    const existing = reservations.get(requestId);
    if (existing !== undefined) return { ok: true, entry: existing, repeated: true };
    for (const reservation of reservations.values()) {
      const shared = reservation.keys.find((key) => keys.includes(key));
      if (shared === undefined) continue;
      return {
        ok: false,
        holder: {
          requestId: reservation.requestId,
          tool: reservation.tool,
          action: reservation.action,
          sessionId: reservation.sessionId,
          state: reservation.state,
          at: reservation.at,
          key: shared,
          dimension: dimensionOf(shared),
        },
      };
    }
    const entry = {
      requestId,
      keys,
      tool: typeof request?.tool === 'string' ? request.tool : '',
      action: typeof request?.action === 'string' ? request.action : '',
      sessionId: typeof request?.sessionId === 'string' ? request.sessionId : '',
      worklineId: typeof request?.worklineId === 'string' ? request.worklineId : '',
      taskId: typeof request?.taskId === 'string' ? request.taskId : '',
      state: 'inflight',
      at: now(),
    };
    reservations.set(requestId, entry);
    return { ok: true, entry };
  }

  /**
   * Release one reservation on real end-of-call evidence (E1 or E2).
   * @param requestId - the registry call id.
   * @returns whether a reservation was released.
   */
  function release(requestId) {
    if (typeof requestId !== 'string' || requestId === '') return false;
    return reservations.delete(requestId);
  }

  /**
   * Release every reservation owned by one session; used only for E2 (the
   * owning Agent went idle, so nothing of its can still be in flight).
   * @param sessionId - the Agent's session id.
   * @returns how many reservations were released.
   */
  function releaseSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return 0;
    let released = 0;
    for (const [requestId, reservation] of reservations) {
      if (reservation.sessionId !== sessionId) continue;
      reservations.delete(requestId);
      released += 1;
    }
    return released;
  }

  /**
   * Mark reservations that outlived the TTL as suspect. A suspect reservation
   * still blocks its keys: only real end-of-call evidence releases a seat.
   * @param at - the instant to compare against (defaults to the clock).
   * @returns the reservations newly marked suspect.
   */
  function sweep(at = now()) {
    const marked = [];
    for (const reservation of reservations.values()) {
      if (reservation.state !== 'inflight') continue;
      if (at - reservation.at < ttlMs) continue;
      reservation.state = 'suspect';
      reservation.suspectAt = at;
      marked.push(reservation);
    }
    return marked;
  }

  /** @returns the number of held seats. */
  function size() {
    return reservations.size;
  }

  /** @returns the held seats, for tests and diagnostics. */
  function entries() {
    return [...reservations.values()].map((reservation) => ({ ...reservation, keys: [...reservation.keys] }));
  }

  return { reserve, release, releaseSession, sweep, size, entries };
}

/**
 * The model-readable refusal of a claim whose seat is already held.
 * It names the in-flight call, the dimension that clashed, and the way out.
 */
export function seatDenialReason({ tool, sessionId, holder }) {
  const dimension = DIMENSION_LABEL[holder.dimension] ?? 'the execution seat';
  const lines = [
    `${tool} is refused for session ${sessionId}: ${dimension} is already reserved by an in-flight call`,
    `(${holder.tool} ${holder.action} for ${holder.key}, request ${holder.requestId}).`,
    'Two claims may not be in flight for the same workline, executor, or task;',
    'the earlier call releases its seat when its own tool result arrives (or its agent goes idle), then retry.',
  ];
  if (holder.state === 'suspect') {
    lines.push('That call never reported a result and is now marked suspect: a timer never releases a seat,'
      + ' so this key stays blocked until real end-of-call evidence arrives.');
  }
  return lines.join(' ');
}

/**
 * Register the end-of-call evidence that releases seats. A listener failure
 * must never break a tool result, so the observers are total functions.
 *
 * @param ctx - the plugin context.
 * @param deps - `{ seats, logger, intervalMs }`; `seats` is a seat table.
 * @returns whether the observers were registered.
 */
export function registerSeatObservers(ctx, { seats, logger = console, intervalMs = SEAT_SWEEP_MS } = {}) {
  if (seats === undefined || typeof ctx?.on !== 'function') return false;
  ctx.effect(() => ctx.on('tools/result', (exec) => {
    try {
      // E1: the registry publishes one result per call, including refusals.
      seats.release(exec?.callId);
    } catch {
      /* observation must never break the tool result */
    }
  }), 'summary-panel: seat release on tool result');

  ctx.effect(() => ctx.on('agent/status', ({ agent, status } = {}) => {
    if (status !== 'idle') return;
    try {
      // E2: a running Agent awaits its tool calls, so idle proves none is left.
      seats.releaseSession(typeof agent?.id === 'string' ? agent.id : undefined);
      seats.releaseSession(typeof agent?.session?.header?.id === 'string' ? agent.session.header.id : undefined);
      seats.releaseSession(typeof agent?.session?.id === 'string' ? agent.session.id : undefined);
    } catch {
      /* observation must never break the agent loop */
    }
  }), 'summary-panel: seat release on agent idle');

  // The timer is a suspicion sweep only: it marks, it never releases.
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        for (const reservation of seats.sweep()) {
          logger.warn(`[summary-panel] execution seat ${reservation.requestId} (${reservation.tool} ${reservation.action})`
            + ` never reported a result; marked suspect, still held`);
        }
      } catch {
        /* the sweep must never break the plugin */
      }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'summary-panel: seat suspicion sweep');
  return true;
}
