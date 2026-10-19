import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('未确认请求仅在停止后显示处理入口，重新执行时关闭面板', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const bundle = await build({ stdin: { contents: await readFile('src/client.tsx', 'utf8') + `
import { createRoot } from 'react-dom/client';
const idle = async () => null;
const noop = () => {};
window.actions = [];
const recover = async (sessionId, action) => {
  window.actions.push({ sessionId, action });
  return { harness: 'codex', locked: true, recoveryRequired: action !== 'unlock', detail: '无法确认原请求的执行结果；没有重发任何请求。' };
};
function App() {
  const [scenario, setScenario] = useState({ running: true, pending: true, harness: 'codex' });
  window.setScenario = setScenario;
  const read = useCallback(async () => ({ harness: scenario.harness, locked: true, recoveryRequired: scenario.pending }), [scenario.pending, scenario.harness]);
  const useSessions = pick => pick({ byId: { session: { running: scenario.running, blank: false, retainedBy: { mainView: 0 } } } });
  return <><style>{styles}</style><HarnessSelect sessionId="session" useSessions={useSessions} read={read} select={read} quota={idle}
    viewing={idle} modelProvider={() => null} changed={noop} secretStatus={idle} answerSecret={idle}
    recover={recover} t={key => zh[key] ?? key} /></>;
}
createRoot(document.querySelector('#root')).render(<App />);`, resolveDir: resolve('src'), loader: 'tsx' }, bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', external: ['@deepseek-ai/dsh-client-ui-primitives'],
    alias: { react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'), 'react-dom': require.resolve('react-dom'), 'react-dom/client': require.resolve('react-dom/client') } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 500 } });
    await page.setContent('<style>:root{--dsw-specific-menu:#29292c;--dsw-alias-label-primary:#f8f8fa;--dsw-alias-label-secondary:#b4b4b8;--dsw-alias-label-tertiary:#a0a0a4;--dsw-alias-border-l2:#404044;--dsw-alias-border-l3:#666}body{margin:40px;padding-top:280px;background:#1b1b1b;color:#f8f8fa;font:16px sans-serif}</style><div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await expect(page.getByText('Codex', { exact: true })).toBeVisible();
    const anyEntry = page.getByRole('button', { name: /恢复会话|处理未确认请求/ });
    await expect(anyEntry).toHaveCount(0);
    const scenario = async (running, pending, harness = 'codex') => page.evaluate(scenario => window.setScenario(scenario), { running, pending, harness });
    await scenario(false, false);
    await expect(anyEntry).toHaveCount(0);
    await scenario(false, true);
    const entry = page.getByRole('button', { name: '处理未确认请求', exact: true });
    await entry.click();
    const panel = page.getByRole('dialog', { name: '处理未确认请求', exact: true });
    await expect(panel).toContainText('上次执行已停止，但结果未确认');
    const check = panel.getByRole('button', { name: '核对原生记录', exact: true });
    const unlock = panel.getByRole('button', { name: '解除暂停，不重发', exact: true });
    await expect(check).toBeEnabled();
    await expect(unlock).toBeEnabled();
    await check.click();
    await expect(panel.getByRole('status')).toContainText('无法确认');
    await mkdir('.cache', { recursive: true });
    await page.screenshot({ path: resolve('.cache/recovery-stopped-web.png') });
    await scenario(true, true);
    await expect(anyEntry).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    await page.screenshot({ path: resolve('.cache/recovery-running-web.png') });
    await scenario(false, true);
    await expect(entry).toBeVisible();
    await expect(panel).toHaveCount(0);
    await entry.click();
    await unlock.click();
    await expect(entry).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.actions), [{ sessionId: 'session', action: 'check' }, { sessionId: 'session', action: 'unlock' }]);
    await scenario(false, true, 'dsh');
    await expect(page.getByText('DSH 原生', { exact: true })).toBeVisible();
    await expect(anyEntry).toHaveCount(0);
  } finally { await browser.close(); }
});

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
    platform: 'browser', format: 'iife', jsx: 'automatic', external: ['@deepseek-ai/dsh-client-ui-primitives'],
    alias: { react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'), 'react-dom': require.resolve('react-dom'), 'react-dom/client': require.resolve('react-dom/client') } });
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

// A subscription login reports its plan as the status label ("ChatGPT Plus"); the composer row keeps
// that out, and still says when the Harness is not logged in.
test('Harness selector hides the subscription plan label and keeps other account statuses', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const bundle = await build({ stdin: { contents: await readFile('src/client.tsx', 'utf8') + `
import { createRoot } from 'react-dom/client';
const states = {
  plan: { harness: 'codex', locked: true, authStatus: { kind: 'chatgpt', label: 'ChatGPT Plus', account: { email: 'a@b.c', plan: 'plus' } } },
  none: { harness: 'codex', locked: true, authStatus: { kind: 'none', label: '未登录' } },
};
const idle = async () => null;
const noop = () => {};
const useSessions = pick => pick({ byId: { plan: { running: false, blank: false, retainedBy: { mainView: 0 } }, none: { running: false, blank: false, retainedBy: { mainView: 0 } } } });
function Row({ id }) {
  const read = async () => states[id];
  return <div id={id}><HarnessSelect sessionId={id} useSessions={useSessions} read={read} select={read} quota={idle}
    viewing={idle} modelProvider={() => null} changed={noop} secretStatus={idle} answerSecret={idle}
    recover={read} t={key => ({ harness: '选择 Harness' }[key] ?? key)} /></div>;
}
createRoot(document.querySelector('#root')).render(<><Row id="plan" /><Row id="none" /></>);`, resolveDir: resolve('src'), loader: 'tsx' }, bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', external: ['@deepseek-ai/dsh-client-ui-primitives'],
    alias: { react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'), 'react-dom': require.resolve('react-dom'), 'react-dom/client': require.resolve('react-dom/client') } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator('#none [role=status]', { hasText: '未登录' }).waitFor();
    assert.equal(await page.locator('#plan [role=status]').count(), 0);
    assert.equal(await page.getByText('ChatGPT Plus').count(), 0);
  } finally { await browser.close(); }
});
