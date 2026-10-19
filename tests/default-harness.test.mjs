import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import { HarnessService, inject } from '../dist/dsh.js';
import { Bindings } from '../dist/bindings.js';
import { Config, defaultSettings, settingsOf } from '../dist/settings.js';

test('新会话默认 Harness 配置保留沿用上次，并校验可选值', () => {
  assert.equal(defaultSettings().defaultHarness, 'last');
  for (const defaultHarness of ['last', 'dsh', 'codex', 'claude-code']) {
    assert.equal(settingsOf(Config({ defaultHarness }))().defaultHarness, defaultHarness);
  }
  assert.ok(Config['~standard'].validate({ defaultHarness: 'invalid' }).issues?.length);
});

test('固定默认 Harness 仅初始化新会话，手动选择和冷恢复保持，配置修改对后续会话生效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-default-harness-')), ctx = new Context();
  const agents = {};
  const agent = id => agents[id] ??= { id, status: 'idle', inbox: {nextTurn: [], nextStep: []},
    session: { header: {cwd: root}, snapshotEvents: () => [] } };
  class Commands extends Service {
    constructor(ctx) { super(ctx, 'sessionController'); }
    async resolveAgent(id) { return {agent: agent(id)}; }
    async prompt() {} async fork() {} async selectModel() {} updateQueue() {}
  }
  let settings = {...defaultSettings(), defaultHarness: 'codex'};
  const adapter = { async close() {} };
  try {
    await ctx.plugin(Typert); await ctx.plugin(Commands);
    ctx.provide('agents', {get: agent}); ctx.provide('sessions', {}); ctx.provide('userQuestions', {});
    ctx.provide('attachments', {}); ctx.provide('fileUploads', {});
    await ctx.plugin({inject, apply(scope) { new HarnessService(scope, root, {codex: adapter, 'claude-code': adapter}, () => settings); }});
    const h = ctx.harness, state = async id => (await h.state({sessionId: id})).harness;
    await h.bindings.writeDefaults({harness: 'claude-code'});
    assert.equal(await state('fixed'), 'codex', '配置优先于上次选择');
    await h.select({sessionId: 'fixed', harness: 'dsh'});
    h.bindings = new Bindings(root);
    assert.equal(await state('fixed'), 'dsh', '显式 DSH 选择在冷恢复后保留');
    assert.equal(await h.bindings.read('fixed'), undefined, 'DSH 选择不变成外部绑定');
    assert.deepEqual(await h.bindings.delegated(), [], '普通 DSH 选择不被视为委派');
    assert.equal(await state('next'), 'codex', '单次选择不改变固定默认值');
    await Promise.all([state('racing'), h.select({sessionId: 'racing', harness: 'dsh'})]);
    assert.equal(await state('racing'), 'dsh', '并发初始化不覆盖手动选择');
    await h.select({sessionId: 'fixed', harness: 'claude-code'});
    assert.equal(await state('fixed'), 'claude-code', '显式选择外部 Harness 后保持');
    settings = {...settings, defaultHarness: 'dsh'};
    assert.equal(await state('native-default'), 'dsh');
    settings = {...settings, defaultHarness: 'claude-code'};
    assert.equal(await state('claude-default'), 'claude-code');
    assert.equal(await state('next'), 'codex', '配置变化不覆盖已有外部绑定');
    assert.equal(await state('native-default'), 'dsh', '配置变化不覆盖已初始化的原生会话');
    agent('started').session.snapshotEvents = () => [{type: 'user/message'}];
    assert.equal(await state('started'), 'dsh', '已开始的原生会话保持');
    agent('no-directory').session.header.cwd = undefined;
    assert.equal(await state('no-directory'), 'dsh', '无目录时不创建外部绑定');
    settings = {...settings, defaultHarness: 'last'};
    await h.bindings.writeDefaults({harness: 'codex'});
    assert.equal(await state('remembered'), 'codex');
    await h.bindings.writeDefaults({harness: 'dsh'});
    assert.equal(await state('remembered-native'), 'dsh');
    await h.bindings.writeDefaults({});
    assert.equal(await state('no-history'), 'dsh');
  } finally { await ctx.fiber.dispose(); await rm(root, {recursive: true, force: true}); }
});

test('默认 Harness 设置在手机和桌面可编辑、恢复默认，并遵守只读状态', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const bundle = await build({stdin: {contents: await readFile('src/client.tsx', 'utf8') + `
import {createRoot} from 'react-dom/client';
document.head.append(Object.assign(document.createElement('style'), {textContent: styles}));
const initial = ${JSON.stringify(defaultSettings())};
window.writes = [];
function App() {
  const [snapshot, setSnapshot] = useState({status: 'ready', value: initial, writable: true, user: {}});
  window.readonly = () => setSnapshot(current => ({...current, writable: false}));
  const form = {set: async (field, value) => { window.writes.push([field, value]); setSnapshot(current => ({...current, value: {...current.value, [field]: value}, user: {...current.user, [field]: value}})); return true; },
    unset: async field => { setSnapshot(current => ({...current, value: {...current.value, [field]: initial[field]}, user: {}})); return true; }};
  return <HarnessSettingsSection useHarnessSettings={pick => pick(snapshot)} form={form} t={key => zh[key] ?? key} />;
}
createRoot(document.querySelector('#root')).render(<App />);
`, resolveDir: resolve('src'), loader: 'tsx'}, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: {react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'), 'react-dom': require.resolve('react-dom'), 'react-dom/client': require.resolve('react-dom/client')},
    external: ['@deepseek-ai/dsh-client-ui-primitives']});
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent('<style>:root{--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#bbb;--dsw-alias-label-tertiary:#999;--dsw-alias-border-l2:#333;--dsw-alias-border-l4:#555;--dsw-alias-bg-layer-3:#29292c}body{margin:24px;background:#1b1b1b;color:#eee;font:14px sans-serif}</style><div id="root"></div>');
    await page.addScriptTag({content: bundle.outputFiles[0].text});
    const select = page.getByRole('combobox', {name: '新会话默认 Harness'});
    await expect(select).toHaveValue('last');
    assert.deepEqual(await select.locator('option').allTextContents(), ['沿用上次选择', 'DSH 原生', 'Codex', 'Claude Code']);
    for (const width of [390, 1280]) {
      await page.setViewportSize({width, height: 850});
      await select.selectOption('codex');
      await expect(select).toHaveValue('codex');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mkdir('.cache', {recursive: true});
      await page.screenshot({path: resolve('.cache/default-harness-' + (width === 390 ? 'mobile' : 'desktop') + '.png')});
      await page.locator('.hp-set-row').filter({has: select}).getByRole('button', {name: '恢复默认'}).click();
      await expect(select).toHaveValue('last');
    }
    await select.selectOption('claude-code');
    assert.deepEqual(await page.evaluate(() => window.writes.at(-1)), ['defaultHarness', 'claude-code']);
    await page.evaluate(() => window.readonly());
    await expect(select).toBeDisabled();
  } finally { await browser.close(); }
});
