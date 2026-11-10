import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { applyOps } from '../../host/model.js';
import { verifyUserQuote } from '../../host/evidence.js';

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

function findLog(home, sessionId) {
  const root = join(home, 'sessions');
  const logs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, sessionId, 'session.v4.jsonl.zstd'))
    .filter((path) => existsSync(path));
  requireEvidence(logs.length === 1, `expected one desktop v4 log for ${sessionId}`);
  return logs[0];
}

function isWithin(root, path) {
  const within = relative(root, path);
  return within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within);
}

function checkDesktopApproval(mode, sessionId, directory, filenames) {
  requireEvidence(['D2', 'D3', 'D6'].includes(mode) && /^session-[a-zA-Z0-9_-]+$/.test(sessionId ?? '') && directory && filenames.length,
    'usage: node test/e2e/desktop-approval.mjs D2|D3|D6 session-<id> <workspace> <implementation-file> [...]');
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const workspace = realpathSync(directory);
  const files = new Set(filenames.map((name) => {
    const path = resolve(workspace, name);
    requireEvidence(!isAbsolute(name) && path !== workspace && isWithin(workspace, path),
      `expected a relative implementation path inside the workspace: ${name}`);
    return path;
  }));
  const events = execFileSync('zstd', ['-dc', findLog(home, sessionId)], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).trim().split('\n').map(JSON.parse);
  const header = events[0];
  requireEvidence(header.id === sessionId && header.version === 4, 'unexpected desktop session header');
  const cwd = realpathSync(header.cwd);
  requireEvidence(isWithin(cwd, workspace),
    'workspace must be the session directory or a directory inside it');
  requireEvidence(events.findLast((event) => event.type === 'turn/start' || event.type === 'turn/end')?.type === 'turn/end',
    'wait for the desktop turn to finish before checking evidence');

  const calls = new Map();
  let tree;
  let createdAtSeq;
  let approval;
  let firstWrite;
  let firstPendingWithPlanSeq;
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event);
    if (event.type !== 'tool/result' || event.data.message?.isError !== false) continue;
    const call = calls.get(event.data.message.toolCallId);
    if (call?.data.name === 'task_tree_write') {
      const result = JSON.parse(event.data.message.content.find((part) => part.type === 'text').text);
      requireEvidence(result.ok === true && result.worklineId === sessionId, 'expected a new, isolated workline');
      const before = tree;
      const verify = (quote) => verifyUserQuote({
        seq: call.seq,
        snapshotEvents: (after) => events.filter((row) => row.seq > after && row.seq < call.seq),
      }, quote);
      const { envelope, applied } = applyOps(tree, JSON.parse(call.data.arguments).ops, {
        worklineId: sessionId, actorSessionId: sessionId, now: event.time, verifyUserQuote: verify,
      });
      requireEvidence(JSON.stringify(applied) === JSON.stringify(result.applied), `task-tree replay differs at event ${event.seq}`);
      tree = envelope;
      if (createdAtSeq === undefined && tree.tasks.length > 0) createdAtSeq = event.seq;
      const approved = tree.tasks.find((task) => task.executionApproval === 'approved');
      if (approved && !approval) {
        approval = {
          id: approved.id, seq: event.seq, basis: approved.approvalBasis,
          userSeq: verify(approved.approvalBasis).seq, before: before?.tasks ?? [],
        };
      }
      if (firstPendingWithPlanSeq === undefined && tree.tasks.length === 1 && tree.tasks[0].executionApproval === 'pending'
        && tree.tasks[0].progress.trim()) firstPendingWithPlanSeq = event.seq;
    }
    const path = event.data.meta?.path;
    if (['write', 'edit', 'apply_patch'].includes(call?.data.name) && typeof path === 'string') {
      const absolute = resolve(cwd, path);
      if (files.has(absolute) && (!firstWrite || call.seq < firstWrite.seq)) {
        firstWrite = { seq: call.seq, resultSeq: event.seq, path: relative(workspace, absolute) };
      }
    }
  }

  const before = approval?.before ?? tree?.tasks ?? [];
  console.log(JSON.stringify({
    mode, sessionId,
    beforeApproval: before.map(({ id, status, executionApproval }) => ({ id, status, executionApproval })),
    firstPendingWithPlanSeq: firstPendingWithPlanSeq ?? null,
    approval: approval ? { id: approval.id, seq: approval.seq, basis: approval.basis, userSeq: approval.userSeq } : null,
    firstImplementationWrite: firstWrite ?? null,
  }, null, 2));
  const [task] = before;
  requireEvidence(before.length === 1 && task.status === 'pending' && task.executionApproval === 'pending'
    && task.approvalBasis === null && task.progress.trim(), 'expected one pending delivery with plan notes before approval');
  const persisted = JSON.parse(readFileSync(join(home, 'agent-task-tree', `${sessionId}.json`), 'utf8'));
  const saved = persisted.tasks.find(({ id }) => id === task.id);
  const latest = tree.tasks.find(({ id }) => id === task.id);
  requireEvidence(saved && ['status', 'executionApproval', 'approvalBasis'].every((field) => saved[field] === latest[field]),
    'persisted task disagrees with the desktop log');

  if (mode === 'D2') {
    requireEvidence(!approval && !firstWrite && [...files].every((path) => !existsSync(path)),
      'D2 has approval or implementation evidence before confirmation');
  } else {
    requireEvidence(approval?.id === task.id && Number.isInteger(approval.userSeq)
      && firstPendingWithPlanSeq < approval.seq && firstWrite?.seq > approval.seq && [...files].every(existsSync),
    'expected the same task to be approved with a user quote after planning and before the first recorded implementation write');
    requireEvidence(mode === 'D3' ? approval.userSeq > createdAtSeq : approval.userSeq < createdAtSeq,
      mode === 'D3' ? 'expected authorization from a later user message' : 'expected authorization from the initial user message');
  }
  console.log(`PASS ${mode}`);
}

try {
  const [mode, sessionId, directory, ...filenames] = process.argv.slice(2);
  checkDesktopApproval(mode, sessionId, directory, filenames);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
