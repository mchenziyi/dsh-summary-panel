/* Minimal React + DOM harness for the client half. */
const errors = [];
const Fragment = Symbol('Fragment');
const hookStates = new Map();
let currentSlots = null;
let hookIndex = 0;
let pendingEffects = [];
let pendingCleanups = [];
let dirty = false;

function slotsAt(path) {
  let slots = hookStates.get(path);
  if (slots === undefined) { slots = { values: [], effects: [], refs: [] }; hookStates.set(path, slots); }
  return slots;
}
function depsEqual(a, b) {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
  return true;
}
const React = {
  Fragment,
  createElement(type, props, ...children) {
    const next = Object.assign({}, props);
    if (children.length > 0) next.children = children.length === 1 ? children[0] : children;
    return { type, props: next };
  },
  useState(initial) {
    const slots = currentSlots; const index = hookIndex++;
    if (!(index in slots.values)) slots.values[index] = typeof initial === 'function' ? initial() : initial;
    return [slots.values[index], (next) => { slots.values[index] = typeof next === 'function' ? next(slots.values[index]) : next; dirty = true; }];
  },
  useEffect(fn, deps) {
    const slots = currentSlots; const index = hookIndex++;
    const previous = slots.effects[index];
    if (previous === undefined || !depsEqual(previous.deps, deps)) {
      // React runs the previous cleanup before the new effect; the client relies
      // on it to abort the request of the session it just left, so the harness
      // has to do the same or a stale reply looks like a real one.
      if (previous !== undefined && typeof previous.cleanup === 'function') pendingCleanups.push(previous.cleanup);
      slots.effects[index] = { deps, cleanup: undefined };
      pendingEffects.push({ slot: slots, index, fn });
    }
  },
  useRef(initial) {
    const slots = currentSlots; const index = hookIndex++;
    if (!(index in slots.refs)) slots.refs[index] = { current: initial };
    return slots.refs[index];
  },
  useMemo(fn) { return fn(); },
};
let output = [];
function renderNode(node, path) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) { node.forEach((child, index) => renderNode(child, `${path}[${index}]`)); return; }
  if (typeof node === 'string' || typeof node === 'number') { output.push(String(node)); return; }
  if (typeof node !== 'object') return;
  const { type, props } = node;
  if (type === Fragment) { renderNode(props.children, path); return; }
  if (typeof type === 'function') {
    const savedSlots = currentSlots; const savedIndex = hookIndex;
    const slots = slotsAt(`${path}#${type.name || 'anonymous'}`);
    currentSlots = slots;
    hookIndex = 0;
    let result;
    let threw = false;
    try { result = type(props); } catch (error) { threw = true; errors.push(error); }
    if (!threw && slots.hookCount !== undefined && slots.hookCount !== hookIndex) {
      errors.push(new Error(`hook order changed in ${type.name || 'anonymous'}: ${slots.hookCount} -> ${hookIndex}`));
    }
    if (!threw) slots.hookCount = hookIndex;
    currentSlots = savedSlots; hookIndex = savedIndex;
    renderNode(result, `${path}>${type.name || 'anonymous'}`);
    return;
  }
  if (typeof type === 'string') renderNode(props.children, path);
}
async function renderTree(Component, props, passes = 8) {
  for (let pass = 0; pass < passes; pass += 1) {
    dirty = false; output = []; pendingEffects = []; pendingCleanups = []; hookIndex = 0;
    renderNode(React.createElement(Component, props), 'root');
    for (const cleanup of pendingCleanups) { try { cleanup(); } catch (error) { errors.push(error); } }
    for (const { slot, index, fn } of pendingEffects) {
      try {
        const cleanup = fn();
        if (typeof cleanup === 'function') slot.effects[index].cleanup = cleanup;
      } catch (error) {
        errors.push(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (!dirty) break;
  }
  return output.join(' ');
}

const samples = {
  git: { available: true, repo: { root: '/tmp/r', name: 'r' }, branch: 'main', detached: false, head: 'abc', upstream: null, ahead: 0, behind: 0, dirty: { staged: 0, modified: 0, untracked: 0, conflicted: 0 }, branches: [
    { name: 'main', upstream: null, ahead: 0, behind: 0, gone: false, current: true },
    { name: 'feature/classify', upstream: null, ahead: 0, behind: 0, gone: false, current: false },
    { name: 'backup/old', upstream: null, ahead: 0, behind: 0, gone: true, current: false },
  ], commits: [{ hash: 'aaa', short: 'a1b2c3d', subject: 'feat: first commit', author: 'czy', time: Date.now() - 60000, refs: ['main'] }] },
  outputs: { deliveries: [{ path: 'out/report.md', address: 'dsh-resource://file/session/s1/out/report.md', description: 'report', time: Date.now() }], workingTree: { root: '/tmp/r', total: 1, files: [{ path: 'a.txt', status: 'modified', staged: false }] } },
  diff: { available: true, path: 'a.txt', untracked: false, binary: false, truncated: false, diff: '@@ -1 +1 @@\n-one\n+two' },
  subagents: { children: [{ id: 's-child-1', label: 'Researcher', mode: 'continuable', createdAt: Date.now() - 300000, running: true }] },
  context: { subagent: { childSessionId: 'c1', parentSessionId: 's1', mode: 'continuable', label: 'Researcher' } },
  sources: { scope: 'turn', turn: 3, links: [{ url: 'https://example.com', title: 'Example', time: Date.now() }], queries: [{ value: 'dsh plugin', time: Date.now() }], files: [{ path: 'a.txt', address: 'dsh-resource://file/session/s1/a.txt', time: Date.now() }], tools: [] },
  tasks: {
    available: true,
    worklineId: 's1',
    goal: { original: '目标 A', current: '目标 A', changes: [] },
    outline: '',
    focus: ['t5'],
    updatedAt: Date.now(),
    tasks: [
      { id: 't1', parentId: null, order: 0, title: 'Host 半', summary: '存储与工具', status: 'in_progress', deferred: false, blocked: null, blocker: null, progress: '', result: null, ownerSessionId: null, ownerLive: false, completion: null, updatedAt: Date.now() },
      { id: 't5', parentId: 't1', order: 0, title: '存储与工具', summary: '原子写', status: 'in_progress', deferred: false, blocked: null, blocker: null, progress: '', result: null, ownerSessionId: null, ownerLive: false, completion: null, updatedAt: Date.now() },
      { id: 't2', parentId: null, order: 1, title: 'Client 半', summary: '任务树分区', status: 'in_progress', deferred: false, blocked: null, blocker: null, progress: '', result: null, ownerSessionId: null, ownerLive: false, completion: null, updatedAt: Date.now() },
      { id: 't6', parentId: 't2', order: 0, title: '悬浮窗展示', summary: '默认收纳', status: 'pending', deferred: true, blocked: null, blocker: null, progress: '', result: null, ownerSessionId: null, ownerLive: false, completion: null, updatedAt: Date.now() },
      { id: 't7', parentId: null, order: 2, title: '登录功能', summary: '已完成', status: 'done', deferred: false, blocked: null, blocker: null, progress: '', result: '已上线', ownerSessionId: null, ownerLive: false, completion: 'user-confirmed', updatedAt: Date.now() },
      { id: 't8', parentId: 't7', order: 0, title: '修复 Token 过期', summary: '上线后发现', status: 'in_progress', deferred: false, blocked: null, blocker: null, progress: '定位中', result: null, ownerSessionId: null, ownerLive: false, completion: null, updatedAt: Date.now() },
      { id: 't9', parentId: null, order: 3, title: 'Web 管理后台', summary: '聊到但没批', status: 'pending', executionApproval: 'pending', deferred: false, blocked: null, blocker: null, progress: '', result: null, ownerSessionId: null, ownerLive: false, completion: null, updatedAt: Date.now() },
    ],
    archived: [],
    archivedCount: 0,
  },
  'tasks/status': { available: true, focus: [{ id: 't5', title: '存储与工具', status: 'in_progress', blocked: false }], updatedAt: Date.now() },
};
globalThis.document = { baseURI: 'http://127.0.0.1:49605/', addEventListener() {}, removeEventListener() {} };
globalThis.window = { location: { href: 'http://127.0.0.1:49605/' }, open() {}, __ModuleLoader__: { load(registration) { globalThis.window.__captured = registration; } } };
// Per-session payloads let one test prove that a session change never shows the
// previous session's data. Empty by default, so the shared `samples` still serve
// every existing case.
const sessionSamples = new Map();
// A hold predicate lets a test park a response and release it later, which is
// how a late reply from the previous session is simulated.
let holdPredicate = () => false;
let heldResponses = [];
function sampleFor(name, url) {
  const sessionId = new URL(String(url)).searchParams.get('sessionId') ?? '';
  const perSession = sessionSamples.get(sessionId);
  if (perSession !== undefined && perSession[name] !== undefined) return perSession[name];
  return samples[name] ?? {};
}
globalThis.fetch = async (url) => {
  const name = String(url).includes('/summary-panel/') ? String(url).split('/summary-panel/')[1].split('?')[0] : '';
  const sessionId = new URL(String(url)).searchParams.get('sessionId') ?? '';
  const payload = sampleFor(name, url);
  if (holdPredicate(name, sessionId) === true) {
    return new Promise((resolve) => {
      heldResponses.push({ name, sessionId, release: () => resolve({ ok: true, json: async () => payload }) });
    });
  }
  return { ok: true, json: async () => payload };
};
// Run every stored cleanup and forget the hook state: React's unmount path,
// which is how the session header disappears on the welcome page.
function unmountAll(prefix = 'root') {
  for (const [key, slots] of [...hookStates.entries()]) {
    if (!key.startsWith(prefix)) continue;
    for (const effect of slots.effects) {
      if (effect !== undefined && typeof effect.cleanup === 'function') {
        try { effect.cleanup(); } catch (error) { errors.push(error); }
      }
    }
    hookStates.delete(key);
  }
  dirty = true;
}

// Drop a component's hook state so one test can mount it afresh.
function resetSlots(prefix = 'root') {
  for (const key of [...hookStates.keys()]) if (key.startsWith(prefix)) hookStates.delete(key);
}
// The frame hands `shell.overlay` occupants a sessions snapshot hook. Each row
// carries `retainedBy` counts; `mainView` marks the Session on screen.
let sessionsSnapshot = { byId: {} };
const sessionListeners = new Set();
function setSessions(byId) {
  sessionsSnapshot = { byId };
  for (const listener of [...sessionListeners]) listener();
  dirty = true;
}
function useSessions(selector) {
  const [value, setValue] = React.useState(() => selector(sessionsSnapshot));
  const latest = React.useRef(selector);
  latest.current = selector;
  React.useEffect(() => {
    const listener = () => setValue(latest.current(sessionsSnapshot));
    sessionListeners.add(listener);
    listener();
    return () => { sessionListeners.delete(listener); };
  }, []);
  return value;
}
function releaseHeld(filter = () => true) {
  const released = [];
  const keep = [];
  for (const held of heldResponses) {
    if (filter(held) === true) released.push(held);
    else keep.push(held);
  }
  heldResponses = keep;
  for (const held of released) held.release();
  return released.length;
}

await import(new URL('../client.js', import.meta.url));
const plugin = globalThis.window.__captured.factory((name) => { if (name === 'react') return React; throw new Error(`unexpected require ${name}`); });

const slotRegistrations = [];
const dicts = new Map();
const provided = {};
const rightCalls = [];
const sidebarRight = { openTab: (kind, options) => rightCalls.push({ call: 'openTab', kind, options }), openResource: (address, options) => rightCalls.push({ call: 'openResource', address, options }) };
const uiWorkspace = { openSession: (target) => rightCalls.push({ call: 'openSession', target }) };
const scope = {
  effect: (fn) => fn(),
  slots: { inject: (_owner, callback) => callback(), register: (registration, component) => { slotRegistrations.push({ registration, component }); return () => {}; } },
  locale: null,
  sidebarRight,
  uiWorkspace,
  sidebarRightTabs: { register: () => () => {} },
};
const locale = {
  register: (ns, lang, dict) => { dicts.set(lang, dict); return () => {}; },
  bind: () => { throw new Error('unbound'); },
  getLocale: () => ({ active: 'zh' }),
  subscribe: () => () => {},
};
scope.locale = locale;
const ctx = {
  effect: (fn) => fn(),
  provide: (name, value) => { provided[name] = value; return () => {}; },
  inject: (_names, callback) => callback(scope),
  slots: { inject: (_owner, callback) => callback(), register: (registration, component) => { slotRegistrations.push({ registration, component }); return () => {}; } },
  locale,
  get: (name) => (name === 'uiWorkspace' ? uiWorkspace : undefined),
};
plugin.apply(ctx);

const api = provided.summaryPanel;
api.open('s1');
const panelEntry = slotRegistrations.find((entry) => entry.registration.name === 'shell.overlay');
if (panelEntry === undefined) throw new Error('summary panel overlay was not registered');
const text = await renderTree(panelEntry.component, {});
const expected = ['Git', 'main', '分支 (3)', '最近提交', '输出内容', '子智能体', '来源', '子智能体会话', 'Researcher', '返回父会话', '当前任务', 'Host 半', '存储与工具', '登录功能', '修复 Token 过期'];
const failures = [];

// Clicking a task opens the lightweight popover outside the list, and closing
// it removes the detail text again.
api.showTaskDetail({
  task: {
    id: 't7', title: '登录功能', status: 'done', summary: '登录功能说明', progress: '已上线',
    result: '验收通过', blocker: null, ownerSessionId: null, completion: 'user-confirmed',
    updatedAt: 1, archiveHistory: [],
  },
  archived: false,
  rect: { left: 240, top: 120, right: 340, bottom: 140 },
});
const detailText = await renderTree(panelEntry.component, {});
for (const needle of ['登录功能说明', '已上线']) {
  if (!detailText.includes(needle)) failures.push(`missing popover detail: ${needle}`);
}
api.closeTaskDetail();
const closedText = await renderTree(panelEntry.component, {});
if (closedText.includes('登录功能说明')) failures.push('popover did not close');
if (detailText.includes('验收通过')) failures.push('popover should stay minimal');
for (const needle of expected) if (!text.includes(needle)) failures.push(`missing text: ${needle}`);
if (text.includes('classify')) failures.push('collapsed feature branch leaked into the list');
if (text.includes('backup/')) failures.push('collapsed branch block leaked into the list');
if (text.includes('Example')) failures.push('collapsed sources section leaked into the list');
// Default fold: only the focus path (t1 > t5) is expanded; t2's child stays hidden.
if (text.includes('悬浮窗展示')) failures.push('default fold leaked a non-focus branch');
// An unapproved idea is marked; an approved or finished task is not.
if (!text.includes('Web 管理后台')) failures.push('pending-approval task did not render');
if (!text.includes('待授权')) failures.push('pending-approval marker missing');
if (text.split('待授权').length - 1 !== 1) failures.push('pending-approval marker leaked to approved tasks');

api.openSourceFile('dsh-resource://file/session/s1/a.txt');
api.openSourceUrl('https://example.com');
api.openDiff('s1', 'a.txt');
api.openSubagent('s1', { id: 's-child-1', label: 'Researcher', mode: 'continuable' });
api.openParent('s1');
const fullTasks = samples.tasks;
const fullStatus = samples['tasks/status'];
const emptyTasks = { available: true, worklineId: 's1', goal: null, outline: '', focus: [], updatedAt: 0, tasks: [], archived: [], archivedCount: 0 };
samples.tasks = emptyTasks;
samples['tasks/status'] = { available: true, focus: [], updatedAt: 0 };
api.open('s1');
api.refresh();
const emptyText = await renderTree(panelEntry.component, {});
if (!emptyText.includes('自动建立任务树')) failures.push('empty task tree state missing');
samples.tasks = fullTasks;
samples['tasks/status'] = fullStatus;
api.refresh();
const filledText = await renderTree(panelEntry.component, {});
if (!filledText.includes('登录功能')) failures.push('task tree did not render after first init');
if (!filledText.includes('修复 Token 过期')) failures.push('task children missing after first init');

// ---------------------------------------------------------------------------
// session switching: the previous session's data never survives a switch
// ---------------------------------------------------------------------------

const entryEntry = slotRegistrations.find((entry) => entry.registration.name === 'conversation.session.header.utilities');
if (entryEntry === undefined) failures.push('entry button slot was not registered');
const panelFor = async () => renderTree(panelEntry.component, {});
const entryFor = async (sessionId) => renderTree(entryEntry.component, { sessionId });
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); };

const sessionATasks = samples.tasks;
const sessionAStatus = samples['tasks/status'];
const sessionAGit = samples.git;
const emptyTree = { available: true, worklineId: 's2', goal: null, outline: '', focus: [], updatedAt: 0, tasks: [], archived: [], archivedCount: 0 };
const sessionBTasks = {
  available: true,
  worklineId: 's2',
  goal: { original: '会话 B 的目标', current: '会话 B 的目标', changes: [] },
  outline: '',
  focus: [],
  updatedAt: Date.now(),
  tasks: [
    { id: 'b1', parentId: null, order: 0, title: '会话 B 的任务', summary: '', status: 'in_progress', executionApproval: 'approved', requiresUserAcceptance: true, deferred: false, blocked: false, blocker: null, progress: '', result: null, ownerSessionId: null, ownerLive: false, completion: null, updatedAt: Date.now() },
  ],
  archived: [],
  archivedCount: 0,
};
const sessionBEmptyStatus = { available: true, focus: [], updatedAt: 0 };
const sessionBStatus = { available: true, focus: [{ id: 'b1', title: '会话 B 的任务', status: 'in_progress', blocked: false }], updatedAt: Date.now() };
const sessionBGit = { available: true, repo: { root: '/tmp/s2', name: 'repo-b' }, branch: 'b-branch', detached: false, head: 'bbb', upstream: null, ahead: 0, behind: 0, dirty: { staged: 0, modified: 0, untracked: 0, conflicted: 0 }, branches: [], commits: [] };

sessionSamples.set('s1', { tasks: sessionATasks, 'tasks/status': sessionAStatus, git: sessionAGit, sources: samples.sources, subagents: samples.subagents, context: samples.context, outputs: samples.outputs });
sessionSamples.set('s2', { tasks: emptyTree, 'tasks/status': sessionBEmptyStatus, git: sessionBGit, sources: { scope: 'turn', turn: 0, links: [], queries: [], files: [], tools: [] }, subagents: { children: [] }, context: { subagent: null }, outputs: { deliveries: [], workingTree: null } });

// Session A: the panel shows A's tree and A's git.
await entryFor('s1');
api.open('s1');
const aText = await panelFor();
if (!aText.includes('Host 半')) failures.push('session A tree missing before the switch');

// A welcome page (no session id) must not keep showing A's data.
await entryFor(null);
const welcomeText = await panelFor();
if (welcomeText.includes('Host 半') || welcomeText.includes('存储与工具')) {
  failures.push('welcome page still shows the previous session tasks');
}
if (welcomeText.includes('main')) failures.push('welcome page still shows the previous session git data');

// A -> (no session) -> B must not leak A into B either.
await entryFor('s2');
const fromWelcome = await panelFor();
if (fromWelcome.includes('Host 半')) failures.push('session B reached from the welcome page shows session A tasks');
if (fromWelcome.includes('会话 B 的任务')) failures.push('session B content appeared before its request');
if (!fromWelcome.includes('自动建立任务树')) failures.push('session B reached from the welcome page is not empty');
await entryFor(null);
await entryFor('s1');

// Direct A -> B while B's request is still in flight: no A data may linger.
api.open('s1');
await panelFor();
holdPredicate = (name, sessionId) => sessionId === 's2';
await entryFor('s2');
const loadingB = await panelFor();
if (loadingB.includes('Host 半')) failures.push('switching to B kept the previous session tasks');
if (loadingB.includes('main')) failures.push('switching to B kept the previous session git data');
if (loadingB.includes('会话 B 的任务')) failures.push('session B content appeared before its response');
releaseHeld((held) => held.sessionId === 's2');
holdPredicate = () => false;
await flush();
const emptyBText = await panelFor();
if (emptyBText.includes('Host 半')) failures.push('session B empty state still shows session A tasks');
if (!emptyBText.includes('自动建立任务树')) failures.push('session B empty state missing');

// Session B creates its own task, then refreshes.
sessionSamples.set('s2', Object.assign({}, sessionSamples.get('s2'), { tasks: sessionBTasks, 'tasks/status': sessionBStatus }));
api.refresh();
const builtB = await panelFor();
if (!builtB.includes('会话 B 的任务')) failures.push('session B tree did not render after creation');
if (builtB.includes('Host 半')) failures.push('session B tree mixed in session A tasks');
if (builtB.includes('main') && !builtB.includes('b-branch')) failures.push('session B git kept session A branch');

// A late reply for session A must not pollute session B.
holdPredicate = (name, sessionId) => sessionId === 's1';
api.open('s1');
await flush();
api.open('s2');
await panelFor();
releaseHeld((held) => held.sessionId === 's1');
holdPredicate = () => false;
await flush();
const afterLate = await panelFor();
if (afterLate.includes('Host 半')) failures.push('a late session A reply polluted session B');
if (!afterLate.includes('会话 B 的任务')) failures.push('session B lost its tree after a late session A reply');

// An open detail popover belongs to the session that opened it.
await entryFor('s1');
api.open('s1');
await panelFor();
api.showTaskDetail({
  task: { id: 't1', title: 'Host 半', status: 'in_progress', summary: '会话 A 的详情', progress: '', result: null, blocker: null, ownerSessionId: null, completion: null, updatedAt: 1, archiveHistory: [] },
  archived: false,
  rect: { left: 240, top: 120, right: 340, bottom: 140 },
});
const popoverA = await panelFor();
if (!popoverA.includes('会话 A 的详情')) failures.push('session A detail popover did not open');
// Switch while session B is still loading: nothing on screen may still belong to
// session A, including the popover it opened.
holdPredicate = (name, sessionId) => sessionId === 's2';
await entryFor('s2');
const popoverB = await panelFor();
if (popoverB.includes('会话 A 的详情')) failures.push('session A detail popover survived the switch to session B');
if (popoverB.includes('Host 半')) failures.push('session A tasks survived the switch to session B (popover case)');
releaseHeld((held) => held.sessionId === 's2');
holdPredicate = () => false;
await flush();
await panelFor();
api.closeTaskDetail();

// Closing and reopening the same session keeps its data.
api.close();
const closedB = await panelFor();
if (closedB !== '') failures.push('closing the panel left content behind');
api.open('s2');
const reopenedB = await panelFor();
if (!reopenedB.includes('会话 B 的任务')) failures.push('reopening session B lost its tree');

// Going back to session A restores A's tree, not B's.
await entryFor('s1');
api.open('s1');
await panelFor();
await flush();
const backA = await panelFor();
if (!backA.includes('Host 半')) failures.push('returning to session A did not restore its tree');
if (backA.includes('会话 B 的任务')) failures.push('returning to session A kept session B tasks');
await entryFor('s1');

// ---------------------------------------------------------------------------
// welcome page: the session header is gone, the frame still knows the truth
// ---------------------------------------------------------------------------

{
  // The entry button lives in the session header, so it unmounts when the user
  // clicks "new session". The panel must follow the frame's session snapshot
  // instead of whatever session it was showing last.
  resetSlots();
  const panelFollowed = () => renderTree(panelEntry.component, { useSessions });
  setSessions({ s1: { id: 's1', retainedBy: { mainView: 1 } } });
  sessionSamples.set('s2', Object.assign({}, sessionSamples.get('s2'), { tasks: emptyTree, 'tasks/status': sessionBEmptyStatus }));
  await entryFor('s1');
  api.open('s1');
  const backToA = await panelFollowed();
  if (!backToA.includes('Host 半')) failures.push('welcome-page case: session A did not render first');

  // 1. Existing session -> new-session welcome page (no header, no entry button).
  setSessions({ s1: { id: 's1', retainedBy: {} } });
  const welcome = await panelFollowed();
  if (welcome.includes('Host 半') || welcome.includes('存储与工具')) failures.push('welcome page kept the previous session tasks');
  if (welcome.includes('main')) failures.push('welcome page kept the previous session git data');
  if (welcome.includes('Researcher')) failures.push('welcome page kept the previous session subagent data');

  // 2. The welcome page turns into a real session: only that session's data.
  setSessions({ s1: { id: 's1', retainedBy: {} }, s2: { id: 's2', retainedBy: { mainView: 1 } } });
  const freshSession = await panelFollowed();
  if (freshSession.includes('Host 半')) failures.push('new session showed the previous session tasks');
  if (!freshSession.includes('自动建立任务树')) failures.push('new session did not start from its own empty tree');

  // 3. That new session builds its own tree.
  sessionSamples.set('s2', Object.assign({}, sessionSamples.get('s2'), { tasks: sessionBTasks, 'tasks/status': sessionBStatus }));
  api.refresh();
  const builtFresh = await panelFollowed();
  if (!builtFresh.includes('会话 B 的任务')) failures.push('new session did not render its own tree');
  if (builtFresh.includes('Host 半')) failures.push('new session tree mixed in the previous session');

  // 4. Back to the original session: its own data returns.
  setSessions({ s1: { id: 's1', retainedBy: { mainView: 1 } }, s2: { id: 's2', retainedBy: {} } });
  const returned = await panelFollowed();
  if (!returned.includes('Host 半')) failures.push('returning to the old session lost its tree');
  if (returned.includes('会话 B 的任务')) failures.push('returning to the old session kept the new session tree');
}

// ---------------------------------------------------------------------------
// welcome page without the frame hook: the entry unmount is the only signal
// ---------------------------------------------------------------------------

{
  resetSlots();
  setSessions({});
  sessionSamples.set('s1', { tasks: sessionATasks, 'tasks/status': sessionAStatus, git: sessionAGit, sources: samples.sources, subagents: samples.subagents, context: samples.context, outputs: samples.outputs });
  await entryFor('s1');
  api.open('s1');
  const shown = await renderTree(panelEntry.component, {});
  if (!shown.includes('Host 半')) failures.push('fallback path: session A did not render');

  unmountAll();
  const afterUnmount = await renderTree(panelEntry.component, {});
  if (afterUnmount.includes('Host 半')) failures.push('fallback path: unmounting the entry left the previous session tasks');
  if (afterUnmount !== '') failures.push('fallback path: the panel stayed visible without a session');
}

api.openTask('s1', 't5');
console.log('sidebar calls:', JSON.stringify(rightCalls, null, 0));
if (rightCalls[0]?.call !== 'openResource' || rightCalls[0]?.address !== 'dsh-resource://file/session/s1/a.txt') failures.push('openSourceFile');
if (rightCalls[1]?.call !== 'openTab' || rightCalls[1]?.kind !== 'browser' || rightCalls[1]?.options?.params?.url !== 'https://example.com') failures.push('openSourceUrl');
if (rightCalls[2]?.kind !== 'summary-panel.diff') failures.push('openDiff');
if (rightCalls[3]?.call !== 'openSession' || rightCalls[3]?.target?.childSessionId !== 's-child-1') failures.push('openSubagent');
if (rightCalls[4]?.call !== 'openSession' || rightCalls[4]?.target !== 's1') failures.push('openParent');
if (rightCalls[5]?.kind !== 'summary-panel.task' || rightCalls[5]?.options?.params?.taskId !== 't5') failures.push('openTask');
if (errors.length > 0) failures.push(...errors.map((error) => String(error?.message ?? error)));
console.log("panel sample:", text.replace(/\s+/g, " "));
console.log(failures.length === 0 ? 'client OK' : 'FAILED: ' + failures.join(' | '));
process.exit(failures.length === 0 ? 0 : 1);
