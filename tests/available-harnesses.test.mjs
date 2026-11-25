import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import { AcpAdapter } from '../dist/acp-adapter.js';
import { antigravityProfile, claudeProfile, codexProfile } from '../dist/acp-profiles.js';
import { HarnessService, inject } from '../dist/dsh.js';
import { defaultSettings } from '../dist/settings.js';

async function touchExecutable(dir, name) {
  const file = join(dir, name);
  await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(file, 0o755);
  return file;
}

test('各 Harness Profile 的 isInstalled 实时反映本机可执行文件安装状态与配置变更', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-installed-'));
  const bin = join(root, 'bin');
  const localBin = join(root, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(localBin, { recursive: true });
  try {
    let settings = defaultSettings();
    const env = { HOME: root, PATH: bin, SHELL: '/bin/false' };
    const codex = new AcpAdapter({ profile: codexProfile({ environment: env, settings: () => settings }), environment: env });
    const claude = new AcpAdapter({ profile: claudeProfile({ environment: env, settings: () => settings }), environment: env });
    const agy = new AcpAdapter({ profile: antigravityProfile(() => settings, env), environment: env });

    assert.equal(codex.isInstalled(), false);
    assert.equal(claude.isInstalled(), false);
    assert.equal(agy.isInstalled(), false);

    await touchExecutable(bin, 'codex');
    assert.equal(codex.isInstalled(), true);
    settings = { ...settings, codexCommand: '/nonexistent/codex' };
    assert.equal(codex.isInstalled(), false);
    settings = { ...settings, codexCommand: 'codex' };
    assert.equal(codex.isInstalled(), true);

    await touchExecutable(localBin, 'reclaude');
    assert.equal(claude.isInstalled(), false, '默认仍查找原生 claude，未配置时不把 reclaude 当作已安装');
    settings = { ...settings, claudeCommand: 'reclaude' };
    assert.equal(claude.isInstalled(), true, '配置 claudeCommand=reclaude 后检测到 ~/.local/bin/reclaude');

    await touchExecutable(bin, 'agy');
    assert.equal(agy.isInstalled(), true);
    const customAgy = new AcpAdapter({ profile: antigravityProfile(() => settings, { ...env, AGY_BIN: '/nonexistent/agy' }), environment: env });
    assert.equal(customAgy.isInstalled(), false);
    const customAcp = new AcpAdapter({ profile: antigravityProfile(() => settings, { ...env, ANTIGRAVITY_ACP_PATH: join(bin, 'agy') }), environment: env });
    assert.equal(customAcp.isInstalled(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('后端仅暴露已安装的 Harness，跳过未安装默认项并从讨论模型目录排除未安装项', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-service-available-'));
  const ctx = new Context();
  const agents = {};
  const agent = id => agents[id] ??= {
    id, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { header: { cwd: root }, snapshotEvents: () => [] },
    followup() {},
  };
  class Commands extends Service {
    constructor(ctx) { super(ctx, 'sessionController'); }
    async resolveAgent(id) { return { agent: agent(id) }; }
    async prompt() {} async fork() {} async selectModel() {} updateQueue() {}
  }
  let settings = { ...defaultSettings(), defaultHarness: 'codex' };
  const installed = {
    isInstalled: () => true,
    inspect: async () => ({ status: 'ready', catalog: { models: [{ ref: { id: 'sonnet' }, label: 'Sonnet' }], thinkingOptions: [] }, capabilities: { configuration: { selectModel: true, selectThinkingOption: false, selectPermissionMode: false, permissionModeScope: 'live' }, history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false } } }),
    async close() {},
  };
  const missing = {
    isInstalled: () => false,
    inspect: async () => { assert.fail('未安装的 Harness 不应被探测'); },
    async close() {},
  };
  try {
    await ctx.plugin(Typert);
    await ctx.plugin(Commands);
    ctx.provide('agents', { get: agent });
    ctx.provide('sessions', { async flush() {} });
    ctx.provide('userQuestions', {});
    ctx.provide('attachments', { admitPromptContent: async content => content });
    ctx.provide('fileUploads', {});
    await ctx.plugin({ inject, apply(scope) { new HarnessService(scope, root, { codex: missing, 'claude-code': installed, antigravity: missing }, () => settings); } });
    const h = ctx.harness;

    assert.deepEqual(await h.availableHarnesses({}), ['dsh', 'claude-code']);
    assert.deepEqual(await h.managedHarnesses({}), [{ id: 'dsh', label: 'DSH 原生' }, { id: 'claude-code', label: 'Claude Code' }]);

    const freshState = await h.state({ sessionId: 'fresh' });
    assert.equal(freshState.harness, 'dsh', '默认 Harness 未安装时回退到 DSH 原生');
    assert.deepEqual(freshState.availableHarnesses, ['dsh', 'claude-code']);

    settings = { ...settings, defaultHarness: 'last' };
    await h.bindings.writeDefaults({ harness: 'antigravity' });
    assert.equal((await h.state({ sessionId: 'remembered-missing' })).harness, 'dsh', '上次记住的未安装 Harness 不自动绑定');

    const models = await h.delegationModels('fresh');
    assert.deepEqual(Object.keys(models), ['claude-code']);

    await assert.rejects(() => h.startDiscussionFromUser({ sessionId: 'fresh', requestId: 'disc-1', prompt: '分析', harnesses: ['codex'] }), /未安装/);
    await assert.rejects(() => h.delegate('fresh', { requestId: 'del-1', harness: 'antigravity', prompt: '实现' }), /未安装/);
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('输入栏菜单、设置页与委派/讨论面板均隐藏未安装的 Harness，并保留已绑定或已保存的当前项', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const nodePaths = [dirname(dirname(require.resolve('react/package.json'))), dirname(dirname(require.resolve('react-dom/package.json')))];
  const bundle = await build({
    stdin: {
      contents: `${await readFile('src/client.tsx', 'utf8')}
import { createRoot } from 'react-dom/client';
document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
const useSessions = pick => pick({ byId: {
  normal: { running: false, blank: true, retainedBy: { mainView: 1 } },
  legacy: { running: false, blank: false, retainedBy: { mainView: 0 } },
} });
const idle = async () => null;
const baseState = { locked: false, model: null, thinking: null, permission: null, configs: {}, linked: [], linkedPaths: [], recoveryRequired: false, rewindRecoveryToken: null, rewindableTurns: [], editableTurns: [], supersededTurns: [] };
const states = {
  normal: { ...baseState, harness: 'dsh', availableHarnesses: ['dsh', 'claude-code'] },
  legacy: { ...baseState, harness: 'antigravity', availableHarnesses: ['dsh', 'claude-code'] },
};
const t = key => zh[key] ?? key;
const initialSettings = { ...${JSON.stringify(defaultSettings())}, defaultHarness: 'codex', delegateHarnesses: ['codex'], discussHarnesses: ['codex', 'claude-code'] };
window.settingsWrites = [];
function App() {
  const [snapshot, setSnapshot] = useState({ status: 'ready', value: initialSettings, writable: true, user: {} });
  const form = {
    set: async (field, value) => {
      window.settingsWrites.push([field, value]);
      setSnapshot(cur => ({ ...cur, value: { ...cur.value, [field]: value }, user: { ...cur.user, [field]: value } }));
      return true;
    },
    unset: async field => true,
  };
  return <div style={{ display: 'grid', gap: 28 }}>
    <div id="composer-normal" style={{ paddingTop: 140 }}>
      <HarnessSelect sessionId="normal" useSessions={useSessions} read={async id => states[id]} select={async (id, harness) => (states[id] = { ...states[id], harness })}
        quota={idle} viewing={idle} modelProvider={() => null} changed={() => {}} subscribe={() => () => {}} secretStatus={idle} answerSecret={idle} recover={idle} confirmRewind={idle} t={t} />
    </div>
    <div id="composer-legacy" style={{ paddingTop: 140 }}>
      <HarnessSelect sessionId="legacy" useSessions={useSessions} read={async id => states[id]} select={async (id, harness) => (states[id] = { ...states[id], harness })}
        quota={idle} viewing={idle} modelProvider={() => null} changed={() => {}} subscribe={() => () => {}} secretStatus={idle} answerSecret={idle} recover={idle} confirmRewind={idle} t={t} />
    </div>
    <div id="dock-delegate">
      <DelegationDockActive sessionId="dock-d" t={t} />
    </div>
    <div id="dock-discuss">
      <DiscussionDockActive sessionId="dock-c" t={t} />
    </div>
    <div id="settings-host">
      <HarnessSettingsSection useHarnessSettings={pick => pick(snapshot)} form={form} loadAvailableHarnesses={async () => ['dsh', 'claude-code']} t={t} />
    </div>
  </div>;
}
window.setOnlyNative = () => setKnownAvailableHarnesses(['dsh']);
createRoot(document.querySelector('#root')).render(<App />);`,
      resolveDir: resolve('src'), loader: 'tsx',
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths, logLevel: 'warning',
    external: ['@deepseek-ai/dsh-client-ui-primitives'],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 1100 } });
    await page.setContent('<style>:root{--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#bbb;--dsw-alias-label-tertiary:#999;--dsw-alias-border-l2:#333;--dsw-alias-border-l4:#555;--dsw-alias-bg-layer-3:#29292c;--dsw-alias-interactive-bg-hover:#262629;--dsw-specific-menu:#2c2c30}body{margin:24px;background:#1b1b1b;color:#eee;font:14px sans-serif}</style><div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });

    // 1. 普通会话下拉只展示 DSH 原生和已安装的 Claude Code
    const normalChip = page.locator('#composer-normal button.hp-chip');
    await expect(normalChip).toBeEnabled();
    await normalChip.click();
    assert.deepEqual(await page.locator('#composer-normal [role="menuitemradio"]').allTextContents(), ['DSH 原生', 'Claude Code']);
    await mkdir('.cache', { recursive: true });
    await page.locator('#composer-normal').screenshot({ path: resolve('.cache/available-harnesses-menu.png') });
    await normalChip.click();

    // 2. 已有绑定未安装项的会话保留当前项
    const legacyChip = page.locator('#composer-legacy button.hp-chip');
    await expect(legacyChip).toHaveText('Antigravity');
    await legacyChip.click();
    assert.deepEqual(await page.locator('#composer-legacy [role="menuitemradio"]').allTextContents(), ['DSH 原生', 'Claude Code', 'Antigravity']);
    await legacyChip.click();

    // 3. 委派与讨论面板隐藏未安装项并过滤默认选中值
    assert.deepEqual(await page.locator('#dock-delegate [role="checkbox"]').allTextContents(), ['DSH 原生', 'Claude Code']);
    await expect(page.locator('#dock-delegate [role="checkbox"]', { hasText: 'Claude Code' })).toHaveAttribute('aria-checked', 'true');
    assert.deepEqual(await page.locator('#dock-discuss [role="checkbox"]').allTextContents(), ['DSH 原生', 'Claude Code']);
    await expect(page.locator('#dock-discuss [role="checkbox"]', { hasText: 'Claude Code' })).toHaveAttribute('aria-checked', 'true');

    // 4. 设置页只展示已安装的选项，但保留已保存的未安装 defaultHarness
    const select = page.locator('#settings-host').getByRole('combobox', { name: '新会话默认 Harness' });
    await expect(select).toHaveValue('codex');
    assert.deepEqual(await select.locator('option').allTextContents(), ['沿用上次选择', 'DSH 原生', 'Claude Code', 'Codex']);
    const delegateRow = page.locator('#settings-host .hp-set-row').filter({ hasText: '委派默认目标' });
    const discussRow = page.locator('#settings-host .hp-set-row').filter({ hasText: '讨论默认参与者' });
    assert.deepEqual(await delegateRow.getByRole('checkbox').allTextContents(), ['DSH 原生', 'Claude Code']);
    assert.deepEqual(await discussRow.getByRole('checkbox').allTextContents(), ['DSH 原生', 'Claude Code']);
    await page.locator('#settings-host').screenshot({ path: resolve('.cache/available-harnesses-settings.png') });

    // 5. 当没有任何外部 Harness 安装时，委派回退 DSH 原生，讨论展示提示
    await page.evaluate(() => window.setOnlyNative());
    assert.deepEqual(await page.locator('#dock-delegate [role="checkbox"]').allTextContents(), ['DSH 原生']);
    await expect(page.locator('#dock-delegate [role="checkbox"]', { hasText: 'DSH 原生' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#dock-discuss')).toContainText('未检测到已安装的外部 Harness');
  } finally {
    await browser.close();
  }
});
