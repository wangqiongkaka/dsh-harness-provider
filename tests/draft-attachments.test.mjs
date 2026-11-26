import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Context, Service } from '@deepseek-ai/cordis';

// The host keeps an unsent composer image only as long as its session scope lives, and releases every draft
// attachment the moment the last session reference goes (a sidebar switch to another session). The plugin holds
// its own reference on sessions whose draft still has attachments, so this fake reproduces exactly that rule:
// zero references, and the session's draft attachments are gone.
function fakeHost() {
  const listeners = { sessions: new Set(), workspaces: new Set() };
  const state = {
    drafts: new Map(), // id -> attachments still in the composer
    refs: new Map(), // id -> Map<source, count>
    archived: new Set(),
    main: undefined, // the session the main view retains
  };
  const notify = (name) => { for (const listener of listeners[name]) listener(); };
  const count = (id) => [...(state.refs.get(id)?.values() ?? [])].reduce((sum, n) => sum + n, 0);
  // The one host rule this is about: the session scope dies with its last reference, and its input shell
  // (the editor state and every draft attachment it holds) is disposed with it.
  const reconcile = (id) => {
    if ((state.refs.get(id)?.size ?? 0) === 0) {
      state.refs.delete(id);
      if (state.drafts.get(id)?.length) state.drafts.set(id, []);
    }
  };
  const setRefs = (id, source, n) => {
    const sources = state.refs.get(id) ?? new Map();
    if (n === 0) sources.delete(source); else sources.set(source, n);
    if (sources.size === 0) state.refs.delete(id); else state.refs.set(id, sources);
    reconcile(id);
  };
  // Like the host's input shell: reading its attachment ids yields [] once its scope was disposed.
  const attachmentsOf = (id) => state.drafts.get(id) ?? [];
  const classOf = (name, extra) => class extends Service {
    constructor(ctx) { super(ctx, name); Object.assign(this, extra); }
  };
  const sessions = classOf('sessions', {
    list: {
      getSnapshot: () => ({ ids: [...state.drafts.keys()], byId: Object.fromEntries([...state.drafts].map(([id]) => [id, { id }])) }),
      subscribe: (listener) => { listeners.sessions.add(listener); return () => listeners.sessions.delete(listener); },
    },
    binding: (id) => count(id) > 0 ? { sessionId: id, ctx: { id } } : undefined,
    retainInfo: (id) => ({ getSnapshot: () => ({ referenceCount: count(id), retainedBy: Object.fromEntries(state.refs.get(id) ?? []) }) }),
    retain: (id, { source }) => {
      const sources = state.refs.get(id) ?? new Map();
      sources.set(source, (sources.get(source) ?? 0) + 1);
      state.refs.set(id, sources);
      notify('sessions');
      return { sessionId: id, release() { const sources = state.refs.get(id); if (!sources?.has(source)) return; setRefs(id, source, sources.get(source) - 1); notify('sessions'); } };
    },
  });
  const workspaces = classOf('workspaces', {
    list: {
      getSnapshot: () => ({ archivedSessionIds: [...state.archived] }),
      subscribe: (listener) => { listeners.workspaces.add(listener); return () => listeners.workspaces.delete(listener); },
    },
  });
  const conversation = classOf('conversation', {
    input: { for: (actx) => ({ state: { getSnapshot: () => ({ attachmentIds: attachmentsOf(actx.id) }) } }) },
  });
  return {
    sessions, workspaces, conversation,
    // The main view's own reference, as the host's navigation holds it: one session at a time.
    view(id) {
      if (state.main && state.main !== id) { setRefs(state.main, 'mainView', 0); notify('sessions'); }
      state.main = id;
      if (count(id) === 0) state.drafts.set(id, state.drafts.get(id) ?? []);
      if (!state.refs.get(id)?.has('mainView')) setRefs(id, 'mainView', 1);
      notify('sessions');
    },
    session(id) { if (!state.drafts.has(id)) state.drafts.set(id, []); notify('sessions'); },
    add(id, ...names) { state.drafts.set(id, [...attachmentsOf(id), ...names]); notify('sessions'); },
    remove(id, name) { state.drafts.set(id, attachmentsOf(id).filter((value) => value !== name)); notify('sessions'); },
    // Like the host: archiving closes the session, and its unsent draft attachments end with it.
    archive(id) { state.archived.add(id); state.drafts.set(id, []); notify('workspaces'); },
    unarchive(id) { state.archived.delete(id); notify('workspaces'); },
    attachmentsOf,
    heldBy: (id) => Object.fromEntries(state.refs.get(id) ?? []),
  };
}

async function start(host) {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  let client;
  let tick; // the plugin's low-frequency read, run on demand
  runInNewContext(await readFile('dist/client.js', 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(require); } } },
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { append() {} }, addEventListener() {}, removeEventListener() {} },
    setInterval: (run) => { tick = run; return 1; }, clearInterval() {},
  });
  const ctx = new Context();
  ctx.provide('locale', { register: () => () => {}, bind: () => key => key });
  ctx.provide('remote', { $mount: async () => () => {} });
  await ctx.plugin(host.sessions);
  await ctx.plugin(host.workspaces);
  await ctx.plugin(host.conversation);
  const plugin = ctx.plugin({ inject: ['remote', 'locale'], apply: (scope) => client.apply(scope) });
  await plugin;
  // A failed inject scope must fail the test instead of silently skipping the behaviour under test.
  const failed = [...ctx.registry.values?.() ?? []];
  assert.notEqual(plugin.state, 'failed', `the client plugin must start; cordis recorded: ${JSON.stringify(String(failed[0] ?? ''))}`);
  return { ctx, plugin, tick: () => tick() };
}

test('an unsent image survives switching to another session and back, per session and in order', async () => {
  const host = fakeHost();
  host.session('a'); host.session('b');
  const { ctx } = await start(host);
  try {
    host.view('a');
    host.add('a', 'one.png');
    host.add('a', 'two.png');
    // The sidebar opens session b: the main view drops a.
    host.view('b');
    assert.deepEqual(host.attachmentsOf('a'), ['one.png', 'two.png'], 'a keeps its unsent images while another session is open');
    host.add('b', 'bee.png');
    assert.deepEqual(host.attachmentsOf('b'), ['bee.png']);
    host.view('a');
    assert.deepEqual(host.attachmentsOf('a'), ['one.png', 'two.png']);
    // Each session keeps its own images across a three-way hop.
    host.view('b');
    host.session('c');
    host.view('c');
    host.view('a');
    assert.deepEqual(host.attachmentsOf('a'), ['one.png', 'two.png']);
    host.view('b');
    assert.deepEqual(host.attachmentsOf('b'), ['bee.png']);
  } finally { await ctx.fiber.dispose(); }
});

test('the plugin lets go once the draft has no attachments left: sent, removed, or archived', async () => {
  const host = fakeHost();
  host.session('a'); host.session('b');
  const { ctx } = await start(host);
  try {
    host.view('a');
    host.add('a', 'one.png');
    assert.deepEqual(host.heldBy('a'), { mainView: 1, harnessDraftAttachments: 1 });
    // Removed by hand while the session is open.
    host.remove('a', 'one.png');
    assert.deepEqual(host.heldBy('a'), { mainView: 1 }, 'an emptied draft releases the plugin reference at once');
    // Left open on another session: the main view drops a, the plugin alone keeps it, until the image is sent.
    host.add('a', 'two.png');
    host.view('b');
    assert.deepEqual(host.heldBy('a'), { harnessDraftAttachments: 1 }, 'a session that is not open is retained by the plugin alone');
    host.remove('a', 'two.png');
    assert.deepEqual(host.heldBy('a'), {}, 'once the last image leaves the draft the session is no longer retained');
    // Archiving a session that still holds an image ends the draft and releases the reference.
    host.add('a', 'three.png');
    host.archive('a');
    assert.deepEqual(host.heldBy('a'), {}, 'an archived session is never retained for its draft');
    assert.deepEqual(host.attachmentsOf('a'), [], 'the archive ends the unsent draft');
    // A session archived while it is open keeps the main view's reference and gains none from the plugin.
    host.unarchive('a');
    host.view('a');
    host.add('a', 'four.png');
    assert.deepEqual(host.heldBy('a'), { mainView: 1, harnessDraftAttachments: 1 });
    host.archive('a');
    assert.deepEqual(host.heldBy('a'), { mainView: 1 }, 'archiving releases the plugin reference and leaves the main view alone');
    host.unarchive('a');
    host.add('a', 'five.png');
    assert.deepEqual(host.heldBy('a'), { mainView: 1, harnessDraftAttachments: 1 }, 'an unarchived session is held again for its new draft');
    host.remove('a', 'five.png');
    assert.deepEqual(host.heldBy('a'), { mainView: 1 }, 'and let go again once that image leaves the draft');
  } finally { await ctx.fiber.dispose(); }
});

test('disposing the plugin releases every reference it holds', async () => {
  const host = fakeHost();
  host.session('a');
  const { ctx, plugin } = await start(host);
  try {
    host.view('a');
    host.add('a', 'one.png');
    host.view('b');
    assert.equal(host.heldBy('a')?.harnessDraftAttachments, 1);
    await plugin.dispose();
    assert.deepEqual(host.heldBy('a'), {}, 'a plugin reload must not leave sessions retained');
  } finally { await ctx.fiber.dispose(); }
});
