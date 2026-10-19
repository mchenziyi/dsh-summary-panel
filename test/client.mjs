/* Minimal React + DOM harness for the client half. */
const errors = [];
const Fragment = Symbol('Fragment');
const hookStates = new Map();
let currentSlots = null;
let hookIndex = 0;
let pendingEffects = [];
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
    if (previous === undefined || !depsEqual(previous.deps, deps)) { slots.effects[index] = { deps }; pendingEffects.push(fn); }
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
    currentSlots = slotsAt(`${path}#${type.name || 'anonymous'}`);
    hookIndex = 0;
    let result;
    try { result = type(props); } catch (error) { errors.push(error); }
    currentSlots = savedSlots; hookIndex = savedIndex;
    renderNode(result, `${path}>${type.name || 'anonymous'}`);
    return;
  }
  if (typeof type === 'string') renderNode(props.children, path);
}
async function renderTree(Component, props, passes = 8) {
  for (let pass = 0; pass < passes; pass += 1) {
    dirty = false; output = []; pendingEffects = []; hookIndex = 0;
    renderNode(React.createElement(Component, props), 'root');
    for (const effect of pendingEffects) { try { effect(); } catch (error) { errors.push(error); } }
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
};
globalThis.document = { baseURI: 'http://127.0.0.1:49605/', addEventListener() {}, removeEventListener() {} };
globalThis.window = { location: { href: 'http://127.0.0.1:49605/' }, open() {}, __ModuleLoader__: { load(registration) { globalThis.window.__captured = registration; } } };
globalThis.fetch = async (url) => {
  const name = String(url).includes('/summary-panel/') ? String(url).split('/summary-panel/')[1].split('?')[0] : '';
  return { ok: true, json: async () => samples[name] ?? {} };
};

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
const panel = slotRegistrations.find((entry) => entry.registration.name === 'shell.overlay').component;
const text = await renderTree(panel, {});
const expected = ['Git', 'main', '分支 (3)', '最近提交', '输出内容', '子智能体', '来源', '子智能体会话', 'Researcher', '返回父会话'];
const failures = [];
for (const needle of expected) if (!text.includes(needle)) failures.push(`missing text: ${needle}`);
if (text.includes('classify')) failures.push('collapsed feature branch leaked into the list');
if (text.includes('backup/')) failures.push('collapsed branch block leaked into the list');
if (text.includes('Example')) failures.push('collapsed sources section leaked into the list');

api.openSourceFile('dsh-resource://file/session/s1/a.txt');
api.openSourceUrl('https://example.com');
api.openDiff('s1', 'a.txt');
api.openSubagent('s1', { id: 's-child-1', label: 'Researcher', mode: 'continuable' });
api.openParent('s1');
console.log('sidebar calls:', JSON.stringify(rightCalls, null, 0));
if (rightCalls[0]?.call !== 'openResource' || rightCalls[0]?.address !== 'dsh-resource://file/session/s1/a.txt') failures.push('openSourceFile');
if (rightCalls[1]?.call !== 'openTab' || rightCalls[1]?.kind !== 'browser' || rightCalls[1]?.options?.params?.url !== 'https://example.com') failures.push('openSourceUrl');
if (rightCalls[2]?.kind !== 'summary-panel.diff') failures.push('openDiff');
if (rightCalls[3]?.call !== 'openSession' || rightCalls[3]?.target?.childSessionId !== 's-child-1') failures.push('openSubagent');
if (rightCalls[4]?.call !== 'openSession' || rightCalls[4]?.target !== 's1') failures.push('openParent');
if (errors.length > 0) failures.push(...errors.map((error) => String(error?.message ?? error)));
console.log("panel sample:", text.replace(/\s+/g, " "));
console.log(failures.length === 0 ? 'client OK' : 'FAILED: ' + failures.join(' | '));
process.exit(failures.length === 0 ? 0 : 1);
