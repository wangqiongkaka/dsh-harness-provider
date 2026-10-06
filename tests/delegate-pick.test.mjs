import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

/** Runs `run` on a page holding the client bundle with the dock's pick components exported. */
async function withDock(run, { touch = false } = {}) {
 const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const nodePaths = [dirname(dirname(require.resolve('react/package.json'))), dirname(dirname(require.resolve('react-dom/package.json')))];
 const bundle = await build({
  stdin: { contents: `${await readFile('src/client.tsx', 'utf8')}\nexport { DelegatePick, DelegateProject, QuotaChip, setLinkPanel, trackTyping, styles };\nexport { createRoot } from 'react-dom/client';\nexport { createElement } from 'react';`, resolveDir: resolve('src'), loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'HarnessProvider', jsx: 'automatic', nodePaths, logLevel: 'warning',
 });
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await (touch ? await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 800 } }) : browser).newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await run(page);
 } finally { await browser.close(); }
}

// The delegation dock's chip reads "默认" without loading anything; opening it shows which model and effort that default is.
test('opening the delegation pick shows the model and effort its default resolves to', () => withDock(async page => {
  await page.evaluate(() => {
   const { createElement, createRoot, DelegatePick } = window.HarnessProvider;
   const words = { pickDefault: '默认', menuModel: '模型', menuEffort: '强度', 'effort.low': '低', 'effort.high': '高' };
   // `fast` is the default and offers only low effort.
   const catalog = { models: [{ id: 'fast', label: 'Fast', resolved: null, thinkingOptionIds: ['low'] }, { id: 'deep', label: 'Deep', resolved: null, thinkingOptionIds: null }],
    defaultModel: { id: 'fast', label: 'Fast', resolved: null }, thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultThinkingOptionId: 'low',
    permissionModes: [], defaultPermissionModeId: null, configOptions: [], error: null };
   createRoot(document.getElementById('root')).render(createElement(DelegatePick, { harness: 'codex', pick: {}, load: async () => catalog, disabled: false, onChange() {}, t: key => words[key] ?? key }));
  });
  const chip = page.getByRole('button', { name: 'pickModel' });
  await chip.waitFor();
  assert.equal((await chip.textContent()).trim(), 'Codex · 默认');
  await chip.click();
  const cells = page.locator('.hp-cell-value');
  await page.waitForFunction(() => document.querySelector('.hp-cell-value')?.textContent === '默认 · Fast', undefined, { timeout: 5_000 });
  assert.deepEqual(await cells.allTextContents(), ['默认 · Fast', '默认 · 低']);
  await page.locator('.hp-cell').first().click();
  assert.equal(await page.locator('.hp-option').first().textContent(), '默认Fast');
  await page.locator('.hp-cell').first().click();
  await page.locator('.hp-cell').nth(1).click();
  // Only the default model's effort levels are offered.
  assert.deepEqual(await page.locator('.hp-option-name').allTextContents(), ['默认', '低']);
  assert.equal(await page.locator('.hp-option-hint').first().textContent(), '低');
}));

// The project chip names the session's own project until another is picked; the list is read only when the menu opens.
test('the delegation project menu lists the other projects and reports the pick', () => withDock(async page => {
  await page.evaluate(() => {
   const { createElement, createRoot, DelegateProject } = window.HarnessProvider;
   const words = { project: '项目', projectCurrent: '当前项目' };
   window.reads = 0; window.picked = [];
   const load = async () => { window.reads++; return [{ id: 'here', title: 'work', path: '/code/work', current: true }, { id: 'there', title: 'dsh-harness-provider', path: '/code/dsh-harness-provider', current: false }]; };
   const root = createRoot(document.getElementById('root'));
   const render = workspaceId => root.render(createElement(DelegateProject, { workspaceId, load, disabled: false, onChange(next) { window.picked.push(next); render(next); }, t: key => words[key] ?? key }));
   render();
  });
  const chip = page.getByRole('button', { name: 'pickProject' });
  await chip.waitFor();
  assert.equal((await chip.textContent()).trim(), '项目 · 当前项目');
  assert.equal(await page.evaluate(() => window.reads), 0);
  await chip.click();
  await page.locator('.hp-option').first().waitFor();
  assert.deepEqual(await page.locator('.hp-option-name').allTextContents(), ['当前项目', 'dsh-harness-provider']);
  assert.deepEqual(await page.locator('.hp-option-hint').allTextContents(), ['work', '/code/dsh-harness-provider']);
  await page.locator('.hp-option').nth(1).click();
  assert.deepEqual(await page.evaluate(() => window.picked), ['there']);
  assert.equal((await chip.textContent()).trim(), '项目 · dsh-harness-provider');
  assert.equal(await page.locator('.hp-menu').count(), 0);
}));

// The quota chip is the last control of the left group, so on a phone its panel would open past the right edge.
test('on a phone-width row the quota panel stays on screen', () => withDock(async page => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => {
   const { createElement, createRoot, QuotaChip, styles } = window.HarnessProvider;
   document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
   Object.assign(document.body.style, { margin: '0' });
   Object.assign(document.getElementById('root').style, { display: 'flex', margin: '700px 12px 0', paddingLeft: '240px' });
   const quota = { kind: 'windows', source: 'Claude Code', plan: 'max', windows: [{ id: 'five_hour', label: '5h', usedPercent: 40, resetsAt: null }] };
   createRoot(document.getElementById('root')).render(createElement(QuotaChip, { quota, t: key => key }));
  });
  const chip = page.getByRole('button', { name: 'quotaAria' });
  await chip.click();
  const panel = await page.getByRole('dialog').boundingBox();
  assert.ok(panel.x >= 16 && panel.x + panel.width <= 390 - 16, `panel spans ${panel.x}–${panel.x + panel.width}`);
  // With room to spare it opens from the chip as before.
  await chip.click();
  await page.setViewportSize({ width: 1200, height: 800 });
  await chip.click();
  assert.equal(Math.round((await page.getByRole('dialog').boundingBox()).x), Math.round((await chip.boundingBox()).x));
}));

// The Host's select popup focuses its search field, which raises the on-screen keyboard; the plugin's panel has no text
// field and leaves focus where it was. Toggles send the whole set and keep the panel open.
test('the linked projects panel opens without a text field or a focus change and toggles projects in place', () => withDock(async page => {
  await page.evaluate(() => {
   const { createElement, createRoot, LinkedProjectsPanel, setLinkPanel, styles } = window.HarnessProvider;
   document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
   document.body.insertAdjacentHTML('afterbegin', '<button id="outside" style="display:block;margin-bottom:420px">outside</button>');
   Object.assign(document.getElementById('root').style, { position: 'relative' });
   window.sets = []; window.fail = false;
   let linked = ['web'];
   const projects = async () => [{ id: 'api', title: 'api', path: '/code/api', current: false, linked: linked.includes('api') }, { id: 'web', title: 'web', path: '/code/web', current: false, linked: linked.includes('web') }];
   const linkProjects = async (_id, ids) => { if (window.fail) throw new Error('请等待当前请求结束'); window.sets.push(ids); linked = ids; return { linked }; };
   createRoot(document.getElementById('root')).render(createElement(LinkedProjectsPanel, { sessionId: 's', projects, linkProjects, t: key => key }));
   window.openPanel = () => setLinkPanel('s', true);
  });
  assert.equal(await page.getByRole('menu').count(), 0);
  await page.locator('#outside').focus();
  await page.evaluate(() => window.openPanel());
  const options = page.getByRole('menuitemcheckbox');
  await options.first().waitFor();
  assert.equal(await page.locator('[role=menu] :is(input,textarea,[contenteditable])').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'outside');
  // The linked project leads; toggling keeps the rows where they are.
  const names = () => page.locator('.hp-option-name').allTextContents();
  const checks = () => options.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-checked')));
  assert.deepEqual(await names(), ['web', 'api']);
  assert.deepEqual(await checks(), ['true', 'false']);
  await options.nth(1).click();
  await page.waitForFunction(() => window.sets.length === 1);
  await options.nth(0).click();
  await page.waitForFunction(() => window.sets.length === 2);
  assert.deepEqual(await page.evaluate(() => window.sets), [['web', 'api'], ['api']]);
  assert.deepEqual(await names(), ['web', 'api']);
  assert.deepEqual(await checks(), ['false', 'true']);
  // A refusal (a running turn) is shown in the panel and changes nothing.
  await page.evaluate(() => { window.fail = true; });
  await options.nth(0).click();
  await page.getByRole('alert').filter({ hasText: '请等待当前请求结束' }).waitFor();
  assert.deepEqual(await checks(), ['false', 'true']);
  await page.locator('#outside').click();
  await page.getByRole('menu').waitFor({ state: 'detached' });
}));

// Tapping `+` makes the Host focus the draft editor, which raises the keyboard. Opening the panel puts that keyboard away,
// but not one the user raised by tapping into the editor, nor anything on a pointer or keyboard device.
test('a keyboard raised by a tap on another control is put away, the user\'s own is kept', () => withDock(async page => {
  const focused = () => page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
  await page.evaluate(() => {
   document.body.innerHTML = '<div id="editor" contenteditable="true">draft</div><button id="plus">+</button>';
   const typing = window.HarnessProvider.trackTyping();
   const editor = document.getElementById('editor'), plus = document.getElementById('plus');
   // The Host's launcher: it focuses the editor from its own click.
   window.press = (target, pointerType) => { target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType })); editor.focus(); };
   window.reset = () => { editor.blur(); };
   window.typing = typing; window.editor = editor; window.plus = plus;
  });
  await page.evaluate(() => { window.press(window.plus, 'touch'); window.typing.putAway(); });
  assert.equal(await focused(), 'BODY', 'the + tap focused the editor; opening the panel blurs it');
  await page.evaluate(() => { window.press(window.editor, 'touch'); window.press(window.plus, 'touch'); window.typing.putAway(); });
  assert.equal(await focused(), 'editor', 'the user tapped into the editor first');
  await page.evaluate(() => { window.reset(); window.press(window.plus, 'mouse'); window.typing.putAway(); });
  assert.equal(await focused(), 'editor', 'a mouse click has no on-screen keyboard to put away');
  await page.evaluate(() => { window.reset(); window.typing.stop(); window.press(window.plus, 'touch'); window.typing.putAway(); });
  assert.equal(await focused(), 'editor', 'stopped: no longer listening');
}));

// With more projects than fit, the list scrolls: rows keep their full height instead of being squeezed until a wrapped
// path runs over the next project's name. Linked projects come first, and each row says where the project lives.
test('a long linked projects list scrolls with whole rows, linked ones first, each with a short location', () => withDock(async page => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => {
   const { createElement, createRoot, LinkedProjectsPanel, setLinkPanel, styles } = window.HarnessProvider;
   document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
   Object.assign(document.body.style, { margin: '0' });
   Object.assign(document.getElementById('root').style, { position: 'relative', margin: '600px 12px 0' });
   const names = ['Real-ESRGAN', 'work', 'life', 'shopline', 'admin-web', 'admin-java', 'goshot', 'notes'];
   const list = [
    ...names.map(name => ({ id: name, title: name, path: '/Users/someone/MyProjects/' + name, current: false, linked: name === 'goshot' })),
    { id: 'wt', title: 'dsh-remote-control-02', path: '/Users/someone/AIProjetcs/dsh-plugin/dsh-remote-control-worktrees/dsh-remote-control-02', current: false, linked: false },
    { id: 'renamed', title: 'Docs site', path: '/home/someone/sites/docs', current: false, linked: true },
    { id: 'elsewhere', title: 'data', path: '/Volumes/disk/data', current: false, linked: false },
   ];
   createRoot(document.getElementById('root')).render(createElement(LinkedProjectsPanel, { sessionId: 's', projects: async () => list, linkProjects: async () => ({ linked: [] }), t: key => key }));
   setLinkPanel('s', true);
  });
  await page.getByRole('menuitemcheckbox').first().waitFor();
  const rows = await page.getByRole('menuitemcheckbox').evaluateAll(nodes => nodes.map(node => {
   const box = node.getBoundingClientRect(), copy = node.querySelector('.hp-option-copy');
   return { name: node.querySelector('.hp-option-name').textContent, hint: node.querySelector('.hp-option-hint')?.textContent, checked: node.getAttribute('aria-checked'),
    top: box.top, bottom: box.bottom, clipped: copy.scrollHeight > node.clientHeight };
  }));
  assert.deepEqual(rows.filter(row => row.clipped).map(row => row.name), [], 'every row is as tall as its text');
  for (let index = 1; index < rows.length; index++) assert.ok(rows[index].top >= rows[index - 1].bottom - 0.5, `${rows[index].name} starts below ${rows[index - 1].name}`);
  assert.ok(await page.getByRole('menu').evaluate(node => node.scrollHeight > node.clientHeight), 'the list scrolls');
  // Linked first, otherwise the Host's order.
  assert.deepEqual(rows.map(row => row.name).slice(0, 3), ['goshot', 'Docs site', 'Real-ESRGAN']);
  assert.deepEqual(rows.map(row => row.checked).slice(0, 3), ['true', 'true', 'false']);
  // The home directory reads `~`; a folder named like the project is left out, a renamed project keeps its folder.
  const hint = name => rows.find(row => row.name === name).hint;
  assert.equal(hint('work'), '~/MyProjects');
  assert.equal(hint('dsh-remote-control-02'), '~/AIProjetcs/dsh-plugin/dsh-remote-control-worktrees');
  assert.equal(hint('Docs site'), '~/sites/docs');
  assert.equal(hint('data'), '/Volumes/disk');
}));

// Scrolled to either end the list gives way with damping and springs back on its own; a list that fits its shell never
// scrolls, so it gets no give, and plain scrolling across the middle is untouched.
test('the scrolled linked projects list gives at its ends and springs back, one that fits does not', () => withDock(async page => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => {
    const { createElement, createRoot, LinkedProjectsPanel, setLinkPanel, styles } = window.HarnessProvider;
    document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
    Object.assign(document.getElementById('root').style, { position: 'relative', margin: '600px 12px 0' });
    const root = createRoot(document.getElementById('root'));
    let edition = 0;
    window.reload = short => {
      const list = Array.from({ length: short ? 2 : 26 }, (_, index) => ({ id: `p${index}`, title: `project ${index}`, path: `/code/p${index}`, current: false, linked: false }));
      // A new key remounts the panel, so its list is read again rather than remembered from the previous edition.
      root.render(createElement(LinkedProjectsPanel, { key: `edition-${edition++}`, sessionId: 's', projects: async () => list, linkProjects: async () => ({ linked: [] }), t: key => key }));
      setLinkPanel('s', true);
    };
    window.reload(false);
  });
  const menu = page.getByRole('menu');
  await page.getByRole('menuitemcheckbox').first().waitFor();
  const home = () => page.waitForFunction(() => { const rows = document.querySelector('[role=menu]').firstElementChild; return !rows.style.transform && !rows.classList.contains('hp-menu-back') && getComputedStyle(rows).transform === 'none'; }, undefined, { timeout: 3000 });
  const over = async () => { const box = await menu.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + 40); };
  await over();
  // Wheel up at rest draws the rows down past the top, then they spring home on their own.
  await page.mouse.wheel(0, -90);
  await page.waitForFunction(() => /^translateY\(\d/.test(document.querySelector('[role=menu]').firstElementChild.style.transform));
  assert.match(await menu.evaluate(node => node.firstElementChild.className), /hp-menu-body/, 'the rows sit in one body the shell holds');
  await home();
  // Wheel down from the top scrolls the list itself; the give never gets in the way of plain scrolling.
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => document.querySelector('[role=menu]').scrollTop > 0);
  assert.equal(await menu.evaluate(node => node.firstElementChild.style.transform), '');
  // At the bottom the rows give the other way, and spring back too.
  await menu.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.mouse.wheel(0, 90);
  await page.waitForFunction(() => /^translateY\(-\d/.test(document.querySelector('[role=menu]').firstElementChild.style.transform));
  await home();
  // A list that fits its shell does not scroll, and does not give either.
  await page.evaluate(() => window.reload(true));
  await page.waitForFunction(() => document.querySelectorAll('[role=menu] .hp-option').length === 2);
  await over();
  await page.mouse.wheel(0, -90);
  await home();
  assert.equal(await menu.evaluate(node => node.firstElementChild.style.transform), '', 'a list that fits does not give');
}));

// A finger that swipes past the top of the list drags the rows with it, damped, and they spring home when it lifts;
// a swipe across the middle still scrolls the list itself.
test('a finger swiping past an end of the scrolled list drags the rows and springs them home on lift', () => withDock(async page => {
  await page.evaluate(() => {
    const { createElement, createRoot, LinkedProjectsPanel, setLinkPanel, styles } = window.HarnessProvider;
    document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
    Object.assign(document.getElementById('root').style, { position: 'relative', margin: '600px 12px 0' });
    const list = Array.from({ length: 26 }, (_, index) => ({ id: `p${index}`, title: `project ${index}`, path: `/code/p${index}`, current: false, linked: false }));
    createRoot(document.getElementById('root')).render(createElement(LinkedProjectsPanel, { sessionId: 's', projects: async () => list, linkProjects: async () => ({ linked: [] }), t: key => key }));
    setLinkPanel('s', true);
  });
  const menu = page.getByRole('menu');
  await page.getByRole('menuitemcheckbox').first().waitFor();
  const home = () => page.waitForFunction(() => { const rows = document.querySelector('[role=menu]').firstElementChild; return !rows.style.transform && !rows.classList.contains('hp-menu-back') && getComputedStyle(rows).transform === 'none'; }, undefined, { timeout: 3000 });
  const box = await menu.boundingBox();
  const x = box.x + box.width / 2;
  const client = await page.context().newCDPSession(page);
  const touch = (type, y) => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  // Down past the top: the rows follow the finger, the list itself does not scroll, and they spring home on lift.
  const top = box.y + 40;
  await touch('touchStart', top);
  for (let step = 1; step <= 6; step++) await touch('touchMove', top + step * 15);
  await page.waitForFunction(() => /^translateY\(\d/.test(document.querySelector('[role=menu]').firstElementChild.style.transform));
  assert.equal(await menu.evaluate(node => node.scrollTop), 0);
  await touch('touchEnd', 0);
  await home();
  // Up across the middle still scrolls the list itself.
  const middle = box.y + 200;
  await touch('touchStart', middle);
  for (let step = 1; step <= 6; step++) await touch('touchMove', middle - step * 15);
  await touch('touchEnd', 0);
  await page.waitForFunction(() => document.querySelector('[role=menu]').scrollTop > 0);
}, { touch: true }));

// A directory outside the registered projects is picked by walking the Host's folders a level at a time: no path is typed,
// so the panel still has no text field. The picked folder is linked to this session alone and joins the list.
test('another folder is browsed level by level and linked without typing a path', () => withDock(async page => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => {
   const { createElement, createRoot, LinkedProjectsPanel, setLinkPanel, styles } = window.HarnessProvider;
   document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
   Object.assign(document.getElementById('root').style, { position: 'relative', margin: '600px 12px 0' });
   const tree = { '/Users/me': ['data', 'code'], '/Users/me/data': ['sets'], '/Users/me/data/sets': [], '/Users': ['me'] };
   window.reads = []; window.sets = [];
   const directories = async (_id, path = '/Users/me') => {
    window.reads.push(path);
    if (path === '/Users') throw new Error('无法读取目录：/Users');
    return { path, parent: path.slice(0, path.lastIndexOf('/')) || null, entries: tree[path].map(name => ({ name, path: `${path}/${name}` })), truncated: false };
   };
   const linkProjects = async (_id, workspaceIds, paths) => { window.sets.push({ workspaceIds, paths }); return { linked: workspaceIds, linkedPaths: paths }; };
   const projects = async () => [{ id: 'api', title: 'api', path: '/Users/me/code/api', current: false, linked: true }];
   createRoot(document.getElementById('root')).render(createElement(LinkedProjectsPanel, { sessionId: 's', projects, linkProjects, directories, t: key => key }));
   setLinkPanel('s', true);
  });
  const item = name => page.getByRole('menuitem', { name });
  const texts = () => page.locator('[role=menu] .hp-option-name').allTextContents();
  await item('linkBrowse').click();
  // The home directory first: the folder to link, its parent, then its subfolders.
  await item('data').waitFor();
  assert.deepEqual(await texts(), ['linkHere', 'linkUp', 'data', 'code']);
  assert.equal(await item('linkHere').locator('.hp-option-hint').textContent(), '~');
  await item('data').click();
  await item('sets').click();
  await page.getByText('linkNoFolders').waitFor();
  assert.equal(await item('linkHere').locator('.hp-option-hint').textContent(), '~/data/sets');
  // Up again, and past a level that cannot be read: the reason shows and the level can be retried or left.
  await item('linkUp').click();
  await item('sets').waitFor();
  await item('linkUp').click();
  await item('code').waitFor();
  await item('linkUp').click();
  await page.getByRole('alert').filter({ hasText: '无法读取目录：/Users' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.reads), ['/Users/me', '/Users/me/data', '/Users/me/data/sets', '/Users/me/data', '/Users/me', '/Users']);
  assert.equal(await page.locator('[role=menu] :is(input,textarea,[contenteditable])').count(), 0);
  // Back on the project list nothing was linked; browsing again and linking a folder adds it, checked, beside the project.
  await item('linked').click();
  await page.getByRole('menuitemcheckbox', { name: 'api' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.sets), []);
  await item('linkBrowse').click();
  await item('data').click();
  await item('sets').waitFor();
  await item('linkHere').click();
  const rows = page.getByRole('menuitemcheckbox');
  await rows.nth(1).waitFor();
  assert.deepEqual(await page.evaluate(() => window.sets), [{ workspaceIds: ['api'], paths: ['/Users/me/data'] }]);
  assert.deepEqual(await texts(), ['api', 'data']);
  assert.deepEqual(await page.locator('[role=menu] .hp-option-hint').allTextContents(), ['~/code', '~']);
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-checked'))), ['true', 'true']);
  // Unchecking the folder sends the set without it; the row stays until the panel closes, so it can be put back.
  await rows.nth(1).click();
  await page.waitForFunction(() => window.sets.length === 2);
  assert.deepEqual(await page.evaluate(() => window.sets[1]), { workspaceIds: ['api'], paths: [] });
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-checked'))), ['true', 'false']);
}));
