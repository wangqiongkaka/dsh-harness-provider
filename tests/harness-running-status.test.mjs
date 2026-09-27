import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('Harness running status follows the session before agent output and after the turn ends', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const bundle = await build({ stdin: { contents: await readFile('src/client.tsx', 'utf8') + `
import { createRoot } from 'react-dom/client';
const read = async () => ({ harness: 'codex', locked: true });
const idle = async () => null;
const noop = () => {};
const root = createRoot(document.querySelector('#root'));
function App() {
  const [running, setRunning] = useState(false);
  window.setRunning = setRunning;
  const useSessions = pick => pick({ byId: { session: { running, blank: false, retainedBy: { mainView: 0 } } } });
  return <HarnessSelect sessionId="session" useSessions={useSessions} read={read} select={read} quota={idle}
    viewing={idle} modelProvider={() => null} changed={noop} secretStatus={idle} answerSecret={idle}
    recover={read} t={key => ({ harness: '选择 Harness', taskRunning: '任务执行中', taskIdle: '本轮已结束' }[key] ?? key)} />;
}
root.render(<App />);`, resolveDir: resolve('src'), loader: 'tsx' }, bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'), 'react-dom/client': require.resolve('react-dom/client') } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('button', { name: '选择 Harness' }).waitFor();
    await page.getByText('Codex', { exact: true }).first().waitFor();
    assert.equal(await page.locator('[data-hp-run-state]').textContent(), '本轮已结束');
    await page.evaluate(() => window.setRunning(true));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('[data-hp-run-state]').count(), 1);
    assert.equal(await page.locator('[data-hp-run-state]').textContent(), '任务执行中');
    await page.evaluate(() => window.setRunning(false));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('[data-hp-run-state]').textContent(), '本轮已结束');
  } finally { await browser.close(); }
});
