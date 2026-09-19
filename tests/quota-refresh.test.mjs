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
  stdin: { contents: `${source}\nexport { createRoot } from 'react-dom/client';\nexport { createElement } from 'react';`, resolveDir: resolve('src'), loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'HarnessProvider', jsx: 'automatic', loader: { '.png': 'dataurl' }, nodePaths, logLevel: 'warning',
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
    quota: async () => { seat.calls.push(session.provider); return { kind: 'balance', source: session.provider, currency: 'CNY', total: '1.00', granted: '0.00', toppedUp: '1.00' }; },
    modelProvider: () => handle, calls: [], viewed: 0, viewing: async () => { seat.viewed++; return null; },
   };
   window.__seat = { seat, session, listeners };
   createRoot(document.getElementById('root')).render(createElement(HarnessSelect, seat));
  });
  await page.waitForFunction(() => window.__seat.seat.calls.length >= 1, undefined, { timeout: 10_000 });
  // The seat loads its Harness state after mount, which legitimately polls once more; the switch is what follows.
  const settled = await page.evaluate(() => window.__seat.seat.calls.length);
  await page.evaluate(() => { window.__seat.session.provider = 'zai-coding-cn'; for (const listener of window.__seat.listeners) listener(); });
  await page.waitForFunction(count => window.__seat.seat.calls.length > count, settled, { timeout: 5_000 });
  // Everything before the switch read the old provider's account; the switch re-reads the new one, not a remount later.
  const calls = await page.evaluate(() => window.__seat.seat.calls);
  assert.equal(calls.at(-1), 'zai-coding-cn');
  assert.ok(calls.slice(0, -1).every(provider => provider === 'deepseek-official'), `unexpected calls: ${calls}`);
  // A DSH-native session has no Harness process to keep open.
  assert.equal(await page.evaluate(() => window.__seat.seat.viewed), 0);
 } finally { await browser.close(); }
});

// The host closes an idle Harness process unless a client keeps reporting its session on screen; a hidden page stops.
test('an external Harness session on a visible page reports itself viewed; a hidden page does not', async () => {
 const script = await clientBundle();
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
   const { createElement, createRoot, HarnessSelect } = window.HarnessProvider;
   let hidden = false;
   Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
   const state = { harness: 'codex', locked: false, model: null, thinking: null, permission: null, configs: {}, recoveryRequired: false, editableTurns: [] };
   const seat = {
    sessionId: 's1', useSessions: selector => selector({ byId: {} }), read: async () => state,
    select: async () => state, changed: () => {}, t: key => key,
    secretStatus: async () => null, answerSecret: async () => ({ accepted: true }), recover: async () => state,
    quota: async () => null, modelProvider: () => null, viewed: [], viewing: async id => { seat.viewed.push(id); return null; },
   };
   window.__view = { seat, hide: value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); } };
   createRoot(document.getElementById('root')).render(createElement(HarnessSelect, seat));
  });
  await page.waitForFunction(() => window.__view.seat.viewed.length >= 1, undefined, { timeout: 10_000 });
  assert.deepEqual(await page.evaluate(() => window.__view.seat.viewed), ['s1']);
  await page.evaluate(() => window.__view.hide(true));
  assert.equal(await page.evaluate(() => window.__view.seat.viewed.length), 1);
  // Coming back reports at once instead of waiting for the next interval.
  await page.evaluate(() => window.__view.hide(false));
  assert.equal(await page.evaluate(() => window.__view.seat.viewed.length), 2);
 } finally { await browser.close(); }
});
