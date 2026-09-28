import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// The delegation dock's chip reads "默认" without loading anything; opening it shows which model and effort that default is.
test('opening the delegation pick shows the model and effort its default resolves to', async () => {
 const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const nodePaths = [dirname(dirname(require.resolve('react/package.json'))), dirname(dirname(require.resolve('react-dom/package.json')))];
 const bundle = await build({
  stdin: { contents: `${await readFile('src/client.tsx', 'utf8')}\nexport { DelegatePick };\nexport { createRoot } from 'react-dom/client';\nexport { createElement } from 'react';`, resolveDir: resolve('src'), loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'HarnessProvider', jsx: 'automatic', nodePaths, logLevel: 'warning',
 });
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
   const { createElement, createRoot, DelegatePick } = window.HarnessProvider;
   const words = { pickDefault: '默认', menuModel: '模型', menuEffort: '强度', 'effort.low': '低', 'effort.high': '高' };
   // `fast` is the default and offers only low effort.
   const catalog = { models: [{ id: 'fast', label: 'Fast', resolved: null, thinkingOptionIds: ['low'] }, { id: 'deep', label: 'Deep', resolved: null, thinkingOptionIds: null }],
    defaultModel: { id: 'fast', label: 'Fast', resolved: null }, thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultThinkingOptionId: 'low',
    permissionModes: [], defaultPermissionModeId: null, configOptions: [], error: null };
   createRoot(document.getElementById('root')).render(createElement(DelegatePick, { harness: 'codex', pick: {}, load: async () => catalog, disabled: false, onChange() {}, t: key => words[key] ?? key }));
  });
  const chip = page.getByRole('button', { name: 'pickModel' });
  await chip.waitFor();
  assert.equal((await chip.textContent()).trim(), 'Codex · 默认');
  await chip.click();
  const cells = page.locator('.hp-cell-value');
  await page.waitForFunction(() => document.querySelector('.hp-cell-value')?.textContent === '默认 · Fast', undefined, { timeout: 5_000 });
  assert.deepEqual(await cells.allTextContents(), ['默认 · Fast', '默认 · 低']);
  await page.locator('.hp-cell').first().click();
  assert.equal(await page.locator('.hp-option').first().textContent(), '默认Fast');
  await page.locator('.hp-cell').first().click();
  await page.locator('.hp-cell').nth(1).click();
  // Only the default model's effort levels are offered.
  assert.deepEqual(await page.locator('.hp-option-name').allTextContents(), ['默认', '低']);
  assert.equal(await page.locator('.hp-option-hint').first().textContent(), '低');
 } finally { await browser.close(); }
});
