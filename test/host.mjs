import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { apply } from '../index.js';

const dir = mkdtempSync(join(tmpdir(), 'sp-git-'));
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
execFileSync('git', ['init', '-q', dir]);
git('config', 'user.email', 'a@b.c');
git('config', 'user.name', 'Tester');
writeFileSync(join(dir, 'a.txt'), 'one\n');
git('add', '.');
git('commit', '-qm', 'first');
writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
writeFileSync(join(dir, 'sub.mjs'), 'export {};\n');

const events = [
  { type: 'turn/start', seq: 1, time: Date.now() - 2000, data: { turn: 3 } },
  { type: 'tool/call', seq: 2, time: Date.now() - 1000, data: { turn: 3, step: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'a.txt' }) } },
  { type: 'tool/call', seq: 3, time: Date.now() - 900, data: { turn: 3, step: 1, callId: 'c2', name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.com' }) } },
  { type: 'tool/call', seq: 4, time: Date.now() - 800, data: { turn: 3, step: 1, callId: 'c3', name: 'web_search', arguments: JSON.stringify({ queries: ['dsh plugin'] }) } },
  { type: 'tool/result', seq: 5, time: Date.now() - 700, data: { turn: 3, step: 1, message: { role: 'tool', toolCallId: 'c3' }, meta: { sources: [{ url: 'https://example.org/result', title: 'Result page' }], truncated: false } } },
  { type: 'deliverables/presented', seq: 6, time: Date.now() - 600, data: { turn: 3, callId: 'c4', files: [{ path: 'out/report.md', description: 'report' }] } },
];
const session = { id: 's1', header: { cwd: dir }, seq: 10, snapshotEvents: () => events };

const persistedHeader = { id: 'c1', cwd: dir, parentSession: 's1', origin: 'subagent' };
const children = [
  { id: 'c1', mode: 'continuable', label: 'Worker', createdAt: 1 },
  { id: 'child-running', mode: 'one-shot', createdAt: 2 },
];
const routes = new Map();
const ctx = {
  get: (name) => {
    if (name === 'sessions') return { get: (id) => (id === 's1' ? session : undefined) };
    if (name === 'sessionPersistence') return {
      stat: async (id) => (id === 'c1' ? { header: persistedHeader, eventCount: events.length } : undefined),
      open: async () => ({ header: persistedHeader, read: async (offset = 0) => ({ events: events.slice(offset) }), close: async () => {} }),
    };
    if (name === 'agents') return { get: (id) => (id === 'child-running' ? { status: 'running' } : { status: 'idle' }) };
    if (name === 'subagents') return { listChildren: async (parent) => (parent === 's1' ? children : []) };
    return undefined;
  },
  effect: (fn) => fn(),
  webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } },
  subprocess: {
    terminalEnvironment: async () => ({ platform: 'posix' }),
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => resolve({ exitCode: code, signal: null })); });
      return { done, collected: { stdout: { readFrom: () => ({ text: out }) }, stderr: { readFrom: () => ({ text: err }) } }, terminate: () => child.kill() };
    },
  },
};
apply(ctx);
const call = (path, query) => new Promise((resolve) => {
  const res = { setHeader() {}, end(body) { resolve(JSON.parse(body)); } };
  routes.get(path)({ method: 'GET', url: path + query }, res);
});

const output = await call('/summary-panel/outputs', '?sessionId=s1');
const persistedSources = await call('/summary-panel/sources', '?sessionId=c1&scope=session');
const contextSelf = await call('/summary-panel/context', '?sessionId=s1');
const contextChild = await call('/summary-panel/context', '?sessionId=c1');
const childRows = await call('/summary-panel/subagents', '?sessionId=s1');
const sources = await call('/summary-panel/sources', '?sessionId=s1&scope=turn');
const diff = await call('/summary-panel/diff', '?sessionId=s1&path=a.txt');

console.log('working tree:', output.workingTree.files.map((f) => `${f.path}:${f.status}`).join(', '));
console.log('source file:', JSON.stringify(sources.files[0]));
console.log('source links:', JSON.stringify(sources.links));
console.log('source queries:', JSON.stringify(sources.queries));
console.log('diff add line:', diff.diff.split('\n').find((line) => line.startsWith('+')));
console.log('persisted sources:', persistedSources.queries?.length, persistedSources.links?.length);
console.log('context self:', JSON.stringify(contextSelf));
console.log('context child:', JSON.stringify(contextChild));
console.log('subagent rows:', JSON.stringify(childRows.children));

const failures = [];
if (output.workingTree.files.length !== 2) failures.push('working tree count');
if (!sources.files[0]?.address?.startsWith('dsh-resource://file/session/s1/')) failures.push('file address');
if (!sources.queries.some((entry) => entry.value === 'dsh plugin')) failures.push('search queries');
if (!sources.links.some((entry) => entry.url === 'https://example.org/result' && entry.title === 'Result page')) failures.push('search result link');
if (!sources.links.some((entry) => entry.url === 'https://example.com')) failures.push('fetch link');
if (!diff.diff.includes('+two')) failures.push('diff body');
if (!output.deliveries[0]?.address?.startsWith('dsh-resource://file/session/s1/')) failures.push('delivery address');
if (persistedSources.error !== undefined) failures.push('persisted session read');
if (contextSelf.subagent !== null) failures.push('parent context');
if (contextChild.subagent?.parentSessionId !== 's1' || contextChild.subagent?.label !== 'Worker') failures.push('subagent context');
const running = (childRows.children || []).find((child) => child.id === 'child-running');
const idle = (childRows.children || []).find((child) => child.id === 'c1');
if (running?.running !== true) failures.push('running flag');
if (idle?.running !== false) failures.push('idle flag');
if (failures.length > 0) { console.log('FAILED:', failures); process.exit(1); }
console.log('host OK');
