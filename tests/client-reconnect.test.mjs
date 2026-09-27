import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Context, Service } from '@deepseek-ai/cordis';

test('the Add menu survives Remote replacement without calling the disposed client scope', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  let client;
  runInNewContext(await readFile('dist/client.js', 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(require); } } },
    document: { createElement: () => ({ remove() {} }), head: { append() {} } },
  });
  const ctx = new Context();
  class Commands extends Service {
    constructor(ctx) { super(ctx, 'commandUi'); this.matchSpace = () => 'existing-override'; }
    async candidates() { return [{ name: 'file' }, { name: 'compact' }]; }
    dispatch() { return 'handled'; }
    matchSpace() { return 'handled'; }
    async matchEnter() { return 'handled'; }
  }
  class Conversation extends Service {
    constructor(ctx) { super(ctx, 'conversation'); }
    async sendSession() { return { kind: 'success' }; }
  }
  class Remote extends Service {
    constructor(ctx) {
      super(ctx, 'remote');
      ctx.provide('remote.harness', { state: async () => ({ ok: true, value: { harness: 'codex' } }) });
      ctx.provide('remote.commands', {});
    }
    async $mount() { return () => {}; }
  }
  ctx.provide('locale', { register: () => () => {}, bind: () => key => key });
  try {
    await ctx.plugin(Commands);
    await ctx.plugin(Conversation);
    const originalSpace = Object.getOwnPropertyDescriptor(ctx.commandUi, 'matchSpace');
    let connection = ctx.plugin(Remote);
    await connection;
    const plugin = ctx.plugin({ inject: ['remote', 'locale'], apply: scope => client.apply(scope) });
    await plugin;
    const menu = async () => Array.from(await ctx.commandUi.candidates({ sessionId: 's1' }, { query: '' }), row => row.name);
    assert.deepEqual(await menu(), ['file', 'compact', 'delegate', 'discuss']);
    for (let reconnect = 0; reconnect < 3; reconnect++) {
      await connection.dispose();
      connection = ctx.plugin(Remote);
      await connection;
      await plugin.await();
      assert.deepEqual(await menu(), ['file', 'compact', 'delegate', 'discuss']);
    }
    await plugin.dispose();
    assert.deepEqual(await menu(), ['file', 'compact']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(ctx.commandUi, 'matchSpace'), originalSpace);
    for (const key of ['candidates', 'dispatch', 'matchEnter']) assert.equal(Object.hasOwn(ctx.commandUi, key), false);
    assert.equal(Object.hasOwn(ctx.conversation, 'sendSession'), false, 'task submission must also release its disposed scope');
  } finally { await ctx.fiber.dispose(); }
});
