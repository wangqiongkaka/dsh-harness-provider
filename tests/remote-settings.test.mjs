import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

// The built client entry against fake services: `configForms` in the page's persistence mode and the Harness RPC.
async function load({ mode, view, update }) {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  let client;
  runInNewContext(await readFile('dist/client.js', 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(require); } } },
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { append() {} }, body: {}, querySelectorAll: () => [] },
    MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setInterval: () => 1, clearInterval() {},
  });
  const registered = [], served = [], reads = [], writes = [], remoteEvents = {}, events = {};
  const slots = { inject: (_name, register) => register(), register(options, component) { registered.push({ options, component }); return () => {}; } };
  const hostForm = { getSnapshot: () => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode }),
    subscribe: () => () => {}, set: async () => false, unset: async () => false, mutate: async () => false };
  const configForms = { get: () => hostForm, whileServed(namespaces, register) { served.push(namespaces); return register(new Set(namespaces)); } };
  const harness = {
    async readSettings(request) { reads.push(request); return { ok: true, value: view() }; },
    async updateSettings(request) { writes.push(request); return { ok: true, value: update(request) }; },
  };
  const remote = { harness, async $mount() { return () => {}; }, $on(name, listener) { remoteEvents[name] = listener; return () => {}; } };
  const scope = { slots, configForms, remote, effect(fn) { fn(); }, on(name, listener) { events[name] = listener; return () => {}; } };
  await client.apply({ remote, locale: { register: () => () => {}, bind: () => key => key }, effect(fn) { fn(); }, on() { return () => {}; },
    inject(keys, apply) { if (keys.includes('configForms')) apply(scope); } });
  await new Promise(resolve => setImmediate(resolve));
  return { hostForm, registered, served, reads, writes, remoteEvents, events, section: () => registered.find(entry => entry.options.name === 'settings.section') };
}

test('a memory-mode page (phone through the remote proxy) edits the Harness settings through the plugin RPC', async () => {
  let current = { value: { idleCloseSeconds: 30, delegateReportBack: false }, user: { idleCloseSeconds: 30 }, revision: 3, writable: true };
  const page = await load({ mode: 'memory', view: () => current,
    update: ({ ops, revision }) => revision === current.revision ? (current = { ...current, value: { ...current.value, [ops[0].path[0]]: ops[0].value }, revision: revision + 1 }) : null });
  assert.equal(page.served.length, 0, 'the Host form never serves a memory page');
  const section = page.section();
  assert.ok(section, 'the Harness section is registered');
  assert.equal(section.options.id, 'harness');
  const { form, hooks } = section.options.inject();
  assert.equal(hooks.harnessSettings, form);
  assert.notEqual(form, page.hostForm);
  const before = form.getSnapshot();
  assert.equal(form.getSnapshot(), before, 'the snapshot is one reference between changes');
  assert.deepEqual(JSON.parse(JSON.stringify(before)), { status: 'ready', value: current.value, user: { idleCloseSeconds: 30 }, revision: 3, writable: true, mode: 'memory' });
  let notified = 0;
  form.subscribe(() => notified++);
  // Two rapid writes: each carries the revision the previous one produced.
  const [first, second] = await Promise.all([form.set('delegateReportBack', true), form.set('idleCloseSeconds', 45)]);
  assert.equal(first, true); assert.equal(second, true);
  assert.deepEqual(page.writes.map(write => write.revision), [3, 4]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.writes[0].ops)), [{ op: 'set', path: ['delegateReportBack'], value: true }]);
  const after = form.getSnapshot();
  assert.notEqual(after, before); assert.equal(after.value.delegateReportBack, true); assert.equal(after.value.idleCloseSeconds, 45); assert.equal(after.revision, 5);
  assert.ok(notified >= 2);
  // A refused write re-reads the Host and reports false.
  const reads = page.reads.length;
  current = { ...current, revision: 9 };
  const stale = { ...form.getSnapshot() };
  assert.equal(await form.mutate([{ op: 'unset', path: ['idleCloseSeconds'] }], 1), false);
  assert.equal(page.reads.length, reads + 1); assert.equal(form.getSnapshot().revision, 9); assert.notEqual(stale.revision, 9);
  // Another client's write and a reconnect both re-read.
  assert.equal(typeof page.remoteEvents['settings/document-updated'], 'function');
  page.remoteEvents['settings/document-updated']('other-plugin', 1);
  page.remoteEvents['settings/document-updated']('harness-plugin', 10);
  page.events['connection/reset']();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.reads.length, reads + 3);
});

test('a memory-mode page without the plugin namespace shows no Harness section', async () => {
  const page = await load({ mode: 'memory', view: () => null, update: () => assert.fail('no writes') });
  assert.equal(page.reads.length, 1);
  assert.equal(page.section(), undefined);
  assert.equal(page.served.length, 0);
});

test('a host-mode page keeps the Host settings form and never calls the plugin RPC', async () => {
  const page = await load({ mode: 'host', view: () => assert.fail('host pages use the Host form'), update: () => assert.fail('host pages use the Host form') });
  assert.deepEqual(page.served.map(namespaces => [...namespaces]), [['harness-plugin']]);
  const { form, hooks } = page.section().options.inject();
  assert.equal(form, page.hostForm); assert.equal(hooks.harnessSettings, page.hostForm);
  assert.equal(page.reads.length, 0);
});
