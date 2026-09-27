import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// Render the real panel without adding test-only exports to the plugin.
const panel = async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const bundle = await build({ stdin: { contents: await readFile('src/client.tsx', 'utf8') + '\nexport { styles, zh, en, subscribeSubagents, subagentFeeds };', resolveDir: resolve('src'), loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] });
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, setInterval, clearInterval });
  const { SubagentRow, SubagentsTab, SubagentsTitle, styles, zh, en, subscribeSubagents, subagentFeeds } = module.exports;
  const t = (key, params) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => name in (params ?? {}) ? String(params[name]) : match);
  const row = (agent, now, expanded = false) => renderToStaticMarkup(React.createElement(SubagentRow, { agent, now, expanded, onToggle() {}, t }));
  const tabInfo = visible => ({ useTabInfo: () => ({ tab: { visible } }) });
  return { React, renderToStaticMarkup, SubagentRow, SubagentsTab, SubagentsTitle, styles, zh, en, t, row, tabInfo, subscribeSubagents, subagentFeeds };
};

const agent = (fields) => ({
  id: 'agent-1', parentId: null, name: '调查宿主会话工作目录能力', task: '只读调查，不要修改任何文件。回答用中文。',
  status: 'running', startedAt: new Date(Date.now() - 65_000).toISOString(), updatedAt: new Date(Date.now() - 3_000).toISOString(), finishedAt: null,
  entries: [{ kind: 'message', text: '背景：先看宿主源码' }, { kind: 'tool', title: 'Read addWorktree and UI dialog', status: 'running', output: null }], ...fields,
});

test('the subagent panel shows a running subagent as running: ticking clock, current step and how long it has been silent', async () => {
  const { row } = await panel();
  const now = Date.now();
  const running = row(agent({ startedAt: new Date(now - 65_000).toISOString(), updatedAt: new Date(now - 3_000).toISOString() }), now);
  assert.match(running, /class="hp-sub-chip hp-sub-chip-running"/, 'the chip takes the running state');
  assert.match(running, /运行中/);
  assert.match(running, /1 分 5 秒/, 'elapsed time, not just a word');
  assert.match(running, /title="已运行 1 分 5 秒"/);
  assert.match(running, /Read addWorktree and UI dialog/, 'the current step shows without expanding the row');
  assert.match(running, /3 秒前/, 'and how long that step has been silent');
  assert.doesNotMatch(running, /<details/, 'the entry list stays collapsed');

  // A subagent that has not said anything yet still reads as running.
  const silent = row(agent({ startedAt: new Date(now - 4_000).toISOString(), updatedAt: new Date(now - 4_000).toISOString(), entries: [] }), now);
  assert.match(silent, /运行中/);
  assert.match(silent, /等待首个动作/);
  assert.match(silent, /4 秒前/);

  // A finished subagent freezes its duration and drops the live line.
  const completed = row(agent({ status: 'completed', startedAt: new Date(now - 200_000).toISOString(), updatedAt: new Date(now - 70_000).toISOString(), finishedAt: new Date(now - 70_000).toISOString() }), now);
  assert.match(completed, /class="hp-sub-chip hp-sub-chip-completed"/);
  assert.match(completed, /已完成/);
  assert.match(completed, /2 分 10 秒/, 'the finished duration, frozen at its end');
  assert.match(completed, /title="耗时 2 分 10 秒"/);
  assert.doesNotMatch(completed, /hp-sub-live/, 'nothing claims a finished subagent is still working');
  assert.doesNotMatch(completed, /秒前/);

  // A resumed session replays finished subagents without their original clock: no "耗时 0 秒" is invented for them.
  const replayed = row(agent({ status: 'completed', startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString() }), now);
  assert.match(replayed, /已完成/);
  assert.doesNotMatch(replayed, /0 秒/);
  assert.doesNotMatch(replayed, /hp-sub-elapsed/);
});

test('running and finished subagents are told apart by color and motion, not only by their words', async () => {
  const { row, styles } = await panel();
  const now = Date.now();
  const running = row(agent({ task: '只读调查，不要修改任何文件。回答用中文。背景：/Users/wangqiongkaka/AIProjetcs/dsh-plugin/dsh-git-sidebar 是 DSH 插件，源码在 deepseek-harness。', startedAt: new Date(now - 5_000).toISOString(), updatedAt: new Date(now).toISOString() }), now);
  const completed = row(agent({ status: 'failed', startedAt: new Date(now - 5_000).toISOString(), updatedAt: new Date(now - 1_000).toISOString(), finishedAt: new Date(now - 1_000).toISOString() }), now);
  assert.match(styles, /\.hp-sub-chip-running\{color:var\(--dsw-static-blue-450\)/);
  assert.match(styles, /\.hp-sub-chip-completed\{color:var\(--dsw-alias-state-success-primary\)/);
  assert.match(styles, /\.hp-sub-chip-failed\{color:var\(--dsw-alias-state-error-primary\)/);
  assert.match(styles, /@media \(prefers-reduced-motion:reduce\)\{\.hp-sub-running,\.hp-sub-live-dot\{animation:none\}\}/, 'the running pulse honors reduced motion');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>:root{--dsw-static-blue-450:#4d93f8;--dsw-alias-state-success-primary:#16a34a;--dsw-alias-state-error-primary:#dc2626;--dsw-static-green-500-a12:rgb(34 197 94 / 12%);--dsw-static-red-400-a12:rgb(242 90 90 / 12%);--dsw-alias-interactive-bg-active:#eeeeee;--dsw-alias-label-dimmed:#cccccc;--dsw-alias-label-secondary:#555555;--dsw-alias-label-tertiary:#999999}${styles}</style><div style="width:420px">${running}${completed}</div>`);
    assert.deepEqual(await page.locator('.hp-sub-chip').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color)), ['rgb(77, 147, 248)', 'rgb(220, 38, 38)']);
    assert.deepEqual(await page.locator('.hp-sub-running,.hp-sub-live-dot').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName)), ['hp-pulse', 'hp-pulse']);
    assert.notEqual(await page.locator('.hp-sub-chip-running').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', 'the running chip is tinted, not bare text');
    // The collapsed task clamps on its line box: two lines tall, with the spacing outside the clip so no half line shows through.
    const clamped = await page.locator('.hp-sub-task').first().evaluate(node => ({ height: node.getBoundingClientRect().height, paddingBottom: getComputedStyle(node).paddingBottom, lineHeight: getComputedStyle(node).lineHeight }));
    assert.deepEqual(clamped, { height: 36, paddingBottom: '0px', lineHeight: '18px' });
  } finally { await browser.close(); }
});

test('the subagents chip reads the same session as the panel, so both report a running subagent', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const bundle = await build({ stdin: { contents: await readFile('src/client.tsx', 'utf8'), resolveDir: resolve('src'), loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] });
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { append() {} } } });
  const asked = [], registrations = [], injected = [];
  const scope = {
    effect: fn => fn(),
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (name, apply) => { injected.push(name); apply(); return () => {}; }, register: (definition, component) => { registrations.push({ definition, component }); return () => {}; } },
    remote: { harness: { subagents: async ({ sessionId }) => { asked.push(sessionId); return { ok: true, value: [] }; } } },
  };
  const ctx = {
    remote: { $mount: async () => () => {} }, locale: { register: () => () => {}, bind: () => key => key }, effect: fn => fn(),
    inject: (keys, apply) => { if (keys.includes('sidebarRightTabs')) apply(scope); },
  };
  await module.exports.apply(ctx);
  assert.deepEqual(injected, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'sidebar.right.tab.guide.entry']);
  assert.deepEqual(registrations.map(({ definition }) => [definition.name, definition.key]), [
    ['sidebar.right.pane.tab', 'dsh-harness-provider/subagents'],
    ['sidebar.right.pane.tab.title', 'dsh-harness-provider/subagents'],
    ['sidebar.right.tab.guide.entry', 'dsh-harness-provider/subagents'],
  ]);
  const [body, chip] = registrations;
  assert.deepEqual(await body.definition.inject('session-1').load(), []);
  assert.deepEqual(await chip.definition.inject('session-1').load(), []);
  assert.deepEqual(asked, ['session-1', 'session-1'], 'the chip and the panel ask the same session for its subagents');
});

test('the panel and its chip share one poll per session, and it stops when the last reader leaves', async () => {
  const { subscribeSubagents, subagentFeeds } = await panel();
  let loads = 0;
  const published = [0, 0];
  const load = async () => { loads += 1; return []; };
  const releases = [];
  try {
    const first = releases[0] = subscribeSubagents('session-2', load, true, () => { published[0] += 1; });
    const second = releases[1] = subscribeSubagents('session-2', load, true, () => { published[1] += 1; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(loads, 1, 'two viewers share one request');
    assert.deepEqual(published, [1, 1], 'and both hear the answer');
    first();
    assert.ok(subagentFeeds.has('session-2'), 'the remaining reader keeps the poll alive');
    second();
    assert.equal(subagentFeeds.has('session-2'), false, 'the last reader releases the poll');
    const third = releases[2] = subscribeSubagents('session-2', load, true, () => { published[0] += 1; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(loads, 2, 'a later reader starts a fresh poll, not a second one per viewer');
    third();
    assert.equal(subagentFeeds.has('session-2'), false, 'and releases it again');
  } finally {
    for (const release of releases) release();
    subagentFeeds.delete('session-2');
  }
});

test('a hidden panel or chip reads the last answer without polling the host again', async () => {
  const { renderToStaticMarkup, SubagentsTab, SubagentsTitle, React, tabInfo, subscribeSubagents, subagentFeeds, t } = await panel();
  let loads = 0;
  const load = async () => { loads += 1; return []; };
  const releases = [];
  try {
    const offscreen = releases[0] = subscribeSubagents('session-3', load, false, () => {});
    const onscreen = releases[1] = subscribeSubagents('session-3', load, true, () => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(loads, 1, 'the on-screen reader polls');
    const spare = releases[2] = subscribeSubagents('session-4', load, false, () => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(loads, 1, 'a hidden reader alone never starts a poll');
    assert.equal(subagentFeeds.has('session-4'), false, 'and leaves nothing behind');
    offscreen();
    assert.ok(subagentFeeds.get('session-3').timer, 'the on-screen reader keeps the poll alive');
    // A hidden reader keeps the last answer readable, but the clock stops with the last on-screen reader.
    const hiddenReader = releases[3] = subscribeSubagents('session-3', load, false, () => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(loads, 1, 'a hidden reader asks the host nothing');
    onscreen();
    assert.equal(subagentFeeds.get('session-3').timer, undefined, 'the last on-screen reader stops the clock');
    assert.ok(subagentFeeds.has('session-3'), 'the hidden reader still holds the answer');
    hiddenReader();
    assert.equal(subagentFeeds.has('session-3'), false, 'the last reader releases it');
    spare();
    // A collapsed sidebar still shows its last answer, and the chip counts the subagents that are running.
    subagentFeeds.set('session-3', { value: [agent({}), agent({ id: 'agent-2', status: 'completed', finishedAt: new Date().toISOString() })], listeners: new Set(), watching: 0, load });
    const hidden = renderToStaticMarkup(React.createElement(SubagentsTab, { sessionId: 'session-3', load, t, ...tabInfo(false) }));
    assert.match(hidden, /hp-sub-agent/, 'the panel renders the cached list');
    const chip = renderToStaticMarkup(React.createElement(SubagentsTitle, { sessionId: 'session-3', load, t, ...tabInfo(false) }));
    assert.match(chip, /hp-sub-badge/);
    assert.match(chip, />1</, 'one of the two subagents is running');
    assert.match(chip, /title="1 个子代理正在运行"/);
    const idle = renderToStaticMarkup(React.createElement(SubagentsTitle, { sessionId: 'session-5', load, t, ...tabInfo(false) }));
    assert.doesNotMatch(idle, /hp-sub-badge/, 'a session with nothing running carries no badge');
  } finally {
    for (const release of releases) release();
    subagentFeeds.delete('session-3');
    subagentFeeds.delete('session-4');
  }
});
