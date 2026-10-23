import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('子代理入口由原生开始页渲染，大小、图标、说明和打开行为一致', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const reference = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness', 'packages/client');
  const bundle = await build({
    stdin: { contents: await readFile('src/client.tsx', 'utf8') + `
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { GuideBody } from '${reference}/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx';
import { IconFolderOpenRegular, IconGlobeOutlineRegular, IconBranchOutlineRegular } from '${reference}/ui-primitives/src/icons/index.tsx';
const types = [], overrides = [];
const scope = { effect: fn => fn(), remote: {harness: {}},
  sidebarRightTabs: {register: definition => { types.push(definition); return () => {}; }},
  slots: {inject: (_, fn) => fn(), register: (definition, component) => { overrides.push({definition, component}); return () => {}; }} };
const applied = apply({remote: {$mount: async () => () => {}}, effect: () => {},
  locale: {register: () => () => {}, bind: () => key => zh[key] ?? key},
  inject: (keys, fn) => { if (keys.includes('sidebarRightTabs')) fn(scope); }});
const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
const root = createRoot(document.querySelector('#root'));
window.opened = [];
const useTabInfo = () => ({tab: {actions: {openTab: (...args) => window.opened.push(args)}}});
window.renderGuide = crowded => {
  const own = {...types[0].guide[0], kind: types[0].kind, providerId: types[0].id};
  const diagnostic = {id: 'diagnostic', kind: 'diagnostic', providerId: 'diagnostic', title: () => '会话数据诊断'};
  const entries = crowded ? [
    {id: 'files', kind: 'files', providerId: 'files', title: () => '工作区文件', icon: IconFolderOpenRegular},
    {id: 'git', kind: 'git', providerId: 'git', title: () => '源代码管理', icon: IconBranchOutlineRegular},
    {id: 'browser', kind: 'browser', providerId: 'browser', title: () => '浏览器', icon: IconGlobeOutlineRegular},
    own, diagnostic,
  ] : [own, diagnostic];
  root.render(<GuideBody useTabInfo={useTabInfo} useShortcuts={pick => pick([])} useGuideEntries={pick => pick(entries)}
    renderSlotChain={(_, __, options) => options.fallback}
    renderSlot={(name, owner, options) => {
      const match = overrides.find(item => item.definition.name === name && item.definition.key === options.entryKey);
      return match ? createElement(match.component, {...owner, useTabInfo, t: key => zh[key] ?? key}) : options.fallback;
    }} />);
};
void applied.then(() => window.renderGuide(true));
`, resolveDir: resolve('src'), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'), 'react-dom': require.resolve('react-dom'), 'react-dom/client': require.resolve('react-dom/client') },
    plugins: [{ name: 'guide-host', setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'ui', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const ShortcutKeys = () => null;', loader: 'js' }));
      builder.onLoad({ filter: /GuideBody\.module\.css$/ }, async ({path}) => ({ contents:
        `const style = document.createElement('style'); style.textContent = ${JSON.stringify((await readFile(path, 'utf8')).replace(/:global\(([^)]+)\)/g, '$1').replace(/\.([a-zA-Z][\w-]*)/g, '.native_$1'))}; document.head.append(style); export default new Proxy({}, {get: (_, key) => 'native_' + key});`, loader: 'js' }));
    } }],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    for (const file of ['base.css', 'design-platform.css', 'focus.css'])
      await page.addStyleTag({ path: resolve(reference, 'ui-theme/src/styles', file) });
    await page.addStyleTag({ content: 'body{margin:0;font:14px var(--dsw-font-family)}#root{height:100dvh}' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const own = page.locator('[data-sidebar-right-guide-entry="harness-subagents"]');
    const native = page.locator('[data-sidebar-right-guide-entry="diagnostic"]');
    const css = async locator => locator.evaluate(node => {
      const style = getComputedStyle(node);
      return ['height', 'padding', 'borderRadius', 'backgroundColor', 'fontSize'].map(key => style[key]);
    });
    await mkdir('.cache', {recursive: true});
    for (const theme of ['light', 'dark']) {
      await page.locator('body').evaluate((node, dark) => node.toggleAttribute('data-ds-dark-theme', dark), theme === 'dark');
      for (const width of [390, 960]) {
        await page.setViewportSize({width, height: 800});
        await expect(own).toHaveText('子代理');
        assert.deepEqual(await css(own), await css(native));
        await expect(own.locator('svg')).toHaveAttribute('width', '22');
        assert.equal(await own.locator('svg').innerHTML(), await native.locator('svg').innerHTML());
        assert.equal(await own.evaluate(node => node.scrollWidth <= node.clientWidth), true);
        await page.screenshot({path: resolve('.cache/subagents-guide-' + theme + '-' + width + '.png')});
      }
    }
    await own.click();
    assert.deepEqual(await page.evaluate(() => window.opened), [['harness-subagents', {replaceTab: true}]]);
    await page.evaluate(() => window.renderGuide(false));
    await expect(own).toHaveText('子代理查看子代理的运行状态和内容');
    await expect(own.locator('svg')).toHaveAttribute('width', '26');
    await own.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.opened.length), 2);
  } finally { await browser.close(); }
});
