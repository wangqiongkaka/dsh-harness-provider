import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import { HarnessService, inject } from '../dist/dsh.js';
import { dshModelId } from '../dist/claude-dsh-models.js';
import * as quota from '../dist/native-quota.js';

test('账户钱包按币种精确合计充值与赠送金额，失败时不伪造零余额', () => {
  const parse = quota.parseAccountBalance;
  const value = parse({ status: 'ready', value: [{ currency: 'USD', balance: '0E-16' }, { currency: 'CNY', balance: '0.1' }],
    bonusWallets: [{ currency: 'CNY', balance: '0.2' }] }, 'deepseek-account');
  assert.deepEqual(value, { kind: 'balance', source: 'deepseek-account', currency: 'CNY', total: '0.30', granted: '0.20', toppedUp: '0.10' });
  assert.equal(parse({ status: 'ready', value: [{ currency: 'USD', balance: '1e-8' }], bonusWallets: [] }, 'account').total, '0.00000001');
  assert.equal(parse({ status: 'failed' }, 'account'), null);
  assert.equal(parse(null, 'account'), null);
  assert.throws(() => parse({ status: 'ready', value: [{ currency: 'CNY', balance: 'not-money' }], bonusWallets: [] }, 'account'));
});

test('外部模型按所选服务商读取订阅窗口或余额，独立账户不混用原生会话及 Claude 额度', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-quota-')), ctx = new Context();
  const providers = ['zai-coding-cn', 'deepseek-official', 'deepseek-account', 'unknown'];
  const models = providers.map(provider => ({ ref: { id: dshModelId(provider, 'model') }, label: provider, supportedThinkingOptionIds: [] }));
  const agent = { id: 'source', status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { header: { cwd: root }, snapshotEvents: () => [],
    requestHeader: () => ({ config: { provider: 'wrong-provider' } }) } };
  class Commands extends Service { constructor(ctx) { super(ctx, 'sessionController'); } async resolveAgent() { return { agent }; }
    async prompt() {} async fork() {} async selectModel() {} updateQueue() {} }
  const requests = [], balances = [], secrets = { DS_KEY: 'fixture-ds', ZAI_KEY: 'fixture-zai' };
  let nativeProbes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([String(url), options.headers.Authorization]);
    return new Response(JSON.stringify(String(url).includes('quota/limit') ? { data: { limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 23 }, { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 47 },
    ] } } : { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.30', granted_balance: '0', topped_up_balance: '12.30' }] }));
  });
  const adapter = { async close() {}, async inspect() { return { status: 'ready', capabilities: {}, catalog: { models, thinkingOptions: [] } }; },
    async inspectAccount() { nativeProbes++; return null; } };
  try {
    await ctx.plugin(Typert); await ctx.plugin(Commands);
    for (const name of ['sessions', 'userQuestions', 'attachments', 'fileUploads']) ctx.provide(name, {});
    ctx.provide('agents', { get: () => agent });
    ctx.provide('llm', { listConfigurableProviders: () => providers.map(provider => ({ provider, settingsNs: 'models', settingsPath: [provider] })) });
    ctx.provide('settings', { describe: () => [{ ns: 'models', value: { 'zai-coding-cn': { apiKeyEnv: 'ZAI_KEY' }, 'deepseek-official': { apiKeyEnv: 'DS_KEY' } } }] });
    ctx.provide('credentials', { resolve: async ref => ({ value: secrets[ref] }) });
    ctx.provide('deepseekAccount', { async getBalance(client) { balances.push(client); return { status: 'ready', value: [{ currency: 'CNY', balance: '4.10' }], bonusWallets: [{ currency: 'CNY', balance: '0.20' }] }; } });
    await ctx.plugin({ inject, apply(scope) { new HarnessService(scope, root, { codex: adapter, 'claude-code': adapter }); } });
    const h = ctx.harness;
    await h.select({ sessionId: 'source', harness: 'claude-code' });
    const select = async provider => { await h.selectModel({ sessionId: 'source', model: dshModelId(provider, 'model') }); return h.quota({ sessionId: 'source' }); };
    const subscription = await select('zai-coding-cn');
    await h.refreshHarnessQuota('source');
    assert.equal(nativeProbes, 0);
    assert.deepEqual(subscription.windows.map(window => [window.id, window.usedPercent]), [['five_hour', 23], ['seven_day', 47]]);
    assert.equal((await select('deepseek-official')).total, '12.30');
    await h.quota({ sessionId: 'source' });
    assert.equal(requests.length, 2);
    secrets.DS_KEY = 'fixture-new-account';
    await h.quota({ sessionId: 'source' });
    assert.equal(requests.length, 3);
    assert.equal(requests.at(-1)[1], 'Bearer fixture-new-account');
    assert.equal((await select('deepseek-account')).total, '4.30');
    assert.equal(balances.length, 1);
    assert.ok(balances[0].version);
    assert.equal(await select('unknown'), null);
    assert.equal(nativeProbes, 0);
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});
