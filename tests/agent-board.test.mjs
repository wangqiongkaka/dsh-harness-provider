import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// ---- the card's rows: pure picks out of the Session list and the unified Session status ----

const board = async () => {
  const bundle = await build({ entryPoints: ['src/agent-board.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
};
const summary = (title, updatedAt, extra = {}) => ({ displayTitle: title, cwd: '/Users/me/dsh-remote-control', running: false, blank: false, updatedAt, ...extra });
const status = (extra = {}) => ({ running: undefined, pendingInteraction: undefined, completionUnread: false, ...extra });

test('the agent card lists pending, running and unseen finished Sessions, each group newest first', async () => {
  const { agentRows } = await board();
  const byId = { idle: summary('空闲', 90), doneOld: summary('早完成', 10), doneNew: summary('刚完成', 30), run: summary('运行中', 20, { running: true }), ask: summary('等回答', 5) };
  const statuses = new Map([['doneOld', status({ completionUnread: true })], ['doneNew', status({ completionUnread: true })], ['ask', status({ pendingInteraction: { kind: 'question' } })]]);
  const rows = agentRows({ ids: Object.keys(byId), byId }, statuses);
  assert.deepEqual(rows.map(row => [row.id, row.state]), [['ask', 'pending'], ['run', 'running'], ['doneNew', 'done'], ['doneOld', 'done']]);
  assert.deepEqual(rows[0], { id: 'ask', title: '等回答', workspace: 'dsh-remote-control', updatedAt: 5, state: 'pending', pending: 'question' });
  assert.equal('pending' in rows[1], false);
});

// The Workspace browser's own precedence: a pending interaction outranks activity, which outranks the completion
// reminder; the live status outranks the list's running fact.
test('the agent card puts each Session in its highest-precedence group', async () => {
  const { agentRows } = await board();
  const byId = { a: summary('a', 1, { running: true }), b: summary('b', 2), c: summary('c', 3, { running: true }) };
  const statuses = new Map([['a', status({ running: true, pendingInteraction: { kind: 'approval' }, completionUnread: true })], ['b', status({ running: true, completionUnread: true })], ['c', status({ running: false })]]);
  assert.deepEqual(agentRows({ ids: ['a', 'b', 'c'], byId }, statuses).map(row => [row.id, row.state]), [['a', 'pending'], ['b', 'running']]);
});

test('the agent card skips subagents, blank Sessions, rows outside the Host list and unknown pending kinds', async () => {
  const { agentRows } = await board();
  const byId = { child: summary('子 agent', 1, { running: true, origin: 'subagent' }), blank: summary('新会话', 2, { running: true, blank: true }), other: summary('其它领域', 3), gone: summary('不在列表', 4, { running: true }) };
  assert.deepEqual(agentRows({ ids: ['child', 'blank', 'other'], byId }, new Map([['other', status({ pendingInteraction: { kind: 'custom' } })]])), []);
});

test('the agent card names the workspace by the last directory segment', async () => {
  const { agentRows } = await board();
  const byId = { posix: summary('p', 3, { running: true, cwd: '/a/b/proj/' }), windows: summary('w', 2, { running: true, cwd: 'C:\\work\\win-proj' }), none: { displayTitle: 'n', running: true, blank: false, updatedAt: 1 } };
  assert.deepEqual(agentRows({ ids: ['posix', 'windows', 'none'], byId }, new Map()).map(row => row.workspace), ['proj', 'win-proj', '']);
});

test('the agent card retains all completions newest first after their unread reminders clear', async () => {
  const { completionHistory } = await board();
  const byId = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`s${index + 1}`, summary(`s${index + 1}`, index + 1)]));
  const list = { ids: Object.keys(byId), byId };
  const unread = new Map(list.ids.map(id => [id, status({ running: false, completionUnread: id !== 's7' })]));
  const history = completionHistory(list, unread, undefined, []);
  assert.deepEqual(history.map(entry => entry.id), ['s6', 's5', 's4', 's3', 's2', 's1']);
  const read = new Map(list.ids.map(id => [id, status({ running: false })]));
  assert.deepEqual(completionHistory(list, read, unread, history), history);
  const running = new Map(read);
  running.set('s7', status({ running: true }));
  assert.deepEqual(completionHistory(list, new Map(read), running, history).map(entry => entry.id), ['s7', 's6', 's5', 's4', 's3', 's2', 's1']);
  const awaiting = new Map(read);
  awaiting.set('s7', status({ running: false, pendingInteraction: { kind: 'approval' } }));
  assert.deepEqual(completionHistory(list, awaiting, running, history), history);
  assert.ok(!completionHistory({ ...list, ids: list.ids.filter(id => id !== 's6') }, read, undefined, history).map(entry => entry.id).includes('s6'));
});

test('the agent card lists idle external Harness Sessions whose native process is still alive, newest first', async () => {
  const { residentRows } = await board();
  const byId = { idleOld: summary('旧驻留', 1), idleNew: summary('新驻留', 5), finished: summary('完成未读', 4), run: summary('运行中', 6, { running: true }), ask: summary('等回答', 7), reclaimed: summary('已回收', 8), native: summary('DSH 原生', 9), child: summary('子 agent', 10, { origin: 'subagent' }), unknown: summary('未查到', 11) };
  const statuses = new Map([['finished', status({ running: false, completionUnread: true })], ['ask', status({ pendingInteraction: { kind: 'question' } })]]);
  const marks = new Map(Object.keys(byId).filter(id => id !== 'unknown').map(id => [id, { harness: 'claude-code', running: true }]));
  marks.set('reclaimed', { harness: 'codex', running: false });
  marks.set('native', { harness: 'dsh', running: true });
  const rows = residentRows({ ids: Object.keys(byId), byId }, statuses, marks);
  assert.deepEqual(rows.map(row => [row.id, row.state]), [['idleNew', 'resident'], ['finished', 'resident'], ['idleOld', 'resident']]);
  assert.deepEqual(rows[0], { id: 'idleNew', title: '新驻留', workspace: 'dsh-remote-control', updatedAt: 5, state: 'resident' });
});

// ---- the card itself, mounted in a real browser with stand-ins for the host primitives ----

// The host's primitives resolve through its module loader; these keep the contracts the card relies on.
const PRIMITIVES = `
import { createElement } from 'react';
const icon = () => createElement('span');
export const IconArchiveOutlineRegular = icon, IconBranchOutlineRegular = icon, IconCopyOutlineRegular = icon, IconEditOutlineRegular = icon,
  IconEllipsisOutlineRegular = icon, IconPinFillRegular = icon, IconPinOutlineRegular = icon;
export const StateDot = ({ state }) => createElement('span', { 'data-state': state });
export const relativeTime = () => ({ unit: 'now', n: 0 });
export const writeClipboard = async text => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };
export const Menu = ({ open, anchor, items, onSelect }) => createElement('span', null, anchor, open && createElement('div', { role: 'menu' },
  items.map(item => createElement('button', { key: item.id, role: 'menuitem', onClick: () => { onSelect(item.id); } }, item.label))));
export const Modal = ({ children, title, description, footer }) => createElement('div', { role: 'dialog', 'aria-label': title },
  createElement('h2', null, title), description && createElement('p', null, description), children, footer);
export const Button = ({ variant, ...props }) => createElement('button', props);
export const Toast = ({ text }) => createElement('div', { role: 'alert' }, text);
`;

// The page side of the old vitest suite: fixtures, render(), and a small expect() so each case body runs as written.
const HARNESS = `
const { AgentBoard, AGENTS_ATTRIBUTE, createElement, createRoot, act } = window.Board;
window.IS_REACT_ACT_ENVIRONMENT = true;
const list = {
  phase: 'ready',
  ids: ['ask', 'run', 'done', 'idle'],
  byId: {
    ask: { displayTitle: '等回答', cwd: '/w/dsh-remote-control', running: false, blank: false, updatedAt: 3 },
    run: { displayTitle: '运行中', cwd: '/w/dsh-remote-control-01', running: true, blank: false, updatedAt: 2 },
    done: { displayTitle: '完成了', cwd: '/w/dsh-remote-control', running: false, blank: false, updatedAt: 1 },
    idle: { displayTitle: '空闲', cwd: '/w/x', running: false, blank: false, updatedAt: 9 },
  },
};
const statuses = new Map([
  ['ask', { running: undefined, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
  ['done', { running: false, pendingInteraction: undefined, completionUnread: true }],
]);
const workspaces = { phase: 'ready', archivedSessionIds: [], pinnedSessionIds: [] };
const opened = [], asked = [], calls = [], fail = {};
const mount = document.createElement('div');
document.body.append(mount);
let root = createRoot(mount);
/** The shell's sidebar column, with New Session between the logo row and the panel list. */
function column() {
  const col = document.createElement('div');
  col.className = 'ui_layout__sidebarCol__h1';
  col.innerHTML = '<div class="ui_sidebar__root__h1"><div class="ui_sidebar__logoRow__h1"></div>'
    + '<button class="ui_sidebar__newSession__h1">新会话</button><nav class="ui_sidebar__panelList__h1"></nav></div>';
  document.body.append(col);
  return col;
}
function render(sessions = list, marks = {}, snapshot = statuses, workspaceSnapshot = workspaces) {
  act(() => {
    root.render(createElement(AgentBoard, {
      t: (key, params) => params?.n === undefined ? key : key + ':' + params.n,
      useSessions: select => select(sessions),
      useSessionStatus: select => select(snapshot),
      useWorkspaces: select => select(workspaceSnapshot),
      openSession: id => { opened.push(id); },
      ...Object.fromEntries(['pinSession', 'unpinSession', 'renameSession', 'forkSession', 'archiveSession'].map(name =>
        [name, async (...args) => {
          calls.push([name, ...args]);
          const reason = fail[name];
          if (reason !== undefined) { delete fail[name]; throw reason; }
        }])),
      harnesses: async ids => {
        asked.push(ids);
        return Object.fromEntries(ids.flatMap(id => marks[id] ? [[id, { running: false, ...marks[id] }]] : []));
      },
    }));
  });
}
const host = () => document.querySelector('[' + AGENTS_ATTRIBUTE + ']');
function click(element) {
  if (!(element instanceof HTMLElement)) throw new Error('missing element');
  act(() => { element.click(); });
}
const settle = () => act(async () => { await Promise.resolve(); });
function openMenu(title) {
  const item = [...host().querySelectorAll('.hp-agents-item')].find(element => element.querySelector('.hp-agents-title')?.textContent === title);
  click(item?.querySelector('.hp-agents-more'));
}
const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim() ?? '');
const pickMenu = label => click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === label));
const dialogButton = label => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === label);
const show = value => { try { return JSON.stringify(value); } catch { return String(value); } };
function expect(actual) {
  const check = negate => {
    const verify = (ok, words) => { if (ok === negate) throw new Error('expected ' + show(actual) + (negate ? ' not ' : ' ') + words); };
    return {
      toBe: value => verify(Object.is(actual, value), 'to be ' + show(value)),
      toEqual: value => verify(show(actual) === show(value), 'to equal ' + show(value)),
      toBeNull: () => verify(actual === null, 'to be null'),
      toHaveLength: length => verify(actual?.length === length, 'to have length ' + length),
      toContain: value => verify(actual.includes(value), 'to contain ' + show(value)),
      toMatch: pattern => verify(pattern.test(actual), 'to match ' + pattern),
      toBeGreaterThan: value => verify(actual > value, 'to be greater than ' + value),
    };
  };
  return Object.assign(check(false), { not: check(true) });
}
Object.assign(window, { list, statuses, workspaces, opened, asked, calls, fail, mount, column, render, host, click, settle, openMenu, menuLabels, pickMenu, dialogButton, expect, act, createRoot,
  remount() { act(() => { root.unmount(); }); root = createRoot(mount); },
  unmount() { act(() => { root.unmount(); }); } });
`;

let browser, script;
before(async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const nodePaths = [dirname(dirname(require.resolve('react/package.json'))), dirname(dirname(require.resolve('react-dom/package.json')))];
  const stub = { name: 'primitives', setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'stub' }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: PRIMITIVES, loader: 'js', resolveDir: resolve('src') }));
  } };
  const bundle = await build({
    stdin: { contents: `export { AgentBoard, AGENTS_ATTRIBUTE } from './agent-board-view.tsx';\nexport { createRoot } from 'react-dom/client';\nexport { createElement } from 'react';\nexport { act } from 'react-dom/test-utils';`, resolveDir: resolve('src'), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'Board', jsx: 'automatic', nodePaths, plugins: [stub], logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(() => browser?.close());

/** Runs `body` in a fresh page (its own storage) holding the card and the old suite's helpers. */
async function inPage(body, { seed, arg } = {}) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // A real origin, so the card's history can use localStorage.
    await page.route('http://board.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('http://board.test/');
    if (seed) await page.evaluate(seed);
    await page.addScriptTag({ content: script });
    await page.addScriptTag({ content: HARNESS });
    await page.evaluate(body, arg);
  } finally { await context.close(); }
}

test('the agent card keeps read completions in inline history after remounting', () => inPage(() => {
  column();
  render();
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect(host()?.querySelector('.hp-agents-history')).toBeNull();
  const read = new Map(statuses);
  read.set('done', { running: false, pendingInteraction: undefined, completionUnread: false });
  render(list, {}, read);
  expect(host()?.querySelector('.hp-agents-tile[data-state="done"]')?.textContent).toBe('agents.done0');
  expect(host()?.querySelector('.hp-agents-history h3')?.textContent).toBe('agents.history');
  expect(host()?.querySelector('.hp-agents-history .hp-agents-title')?.textContent).toBe('完成了');
  remount();
  render(list, {}, read);
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect(host()?.querySelector('.hp-agents-history .hp-agents-title')?.textContent).toBe('完成了');
  click(host()?.querySelector('.hp-agents-history [data-hp-agents-pick]'));
  expect(opened).toEqual(['done']);
}));

test('the agent card does not re-remind a completion watched from inside the Session, but keeps it in history', () => inPage(async () => {
  const frame = document.createElement('div');
  frame.className = 'ui_layout__frame__h1';
  frame.setAttribute('data-sidebar-collapsed', '');
  document.body.append(frame);
  frame.append(column());
  const sessions = { ...list, ids: ['run'] };
  render(sessions, {}, new Map([['run', { running: true, pendingInteraction: undefined, completionUnread: false }]]));
  const finished = { ...sessions, byId: { ...sessions.byId, run: { ...sessions.byId.run, running: false, updatedAt: 10 } } };
  // The host acknowledges the completion immediately: the user is watching the Session.
  render(finished, {}, new Map([['run', { running: false, pendingInteraction: undefined, completionUnread: false }]]));
  frame.removeAttribute('data-sidebar-collapsed');
  await settle();
  expect(host()?.querySelector('.hp-agents-tile[data-state="done"]')?.textContent).toBe('agents.done0');
  expect(host()?.querySelectorAll('[data-hp-agents-pick]')).toHaveLength(0);
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect(host()?.querySelector('.hp-agents-empty')).toBeNull();
  expect(host()?.querySelector('.hp-agents-history .hp-agents-title')?.textContent).toBe('运行中');
  click(host()?.querySelector('.hp-agents-history [data-hp-agents-pick]'));
  expect(opened).toEqual(['run']);
}));

test('the agent card still reminds of a completion that happened while the user was elsewhere', () => inPage(async () => {
  column();
  const sessions = { ...list, ids: ['run'], byId: { ...list.byId, run: { ...list.byId.run, running: false, updatedAt: 10 } } };
  render(sessions, {}, new Map([['run', { running: true, pendingInteraction: undefined, completionUnread: false }]]));
  // The user never opened this Session, so the host keeps its completion unread.
  render(sessions, {}, new Map([['run', { running: false, pendingInteraction: undefined, completionUnread: true }]]));
  await settle();
  expect(host()?.querySelector('.hp-agents-tile[data-state="done"]')?.textContent).toBe('agents.done1');
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect(host()?.querySelector('.hp-agents-title')?.textContent).toBe('运行中');
  click(host()?.querySelector('[data-hp-agents-pick]'));
  expect(opened).toEqual(['run']);
  // Opening the Session is what clears the host's unread completion.
  render(sessions, {}, new Map([['run', { running: false, pendingInteraction: undefined, completionUnread: false }]]));
  expect(host()?.querySelector('.hp-agents-tile[data-state="done"]')?.textContent).toBe('agents.done0');
  expect(host()?.querySelector('.hp-agents-history .hp-agents-title')?.textContent).toBe('运行中');
}));

// The card moved from dsh-remote-control; it reads the history that plugin saved under the same key.
test('the agent card restores history saved before the move, with the Harness icon', () => inPage(async () => {
  column();
  const read = new Map(statuses);
  read.set('done', { running: false, pendingInteraction: undefined, completionUnread: false });
  render(list, { done: { harness: 'codex' } }, read);
  await settle();
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect(host()?.querySelector('.hp-agents-history [data-hp-agents-pick]').dataset.hpHarness).toBe('codex');
}, { seed: () => localStorage.setItem('dsh-remote-control.agent-history.v1', JSON.stringify([{ id: 'done', completedAt: 1 }])) }));

test('the agent card removes archived Sessions from card counts, rows and saved history', () => inPage(() => {
  column();
  render();
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  render(list, {}, statuses, { ...workspaces, archivedSessionIds: ['ask', 'run', 'done'] });
  expect([...host().querySelectorAll('.hp-agents-card .hp-agents-tile')].map(tile => tile.textContent))
    .toEqual(['agents.pending0', 'agents.running0', 'agents.done0', 'agents.resident0']);
  expect(host()?.querySelectorAll('[data-hp-agents-pick]')).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem('dsh-remote-control.agent-history.v1') ?? '[]')).toEqual([]);
}));

test('the agent card clears archived read history and keeps other completions after remounting', () => inPage(() => {
  const kept = { id: 'idle', completedAt: 9 };
  column();
  const read = new Map(statuses);
  read.set('done', { running: false, pendingInteraction: undefined, completionUnread: false });
  render(list, {}, read);
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect(host()?.querySelectorAll('.hp-agents-history .hp-agents-title')).toHaveLength(2);
  const archived = { ...workspaces, archivedSessionIds: ['done'] };
  render(list, {}, read, archived);
  expect([...host().querySelectorAll('.hp-agents-history .hp-agents-title')].map(row => row.textContent)).toEqual(['空闲']);
  expect(JSON.parse(localStorage.getItem('dsh-remote-control.agent-history.v1') ?? '[]')).toEqual([kept]);
  remount();
  render(list, {}, read, archived);
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect([...host().querySelectorAll('.hp-agents-history .hp-agents-title')].map(row => row.textContent)).toEqual(['空闲']);
}, { seed: () => localStorage.setItem('dsh-remote-control.agent-history.v1', JSON.stringify([{ id: 'done', completedAt: 1 }, { id: 'idle', completedAt: 9 }])) }));

test('the agent card preserves saved history until the Workspace archive list is ready', () => inPage(() => {
  const entry = { id: 'done', completedAt: 1 };
  column();
  const read = new Map(statuses);
  read.set('done', { running: false, pendingInteraction: undefined, completionUnread: false });
  render({ ...list, ids: [] }, {}, read, { ...workspaces, phase: 'pending' });
  expect(JSON.parse(localStorage.getItem('dsh-remote-control.agent-history.v1') ?? '[]')).toEqual([entry]);
  render(list, {}, read, { ...workspaces, archivedSessionIds: ['done'] });
  expect(JSON.parse(localStorage.getItem('dsh-remote-control.agent-history.v1') ?? '[]')).toEqual([]);
}, { seed: () => localStorage.setItem('dsh-remote-control.agent-history.v1', JSON.stringify([{ id: 'done', completedAt: 1 }])) }));

test('the agent card does not erase saved history while the Session list is loading', () => inPage(() => {
  const entry = { id: 'done', completedAt: 1 };
  column();
  render({ ...list, phase: 'pending', ids: [] });
  expect(JSON.parse(localStorage.getItem('dsh-remote-control.agent-history.v1') ?? '[]')).toEqual([entry]);
  const read = new Map(statuses);
  read.set('done', { running: false, pendingInteraction: undefined, completionUnread: false });
  render(list, {}, read);
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect(host()?.querySelector('.hp-agents-history .hp-agents-title')?.textContent).toBe('完成了');
}, { seed: () => localStorage.setItem('dsh-remote-control.agent-history.v1', JSON.stringify([{ id: 'done', completedAt: 1 }])) }));

test('the agent card defaults to running details below four tiles, right after New Session', () => inPage(() => {
  column();
  render();
  const card = host();
  expect(card?.previousElementSibling?.textContent).toBe('新会话');
  expect(card?.nextElementSibling?.tagName).toBe('NAV');
  expect([...card.querySelectorAll('.hp-agents-tile')].map(tile => tile.textContent))
    .toEqual(['agents.pending1', 'agents.running1', 'agents.done1', 'agents.resident0']);
  expect(card?.querySelector('[role="dialog"]')).toBeNull();
  expect(card?.querySelector('[aria-pressed="true"]')?.getAttribute('data-state')).toBe('running');
  const details = card.querySelector('.hp-agents-list');
  expect(details.previousElementSibling?.className).toBe('hp-agents-tiles');
  expect([...details.querySelectorAll('.hp-agents-title')].map(row => row.textContent)).toEqual(['运行中']);
}));

test('the agent card switches details inline and opens the chosen Session without navigating on a tile tap', () => inPage(() => {
  column();
  render();
  click(host()?.querySelector('.hp-agents-tile[data-state="pending"]'));
  expect(host()?.querySelector('[role="dialog"]')).toBeNull();
  expect(host()?.querySelectorAll('.hp-agents-tile')).toHaveLength(4);
  expect(host()?.querySelector('[aria-pressed="true"]')?.getAttribute('data-state')).toBe('pending');
  expect([...host().querySelectorAll('.hp-agents-title')].map(row => row.textContent)).toEqual(['等回答']);
  expect(host()?.querySelector('.hp-agents-meta')?.textContent).toBe('agents.pending.approval · dsh-remote-control');
  expect(opened).toEqual([]);
  expect(host()?.querySelector('.hp-agents-tile')?.hasAttribute('data-hp-agents-pick')).toBe(false);
  click(host()?.querySelector('[data-hp-agents-pick]'));
  expect(opened).toEqual(['ask']);
  click(host()?.querySelector('.hp-agents-tile[data-state="running"]'));
  expect([...host().querySelectorAll('.hp-agents-title')].map(row => row.textContent)).toEqual(['运行中']);
}));

test('the agent card shows all selected rows rather than limiting details to three previews', () => inPage(() => {
  column();
  render({ ...list, ids: [...list.ids, 'run2', 'run3', 'run4'], byId: { ...list.byId,
    run2: { ...list.byId.run, displayTitle: '运行 2', updatedAt: 4 },
    run3: { ...list.byId.run, displayTitle: '运行 3', updatedAt: 5 },
    run4: { ...list.byId.run, displayTitle: '运行 4', updatedAt: 6 } } });
  expect([...host().querySelectorAll('.hp-agents-title')].map(row => row.textContent)).toEqual(['运行 4', '运行 3', '运行 2', '运行中']);
}));

for (const state of ['pending', 'running', 'done']) {
  test(`the agent card keeps more than five ${state} rows in a five-row scrollport`, () => inPage(async state => {
    column();
    const ids = Array.from({ length: 7 }, (_, index) => `session${index}`);
    const sessions = { ...list, ids, byId: { ...list.byId, ...Object.fromEntries(ids.map((id, index) => [id, { ...list.byId.idle, displayTitle: id, updatedAt: index }])) } };
    render(sessions, {}, new Map(ids.map(id => [id, { running: state === 'running', pendingInteraction: state === 'pending' ? { kind: 'question' } : undefined, completionUnread: state === 'done' }])));
    await settle();
    click(host()?.querySelector(`.hp-agents-tile[data-state="${state}"]`));
    const scroller = host().querySelector('.hp-agents-group > div');
    expect(scroller.querySelectorAll('.hp-agents-row')).toHaveLength(7);
    expect(getComputedStyle(scroller).maxHeight).toBe('248px');
    expect(getComputedStyle(scroller).overflowY).toBe('auto');
    expect(getComputedStyle(scroller.firstElementChild).height).toBe('48px');
    click(scroller.lastElementChild?.querySelector('[data-hp-agents-pick]'));
    expect(opened).toEqual(['session0']);
  }, { arg: state }));
}

test('the agent card restores and opens saved history beyond the first five rows', () => inPage(async () => {
  const ids = Array.from({ length: 7 }, (_, index) => `session${index}`);
  const entries = ids.map((id, index) => ({ id, completedAt: 7 - index }));
  column();
  render({ ...list, ids, byId: { ...list.byId, ...Object.fromEntries(ids.map(id => [id, { ...list.byId.idle, displayTitle: id }])) } }, {}, new Map());
  await settle();
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  const scroller = host().querySelector('.hp-agents-history > div');
  expect(scroller.querySelectorAll('.hp-agents-row')).toHaveLength(7);
  expect(JSON.parse(localStorage.getItem('dsh-remote-control.agent-history.v1') ?? '[]')).toEqual(entries);
  click(scroller.lastElementChild?.querySelector('[data-hp-agents-pick]'));
  expect(opened).toEqual(['session6']);
}, { seed: () => localStorage.setItem('dsh-remote-control.agent-history.v1', JSON.stringify(Array.from({ length: 7 }, (_, index) => ({ id: `session${index}`, completedAt: 7 - index })))) }));

test('the agent card shows unread completions and read history only under the completed tile', () => inPage(() => {
  column();
  render();
  expect(host()?.querySelector('.hp-agents-history')).toBeNull();
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect([...host().querySelectorAll('.hp-agents-title')].map(row => row.textContent)).toEqual(['完成了', '空闲']);
  expect(host()?.querySelector('.hp-agents-history .hp-agents-title')?.textContent).toBe('空闲');
  click(host()?.querySelector('.hp-agents-tile[data-state="pending"]'));
  expect(host()?.querySelector('.hp-agents-history')).toBeNull();
  expect([...host().querySelectorAll('.hp-agents-title')].map(row => row.textContent)).toEqual(['等回答']);
}, { seed: () => localStorage.setItem('dsh-remote-control.agent-history.v1', JSON.stringify([{ id: 'idle', completedAt: 9 }])) }));

test('the agent card shows an empty message for the selected group without falling back to other groups', () => inPage(() => {
  column();
  render({ ...list, ids: ['idle'] });
  for (const state of ['running', 'pending', 'done', 'resident']) {
    click(host()?.querySelector(`.hp-agents-tile[data-state="${state}"]`));
    expect(host()?.querySelector('.hp-agents-empty')?.textContent).toBe(`agents.empty.${state}`);
    expect(host()?.querySelectorAll('[data-hp-agents-pick]')).toHaveLength(0);
    expect(host()?.querySelector('[role="dialog"]')).toBeNull();
  }
}));

test('the agent card follows the column when the shell rebuilds it, and leaves with the component', () => inPage(async () => {
  render();
  expect(host()).toBeNull();
  column();
  await settle();
  expect(host()?.previousElementSibling?.textContent).toBe('新会话');
  document.querySelector('.ui_layout__sidebarCol__h1')?.remove();
  column();
  await settle();
  expect(host()?.isConnected).toBe(true);
  expect(host()?.querySelector('.hp-agents-card')).not.toBeNull();
  unmount();
  expect(host()).toBeNull();
}));

test('the agent card turns the running spinner only while a Session runs', () => inPage(() => {
  column();
  const running = () => host()?.querySelector('.hp-agents-tile[data-state="running"] [data-state]')?.getAttribute('data-state');
  render();
  expect(running()).toBe('ongoing');
  render({ ...list, ids: ['ask', 'done', 'idle'] });
  expect(host()?.querySelector('.hp-agents-tile[data-state="running"]')?.textContent).toBe('agents.running0');
  expect(running()).toBe('idle');
  expect(host()?.querySelectorAll('[data-hp-agents-pick]')).toHaveLength(0);
  expect(host()?.querySelector('.hp-agents-empty')?.textContent).toBe('agents.empty.running');
}));

test('the agent card leads a row with its harness logo, breathing while it runs', () => inPage(async () => {
  column();
  render(list, { run: { harness: 'claude-code' }, done: { harness: 'codex' } });
  await settle();
  const row = title => [...host().querySelectorAll('[data-hp-agents-pick]')].find(item => item.querySelector('.hp-agents-title')?.textContent === title);
  expect(row('运行中').dataset.hpHarness).toBe('claude-code');
  expect(row('运行中').hasAttribute('data-hp-running')).toBe(true);
  expect(row('运行中').firstElementChild?.children).toHaveLength(0);
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect(row('完成了').dataset.hpHarness).toBe('codex');
  expect(row('完成了').hasAttribute('data-hp-running')).toBe(false);
  // No harness known: the status dot stays.
  click(host()?.querySelector('.hp-agents-tile[data-state="pending"]'));
  expect(row('等回答').hasAttribute('data-hp-harness')).toBe(false);
  expect(row('等回答').firstElementChild?.querySelector('[data-state="warning"]')).not.toBeNull();
}));

test('the agent card marks delegated Sessions so their logo gets the delegation badge', () => inPage(async () => {
  column();
  render(list, { run: { harness: 'codex', delegated: true }, done: { harness: 'claude-code', delegated: false } });
  await settle();
  const row = title => [...host().querySelectorAll('[data-hp-agents-pick]')].find(item => item.querySelector('.hp-agents-title')?.textContent === title);
  expect(row('运行中').hasAttribute('data-hp-delegated')).toBe(true);
  // The badge is drawn into the empty leading cell.
  expect(row('运行中').firstElementChild?.innerHTML).toBe('');
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  expect(row('完成了').hasAttribute('data-hp-delegated')).toBe(false);
}));

test('the agent card folds its four tiles into two rows on a narrow card, such as the desktop sidebar', () => inPage(() => {
  const col = column();
  render();
  const tops = () => [...host().querySelectorAll('.hp-agents-tile')].map(tile => Math.round(tile.getBoundingClientRect().top));
  // The default 280px desktop sidebar: two rows of two.
  col.style.width = '256px';
  expect(new Set(tops()).size).toBe(2);
  // A wide sidebar, or a 360px-and-up phone: one row of four, every label whole.
  col.style.width = '360px';
  expect(new Set(tops()).size).toBe(1);
}));

test('the agent card lists idle Codex and Claude Code Sessions whose process is still alive under the unreleased tile', () => inPage(async () => {
  // A hand-driven clock for the 30-second mark refresh.
  const ticks = [];
  window.setInterval = (run, delay) => { ticks.push({ run, delay }); return ticks.length; };
  window.clearInterval = () => {};
  column();
  const marks = { ask: { harness: 'codex', running: true }, run: { harness: 'claude-code', running: true }, done: { harness: 'claude-code', running: true }, idle: { harness: 'codex', running: true } };
  render(list, marks);
  await settle();
  // Every listed Session is asked, not only the rows already on the board.
  expect(asked[0]).toEqual(['ask', 'run', 'done', 'idle']);
  const tile = host()?.querySelector('.hp-agents-tile[data-state="resident"]');
  expect(tile?.textContent).toBe('agents.resident2');
  click(tile);
  const rows = [...host().querySelectorAll('[data-hp-agents-pick]')];
  expect(rows.map(row => row.querySelector('.hp-agents-title')?.textContent)).toEqual(['空闲', '完成了']);
  expect(rows[0]?.dataset.hpHarness).toBe('codex');
  expect(rows[0]?.hasAttribute('data-hp-running')).toBe(false);
  expect(rows[0]?.querySelector('.hp-agents-meta')?.textContent).toBe('agents.resident · x');
  click(rows[0]);
  expect(opened).toEqual(['idle']);
  // A reclaimed process leaves the tile on the next refresh.
  marks.idle = { harness: 'codex', running: false };
  await act(async () => { for (const tick of ticks.filter(tick => tick.delay === 30_000)) tick.run(); await Promise.resolve(); });
  expect(asked.length).toBeGreaterThan(1);
  expect(host()?.querySelector('.hp-agents-tile[data-state="resident"]')?.textContent).toBe('agents.resident1');
  expect([...host().querySelectorAll('.hp-agents-title')].map(row => row.textContent)).toEqual(['完成了']);
}));

test('the agent card asks harness marks in batches the Remote call accepts', () => inPage(async () => {
  column();
  const ids = Array.from({ length: 1001 }, (_, index) => `s${index}`);
  render({ ...list, ids, byId: { ...list.byId, ...Object.fromEntries(ids.map(id => [id, { ...list.byId.idle, displayTitle: id }])) } }, {}, new Map());
  await settle();
  expect(asked.map(batch => batch.length)).toEqual([1000, 1]);
}));

test('the agent card opens a row menu from its trailing button without opening the Session, then pins or unpins it', () => inPage(() => {
  column();
  render();
  openMenu('运行中');
  expect(opened).toEqual([]);
  expect(host()?.querySelector('.hp-agents-more')?.hasAttribute('data-hp-agents-pick')).toBe(false);
  expect(menuLabels()).toEqual(['agents.menu.pin', 'agents.menu.rename', 'agents.menu.fork', 'agents.menu.archive', 'agents.menu.copyId']);
  pickMenu('agents.menu.pin');
  expect(calls).toEqual([['pinSession', 'run']]);
  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  render(list, {}, statuses, { ...workspaces, pinnedSessionIds: ['run'] });
  openMenu('运行中');
  expect(menuLabels()[0]).toBe('agents.menu.unpin');
  pickMenu('agents.menu.unpin');
  expect(calls.at(-1)).toEqual(['unpinSession', 'run']);
}));

test('the agent card renames a Session from a dialog seeded with its title, keeping the dialog on failure', () => inPage(async () => {
  column();
  render();
  openMenu('运行中');
  pickMenu('agents.menu.rename');
  const input = document.querySelector('[role="dialog"] input');
  expect(input.value).toBe('运行中');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '  新标题 ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  fail.renameSession = new Error('host down');
  click(dialogButton('agents.rename.confirm'));
  await settle();
  expect(calls).toEqual([['renameSession', 'run', '新标题']]);
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('host down');
  click(dialogButton('agents.rename.confirm'));
  await settle();
  expect(calls).toHaveLength(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
}));

test('the agent card archives a quiet Session directly and asks before stopping a running one', () => inPage(async () => {
  column();
  render();
  click(host()?.querySelector('.hp-agents-tile[data-state="done"]'));
  openMenu('完成了');
  pickMenu('agents.menu.archive');
  await settle();
  expect(calls).toEqual([['archiveSession', 'done']]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).toContain('agents.toast.archived');
  click(host()?.querySelector('.hp-agents-tile[data-state="running"]'));
  fail.archiveSession = Object.assign(new Error('active'), { name: 'WorkspaceArchiveError', rpcError: { code: 'workspace/session-active', details: { activity: [{ kind: 'turn' }] } } });
  openMenu('运行中');
  pickMenu('agents.menu.archive');
  await settle();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('agents.archive.title');
  click(dialogButton('agents.archive.confirm'));
  await settle();
  expect(calls.at(-1)).toEqual(['archiveSession', 'run', { stopActivity: true }]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
}));

test('the agent card forks a Session and reports a failed fork', () => inPage(async () => {
  column();
  render();
  openMenu('运行中');
  pickMenu('agents.menu.fork');
  await settle();
  expect(calls).toEqual([['forkSession', 'run']]);
  expect(document.body.textContent).toContain('agents.toast.forked');
  fail.forkSession = new Error('migration required');
  openMenu('运行中');
  pickMenu('agents.menu.fork');
  await settle();
  expect(document.body.textContent).toContain('agents.toast.failed');
}));

test('the agent card copies the Session ID', () => inPage(async () => {
  const written = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { written.push(text); } } });
  column();
  render();
  openMenu('运行中');
  pickMenu('agents.menu.copyId');
  await settle();
  expect(written).toEqual(['run']);
  expect(document.body.textContent).toContain('agents.toast.copied');
}));
