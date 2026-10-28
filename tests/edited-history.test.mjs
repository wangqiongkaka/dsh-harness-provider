import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('编辑后只展示修改后的消息及附件，隐藏旧消息和停止状态', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const bundle = await build({ stdin: { contents: await readFile('src/client.tsx', 'utf8') + `
const registrations = [], subscribers = new Set(), cleanup = [];
let current = 'session', wrapped = true;
const states = { session: { harness: 'codex', supersededTurns: [], editableTurns: [124] }, other: { harness: 'codex', supersededTurns: [], editableTurns: [124] } };
const snapshot = () => ({ byId: Object.fromEntries(['session', 'other'].map(id => [id, { id, retainedBy: { mainView: id === current ? 1 : 0 } }])) });
const row = (turn, text, stopped) => '<div data-chat-turn="' + turn + '" data-chat-flow-kind="user"><div class="attachment">订单列表截图</div><p class="bubble">' + text + '</p></div>' + (stopped ? '<div data-chat-turn="' + turn + '" data-chat-flow-kind="turn-process">已停止</div>' : '');
const render = () => {
 const state = states[current];
 const content = row(124, '这两个字段容器让人误解', true) + (state.supersededTurns.length ? row(125, '这两个字段容易让人误解', false) : '');
 document.querySelector('#chat').innerHTML = wrapped ? '<div data-slot="conversation.chat.flow">' + content + '</div>' : content;
};
const slots = { inject: (_name, callback) => callback(), entries: () => [], register: (options, component) => { const entry = { options, component }; registrations.push(entry); return () => { const i = registrations.indexOf(entry); if (i >= 0) registrations.splice(i, 1); }; } };
const remote = { $mount: async () => () => {}, harness: {
 state: async ({ sessionId }) => ({ ok: true, value: states[sessionId] }),
 edit: async ({ sessionId }) => { states[sessionId] = { ...states[sessionId], supersededTurns: [124], editableTurns: [125] }; render(); return { ok: true, value: states[sessionId] }; }
} };
const scope = { remote, slots, locale: { register: () => () => {}, bind: () => key => key }, get: () => undefined,
 sessions: { list: { getSnapshot: snapshot, subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); } } },
 effect: callback => { const dispose = callback(); if (typeof dispose === 'function') cleanup.push(dispose); }, on: () => () => {},
};
const ctx = { ...scope, inject: (dependencies, callback) => { if (dependencies[0] === 'sessions' && dependencies[1] === 'remote.harness') callback(scope); } };
window.ready = apply(ctx).then(async () => {
 const input = registrations.find(entry => entry.options.name === 'conversation.input.left').options.inject();
 input.changed(current, 'codex');
 const edits = () => registrations.find(entry => entry.component === EditableUserMessage).options.inject();
 window.editMessage = () => edits().edit(current, 28246, '这两个字段容易让人误解', crypto.randomUUID());
 window.switchSession = async id => { current = id; for (const callback of subscribers) callback(); input.changed(id, 'codex'); render(); await edits().read(id); };
 window.setWrapped = async value => { wrapped = value; render(); await edits().read(current); };
 render(); await edits().read(current);
});
`, resolveDir: resolve('src'), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    external: ['@deepseek-ai/dsh-client-ui-primitives'], alias: { react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'), 'react-dom': require.resolve('react-dom') } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: `<style>
body{margin:40px;background:#141414;color:#eee;font:16px sans-serif}#chat{max-width:760px;margin:auto}[data-chat-flow-kind=user]{display:flex;align-items:flex-end;flex-direction:column;margin:24px 0}.attachment{border:1px solid #444;border-radius:16px;width:260px;padding:24px;background:#1c1c1c}.bubble{background:#303030;border-radius:20px;padding:16px 20px}[data-chat-flow-kind=turn-process]{color:#aaa;border-bottom:1px solid #333;padding:20px 0}
</style><div id="chat" data-chat-flow></div>` }));
    await page.goto('http://localhost/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => window.ready);
    await expect(page.getByText('这两个字段容器让人误解', { exact: true })).toBeVisible();
    await page.evaluate(() => window.editMessage());
    await expect(page.getByText('这两个字段容易让人误解', { exact: true })).toBeVisible();
    await expect(page.getByText('这两个字段容器让人误解', { exact: true })).toBeHidden();
    await expect(page.getByText('已停止', { exact: true })).toBeHidden();
    assert.equal(await page.locator('.attachment:visible').count(), 1);
    await mkdir('.cache', { recursive: true });
    await page.screenshot({ path: resolve('.cache/edited-history-web.png') });
    await page.evaluate(() => window.switchSession('other'));
    await expect(page.getByText('这两个字段容器让人误解', { exact: true })).toBeVisible();
    await page.evaluate(() => window.switchSession('session'));
    await expect(page.getByText('这两个字段容器让人误解', { exact: true })).toBeHidden();
    await page.evaluate(() => window.setWrapped(false));
    await expect(page.getByText('这两个字段容器让人误解', { exact: true })).toBeHidden();
    await expect(page.getByText('这两个字段容易让人误解', { exact: true })).toBeVisible();
  } finally { await browser.close(); }
});
