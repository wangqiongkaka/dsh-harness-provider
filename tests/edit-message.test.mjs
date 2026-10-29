import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('消息编辑仅显示输入框和右对齐的操作按钮，取消与发送仍可用', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const bundle = await build({ stdin: { contents: await readFile('src/client.tsx', 'utf8') + `
import { createRoot } from 'react-dom/client';
const state = { harness: 'codex', editableTurns: [1], rewindableTurns: [1], recoveryRequired: false };
const read = async () => state;
const useSessions = pick => pick({ byId: { session: { running: false } } });
const node = { data: { seq: 1, content: [{ type: 'text', text: '把主题改成蓝白' }] }, location: { kind: 'turn', turn: { turn: 1 } } };
const Host = () => <div>把主题改成蓝白</div>;
const host = () => Host;
window.requests = [];
window.rewinds = [];
const previewRewind = async (...args) => { window.rewinds.push(['preview', ...args]); return { token: 'preview-token', paths: ['src/app.ts'], conflicts: window.conflict ? ['src/app.ts'] : [], diff: '-旧内容\\n+新内容', truncated: false, turns: 1 }; };
const confirmRewind = async (...args) => { window.rewinds.push(['confirm', ...args]); return state; };
const edit = async (...args) => { window.requests.push(args); return state; };
const root = createRoot(document.querySelector('#root'));
window.renderEditor = locale => root.render(<><style>{styles}</style><EditableUserMessage
  sessionId="session" useSessions={useSessions} node={node} read={read} edit={edit} previewRewind={previewRewind} confirmRewind={confirmRewind} host={host}
  ht={key => (locale === 'zh' ? zh : en)[key]} /></>);
window.renderEditor('zh');`, resolveDir: resolve('src'), loader: 'tsx' }, bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', external: ['@deepseek-ai/dsh-client-ui-primitives'],
    alias: { react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'), 'react-dom': require.resolve('react-dom'), 'react-dom/client': require.resolve('react-dom/client') } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 360 } });
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: `<style>:root{--dsw-alias-label-primary:#f8f8fa;--dsw-alias-label-secondary:#b4b4b8;--dsw-alias-border-l2:#404044;--dsw-alias-border-l3:#666;--dsw-specific-bubble:#29292c}body{margin:40px;background:#1b1b1b;color:#f8f8fa;font:16px sans-serif}</style><div id="root"></div>` }));
    await page.goto('http://localhost/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await expect(page.getByRole('button', { name: '恢复文件与对话', exact: true }).locator('svg')).toHaveCount(1);
    await mkdir('.cache', { recursive: true });
    await page.screenshot({ path: resolve('.cache/rewind-icon-web.png') });
    await page.getByRole('button', { name: '恢复文件与对话', exact: true }).click();
    await expect(page.getByRole('region', { name: '恢复文件与对话' })).toBeVisible();
    await expect(page.getByRole('region', { name: '恢复文件与对话' })).toContainText('src/app.ts');
    assert.deepEqual(await page.evaluate(() => window.rewinds), [['preview', 'session', 1]]);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(() => { window.conflict = true; });
    await page.getByRole('button', { name: '恢复文件与对话', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认恢复', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(() => { window.conflict = false; });
    await page.getByRole('button', { name: '恢复文件与对话', exact: true }).click();
    await mkdir('.cache', { recursive: true });
    await page.screenshot({ path: resolve('.cache/rewind-preview-web.png') });
    await page.setViewportSize({ width: 390, height: 680 });
    await page.getByText('查看文件差异', { exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve('.cache/rewind-preview-mobile-web.png') });
    await page.setViewportSize({ width: 1000, height: 360 });
    await page.getByRole('button', { name: '确认恢复', exact: true }).click();
    await expect(page.getByRole('region', { name: '恢复文件与对话' })).toHaveCount(0);
    assert.deepEqual((await page.evaluate(() => window.rewinds)).at(-1), ['confirm', 'session', 'preview-token']);
    for (const [locale, labels] of [['zh', ['编辑', '取消', '发送']], ['en', ['Edit', 'Cancel', 'Send']]]) {
      await page.evaluate(locale => window.renderEditor(locale), locale);
      await page.getByRole('button', { name: labels[0], exact: true }).click();
      const box = page.getByRole('textbox', { name: labels[0], exact: true });
      await expect(box).toHaveValue('把主题改成蓝白');
      await expect(page.locator('.hp-edit-bar')).toHaveText(labels[1] + labels[2]);
      const bar = await page.locator('.hp-edit-bar').boundingBox();
      const send = page.getByRole('button', { name: labels[2], exact: true });
      const button = await send.boundingBox();
      assert.ok(Math.abs(bar.x + bar.width - button.x - button.width) < 1);
      if (locale === 'zh') {
        await mkdir('.cache', { recursive: true });
        await page.screenshot({ path: resolve('.cache/edit-message-web.png') });
      }
      await page.getByRole('button', { name: labels[1], exact: true }).click();
      await expect(box).toHaveCount(0);
      assert.deepEqual(await page.evaluate(() => window.requests), []);
    }
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Edit', exact: true }).fill('改成蓝白主题');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.hp-edit')).toHaveCount(0);
    const [request] = await page.evaluate(() => window.requests);
    assert.deepEqual(request.slice(0, 3), ['session', 1, '改成蓝白主题']);
    assert.match(request[3], /^[0-9a-f-]{36}$/);
  } finally { await browser.close(); }
});
