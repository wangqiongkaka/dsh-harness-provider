import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('Harness selector shows no turn status label while idle or running', async () => {
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
    recover={read} t={key => ({ harness: '选择 Harness' }[key] ?? key)} />;
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
    const statuses = page.locator('.hp-root [role=status]');
    assert.equal(await statuses.count(), 0);
    await page.evaluate(() => window.setRunning(true));
    await page.waitForTimeout(50);
    assert.equal(await statuses.count(), 0);
    await page.evaluate(() => window.setRunning(false));
    await page.waitForTimeout(50);
    assert.equal(await statuses.count(), 0);
  } finally { await browser.close(); }
});
