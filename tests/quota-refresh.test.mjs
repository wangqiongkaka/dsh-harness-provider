import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// Switching the session's model provider changes whose account the quota describes, so the seat must re-read at once
// instead of waiting out the 60s interval. The real component is rendered in a browser over a fake host directory that
// mirrors the host's per-session snapshot store: publishing a new provider is exactly what the host does on a switch.
/** The real client module bundled for the browser, with React's entry points alongside. */
async function clientBundle() {
 const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const nodePaths = [dirname(dirname(require.resolve('react/package.json'))), dirname(dirname(require.resolve('react-dom/package.json')))];
 const source = await readFile('src/client.tsx', 'utf8');
 const bundle = await build({
  stdin: { contents: `${source}\nexport { createRoot } from 'react-dom/client';\nexport { createElement, useSyncExternalStore } from 'react';`, resolveDir: resolve('src'), loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'HarnessProvider', jsx: 'automatic', nodePaths, logLevel: 'warning',
 });
 return bundle.outputFiles[0].text;
}

test('switching the session model provider re-reads account quota immediately', async () => {
 const script = await clientBundle();
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
   const { createElement, createRoot, HarnessSelect } = window.HarnessProvider;
   const listeners = new Set();
   const session = { provider: 'deepseek-official' };
   const state = { harness: 'dsh', locked: false, model: null, thinking: null, permission: null, configs: {}, recoveryRequired: false, editableTurns: [] };
   // One handle per session, as the plugin caches it: React keeps a single subscription across renders.
   const handle = { get: () => session.provider, subscribe: onChange => { listeners.add(onChange); return () => listeners.delete(onChange); } };
   const seat = {
    sessionId: 's1', useSessions: selector => selector({ byId: {} }), read: async () => state,
    select: async () => state, changed: () => {}, t: key => key,
    secretStatus: async () => null, answerSecret: async () => ({ accepted: true }), recover: async () => state,
    quota: async () => { seat.calls.push(session.provider); if (session.provider === 'zai-coding-cn') return new Promise(resolve => { seat.resolveNew = resolve; }); return { kind: 'balance', source: session.provider, currency: 'CNY', total: '1.00', granted: '0.00', toppedUp: '1.00' }; },
    modelProvider: () => handle, calls: [], viewed: 0, viewing: async () => { seat.viewed++; return null; },
   };
   window.__seat = { seat, session, listeners };
   createRoot(document.getElementById('root')).render(createElement(HarnessSelect, seat));
  });
  await page.waitForFunction(() => window.__seat.seat.calls.length >= 1, undefined, { timeout: 10_000 });
  // The seat loads its Harness state after mount, which legitimately polls once more; the switch is what follows.
  await page.getByRole('button', { name: 'quotaAria', exact: true }).waitFor();
  const settled = await page.evaluate(() => window.__seat.seat.calls.length);
  await page.evaluate(() => { window.__seat.session.provider = 'zai-coding-cn'; for (const listener of window.__seat.listeners) listener(); });
  await page.waitForFunction(count => window.__seat.seat.calls.length > count, settled, { timeout: 5_000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="quotaAria"]'), undefined, { timeout: 1000 });
  await page.evaluate(() => window.__seat.seat.resolveNew({ kind: 'balance', source: 'zai-coding-cn', currency: 'CNY', total: '2.00', granted: '0.00', toppedUp: '2.00' }));
  await page.getByRole('button', { name: 'quotaAria', exact: true }).waitFor();
  assert.match(await page.getByRole('button', { name: 'quotaAria', exact: true }).textContent(), /2.00/u);
  // Everything before the switch read the old provider's account; the switch re-reads the new one, not a remount later.
  const calls = await page.evaluate(() => window.__seat.seat.calls);
  assert.equal(calls.at(-1), 'zai-coding-cn');
  assert.ok(calls.slice(0, -1).every(provider => provider === 'deepseek-official'), `unexpected calls: ${calls}`);
  // A DSH-native session has no Harness process to keep open.
  assert.equal(await page.evaluate(() => window.__seat.seat.viewed), 0);
 } finally { await browser.close(); }
});

// The host closes an idle Harness process unless a client keeps reporting its session on screen; a hidden page stops.
test('only the visible main-view Harness session reports itself viewed', async () => {
 const script = await clientBundle();
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
   const { createElement, createRoot, HarnessSelect } = window.HarnessProvider;
   let hidden = false, current = true;
   Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
   const state = { harness: 'codex', locked: false, model: null, thinking: null, permission: null, configs: {}, recoveryRequired: false, editableTurns: [] };
   const seat = {
    sessionId: 's1', useSessions: selector => selector({ byId: { s1: { retainedBy: { mainView: current ? 1 : 0 } } } }), read: async () => state,
    select: async () => state, changed: () => {}, t: key => key,
    secretStatus: async () => null, answerSecret: async () => ({ accepted: true }), recover: async () => state,
    quota: async () => null, modelProvider: () => null, viewed: [], viewing: async id => { seat.viewed.push(id); return null; },
   };
   const root = createRoot(document.getElementById('root'));
   window.__view = {
    seat,
    hide: value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); },
    current: value => { current = value; root.render(createElement(HarnessSelect, { ...seat })); },
   };
   root.render(createElement(HarnessSelect, seat));
  });
  await page.waitForFunction(() => window.__view.seat.viewed.length >= 1, undefined, { timeout: 10_000 });
  assert.deepEqual(await page.evaluate(() => window.__view.seat.viewed), ['s1']);
  await page.evaluate(() => window.__view.hide(true));
  assert.equal(await page.evaluate(() => window.__view.seat.viewed.length), 1);
  // Coming back reports at once instead of waiting for the next interval.
  await page.evaluate(() => window.__view.hide(false));
  assert.equal(await page.evaluate(() => window.__view.seat.viewed.length), 2);
  // The host may retain an old conversation component; once it leaves mainView it must stop keeping its process alive.
  await page.evaluate(async () => { window.__view.current(false); await new Promise(requestAnimationFrame); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.evaluate(() => window.__view.seat.viewed.length), 2);
 } finally { await browser.close(); }
});

// Opening a menu reloads its directory; picking from it must still land the answer and free the control.
test('picking from the permission menu shows the new mode and leaves the control usable', async () => {
 const script = await clientBundle();
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
   const { createElement, createRoot, HarnessPermission } = window.HarnessProvider;
   const server = { permission: 'default', models: 0 };
   const view = () => ({ harness: 'claude-code', locked: false, model: null, thinking: null, permission: server.permission, configs: {}, recoveryRequired: false, editableTurns: [], supersededTurns: [] });
   window.__server = server;
   createRoot(document.getElementById('root')).render(createElement(HarnessPermission, {
    sessionId: 's1', locked: false, useSessions: selector => selector({ byId: {} }), t: key => key, subscribe: () => () => {}, read: async () => view(),
    models: async () => { server.models++; return { models: [], defaultModel: null, thinkingOptions: [], defaultThinkingOptionId: null, configOptions: [], error: null,
     permissionModes: [{ id: 'default', label: 'Default', dangerous: false }, { id: 'plan', label: 'Plan', dangerous: false }], defaultPermissionModeId: 'default' }; },
    // The write is serialized on the host, so it answers after the state read the menu itself triggers.
    selectPermission: async (_sessionId, mode) => { await new Promise(resolve => setTimeout(resolve, 150)); server.permission = mode; return view(); },
   }));
  });
  const chip = page.getByRole('button', { name: 'permissionAria', exact: true });
  await chip.waitFor();
  await page.waitForFunction(() => window.__server.models === 1);
  await chip.click();
  await page.waitForFunction(() => window.__server.models === 2, undefined, { timeout: 3_000 });
  await page.getByRole('menuitemradio').nth(1).click();
  await page.waitForFunction(() => window.__server.permission === 'plan');
  await page.waitForFunction(() => { const chip = document.querySelector('[aria-label="permissionAria"]'); return chip.textContent.includes('mode.plan') && !chip.disabled; }, undefined, { timeout: 3_000 });
 } finally { await browser.close(); }
});

// Only a different session or account makes the last reading someone else's; a turn starting or ending merely re-reads it.
test('a turn starting keeps the context reading on screen while it is re-read', async () => {
 const script = await clientBundle();
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
   const { createElement, createRoot, useSyncExternalStore, HarnessContext } = window.HarnessProvider;
   const listeners = new Set(), seat = { calls: 0, store: { byId: { s1: { running: false } } } };
   window.__context = { seat, listeners };
   createRoot(document.getElementById('root')).render(createElement(HarnessContext, {
    sessionId: 's1', t: key => key,
    useSessions: selector => useSyncExternalStore(onChange => { listeners.add(onChange); return () => listeners.delete(onChange); }, () => selector(seat.store)),
    // The first reading answers at once; the one the turn start triggers stays pending.
    usage: () => ++seat.calls === 1 ? Promise.resolve({ contextUsedTokens: 500, contextWindowTokens: 1000, totalTokens: null }) : new Promise(() => {}),
   }));
  });
  const ring = page.getByRole('button', { name: 'contextUsed 50%', exact: true });
  await ring.waitFor();
  await page.evaluate(() => { const { seat, listeners } = window.__context; seat.store = { byId: { s1: { running: true } } }; for (const listener of listeners) listener(); });
  await page.waitForFunction(() => window.__context.seat.calls === 2, undefined, { timeout: 3_000 });
  await page.waitForTimeout(100);
  assert.equal(await ring.count(), 1);
 } finally { await browser.close(); }
});
