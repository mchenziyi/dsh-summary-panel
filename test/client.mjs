/* Minimal React + DOM harness for the client half. */
const errors = [];
const Fragment = Symbol('Fragment');
const hookStates = new Map();
let currentSlots = null;
let hookIndex = 0;
let pendingEffects = [];
let pendingCleanups = [];
let dirty = false;
// Component keys invoked in the current pass. A key that was mounted before and
// is missing now was unmounted, exactly like React's reconciler decides.
let renderedPaths = new Set();
// Every root whose components are still mounted, and the keys its last pass
// rendered. Keyed by root because the panel and the entry button are separate
// slots that coexist, each keeping its own tree.
const mountedRoots = new Map();

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
// Element capture. The older assertions only needed visible text, but the
// requirements for §7 are written in things text cannot express: "only a colour
// dot, no status word", "the focused row is bold with a pale background",
// "the status lamp only shows while the panel is closed". Every pass therefore
// also records one node per host element (`div`, `span`, `button`, `svg`, …)
// with its class names, attributes, handlers, rendered text and parent. The
// record keeps the props object the client built, so a handler can be clicked
// and an attribute can be read exactly as the browser would see it.
let passElements = [];
let lastElements = [];
let elementStack = [];
function captureElement(type, props) {
  const record = {
    tag: type,
    className: typeof props.className === 'string' ? props.className : '',
    props,
    text: '',
    parent: elementStack.length === 0 ? null : elementStack[elementStack.length - 1],
    children: [],
  };
  if (type === 'style' && props.dangerouslySetInnerHTML !== undefined && props.dangerouslySetInnerHTML !== null
    && typeof props.dangerouslySetInnerHTML.__html === 'string') {
    record.html = props.dangerouslySetInnerHTML.__html;
  }
  if (record.parent !== null) record.parent.children.push(record);
  passElements.push(record);
  return record;
}
function renderNode(node, path) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) { node.forEach((child, index) => renderNode(child, `${path}[${index}]`)); return; }
  if (typeof node === 'string' || typeof node === 'number') { output.push(String(node)); return; }
  if (typeof node !== 'object') return;
  const { type, props } = node;
  if (type === Fragment) { renderNode(props.children, path); return; }
  if (typeof type === 'function') {
    const savedSlots = currentSlots; const savedIndex = hookIndex;
    const key = `${path}#${type.name || 'anonymous'}`;
    renderedPaths.add(key);
    const slots = slotsAt(key);
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
  if (typeof type === 'string') {
    const record = captureElement(type, props);
    const start = output.length;
    elementStack.push(record);
    renderNode(props.children, path);
    elementStack.pop();
    record.text = output.slice(start).join(' ');
  }
}
async function renderTree(Component, props, passes = 8) {
  // A re-rendered root continues its own tree, so a component that vanished
  // since that root's previous pass really was unmounted. Roots are tracked
  // separately: rendering one root never disturbs another's bookkeeping.
  let previous = mountedRoots.get(Component) ?? new Set();
  for (let pass = 0; pass < passes; pass += 1) {
    dirty = false; output = []; pendingEffects = []; pendingCleanups = []; hookIndex = 0;
    renderedPaths = new Set();
    passElements = []; elementStack = [];
    renderNode(React.createElement(Component, props), 'root');
    lastElements = passElements;
    unmountVanished(previous);
    previous = new Set(renderedPaths);
    mountedRoots.set(Component, renderedPaths);
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

/**
 * Unmount every component that was rendered in the previous pass of this tree
 * but not in the current one: run its effect cleanups and drop its hook state.
 * Scoped to one renderTree run on purpose — the panel and the entry button live
 * in different slots of the real UI, so a component missing from this tree is
 * not necessarily gone from the screen.
 */
function unmountVanished(previous) {
  for (const key of previous) {
    if (renderedPaths.has(key)) continue;
    const slots = hookStates.get(key);
    if (slots === undefined) continue;
    unmountSlots(slots);
    hookStates.delete(key);
  }
}

/** Run one component's effect cleanups in declaration order, like React. */
function unmountSlots(slots) {
  for (const effect of slots.effects) {
    if (effect === undefined || typeof effect.cleanup !== 'function') continue;
    try {
      effect.cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  slots.effects = [];
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
      { id: 't7', parentId: null, order: 2, title: '登录功能', summary: '已完成', status: 'done', settled: false, deferred: false, blocked: null, blocker: null, progress: '', result: '已上线', ownerSessionId: null, ownerLive: false, completion: 'user-confirmed', updatedAt: Date.now() },
      { id: 't8', parentId: 't7', order: 0, title: '修复 Token 过期', summary: '上线后发现', status: 'in_progress', deferred: false, blocked: null, blocker: null, progress: '定位中', result: null, ownerSessionId: null, ownerLive: false, completion: null, updatedAt: Date.now() },
      { id: 't9', parentId: null, order: 3, title: 'Web 管理后台', summary: '聊到但没批', status: 'pending', executionApproval: 'pending', deferred: false, blocked: null, blocker: null, progress: '', result: null, ownerSessionId: null, ownerLive: false, completion: null, updatedAt: Date.now() },
    ],
    archived: [],
    archivedCount: 0,
  },
  'tasks/status': { available: true, focus: [{ id: 't5', title: '存储与工具', status: 'in_progress', blocked: false }], updatedAt: Date.now() },
};
// The panel reads the DOM in two ways the requirements care about: it listens
// for Escape on `document` and for resize on `window`. A no-op stub made those
// paths unobservable, so the stubs now record their listeners and the suite can
// dispatch at them — that is the only way to prove "Esc closes, an outside click
// does not, scrolling does not".
function makeListeners() {
  const listeners = new Map();
  return {
    listeners,
    add(type, fn) {
      if (typeof fn !== 'function') return;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    remove(type, fn) {
      const set = listeners.get(type);
      if (set !== undefined) set.delete(fn);
    },
    count(type) {
      const set = listeners.get(type);
      return set === undefined ? 0 : set.size;
    },
    dispatch(type, event) {
      const set = listeners.get(type);
      if (set === undefined) return 0;
      let ran = 0;
      for (const fn of [...set]) { fn(event); ran += 1; }
      return ran;
    },
  };
}
const documentEvents = makeListeners();
const windowEvents = makeListeners();
globalThis.document = {
  baseURI: 'http://127.0.0.1:49605/',
  addEventListener: (type, fn) => documentEvents.add(type, fn),
  removeEventListener: (type, fn) => documentEvents.remove(type, fn),
};
globalThis.window = {
  location: { href: 'http://127.0.0.1:49605/' },
  open() {},
  addEventListener: (type, fn) => windowEvents.add(type, fn),
  removeEventListener: (type, fn) => windowEvents.remove(type, fn),
  __ModuleLoader__: { load(registration) { globalThis.window.__captured = registration; } },
};
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
/** Run every effect cleanup under one path prefix and forget those components. */
function dropSlots(prefix) {
  for (const [key, slots] of [...hookStates.entries()]) {
    if (!key.startsWith(prefix)) continue;
    unmountSlots(slots);
    hookStates.delete(key);
  }
  for (const [root, paths] of [...mountedRoots.entries()]) {
    if ([...paths].every((key) => key.startsWith(prefix))) mountedRoots.delete(root);
  }
}
function unmountAll(prefix = 'root') {
  dropSlots(prefix);
  dirty = true;
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

// ---------------------------------------------------------------------------
// queries and actions over the last rendered tree
// ---------------------------------------------------------------------------

function tokens(element) {
  return element === undefined ? [] : element.className.split(/\s+/).filter(Boolean);
}
function hasClass(element, name) {
  return element !== undefined && tokens(element).includes(name);
}
function byClass(name) {
  return lastElements.filter((element) => tokens(element).includes(name));
}
function byTag(tag) {
  return lastElements.filter((element) => element.tag === tag);
}
function isInside(element, ancestor) {
  if (element === undefined || ancestor === undefined) return false;
  let cursor = element.parent;
  while (cursor !== null) {
    if (cursor === ancestor) return true;
    cursor = cursor.parent;
  }
  return false;
}
/** Every descendant record of `ancestor`, depth first. */
function descendantsOf(ancestor) {
  const found = [];
  const walk = (element) => {
    for (const child of element.children) {
      found.push(child);
      walk(child);
    }
  };
  if (ancestor !== undefined) walk(ancestor);
  return found;
}
/** The CSS the client actually rendered into the document. */
function styleCss() {
  const style = lastElements.find((element) => element.tag === 'style' && typeof element.html === 'string');
  return style === undefined ? '' : style.html;
}
/** One tree row, found by the title it shows. */
function rowOf(title) {
  return byClass('sp-task-row').find((row) => row.text.includes(title));
}
function within(row, className) {
  return byClass(className).filter((element) => isInside(element, row));
}
const FAKE_RECT = { left: 240, top: 120, right: 400, bottom: 140, width: 160, height: 20 };
/** The event shape the client's handlers read: `currentTarget` and `target`. */
function fakeEvent(rect = FAKE_RECT) {
  return {
    currentTarget: { getBoundingClientRect: () => rect },
    target: { closest: () => null },
    stopPropagation() {},
    preventDefault() {},
  };
}
/** Click a captured element through the handler the client attached to it. */
function clickElement(element, label = 'element') {
  if (element === undefined) return `click ${label}: not found`;
  if (typeof element.props.onClick !== 'function') return `click ${label}: ${element.tag}.${element.className} has no onClick`;
  element.props.onClick(fakeEvent());
  return null;
}
function hoverElement(element, label = 'element') {
  if (element === undefined) return `hover ${label}: not found`;
  if (typeof element.props.onMouseEnter !== 'function') return `hover ${label}: ${element.tag}.${element.className} has no onMouseEnter`;
  element.props.onMouseEnter(fakeEvent());
  return null;
}
function leaveElement(element) {
  if (element !== undefined && typeof element.props.onMouseLeave === 'function') element.props.onMouseLeave(fakeEvent());
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Harness self-test: a component that stops being rendered must run its cleanup
// and lose its state — including when another root was rendered in between,
// which is how the suite interleaves the panel and the entry button. Every
// conditional-section case below depends on this, and before it existed the
// suite could not see a leaked timer or a stale popover.
{
  const cleanups = [];
  function Probe() {
    const [count] = React.useState(0);
    React.useEffect(() => () => { cleanups.push(count); }, []);
    return `probe-${count}`;
  }
  function Holder({ show }) {
    return show ? React.createElement(Probe) : 'gone';
  }
  function OtherRoot() {
    return 'other';
  }
  const mounted = await renderTree(Holder, { show: true });
  if (mounted !== 'probe-0') failures.push(`harness: probe did not mount (${mounted})`);
  const other = await renderTree(OtherRoot, {});
  if (other !== 'other') failures.push(`harness: second root rendered ${other}`);
  const unmounted = await renderTree(Holder, { show: false });
  if (unmounted !== 'gone') failures.push(`harness: probe survived unmount (${unmounted})`);
  if (cleanups.length !== 1) failures.push(`harness: unmount across an interleaved root ran ${cleanups.length} cleanups, expected 1`);
  const remounted = await renderTree(Holder, { show: true });
  if (remounted !== 'probe-0') failures.push(`harness: remount kept stale state (${remounted})`);
  if (cleanups.length !== 1) failures.push('harness: remount ran an extra cleanup');

  // Cleanup order: React destroys a component's effects in declaration order.
  // A reverse loop would still run both cleanups, so the "ran once" check above
  // cannot see an ordering bug; this probe pins the exact order.
  {
    const order = [];
    function OrderedProbe() {
      React.useEffect(() => () => { order.push('first'); }, []);
      React.useEffect(() => () => { order.push('second'); }, []);
      return 'ordered';
    }
    function OrderedHolder({ show }) {
      return show ? React.createElement(OrderedProbe) : 'gone';
    }
    const orderedMounted = await renderTree(OrderedHolder, { show: true });
    if (orderedMounted !== 'ordered') failures.push(`harness: ordered probe did not mount (${orderedMounted})`);
    const orderedUnmounted = await renderTree(OrderedHolder, { show: false });
    if (orderedUnmounted !== 'gone') failures.push(`harness: ordered probe survived unmount (${orderedUnmounted})`);
    if (order.length !== 2 || order[0] !== 'first' || order[1] !== 'second') {
      failures.push(`harness: unmount cleanups ran [${order.join(', ')}], expected ['first', 'second'] in declaration order`);
    }
  }
}

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
  dropSlots('root');
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
  dropSlots('root');
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
// ---------------------------------------------------------------------------
// §7 悬浮窗 / §8 右侧栏：需求级验收断言
//
// 需求原文：docs/requirements/REQUIREMENTS.md §7 (284-356) / §8 (360-378)。
// 这些断言按需求写，不按现状写。现状与需求对不上的地方不做静默放过：先在
// 这里断言，能修的极小偏差当场修掉，其余红了就是实现与需求有偏差——要改的
// 是实现或需求文档，不是把断言放宽。
// ---------------------------------------------------------------------------

const check = (ok, message) => { if (!ok) failures.push(message); };

function uiTask(id, title, extra) {
  return Object.assign({
    id,
    parentId: null,
    order: 0,
    title,
    summary: '',
    status: 'pending',
    executionApproval: 'approved',
    requiresUserAcceptance: false,
    deferred: false,
    blocked: false,
    blocker: null,
    progress: '',
    result: null,
    ownerSessionId: null,
    ownerLive: false,
    completion: null,
    updatedAt: 1,
  }, extra);
}

// One small but complete tree, shaped so every §7 rule has something to point
// at: two branches (indentation and parent/child), a deferred row, a blocked
// row with a reason, a finished row and an unapproved idea.
const uiTree = [
  uiTask('u1', '渲染层', { status: 'in_progress', summary: '悬浮窗的任务树', order: 0 }),
  uiTask('u2', '焦点行样式', { parentId: 'u1', status: 'in_progress', summary: '加粗与淡背景', order: 0 }),
  uiTask('u3', '设计稿分支', { parentId: 'u1', status: 'pending', deferred: true, order: 1 }),
  uiTask('u4', '卡住的权限申请', {
    parentId: 'u2',
    status: 'blocked',
    summary: '等账号权限',
    blocker: { reason: '等待账号权限', unblock: '运维开通账号' },
    order: 0,
  }),
  uiTask('u5', '已交付的历史功能', { status: 'done', result: '已上线', completion: 'user-confirmed', settled: true, order: 1 }),
  uiTask('u6', '聊到但没批的想法', { status: 'pending', executionApproval: 'pending', order: 2 }),
  uiTask('u7', '右栏详情', { status: 'in_progress', summary: '字段渲染', order: 3 }),
  uiTask('u8', '详情按钮', { parentId: 'u7', status: 'in_progress', order: 0 }),
];

function uiPayload(tasks, focus, extra) {
  return Object.assign({
    available: true,
    worklineId: 'ui',
    goal: null,
    outline: '',
    focus,
    updatedAt: Date.now(),
    tasks,
    archived: [],
    archivedCount: 0,
  }, extra);
}
function uiStatus(focus, tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return {
    available: true,
    updatedAt: Date.now(),
    focus: focus.map((id) => {
      const task = byId.get(id);
      return {
        id,
        title: task === undefined ? id : task.title,
        status: task === undefined ? 'pending' : task.status,
        blocked: task !== undefined && task.status === 'blocked',
      };
    }),
  };
}
function uiSession(id, tasks, focus, extra) {
  sessionSamples.set(id, { tasks: uiPayload(tasks, focus, extra), 'tasks/status': uiStatus(focus, tasks) });
  return id;
}
function iconElementOf(row) {
  return row === undefined ? undefined : descendantsOf(row).find((element) => /(^|\s)sp-task-icon-/.test(element.className));
}
function titleElementOf(row) {
  return row === undefined ? undefined : descendantsOf(row).find((element) => hasClass(element, 'sp-task-title'));
}
function mainElementOf(row) {
  return row === undefined ? undefined : descendantsOf(row).find((element) => hasClass(element, 'sp-task-main'));
}
function arrowElementOf(row) {
  return row === undefined ? undefined : descendantsOf(row).find((element) => hasClass(element, 'sp-task-arrow'));
}
function focusTokenOf(row) {
  return tokens(row).filter((name) => name.startsWith('sp-task-row-focus')).sort().join(' ');
}

// ---------------------------------------------------------------------------
// §7.1 任务树行 + §7.2 焦点视觉 + §7.3 默认收纳（焦点 = u4）
// ---------------------------------------------------------------------------

const uiFocusSession = uiSession('ui-focus', uiTree, ['u4']);
await entryFor(uiFocusSession);
api.open(uiFocusSession);
const focusTreeText = await panelFor();

const rowRoot = rowOf('渲染层');
const rowFocusParent = rowOf('焦点行样式');
const rowBlocked = rowOf('卡住的权限申请');
const rowDeferred = rowOf('设计稿分支');
check(rowRoot !== undefined && rowFocusParent !== undefined && rowBlocked !== undefined,
  `7.1 焦点路径没有渲染出来（每行=展开入口+状态颜色点+任务名）: ${focusTreeText}`);

// REQ:292 不显示编号
check(!/(^|\s)u\d(\s|$)/.test(focusTreeText), `7.1 REQ:292 任务树里出现了任务编号: ${focusTreeText}`);
for (const row of byClass('sp-task-row')) {
  check(!/^(t|u)\d+/.test(row.text), `7.1 REQ:292 行以编号开头: ${row.text}`);
}

// REQ:290/295 每行只有 展开入口 + 状态颜色点 + 任务名，状态不用文字表达
for (const row of byClass('sp-task-row')) {
  const handles = within(row, 'sp-task-arrow').length + within(row, 'sp-task-arrow-space').length;
  check(handles === 1, `7.1 REQ:290 行缺少展开/折叠入口（或占位）: ${row.text}`);
  const statusDots = descendantsOf(row).filter((element) => /(^|\s)sp-task-icon-/.test(element.className));
  check(statusDots.length === 1, `7.1 REQ:290 行的状态颜色点数量不对（${statusDots.length}）: ${row.text}`);
}
const STATUS_WORDS = ['待开始', '进行中', '阻塞', '已完成', '暂缓'];
for (const row of byClass('sp-task-row')) {
  for (const word of STATUS_WORDS) {
    check(!row.text.includes(word), `7.1 REQ:295 行内出现状态文字「${word}」，需求要求树中只用颜色点: ${row.text}`);
  }
}

// REQ:297 状态用颜色点，颜色取主题语义色
check(hasClass(iconElementOf(rowBlocked), 'sp-task-icon-blocked'), '7.1 REQ:297 阻塞任务的状态点没有用阻塞语义色');
check(hasClass(iconElementOf(rowFocusParent), 'sp-task-icon-in_progress'), '7.1 REQ:297 进行中任务的状态点没有用进行中语义色');
check(hasClass(iconElementOf(rowOf('已交付的历史功能')), 'sp-task-icon-done'), '7.1 REQ:297 已完成任务的状态点没有用完成语义色');
check(hasClass(iconElementOf(rowOf('聊到但没批的想法')), 'sp-task-icon-pending'), '7.1 REQ:297 未开始任务的状态点没有用待开始语义色');

// REQ:293 用缩进表达父子关系
check(within(rowRoot, 'sp-task-guide').length === 0, `7.1 REQ:293 顶层任务带了缩进（${within(rowRoot, 'sp-task-guide').length}）`);
check(within(rowFocusParent, 'sp-task-guide').length === 1,
  `7.1 REQ:293 一级子任务的缩进层级不对（${within(rowFocusParent, 'sp-task-guide').length}，应为 1）`);
check(within(rowBlocked, 'sp-task-guide').length === 2,
  `7.1 REQ:293 二级子任务的缩进层级不对（${within(rowBlocked, 'sp-task-guide').length}，应为 2）`);
check(rowFocusParent.props['aria-level'] === 2 && rowBlocked.props['aria-level'] === 3,
  '7.1 REQ:293 aria-level 没有表达父子层级');

// REQ:297 使用主题语义色，不硬编码色值
const cssText = styleCss();
const taskCssFrom = cssText.indexOf('.sp-task-tree{');
const taskCssTo = cssText.indexOf('.sp-detail-pop{');
check(taskCssFrom >= 0 && taskCssTo > taskCssFrom, '7.1 没有找到任务树的样式块');
const taskCss = taskCssFrom >= 0 && taskCssTo > taskCssFrom ? cssText.slice(taskCssFrom, taskCssTo) : '';
check(!/#[0-9a-fA-F]{3,8}/.test(taskCss), '7.1 REQ:297 任务树样式硬编码了色值，需求要求使用 DSH 主题语义色');
for (const status of ['pending', 'in_progress', 'blocked', 'done']) {
  check(new RegExp(`\\.sp-task-icon-${status}\\{color:var\\(--dsw-`).test(taskCss),
    `7.1 REQ:297 状态点 ${status} 没有使用主题语义色`);
}

// REQ:296 暂缓任务整行降低不透明度
check(hasClass(rowDeferred, 'sp-task-row-deferred'), '7.1 REQ:296 暂缓任务没有整行降透明度');
check(/\.sp-task-row-deferred\{opacity:\.5\}/.test(cssText), '7.1 REQ:296 暂缓行的透明度样式缺失');

// REQ:301 焦点行：任务名加粗 + 很淡的行背景
check(hasClass(rowBlocked, 'sp-task-row-focus'), '7.2 REQ:301 实际执行的任务行没有焦点样式类');
check(/\.sp-task-row-focus>\.sp-task-main>\.sp-task-title\{font-weight:700\}/.test(cssText),
  '7.2 REQ:301 焦点行任务名没有加粗');
check(/\.sp-task-row-focus\{background:color-mix\(in srgb,var\(--dsw-static-blue-500\) 10%,transparent\)\}/.test(cssText),
  '7.2 REQ:301 焦点行没有很淡的行背景');

// REQ:302/303 父任务不跟随高亮：父任务可显示进行中，焦点只在被执行的子任务上
check(!hasClass(rowFocusParent, 'sp-task-row-focus'), '7.2 REQ:302 父任务跟随了执行高亮');
check(!hasClass(rowRoot, 'sp-task-row-focus'), '7.2 REQ:302 祖父任务跟随了执行高亮');
check(hasClass(iconElementOf(rowRoot), 'sp-task-icon-in_progress'), '7.2 REQ:303 父任务应仍显示"进行中"');

// REQ:311 首次打开只展开焦点祖先路径，其余收纳
check(rowOf('详情按钮') === undefined, '7.3 REQ:311 首次打开展开了非焦点分支（u7 的子树）');
for (const title of ['渲染层', '焦点行样式', '卡住的权限申请', '已交付的历史功能', '聊到但没批的想法', '右栏详情']) {
  check(rowOf(title) !== undefined, `7.3 REQ:311 焦点路径/顶层任务被错误收起: ${title}`);
}

// ---------------------------------------------------------------------------
// §7.2/§7.3 多焦点：两个分支同时展开并同等高亮
// ---------------------------------------------------------------------------

const uiMulti = uiSession('ui-multi', uiTree, ['u2', 'u8']);
await entryFor(uiMulti);
api.open(uiMulti);
const multiText = await panelFor();
const rowM2 = rowOf('焦点行样式');
const rowM8 = rowOf('详情按钮');
check(rowM2 !== undefined && rowM8 !== undefined, `7.3 REQ:313 多个焦点时没有展开所有焦点路径: ${multiText}`);
check(hasClass(rowM2, 'sp-task-row-focus') && hasClass(rowM8, 'sp-task-row-focus'),
  '7.2 REQ:306 多个执行项没有同时高亮');
check(focusTokenOf(rowM2) === focusTokenOf(rowM8),
  `7.2 REQ:307 多个执行项的高亮不一致: ${focusTokenOf(rowM2)} vs ${focusTokenOf(rowM8)}`);
check(!hasClass(rowOf('渲染层'), 'sp-task-row-focus') && !hasClass(rowOf('右栏详情'), 'sp-task-row-focus'),
  '7.2 REQ:302 多焦点时父任务也跟着高亮了');
const focusClassNames = new Set();
for (const row of byClass('sp-task-row')) {
  for (const name of tokens(row)) if (name.startsWith('sp-task-row-focus')) focusClassNames.add(name);
}
check(focusClassNames.size === 1, `7.2 REQ:307 焦点高亮类名应只有一个（同等高亮），实际: ${focusClassNames.size === 0 ? '没有任何高亮行' : [...focusClassNames].join(', ')}`);

// ---------------------------------------------------------------------------
// §7.2/§7.3 无焦点：清空执行高亮 + 整棵树收纳只留顶层
// ---------------------------------------------------------------------------

const uiNone = uiSession('ui-none', uiTree, []);
await entryFor(uiNone);
api.open(uiNone);
const noneText = await panelFor();
check(!byClass('sp-task-row').some((row) => hasClass(row, 'sp-task-row-focus')),
  '7.2 REQ:305 执行焦点清空后仍有行保持执行高亮');
for (const title of ['渲染层', '已交付的历史功能', '聊到但没批的想法', '右栏详情']) {
  check(rowOf(title) !== undefined, `7.3 REQ:312 无焦点时顶层任务没有全部显示: ${title}`);
}
for (const title of ['焦点行样式', '卡住的权限申请', '详情按钮']) {
  check(rowOf(title) === undefined, `7.3 REQ:312 无任何执行焦点时整棵树应收纳，却露出了: ${title}`);
}

// ---------------------------------------------------------------------------
// §7.3 展开状态：用户可以展开，更新不收回；状态变化不动展开状态
// ---------------------------------------------------------------------------

const uiKeep = uiSession('ui-keep', uiTree, ['u2']);
await entryFor(uiKeep);
api.open(uiKeep);
let keepText = await panelFor();
check(rowOf('焦点行样式') !== undefined, `7.3 REQ:311 焦点路径没有展开: ${keepText}`);
check(rowOf('详情按钮') === undefined, '7.3 REQ:311 非焦点分支默认应收起');

const openBranchError = clickElement(arrowElementOf(rowOf('右栏详情')), 'u7 arrow');
check(openBranchError === null, openBranchError);
keepText = await panelFor();
check(rowOf('详情按钮') !== undefined, `7.3 REQ:318 点击折叠入口没有展开分支: ${keepText}`);

// REQ:319 用户手动展开过的分支，Agent 更新时不得强制收回
const tickedTree = uiTree.map((task) => (task.id === 'u8'
  ? Object.assign({}, task, { status: 'blocked', updatedAt: 2 })
  : task));
sessionSamples.set(uiKeep, { tasks: uiPayload(tickedTree, ['u2']), 'tasks/status': uiStatus(['u2'], tickedTree) });
api.refresh();
keepText = await panelFor();
check(rowOf('详情按钮') !== undefined, '7.3 REQ:319 数据更新收回了用户手动展开的分支');

// REQ:314 状态变化但焦点未变：不改变展开状态
const collapseError = clickElement(arrowElementOf(rowOf('渲染层')), 'u1 arrow');
check(collapseError === null, collapseError);
keepText = await panelFor();
check(rowOf('焦点行样式') === undefined, `7.3 REQ:318 点击折叠入口没有收起分支: ${keepText}`);
const statusOnlyTree = tickedTree.map((task) => (task.id === 'u3'
  ? Object.assign({}, task, { status: 'in_progress', updatedAt: 3 })
  : task));
sessionSamples.set(uiKeep, { tasks: uiPayload(statusOnlyTree, ['u2']), 'tasks/status': uiStatus(['u2'], statusOnlyTree) });
api.refresh();
keepText = await panelFor();
check(rowOf('焦点行样式') === undefined, '7.3 REQ:314 状态变化（焦点未变）改变了展开状态，界面会跳动');

// REQ:320 焦点切换到新任务：自动展开新焦点路径，之前展开的分支保持不动
sessionSamples.set(uiKeep, { tasks: uiPayload(statusOnlyTree, ['u4']), 'tasks/status': uiStatus(['u4'], statusOnlyTree) });
api.refresh();
keepText = await panelFor();
check(rowOf('焦点行样式') !== undefined, `7.3 REQ:320 焦点切换后没有自动展开新焦点路径: ${keepText}`);
check(rowOf('卡住的权限申请') !== undefined, '7.3 REQ:320 焦点切换后新焦点任务没有露出来');
check(hasClass(rowOf('卡住的权限申请'), 'sp-task-row-focus'), '7.2 REQ:304 焦点切换后高亮没有同步移动');
check(!hasClass(rowOf('焦点行样式'), 'sp-task-row-focus'), '7.2 REQ:304 焦点切换后旧焦点仍然高亮');
check(rowOf('详情按钮') !== undefined, '7.3 REQ:320 焦点切换收回了之前手动展开的分支');

// REQ:311 重新进入会话：展开状态回到默认（只展开焦点祖先路径）
await entryFor(uiNone);
await panelFor(); // 面板确实切到了另一个会话，再切回来
await entryFor(uiKeep);
const reenteredText = await panelFor();
check(rowOf('详情按钮') === undefined, `7.3 REQ:311 重新进入会话没有回到默认收纳: ${reenteredText}`);
check(rowOf('卡住的权限申请') !== undefined, '7.3 REQ:311 重新进入会话后焦点路径没有展开');

// ---------------------------------------------------------------------------
// §7.4 悬停简介：完整任务名 + 简介 + 阻塞原因，不堆放日志或按钮
// ---------------------------------------------------------------------------

const uiHover = uiSession('ui-hover', uiTree, ['u4']);
await entryFor(uiHover);
api.open(uiHover);
await panelFor();
const hoverOpenError = hoverElement(mainElementOf(rowOf('卡住的权限申请')), 'u4 row');
check(hoverOpenError === null, hoverOpenError);
await wait(320);
await panelFor();
let tips = byClass('sp-task-tip');
check(tips.length === 1, `7.4 REQ:325 悬停在阻塞任务行上没有出现简介（${tips.length}）`);
const blockedTip = tips[0];
if (blockedTip !== undefined) {
  check(blockedTip.text.includes('卡住的权限申请'), `7.4 REQ:327 简介缺少完整任务名: ${blockedTip.text}`);
  check(blockedTip.text.includes('等账号权限'), `7.4 REQ:328 简介缺少任务简介: ${blockedTip.text}`);
  check(blockedTip.text.includes('等待账号权限'), `7.4 REQ:329 阻塞任务缺少简短阻塞原因: ${blockedTip.text}`);
  check(blockedTip.text === '卡住的权限申请 等账号权限 阻塞原因：等待账号权限',
    `7.4 REQ:331 简介混入了额外内容: ${blockedTip.text}`);
  check(blockedTip.children.length === 3,
    `7.4 REQ:331 简介不止三样内容（${blockedTip.children.map((child) => child.className || child.tag).join(', ')}）`);
  check(!descendantsOf(blockedTip).some((element) => element.tag === 'button'), '7.4 REQ:331 简介里出现了操作按钮');
  check(blockedTip.text.length < 80, '7.4 REQ:331 简介过长，堆放了完整日志或长历史');
}
leaveElement(mainElementOf(rowOf('卡住的权限申请')));
await panelFor();
check(byClass('sp-task-tip').length === 0, '7.4 鼠标移开后简介没有消失');

const hoverPlainError = hoverElement(mainElementOf(rowOf('焦点行样式')), 'u2 row');
check(hoverPlainError === null, hoverPlainError);
await wait(320);
await panelFor();
tips = byClass('sp-task-tip');
const plainTip = tips[0];
check(plainTip !== undefined && plainTip.text.includes('焦点行样式') && plainTip.text.includes('加粗与淡背景'),
  `7.4 REQ:327-328 非阻塞任务的简介缺少任务名或简介: ${plainTip === undefined ? '没有简介' : plainTip.text}`);
check(plainTip !== undefined && !plainTip.text.includes('阻塞原因'), '7.4 REQ:329 非阻塞任务也显示了阻塞原因');
check(plainTip !== undefined && plainTip.children.length === 2,
  `7.4 REQ:331 非阻塞简介应为两行（任务名+简介），实际 ${plainTip === undefined ? '0' : plainTip.children.length}`);
leaveElement(mainElementOf(rowOf('焦点行样式')));
await panelFor();

// ---------------------------------------------------------------------------
// §7.5 面板开关与常驻
// ---------------------------------------------------------------------------

const uiPanel = uiSession('ui-panel', uiTree, ['u4']);
api.close();
await entryFor(uiPanel);
check((await panelFor()) === '', '7.5 关闭后面板仍留有内容');

// 上一次 renderTree 是面板（已关闭、没有任何元素），入口的 DOM 要重新取一次。
await entryFor(uiPanel);
const entryButton = byTag('button').find((element) => hasClass(element, 'sp-entry'));
check(entryButton !== undefined, '7.5 REQ:337 会话头部没有入口按钮');
const entryOpenError = clickElement(entryButton, 'entry button');
check(entryOpenError === null, entryOpenError);
const openedText = await panelFor();
check(openedText.includes('渲染层'), `7.5 REQ:337 点击入口按钮没有打开面板: ${openedText}`);
check(documentEvents.count('keydown') >= 1, '7.5 REQ:339 面板打开时没有注册 Esc 监听');

// REQ:338 点击面板外部不关闭
documentEvents.dispatch('pointerdown', { target: { closest: () => null }, stopPropagation() {}, preventDefault() {} });
check((await panelFor()).includes('渲染层'), '7.5 REQ:338 点击面板外部把面板关掉了');

// REQ:338 面板稳定停留在打开位置：位置写在面板根节点上，刷新不跳动
const panelRoot = lastElements.find((element) => hasClass(element, 'sp-root'));
check(panelRoot !== undefined && typeof panelRoot.props.style?.top === 'string'
  && typeof panelRoot.props.style?.right === 'string', '7.5 REQ:338 面板没有固定的打开位置');
const positionBefore = panelRoot === undefined ? '' : `${panelRoot.props.style.top}/${panelRoot.props.style.right}`;
api.refresh();
const refreshedText = await panelFor();
const panelRootAfter = lastElements.find((element) => hasClass(element, 'sp-root'));
const positionAfter = panelRootAfter === undefined ? '' : `${panelRootAfter.props.style.top}/${panelRootAfter.props.style.right}`;
check(refreshedText.includes('渲染层'), '7.5 刷新后面板内容消失了');
check(positionBefore !== '' && positionBefore === positionAfter,
  `7.5 REQ:338 刷新后面板位置跳动了: ${positionBefore} -> ${positionAfter}`);

// REQ:338 不随页面滚动消失
windowEvents.dispatch('scroll', {});
documentEvents.dispatch('scroll', {});
check((await panelFor()).includes('渲染层'), '7.5 REQ:338 页面滚动让面板消失了');

// 打开任务气泡后点外部：只关气泡，面板不关
const popoverError = clickElement(mainElementOf(rowOf('焦点行样式')), 'u2 row');
check(popoverError === null, popoverError);
const popoverText = await panelFor();
check(popoverText.includes('加粗与淡背景'), `7.5 点击任务行没有打开详情气泡: ${popoverText}`);
documentEvents.dispatch('pointerdown', { target: { closest: () => null }, stopPropagation() {}, preventDefault() {} });
const afterOutsideText = await panelFor();
check(afterOutsideText.includes('渲染层'), '7.5 REQ:338 点外部关闭了面板');
check(!afterOutsideText.includes('加粗与淡背景'), '7.5 REQ:338 点外部没有关闭详情气泡');

// REQ:339 Esc 关闭
documentEvents.dispatch('keydown', { key: 'Escape', stopPropagation() {}, preventDefault() {} });
check((await panelFor()) === '', '7.5 REQ:339 Esc 没有关闭面板');

// REQ:339 关闭按钮
clickElement(entryButton, 'entry reopen');
await panelFor();
const closeButton = byTag('button').find((element) => element.props['aria-label'] === '关闭');
check(closeButton !== undefined, '7.5 REQ:339 面板上没有关闭按钮');
const closeError = clickElement(closeButton, 'panel close');
check(closeError === null, closeError);
check((await panelFor()) === '', '7.5 REQ:339 关闭按钮没有关闭面板');

// REQ:339 再点入口按钮关闭
clickElement(entryButton, 'entry reopen 2');
check((await panelFor()).includes('渲染层'), '7.5 REQ:337 再点入口按钮没有重新打开面板');
clickElement(entryButton, 'entry toggle');
check((await panelFor()) === '', '7.5 REQ:339 再点入口按钮没有关闭面板');

// REQ:347/348 切换会话：面板不关闭，直接显示新会话的任务树/空态
const uiEmptySession = 'ui-panel-empty';
sessionSamples.set(uiEmptySession, { tasks: uiPayload([], []), 'tasks/status': uiStatus([], []) });
clickElement(entryButton, 'entry reopen 3');
await panelFor();
await entryFor(uiEmptySession);
const switchedText = await panelFor();
check(switchedText !== '', '7.5 REQ:347 切换会话把面板关掉了');
check(switchedText.includes('自动建立任务树'), `7.5 REQ:348 新会话没有显示空态: ${switchedText}`);

// ---------------------------------------------------------------------------
// §7.5 入口状态灯（呼吸灯）
// ---------------------------------------------------------------------------

const dotSession = uiSession('ui-dot', uiTree, ['u2']);
api.close();
await entryFor(dotSession);
await entryFor(dotSession);
const dots = byClass('sp-entry-dot');
check(dots.length === 1, `7.5 REQ:352 有执行焦点且面板关闭时入口没有状态点（${dots.length}）`);
check(dots.length === 1 && !hasClass(dots[0], 'sp-entry-dot-warn'), '7.5 REQ:353 进行中焦点的状态点用了警示色');

// REQ:352 面板关闭时才显示
api.open(dotSession);
await panelFor();
await entryFor(dotSession);
check(byClass('sp-entry-dot').length === 0, '7.5 REQ:352 面板打开时入口仍在显示状态点');
api.close();

// REQ:353 阻塞焦点 = 警示色
const dotBlockedSession = 'ui-dot-blocked';
sessionSamples.set(dotBlockedSession, {
  tasks: uiPayload(uiTree, ['u4']),
  'tasks/status': { available: true, updatedAt: Date.now(), focus: [{ id: 'u4', title: '卡住的权限申请', status: 'blocked', blocked: true }] },
});
await entryFor(dotBlockedSession);
const warnDots = byClass('sp-entry-dot');
check(warnDots.length === 1 && hasClass(warnDots[0], 'sp-entry-dot-warn'),
  `7.5 REQ:353 阻塞焦点的状态点没有用警示色（${warnDots.length} 个点）`);

// REQ:354 没有执行焦点时不显示
await entryFor(uiEmptySession);
check(byClass('sp-entry-dot').length === 0, '7.5 REQ:354 没有执行焦点时入口显示了状态点');

// REQ:355 悬停入口按钮可看到当前执行任务名
await entryFor(dotSession);
const dotEntryButton = byTag('button').find((element) => hasClass(element, 'sp-entry'));
const dotHoverError = hoverElement(dotEntryButton, 'entry button');
check(dotHoverError === null, dotHoverError);
await entryFor(dotSession);
const entryTip = byClass('sp-task-tip')[0];
check(entryTip !== undefined && entryTip.text.includes('焦点行样式'),
  `7.5 REQ:355 悬停入口看不到当前执行任务名: ${entryTip === undefined ? '没有提示' : entryTip.text}`);
check(entryTip !== undefined && entryTip.text.includes('摘要'), '7.5 REQ:355 悬停入口只有任务名，没有入口名称');

// REQ:353/356 呼吸脉动 + 尊重「减少动态效果」
const entryCss = styleCss();
check(/\.sp-entry-dot\{[^}]*animation:sp-breathe/.test(entryCss), '7.5 REQ:353 状态点没有呼吸动画');
check(/@keyframes sp-breathe\{0%,100%\{opacity:1\}50%\{opacity:\.25\}\}/.test(entryCss),
  '7.5 REQ:353 呼吸脉动没有低透明度关键帧');
check(/@media \(prefers-reduced-motion: reduce\)\{\.sp-entry-dot\{animation:none/.test(entryCss),
  '7.5 REQ:356 没有尊重系统「减少动态效果」设置');

// ---------------------------------------------------------------------------
// §8 右侧栏详情
// ---------------------------------------------------------------------------

const tabEntry = slotRegistrations.find((entry) => entry.registration.key === 'summary-panel.task');
check(tabEntry !== undefined, '§8 任务详情 tab 没有注册到 sidebar.right.pane.tab');
if (tabEntry !== undefined) {
  const zhDict = dicts.get('zh');
  const tabT = (key, params) => {
    let value = zhDict !== undefined && zhDict[key] !== undefined ? zhDict[key] : key;
    if (params !== undefined && params !== null) {
      for (const name of Object.keys(params)) value = value.split(`{${name}}`).join(String(params[name]));
    }
    return value;
  };
  const tabFor = async (sessionId, taskId) => renderTree(tabEntry.component, {
    sessionId,
    t: tabT,
    useTabInfo: () => ({ tab: { visible: true, navigation: { params: { sessionId, taskId }, revision: 0 } } }),
  });

  const tabTasks = uiTree.map((task) => Object.assign({}, task));
  const deferredIndex = tabTasks.findIndex((task) => task.id === 'u3');
  tabTasks[deferredIndex] = Object.assign({}, tabTasks[deferredIndex], {
    status: 'pending',
    deferred: true,
    progress: '做了六成',
    result: '部分可用',
    completion: 'self',
    deferredReason: '等设计定稿',
    resumeCondition: '设计稿确认后恢复',
    updatedAt: 5,
  });
  const parentIndex = tabTasks.findIndex((task) => task.id === 'u1');
  tabTasks[parentIndex] = Object.assign({}, tabTasks[parentIndex], {
    expectedOutcome: '详情页能看清这条任务要交付什么',
    nextStep: '补齐子任务列表',
  });
  const u4Index = tabTasks.findIndex((task) => task.id === 'u4');
  tabTasks[u4Index] = Object.assign({}, tabTasks[u4Index], {
    approvalBasis: '用户在 11:02 明确授权',
    temporary: true,
    temporaryFor: 'u2',
  });
  tabTasks[deferredIndex] = Object.assign({}, tabTasks[deferredIndex], {
    archiveHistory: [{ at: Date.now() - 600000, reason: '第一版被取消' }],
  });
  const tabArchived = [{ id: 'a1', title: '被取消的任务', archiveReason: '用户决定不做', archivedAt: Date.now() - 3600000 }];
  const tabPayload = Object.assign(uiPayload(tabTasks, []), {
    goal: {
      original: '原始目标 X',
      current: '当前目标 Y',
      changes: [{ at: Date.now() - 7200000, reason: '方向调整原因', previous: '旧目标', next: '新目标' }],
    },
    outline: '目标大纲第一行',
    archived: tabArchived,
    archivedCount: 1,
  });
  sessionSamples.set('ui-tab', { tasks: tabPayload, 'tasks/status': uiStatus([], tabTasks) });

  // REQ:362-376 阻塞任务：状态、说明、阻塞原因与解除条件、目标、修订记录、归档入口
  const tabBlockedText = await tabFor('ui-tab', 'u4');
  const DETAIL_NEEDLES = [
    ['卡住的权限申请', '任务标题'],
    ['阻塞', '当前状态'],
    ['等账号权限', '任务说明（简介）'],
    ['等待账号权限', '阻塞原因'],
    ['运维开通账号', '解除条件'],
    ['原始目标 X', '原始目标'],
    ['当前目标 Y', '当前目标'],
    ['目标大纲第一行', '目标大纲'],
    ['修订记录 (1)', '目标修订记录'],
    ['方向调整原因', '修订原因'],
    ['旧目标 → 新目标', '修订前后目标'],
    ['已归档 1', '已归档任务入口'],
    ['授权依据', '相关调整及原因（授权依据）'],
    ['用户在 11:02 明确授权', '授权依据内容'],
  ];
  for (const [needle, label] of DETAIL_NEEDLES) {
    check(tabBlockedText.includes(needle), `§8 详情缺少「${label}」: ${needle}`);
  }
  check(!tabBlockedText.includes('被取消的任务'), '§8 归档列表默认就展开了');
  const editable = lastElements.filter((element) => ['input', 'textarea', 'select'].includes(element.tag)
    || element.props.contentEditable === true || element.props.contenteditable === true);
  check(editable.length === 0, `§8 REQ:362 详情里出现了可编辑控件，需求要求只读: ${editable.map((element) => element.tag).join(', ')}`);

  // REQ:364-369 暂缓任务：进展、结果、完成方式、暂缓原因与恢复条件
  const tabDeferredText = await tabFor('ui-tab', 'u3');
  for (const [needle, label] of [
    ['设计稿分支', '任务标题'],
    ['暂缓', '当前状态'],
    ['做了六成', '进展'],
    ['部分可用', '结果'],
    ['Agent 自行确认', '完成方式/验证情况'],
    ['等设计定稿', '暂缓原因'],
    ['设计稿确认后恢复', '恢复条件'],
    ['归档历史', '相关调整及原因（归档历史）'],
    ['第一版被取消', '调整原因'],
  ]) {
    check(tabDeferredText.includes(needle), `§8 详情缺少「${label}」: ${needle}`);
  }

  // REQ:375 归档入口：展开后列出被取消任务的原因与产出，点一行能打开该任务
  const archiveToggle = lastElements.find((element) => hasClass(element, 'sp-detail-block-toggle'));
  const toggleError = clickElement(archiveToggle, 'archive toggle');
  check(toggleError === null, toggleError);
  const tabArchivedText = await tabFor('ui-tab', 'u3');
  check(tabArchivedText.includes('被取消的任务') && tabArchivedText.includes('用户决定不做'),
    `§8 REQ:375 归档入口没有列出被取消任务的原因: ${tabArchivedText}`);
  const archiveRow = lastElements.find((element) => hasClass(element, 'sp-detail-archive-row'));
  const archiveRowError = clickElement(archiveRow, 'archive row');
  check(archiveRowError === null, archiveRowError);
  const archiveCall = rightCalls[rightCalls.length - 1];
  check(archiveCall !== undefined && archiveCall.kind === 'summary-panel.task'
    && archiveCall.options?.params?.taskId === 'a1',
    `§8 REQ:375 归档任务点开后没有打开该任务的详情: ${JSON.stringify(archiveCall)}`);

  // REQ:375 悬浮窗不显示归档入口（只在右侧详情里）
  await entryFor('ui-tab');
  api.open('ui-tab');
  const tabSessionPanel = await panelFor();
  check(!tabSessionPanel.includes('已归档'), `§8 REQ:375 悬浮窗里出现了归档入口: ${tabSessionPanel}`);
  check(byClass('sp-detail-archive-row').length === 0, '§8 REQ:375 悬浮窗渲染了归档列表行');

  // REQ:378 悬浮窗与右侧栏同一份数据；打开详情不影响任务树状态
  clickElement(arrowElementOf(rowOf('右栏详情')), 'u7 arrow (tab session)');
  const expandedPanelText = await panelFor();
  check(rowOf('详情按钮') !== undefined, `§8 面板里手动展开没有生效: ${expandedPanelText}`);
  await tabFor('ui-tab', 'u4');
  const afterTabPanelText = await panelFor();
  check(rowOf('详情按钮') !== undefined, '§8 REQ:378 打开详情改变了任务树的展开状态');
  check(afterTabPanelText.includes('渲染层'), '§8 REQ:378 打开详情后任务树消失了');

  // REQ:362 点击任务 → 气泡 →「在右栏打开」→ 右侧栏详情
  clickElement(mainElementOf(rowOf('右栏详情')), 'u7 row (tab session)');
  await panelFor();
  const openTabLink = byTag('button').find((element) => element.text.includes('在右栏打开'));
  check(openTabLink !== undefined, '§8 REQ:362 任务气泡里没有「在右栏打开」入口');
  const openTabError = clickElement(openTabLink, 'open tab link');
  check(openTabError === null, openTabError);
  const openTabCall = rightCalls[rightCalls.length - 1];
  check(openTabCall !== undefined && openTabCall.kind === 'summary-panel.task'
    && openTabCall.options?.params?.taskId === 'u7',
    `§8 REQ:362 点击任务后没有在右侧栏打开详情: ${JSON.stringify(openTabCall)}`);

  // REQ:364/365/369 预期结果、子任务列表、下一步
  const tabParentText = await tabFor('ui-tab', 'u1');
  for (const [needle, label] of [
    ['预期结果', '预期结果字段'],
    ['详情页能看清这条任务要交付什么', '预期结果内容'],
    ['下一步', '下一步字段'],
    ['补齐子任务列表', '下一步内容'],
    ['子任务 (2)', '子任务列表标题'],
    ['焦点行样式', '子任务行（第一个子任务）'],
    ['设计稿分支', '子任务行（第二个子任务）'],
    ['暂缓', '子任务行的暂缓标记'],
  ]) {
    check(tabParentText.includes(needle), `§8 详情缺少「${label}」: ${needle}`);
  }
  const subtaskRows = byClass('sp-detail-subtask-row');
  check(subtaskRows.length === 2, `§8 REQ:365 子任务列表应只列直接子任务（2 个），实际 ${subtaskRows.length} 个`);
  check(subtaskRows[0] !== undefined && subtaskRows[0].text.includes('焦点行样式')
    && subtaskRows[0].text.includes('进行中'), `§8 REQ:365 子任务行缺少标题或状态: ${subtaskRows[0] === undefined ? '没有行' : subtaskRows[0].text}`);
  check(subtaskRows[1] !== undefined && subtaskRows[1].text.includes('设计稿分支')
    && subtaskRows[1].text.includes('待开始'), `§8 REQ:365 暂缓子任务的标题或状态不对: ${subtaskRows[1] === undefined ? '没有行' : subtaskRows[1].text}`);
  const subtaskClickError = clickElement(subtaskRows[0], 'subtask row');
  check(subtaskClickError === null, subtaskClickError);
  const subtaskCall = rightCalls[rightCalls.length - 1];
  check(subtaskCall !== undefined && subtaskCall.kind === 'summary-panel.task'
    && subtaskCall.options?.params?.taskId === 'u2',
    `§8 REQ:365 点击子任务没有打开它的详情: ${JSON.stringify(subtaskCall)}`);

  // REQ:107/§8.3 临时任务：右栏说明它打断了哪条主线任务
  const tabTemporaryText = await tabFor('ui-tab', 'u4');
  check(tabTemporaryText.includes('临时任务，打断自 焦点行样式'),
    `§8 临时任务没有说明打断来源: ${tabTemporaryText}`);
  const temporaryLine = lastElements.find((element) => hasClass(element, 'sp-detail-temporary'));
  check(temporaryLine !== undefined, '§8 临时任务说明没有专门的展示元素');

  // REQ:290 树行只含展开入口+状态点+任务名：临时标记不进树行，只在右栏
  // 说明来源（取舍见交付报告）。这一条把「没有行内标记」钉住。
  {
    const tempSession = uiSession('ui-temp', tabTasks, ['u4']);
    await entryFor(tempSession);
    api.open(tempSession);
    await panelFor();
    const tempRow = rowOf('卡住的权限申请');
    check(tempRow !== undefined, '§7.1 临时任务没有渲染进任务树');
    check(tempRow !== undefined && tempRow.text === '卡住的权限申请',
      `7.1 REQ:290 树行混入了任务名以外的内容（临时标记应当只在右栏）: ${tempRow === undefined ? '没有行' : tempRow.text}`);
    check(byClass('sp-task-row').every((row) => !row.text.includes('临时')), '7.1 REQ:290 任务树出现了行内「临时」标记');
  }
}

// ---------------------------------------------------------------------------
// REQ:339 第四种关闭方式：面板内的导航动作让位
//
// 需求（2026-11-09 与实现对齐后）写明关闭方式一共四种，第四种是"面板内的
// 导航动作会让位"：打开文件 / 链接 / 父会话 / 子会话 / diff / 任务详情时
// 面板自动收起，免得浮层挡住刚打开的目标。下面 6 条即验证这一条；source 指
// 该 API 方法里的 `panelStore.set({ open: false })`（client.js）。
// ---------------------------------------------------------------------------

const navSession = uiSession('ui-nav', uiTree, ['u4']);
const NAVIGATION_CLOSERS = [
  ['openSourceFile', () => api.openSourceFile('dsh-resource://file/session/ui-nav/a.txt'), 'client.js:2621'],
  ['openSourceUrl', () => api.openSourceUrl('https://example.com'), 'client.js:2631'],
  ['openParent', () => api.openParent('ui-nav'), 'client.js:2647'],
  ['openSubagent', () => api.openSubagent('ui-nav', { id: 's-child-1', mode: 'continuable' }), 'client.js:2660'],
  ['openDiff', () => api.openDiff('ui-nav', 'a.txt'), 'client.js:2669'],
  ['openTask', () => api.openTask('ui-nav', 'u4'), 'client.js:2690'],
];
for (const [name, run, source] of NAVIGATION_CLOSERS) {
  api.open(navSession);
  await panelFor();
  run();
  const afterNavigation = await panelFor();
  check(afterNavigation === '',
    `§7 REQ:339 第四种关闭方式：${source} ${name}() 没有让面板让位收起（导航后面板仍打开）`);
}
if (errors.length > 0) failures.push(...errors.map((error) => String(error?.message ?? error)));
console.log("panel sample:", text.replace(/\s+/g, " "));
console.log(failures.length === 0 ? 'client OK' : 'FAILED: ' + failures.join(' | '));
process.exit(failures.length === 0 ? 0 : 1);
