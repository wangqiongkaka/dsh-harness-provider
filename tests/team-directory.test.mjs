import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { HarnessService } from '../dist/dsh.js';

test('成员目录查询返回绑定的实际工作目录，不加载会话', async () => {
  const binding = { harness: 'codex', cwd: '/work/isolated-checkout' };
  const ctx = { agents: { get: () => undefined } };
  const result = await HarnessService.prototype.harnesses.call({ ctx, runner: { live: new Map() }, bindings: {
    readDelegated: async () => undefined,
    read: async id => id === 'bound' ? binding : undefined,
  } }, { sessionIds: ['bound', 'native'] });
  assert.equal(result.bound.cwd, binding.cwd);
  assert.equal(result.native.cwd, undefined);
});

test('真实成员弹窗在手机和桌面展示当前会话目录，支持更新、重开与卸载', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const reference = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
  const bundle = await build({
    stdin: { contents: await readFile('src/client.tsx', 'utf8') + `
import { createRoot } from 'react-dom/client';
import { TeamAction } from '${reference}/packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx';
const entries = [];
window.directoryRequests = [];
const scope = {
  effect: fn => fn(),
  slots: { inject: (name, fn) => fn(), register: (definition, component) => { if (definition.name === 'conversation.session.header.actions') entries.push({ definition, component }); return () => {}; } },
  remote: { harness: { harnesses: async ({sessionIds}) => { window.directoryRequests.push(sessionIds); return window.lookup(); } } },
};
const applied = apply({ remote: { $mount: async () => () => {} }, locale: { register: () => () => {} },
  effect: () => {}, inject: (keys, fn) => { if (keys.length === 2 && keys.includes('slots') && keys.includes('remote.harness')) fn(scope); } });
const root = createRoot(document.querySelector('#root'));
const team = { members: [{ id: 'session', name: 'lead', phase: 'active' }, { id: 'worker', name: 'worker', phase: 'active' }], tasks: [] };
window.renderTeam = (id, cwd, compact = false) => {
  const props = { sessionId: id, useSessions: pick => pick({ byId: { [id]: {cwd} }, projectionsBySession: { session: { values: { agentTeam: compact ? {...team, members: team.members.filter(member => member.id === id)} : team } } } }),
    useSession: pick => pick({ subagent: id === 'worker' ? { address: { parentSessionId: 'session' } } : null, openState: 'open' }),
    useSessionStatus: pick => pick(new Map()), openTeammate() {}, t: key => ({ trigger: '智能体团队', roster: '成员', current: '当前会话', empty: '暂无共享任务，可以通过对话创建', 'memberStatus.inactive': '未运行' }[key] ?? key) };
  root.render(<div className="host_headerActions"><TeamAction {...props} />{entries.map(({definition, component: Component}) => <Component key={definition.id} {...props} {...definition.inject?.()} t={key => zh[key] ?? key} />)}</div>);
};
window.unmountTeam = () => root.unmount();
window.lookup = async () => ({ ok: true, value: {} });
void applied.then(() => window.renderTeam('session', '/Users/me/项目/很长的工作目录/' + 'long-project-name'.repeat(5)));
`, resolveDir: resolve('src'), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'), 'react-dom': require.resolve('react-dom'), 'react-dom/client': require.resolve('react-dom/client') },
    plugins: [{ name: 'team-host', setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'ui', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `import { createElement } from 'react';
        export const IconChevronDownOutlineRegular = () => null, IconUserOutlineRegular = () => null, IconUsersOutlineRegular = () => createElement('span', null, '♧');
        export const StateDot = () => createElement('span', null, '○'), Tag = ({children, ...props}) => createElement('span', props, children), Tooltip = ({children}) => children;
        export const useAnchoredPosition = () => ({top: 75, right: 16}), useDismissOnOutsidePointer = () => {};`, loader: 'js', resolveDir: resolve('src') }));
      builder.onLoad({ filter: /TeamAction\.module\.css$/ }, async ({path}) => {
        const css = (await readFile(path, 'utf8')).replace(/\.([a-zA-Z]\w*)/g, '.host_$1');
        return { contents: `const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style); export default new Proxy({}, {get: (_, key) => 'host_' + key});`, loader: 'js' };
      });
    } }],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>:root{--dsw-alias-label-primary:#eee;--dsw-alias-label-tertiary:#aaa;--dsw-alias-bg-layer-2:#29292c;--dsw-specific-menu:#303034;--dsw-alias-border-l2:#555;--dsw-elevation-stroke:inset 0 0 0 1px #555;--dsw-elevation-prominent:0 0 0 1px #444}body{background:#1b1b1b;color:#eee;font:14px sans-serif;margin:20px}button{font:inherit}.host_headerActions{display:flex;justify-content:flex-end}</style><div id="root"></div>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('button', { name: '智能体团队' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.directoryRequests), []);
    const directory = page.locator('[data-hp-team-directory]');
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.getByRole('button', { name: '智能体团队' }).click();
      await expect(directory).toContainText('工作目录');
      await expect(directory).toContainText('long-project-name'.repeat(5));
      const layout = await directory.evaluate(node => {
        const label = node.firstElementChild, path = node.lastElementChild;
        return label && path ? {
          label: label.textContent,
          nowrap: getComputedStyle(label).whiteSpace,
          align: getComputedStyle(node).textAlign,
          singleLine: label.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 1,
          sameTop: Math.abs(label.getBoundingClientRect().top - path.getBoundingClientRect().top) < 1,
        } : null;
      });
      assert.deepEqual(layout, {label: '工作目录：', nowrap: 'nowrap', align: 'left', singleLine: true, sameTop: true});
      assert.equal(await directory.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      assert.equal(await page.locator('[data-team-panel]').evaluate(node => node.getBoundingClientRect().right <= innerWidth), true);
      await expect(page.locator('.host_member').filter({ hasText: 'worker' }).locator('[data-hp-team-directory]')).toHaveCount(0);
      await page.evaluate(cwd => window.renderTeam('session', cwd, true), resolve('.'));
      await expect(page.locator('.host_member')).toHaveCount(1);
      await expect(directory).toHaveText('工作目录：' + resolve('.'));
      await mkdir('.cache', { recursive: true });
      await page.locator('[data-team-panel]').screenshot({ path: resolve('.cache/team-directory-' + (width === 390 ? 'mobile' : 'desktop') + '.png') });
      await page.keyboard.press('Escape');
      await expect(directory).toHaveCount(0);
      await page.evaluate(() => window.renderTeam('session', '/Users/me/项目/很长的工作目录/' + 'long-project-name'.repeat(5)));
    }
    await page.evaluate(() => {
      window.lookup = async () => ({ok: true, value: {worker: {cwd: '/work/isolated-checkout'}}});
      window.renderTeam('worker', '/work/original');
    });
    await page.getByRole('button', { name: '智能体团队' }).click();
    await expect(directory).toHaveText('工作目录：/work/isolated-checkout');
    await expect(page.locator('.host_member').filter({ hasText: 'lead' }).locator('[data-hp-team-directory]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.lookup = async () => { throw new Error('offline'); }; window.renderTeam('worker', '/work/updated'); });
    await page.getByRole('button', { name: '智能体团队' }).click();
    await expect(directory).toHaveText('工作目录：/work/updated');
    await page.evaluate(() => window.renderTeam('worker', undefined));
    await expect(directory).toHaveText('工作目录：未连接工作目录');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.lookup = () => new Promise(resolve => { window.finishLookup = resolve; }); });
    await page.getByRole('button', { name: '智能体团队' }).click();
    await expect.poll(() => page.evaluate(() => typeof window.finishLookup)).toBe('function');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.lookup = async () => ({ok: true, value: {}}); window.renderTeam('session', '/work/new-session'); });
    await page.getByRole('button', { name: '智能体团队' }).click();
    await expect(directory).toHaveText('工作目录：/work/new-session');
    await page.evaluate(() => window.finishLookup({ok: true, value: {worker: {cwd: '/work/stale'}}}));
    await expect(directory).toHaveText('工作目录：/work/new-session');
    await page.evaluate(() => window.unmountTeam());
    await expect(directory).toHaveCount(0);
  } finally { await browser.close(); }
});
