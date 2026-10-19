/**
 * Host half of the summary panel bundle.
 *
 * Serves read-only JSON endpoints under `/summary-panel/*` for the browser
 * summary panel: `git`, `outputs`, `diff`, `subagents`, and `sources`.
 *
 * Every route answers through the composition's `connection` trust fence and
 * carries `cache-control: no-store`: the panel polls while it is open and the
 * values are live facts.
 *
 * Git runs through the `subprocess` capability with the same hardened
 * environment the workspace-changes recorder uses (no terminal prompts, no
 * optional locks, ambient git configuration excluded, bounded output).
 */

export const name = 'summary-panel';

export const inject = ['webServer', 'connection', 'sessions', 'subprocess'];

const PREFIX = '/summary-panel';
const GIT_TIMEOUT_MS = 6000;
const GIT_STDOUT_BYTES = 2 * 1024 * 1024;
const GIT_STDERR_BYTES = 64 * 1024;
const MAX_BRANCHES = 200;
const MAX_COMMITS = 60;
const MAX_EVENTS = 4000;
const SESSION_SCOPE_EVENTS = 20000;
const MAX_DIFF_LINES = 4000;

/**
 * Register one exact GET route behind the connection trust fence.
 * @param ctx - the plugin context.
 * @param path - suffix under the summary-panel prefix.
 * @param handler - async (context, session, url) => JSON payload.
 */
function route(ctx, path, handler) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + path,
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end();
          return;
        }
        const rejection = rejectUntrusted(ctx, req);
        if (rejection !== undefined) {
          res.statusCode = rejection;
          res.end();
          return;
        }
        const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1');
        const id = url.searchParams.get('sessionId');
        if (id === null || id === '') {
          sendJson(res, 400, { error: 'missing-session' });
          return;
        }
        const session = await sessionView(ctx, id);
        if (session === undefined) {
          sendJson(res, 404, { error: 'unknown-session' });
          return;
        }
        sendJson(res, 200, await handler(ctx, session, url));
      } catch (error) {
        sendJson(res, 500, { error: 'internal', message: String(error?.message ?? error) });
      }
    },
  }), `summary-panel: GET ${PREFIX}${path}`);
}

/** The connection fence's rejection status, or undefined when admitted. */
function rejectUntrusted(ctx, req) {
  const connection = ctx.get('connection');
  if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined;
  try {
    return connection.requestRejection(req);
  } catch {
    return 403;
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * One session's readable facts: the live Session when this process holds it,
 * otherwise the persisted log (completed subagent conversations outlive their
 * Agent).
 */
async function sessionView(ctx, id) {
  const sessions = ctx.get('sessions');
  const live = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(id) : undefined;
  if (live !== undefined) {
    return {
      id: live.id,
      live,
      header: live.header,
      seq: live.seq,
      snapshotEvents: (from = 0) => live.snapshotEvents(from),
    };
  }
  return persistedView(ctx, id);
}

async function persistedView(ctx, id) {
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined || typeof persistence.open !== 'function' || typeof persistence.stat !== 'function') {
    return undefined;
  }
  let snapshot;
  try {
    snapshot = await persistence.stat(id);
  } catch {
    snapshot = undefined;
  }
  if (snapshot === undefined) return undefined;

  let handle;
  try {
    handle = await persistence.open(id, 'read');
  } catch {
    return undefined;
  }
  try {
    const count = typeof snapshot.eventCount === 'number' ? snapshot.eventCount : undefined;
    const offset = count === undefined ? 0 : Math.max(0, count - MAX_EVENTS);
    const result = await handle.read(offset);
    const events = Array.isArray(result?.events) ? result.events : [];
    return {
      id,
      live: undefined,
      header: handle.header ?? snapshot.header,
      seq: offset + events.length,
      snapshotEvents: (from = 0) => events.filter((event) => Number(event.seq) >= Number(from)),
    };
  } catch {
    return undefined;
  } finally {
    try {
      await handle.close();
    } catch {
      /* ignore close failures */
    }
  }
}

/** The Session's effective working directory, falling back to its creation cwd. */
function sessionCwd(ctx, session) {
  if (session.live !== undefined) {
    const workingDirectory = ctx.get('workingDirectory');
    if (workingDirectory !== undefined && typeof workingDirectory.get === 'function') {
      try {
        const effective = workingDirectory.get(session.live);
        if (typeof effective === 'string' && effective !== '') return effective;
      } catch {
        /* fall through to the immutable header cwd */
      }
    }
  }
  const headerCwd = session.header?.cwd;
  return typeof headerCwd === 'string' && headerCwd !== '' ? headerCwd : undefined;
}

function baseName(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts.length === 0 ? String(path) : parts[parts.length - 1];
}

/** The most recent Session events (bounded tail scan). */
function tailEvents(session, limit = MAX_EVENTS) {
  try {
    const end = Number(session.seq) || 0;
    const from = Math.max(0, end - limit);
    return session.snapshotEvents(from);
  } catch {
    try {
      return session.snapshotEvents();
    } catch {
      return [];
    }
  }
}

function safeParseJson(text) {
  if (typeof text !== 'string' || text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Repository-relative path check: no absolute paths, no parent traversal. */
function isSafeRepoPath(path) {
  if (typeof path !== 'string' || path === '') return false;
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]/).some((segment) => segment === '..');
}

// ---------------------------------------------------------------------------
// file addresses (mirror of @deepseek-ai/dsh-util-workspace-path)
// ---------------------------------------------------------------------------

function encodeFileSegment(segment) {
  return encodeURIComponent(segment).replace(/%3A/gi, ':');
}

function sessionFileAddress(sessionId, path) {
  const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return `dsh-resource://file/session/${encodeFileSegment(String(sessionId))}/${normalized.split('/').map(encodeFileSegment).join('/')}`;
}

/** The Sidebar's file address for one path, relative to the Session root when possible. */
function fileAddressFor(sessionId, cwd, path) {
  const normalized = String(path).replace(/\\/g, '/');
  const root = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//');
  if (!absolute) return sessionFileAddress(sessionId, normalized);
  if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '');
  if (root !== '' && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
  return sessionFileAddress(sessionId, normalized);
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

function withDeadline(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer),
  };
}

/**
 * Run one git command in collect mode.
 * @returns exit facts plus the collected stdout/stderr text, or undefined when
 * the process could not start at all.
 */
async function runGit(ctx, cwd, args, signal) {
  let handle;
  try {
    handle = ctx.subprocess.spawn({
      argv: ['git', ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: GIT_STDOUT_BYTES },
        stderr: { maxBytes: GIT_STDERR_BYTES },
      },
      graceMs: 2000,
      signal,
      env: {
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '0',
        GIT_PAGER: 'cat',
        LC_ALL: 'C',
        LANG: 'C',
      },
    });
  } catch {
    return undefined;
  }
  try {
    const outcome = await handle.done;
    const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '';
    const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '';
    return { code: outcome.exitCode, stdout, stderr };
  } catch {
    return undefined;
  }
}

let nullDevicePromise;

/** The execution world's null device, for `git diff --no-index` on an untracked file. */
function nullDevice(ctx) {
  if (nullDevicePromise === undefined) {
    nullDevicePromise = (async () => {
      try {
        const environment = await ctx.subprocess.terminalEnvironment();
        if (environment !== undefined && environment.platform === 'windows') return 'NUL';
        return '/dev/null';
      } catch {
        return process.platform === 'win32' ? 'NUL' : '/dev/null';
      }
    })();
  }
  return nullDevicePromise;
}

/** Find the repository root for the Session's working directory, or undefined. */
async function repoRoot(ctx, session, signal) {
  const cwd = sessionCwd(ctx, session);
  if (cwd === undefined) return undefined;
  const probe = await runGit(ctx, cwd, ['rev-parse', '--show-toplevel'], signal);
  if (probe === undefined || probe.code !== 0) return undefined;
  const root = probe.stdout.trim();
  return root === '' ? undefined : root;
}

function parseStatus(text) {
  const status = {
    branch: undefined,
    upstream: undefined,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0,
  };
  for (const line of String(text).split('\n')) {
    if (line === '') continue;
    if (line.startsWith('# branch.head ')) {
      status.branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
    } else if (line[0] === '1' || line[0] === '2') {
      const xy = line.slice(2, 4);
      if (xy[0] !== undefined && xy[0] !== '.') status.staged += 1;
      if (xy[1] !== undefined && xy[1] !== '.') status.modified += 1;
    } else if (line[0] === 'u') {
      status.conflicted += 1;
    } else if (line[0] === '?') {
      status.untracked += 1;
    }
  }
  return status;
}

function parseBranches(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    if (line === '') continue;
    const parts = line.split('\u0000');
    const name = parts[0];
    if (typeof name !== 'string' || name === '') continue;
    const upstream = typeof parts[1] === 'string' ? parts[1] : '';
    const track = typeof parts[2] === 'string' ? parts[2] : '';
    const head = typeof parts[3] === 'string' ? parts[3].trim() : '';
    const aheadMatch = /ahead (\d+)/.exec(track);
    const behindMatch = /behind (\d+)/.exec(track);
    rows.push({
      name,
      upstream: upstream === '' ? null : upstream,
      ahead: aheadMatch === null ? 0 : Number(aheadMatch[1]),
      behind: behindMatch === null ? 0 : Number(behindMatch[1]),
      gone: track.includes('gone'),
      current: head === '*',
    });
    if (rows.length >= MAX_BRANCHES) break;
  }
  return rows;
}

function parseCommits(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    if (line === '') continue;
    const fields = line.split('\u001f');
    if (fields.length < 5) continue;
    const [hash, short, subject, author, time, decoration] = fields;
    rows.push({
      hash,
      short,
      subject,
      author,
      time: Number(time) * 1000,
      refs: typeof decoration === 'string' && decoration !== ''
        ? decoration.split(',').map((ref) => ref.trim()).filter((ref) => ref !== '').map((ref) => ref.replace(/^HEAD -> /, ''))
        : [],
    });
    if (rows.length >= MAX_COMMITS) break;
  }
  return rows;
}

/** One file's uncommitted status from porcelain v2's `XY` pair. */
function statusOf(xy, renamed, conflicted) {
  if (conflicted) return { status: 'conflicted', staged: false };
  if (typeof xy !== 'string' || xy.length < 2) return { status: 'modified', staged: false };
  const staged = xy[0] !== '.';
  if (renamed) return { status: 'renamed', staged };
  if (xy[0] === 'D' || xy[1] === 'D') return { status: 'deleted', staged };
  if (xy[0] === 'A' || xy[1] === 'A') return { status: 'added', staged };
  return { status: 'modified', staged };
}

/** Working-tree files from `git status --porcelain=v2 -z`. */
function parseWorkingTree(text) {
  const files = [];
  const parts = String(text).split('\u0000');
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (record === '') continue;
    const kind = record[0];
    if (kind === '1' || kind === '2') {
      const fields = record.split(' ', kind === '2' ? 10 : 9);
      const xy = fields[1];
      const path = kind === '2' ? fields[9] : fields[8];
      if (kind === '2') index += 1; // the following NUL field is the original path
      if (typeof path !== 'string' || path === '') continue;
      files.push({ path, ...statusOf(xy, kind === '2', false) });
    } else if (kind === 'u') {
      const fields = record.split(' ', 11);
      const path = fields[10];
      if (typeof path === 'string' && path !== '') files.push({ path, ...statusOf('UU', false, true) });
    } else if (kind === '?') {
      files.push({ path: record.slice(2), status: 'untracked', staged: false });
    }
  }
  return files;
}

async function gitHandler(ctx, session) {
  const deadline = withDeadline(GIT_TIMEOUT_MS);
  try {
    const root = await repoRoot(ctx, session, deadline.signal);
    if (root === undefined) {
      return { available: false, reason: sessionCwd(ctx, session) === undefined ? 'no-cwd' : 'not-repository' };
    }

    const [head, short, statusText, branchesText, logText] = await Promise.all([
      runGit(ctx, root, ['rev-parse', '--abbrev-ref', 'HEAD'], deadline.signal),
      runGit(ctx, root, ['rev-parse', '--short', 'HEAD'], deadline.signal),
      runGit(ctx, root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], deadline.signal),
      runGit(ctx, root, ['for-each-ref', '--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)', 'refs/heads'], deadline.signal),
      runGit(ctx, root, ['log', '--max-count=60', '--date=unix', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%at%x1f%D'], deadline.signal),
    ]);

    const status = statusText !== undefined && statusText.code === 0 ? parseStatus(statusText.stdout) : parseStatus('');
    const headName = head !== undefined && head.code === 0 ? head.stdout.trim() : '';
    const detached = headName === 'HEAD' || headName === '';
    const shortHash = short !== undefined && short.code === 0 ? short.stdout.trim() : '';
    const branches = branchesText !== undefined && branchesText.code === 0 ? parseBranches(branchesText.stdout) : [];
    const commits = logText !== undefined && logText.code === 0 ? parseCommits(logText.stdout) : [];

    return {
      available: true,
      repo: { root, name: baseName(root) },
      branch: detached ? shortHash : (status.branch !== undefined && status.branch !== '(detached)' ? status.branch : headName),
      detached,
      head: shortHash,
      upstream: status.upstream ?? null,
      ahead: status.ahead,
      behind: status.behind,
      dirty: {
        staged: status.staged,
        modified: status.modified,
        untracked: status.untracked,
        conflicted: status.conflicted,
      },
      branches,
      commits,
    };
  } finally {
    deadline.done();
  }
}

// ---------------------------------------------------------------------------
// outputs (deliveries + the live uncommitted working tree)
// ---------------------------------------------------------------------------

async function outputsHandler(ctx, session) {
  const cwd = sessionCwd(ctx, session);
  const deliveries = new Map();
  for (const event of tailEvents(session)) {
    if (event.type !== 'deliverables/presented') continue;
    const files = Array.isArray(event.data?.files) ? event.data.files : [];
    for (const file of files) {
      if (typeof file?.path !== 'string') continue;
      deliveries.set(file.path, {
        path: file.path,
        address: fileAddressFor(session.id, cwd, file.path),
        description: typeof file.description === 'string' ? file.description : null,
        turn: event.data?.turn,
        time: event.time,
      });
    }
  }

  let workingTree = null;
  const deadline = withDeadline(GIT_TIMEOUT_MS);
  try {
    const root = await repoRoot(ctx, session, deadline.signal);
    if (root !== undefined) {
      const status = await runGit(ctx, root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], deadline.signal);
      if (status !== undefined && status.code === 0) {
        const files = parseWorkingTree(status.stdout);
        workingTree = { root, total: files.length, files };
      }
    }
  } finally {
    deadline.done();
  }

  return {
    deliveries: [...deliveries.values()].slice(-30).reverse(),
    workingTree,
  };
}

// ---------------------------------------------------------------------------
// diff (working tree versus HEAD)
// ---------------------------------------------------------------------------

async function diffHandler(ctx, session, url) {
  const path = url.searchParams.get('path') ?? '';
  if (!isSafeRepoPath(path)) return { available: false, reason: 'bad-path' };

  const deadline = withDeadline(GIT_TIMEOUT_MS);
  try {
    const root = await repoRoot(ctx, session, deadline.signal);
    if (root === undefined) {
      return { available: false, reason: sessionCwd(ctx, session) === undefined ? 'no-cwd' : 'not-repository' };
    }

    const status = await runGit(ctx, root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', path], deadline.signal);
    const untracked = status !== undefined && status.code === 0
      && status.stdout.split('\u0000').some((record) => record[0] === '?');

    let result;
    if (untracked) {
      const device = await nullDevice(ctx);
      result = await runGit(ctx, root, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', device, path], deadline.signal);
    } else {
      result = await runGit(ctx, root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '-U3', '--', path], deadline.signal);
    }
    if (result === undefined) return { available: false, reason: 'git-error' };

    const text = result.stdout;
    const binary = /^Binary files .* differ$/m.test(text) || text.startsWith('GIT binary patch');
    let lines = text.split('\n');
    const truncated = lines.length > MAX_DIFF_LINES;
    if (truncated) lines = lines.slice(0, MAX_DIFF_LINES);

    return {
      available: true,
      path,
      untracked,
      binary,
      truncated,
      diff: binary ? '' : lines.join('\n'),
    };
  } finally {
    deadline.done();
  }
}

// ---------------------------------------------------------------------------
// subagents
// ---------------------------------------------------------------------------

async function subagentsHandler(ctx, session) {
  const subagents = ctx.get('subagents');
  if (subagents === undefined || typeof subagents.listChildren !== 'function') {
    return { children: [] };
  }
  const agents = ctx.get('agents');
  const runningOf = (id) => {
    try {
      const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(id) : undefined;
      return agent !== undefined && agent.status === 'running';
    } catch {
      return false;
    }
  };
  try {
    const children = await subagents.listChildren(session.id);
    return {
      children: (Array.isArray(children) ? children : []).map((child) => ({
        id: child.id,
        label: typeof child.label === 'string' ? child.label : null,
        mode: child.mode ?? 'unknown',
        createdAt: child.createdAt ?? null,
        running: runningOf(child.id),
      })),
    };
  } catch {
    return { children: [] };
  }
}

// ---------------------------------------------------------------------------
// session context (is this conversation a subagent?)
// ---------------------------------------------------------------------------

async function contextHandler(ctx, session) {
  const header = session.header ?? {};
  const parentSessionId = typeof header.parentSession === 'string' && header.parentSession !== ''
    ? header.parentSession
    : undefined;
  const isSubagent = header.origin === 'subagent' || parentSessionId !== undefined;
  if (!isSubagent) return { subagent: null };

  let mode = 'unknown';
  let label = null;
  if (parentSessionId !== undefined) {
    const subagents = ctx.get('subagents');
    if (subagents !== undefined && typeof subagents.listChildren === 'function') {
      try {
        const children = await subagents.listChildren(parentSessionId);
        const entry = (Array.isArray(children) ? children : []).find((child) => child.id === session.id);
        if (entry !== undefined) {
          mode = entry.mode ?? 'unknown';
          label = typeof entry.label === 'string' ? entry.label : null;
        }
      } catch {
        /* label and mode stay unknown */
      }
    }
  }
  return {
    subagent: {
      childSessionId: session.id,
      parentSessionId: parentSessionId ?? null,
      mode,
      label,
    },
  };
}

// ---------------------------------------------------------------------------
// sources (current turn by default, whole session on request)
// ---------------------------------------------------------------------------

function sourcesHandler(ctx, session, url) {
  const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'turn';
  const cwd = sessionCwd(ctx, session);
  const events = tailEvents(session, scope === 'session' ? SESSION_SCOPE_EVENTS : 6000);

  let currentTurn;
  for (const event of events) {
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') {
      currentTurn = currentTurn === undefined ? event.data.turn : Math.max(currentTurn, event.data.turn);
    }
  }

  const calls = new Map();
  const queries = new Map();
  const links = new Map();
  const files = new Map();
  const tools = new Map();

  for (const event of events) {
    if (scope === 'turn' && currentTurn !== undefined && event.data?.turn !== currentTurn) continue;

    if (event.type === 'tool/call') {
      const toolName = typeof event.data?.name === 'string' ? event.data.name : '';
      if (toolName === '') continue;
      if (typeof event.data?.callId === 'string') calls.set(event.data.callId, toolName);
      tools.set(toolName, (tools.get(toolName) ?? 0) + 1);
      const args = safeParseJson(event.data?.arguments) ?? {};

      if (toolName === 'web_search') {
        const list = Array.isArray(args.queries)
          ? args.queries
          : (typeof args.query === 'string' ? [args.query] : []);
        for (const query of list) {
          if (typeof query !== 'string' || query === '') continue;
          queries.set(query, { value: query, time: event.time });
        }
      } else if (toolName === 'web_fetch') {
        if (typeof args.url === 'string' && args.url !== '') {
          links.set(args.url, { url: args.url, title: null, time: event.time });
        }
      } else if (toolName === 'read' || toolName === 'write' || toolName === 'edit' || toolName === 'str_replace_editor' || toolName === 'lsp') {
        const path = typeof args.file_path === 'string'
          ? args.file_path
          : (typeof args.path === 'string' ? args.path : '');
        if (path !== '') files.set(path, { path, address: fileAddressFor(session.id, cwd, path), time: event.time });
      }
    } else if (event.type === 'tool/result') {
      const callId = typeof event.data?.message?.toolCallId === 'string'
        ? event.data.message.toolCallId
        : (typeof event.data?.callId === 'string' ? event.data.callId : undefined);
      if (callId === undefined || calls.get(callId) !== 'web_search') continue;
      const meta = event.data?.meta;
      const sources = Array.isArray(meta?.sources) ? meta.sources : [];
      for (const source of sources) {
        if (typeof source?.url !== 'string' || source.url === '') continue;
        links.set(source.url, {
          url: source.url,
          title: typeof source.title === 'string' && source.title !== '' ? source.title : null,
          time: event.time,
        });
      }
    }
  }

  return {
    scope,
    turn: currentTurn ?? null,
    queries: [...queries.values()].slice(-20).reverse(),
    links: [...links.values()].slice(-40).reverse(),
    files: [...files.values()].slice(-40).reverse(),
    tools: [...tools.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([toolName, count]) => ({ name: toolName, count })),
  };
}

// ---------------------------------------------------------------------------

export function apply(ctx) {
  route(ctx, '/git', gitHandler);
  route(ctx, '/outputs', outputsHandler);
  route(ctx, '/diff', diffHandler);
  route(ctx, '/subagents', subagentsHandler);
  route(ctx, '/sources', sourcesHandler);
  route(ctx, '/context', contextHandler);
}
