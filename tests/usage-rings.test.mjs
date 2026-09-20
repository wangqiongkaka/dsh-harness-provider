import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// Render the real components without adding test-only exports to the plugin.
test('quota remaining and context used have opposite arcs but the same scarcity colors', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const React=require('react'), {renderToStaticMarkup}=require('react-dom/server');
 const source=await readFile('src/client.tsx','utf8');
 const bundle=await build({stdin:{contents:source+'\nexport {QuotaChip,ContextRing,styles};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require});
 const {QuotaChip,ContextRing,styles}=module.exports;
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  for(const used of [0,9,69.9,70,89.9,90,91,100]){
   const quota=renderToStaticMarkup(React.createElement(QuotaChip,{quota:{kind:'windows',source:'test',plan:null,windows:[{id:'five_hour',label:'5h',usedPercent:used,resetsAt:null}]},t:key=>key}));
   const context=renderToStaticMarkup(React.createElement(ContextRing,{usage:{contextUsedTokens:used*10,contextWindowTokens:1000,totalTokens:null},t:key=>key}));
   await page.setContent(`<style>:root{--dsw-alias-state-success-primary:#16a34a;--dsw-alias-state-warn-primary:#f59e0b;--dsw-alias-state-error-primary:#dc2626}${styles}</style>${quota}${context}`);
   const expected=used>=90?'rgb(220, 38, 38)':used>=70?'rgb(245, 158, 11)':'rgb(22, 163, 74)';
   const rings=await page.locator('.hp-fill').evaluateAll(nodes=>nodes.map(node=>({color:getComputedStyle(node).stroke,offset:Number(node.getAttribute('stroke-dashoffset'))})));
   assert.deepEqual(rings.map(ring=>ring.color),[expected,expected],`used ${used}%, remaining ${100-used}%`);
   const circumference=2*Math.PI*5.5;
   assert.ok(Math.abs(rings[0].offset-circumference*used/100)<1e-8);
   assert.ok(Math.abs(rings[1].offset-circumference*(1-used/100))<1e-8);
   // Empty arcs retain a faint state-colored track, including exhausted quota.
   assert.deepEqual(await page.locator('.hp-track').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).stroke)),[expected,expected]);
  }
  // The context reading sits under the composer like the host's: ring plus percentage.
  assert.match(renderToStaticMarkup(React.createElement(ContextRing,{usage:{contextUsedTokens:200,contextWindowTokens:1000,totalTokens:null},t:key=>key})),/<span>20%<\/span>/);
  // A DSH native session's host ring (no tier classes) takes the same colors from its aria-label, in either locale.
  const host=label=>`<button aria-label="${label}"><svg viewBox="0 0 14 14"><circle class="track" cx="7" cy="7" r="5.5"></circle><circle class="fill" cx="7" cy="7" r="5.5"></circle></svg><span>x</span></button>`;
  const cases=[['上下文已用 20%','rgb(22, 163, 74)'],['上下文已用 69%','rgb(22, 163, 74)'],['上下文已用 70%','rgb(245, 158, 11)'],['89% of context used','rgb(245, 158, 11)'],['上下文已用 90%','rgb(220, 38, 38)'],['100% of context used','rgb(220, 38, 38)']];
  await page.setContent(`<style>:root{--dsw-alias-state-success-primary:#16a34a;--dsw-alias-state-warn-primary:#f59e0b;--dsw-alias-state-error-primary:#dc2626}.track{stroke:gray}.fill{stroke:gray}${styles}</style>${cases.map(([label])=>host(label)).join('')}<button aria-label="Send"><svg><circle class="fill"></circle></svg></button>`);
  const fills=await page.locator('circle.fill').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).stroke));
  assert.deepEqual(fills,[...cases.map(([,color])=>color),'rgb(128, 128, 128)'],'other buttons keep their own stroke');
  assert.deepEqual(await page.locator('circle.track').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).strokeOpacity)),cases.map(()=>'0.2'));
  // The ring matches the percentage printed beside it, not a per-model window that only the panel lists.
  const mixed=renderToStaticMarkup(React.createElement(QuotaChip,{quota:{kind:'windows',source:'test',plan:null,windows:[{id:'five_hour',label:'5h',usedPercent:1,resetsAt:null},{id:'product:opus',label:'Opus',usedPercent:40,resetsAt:null}]},t:key=>key}));
  assert.match(mixed,/ 99%/);
  assert.match(mixed,new RegExp(`stroke-dashoffset="${2*Math.PI*5.5/100}"`));
 } finally {await browser.close();}
});

test('delegation and discussion modes share composer styling with distinct colors', async () => {
 const source=await readFile('src/client.tsx','utf8');
 const bundle=await build({stdin:{contents:source+'\nexport {styles};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'))});
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  const seat=(dock,id,command='/delegate ')=>`<div data-composer-seat><div>${dock}</div><div><div data-composer-card id="${id}"><div contenteditable><p><span style="color: var(--dsw-alias-state-warn-label);">${command}</span><span>实现登录</span></p></div></div></div></div>`;
  await page.setContent(`<style>:root{--dsw-alias-state-warn-label:rgb(255, 128, 0);--dsw-static-blue-450:rgb(77, 107, 254)}${module.exports.styles}</style>`
   +seat('<div class="hp-delegate" data-hp-mode="delegate"><strong>委派模式</strong></div>','delegating')
   +seat('<div class="hp-delegate" data-hp-mode="discuss"><strong>讨论</strong></div>','discussing','/discuss ')+seat('','plain'));
  const shadow=id=>page.locator('#'+id).evaluate(node=>getComputedStyle(node).boxShadow);
  assert.match(await shadow('delegating'),/rgb\(255, 128, 0\)/);
  assert.match(await shadow('discussing'),/rgb\(77, 107, 254\)/);assert.equal(await shadow('plain'),'none');
  assert.equal(await page.locator('.hp-delegate[data-hp-mode=delegate]>strong').evaluate(node=>getComputedStyle(node).color),'rgb(255, 128, 0)');
  assert.equal(await page.locator('.hp-delegate[data-hp-mode=discuss]>strong').evaluate(node=>getComputedStyle(node).color),'rgb(77, 107, 254)');
  // Mode tokens stay in the draft (and the submitted command) but are not shown in either mode.
  const token=id=>page.locator(`#${id} p>span`).first().evaluate(node=>({width:node.getBoundingClientRect().width,color:getComputedStyle(node).color}));
  assert.deepEqual(await token('delegating'),{width:0,color:'rgba(0, 0, 0, 0)'});
  assert.equal(await page.locator('#delegating [contenteditable]').innerText(),'/delegate 实现登录');
  assert.deepEqual(await token('discussing'),{width:0,color:'rgba(0, 0, 0, 0)'});
  assert.equal(await page.locator('#discussing [contenteditable]').innerText(),'/discuss 实现登录');
 } finally {await browser.close();}
});

// The host composer is Lexical with plain-text bindings, which deletes on keydown itself.
test('task modes keep the hidden token and block empty sends in a Lexical editor', async () => {
 const source=await readFile('src/client.tsx','utf8');
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const conversation=resolve('node_modules/@deepseek-ai/dsh-client-ui-conversation'), lexical=name=>resolve(conversation,'node_modules',name);
 const bundle=await build({stdin:{contents:source+`\nimport {createRoot} from 'react-dom/client';
import {createEditor,$getRoot,$getSelection,$createParagraphNode,$createTextNode,KEY_ENTER_COMMAND,COMMAND_PRIORITY_CRITICAL} from 'lexical';
import {registerPlainText} from '@lexical/plain-text';
import {registerClaimDecoration} from '${conversation}/src/client/input/editor/claim-decor.ts';
document.head.append(Object.assign(document.createElement('style'),{textContent:styles}));
const editor=createEditor({namespace:'composer',onError(error){throw error;}});
editor.setRootElement(document.querySelector('[contenteditable]'));
let token='/delegate ';
registerPlainText(editor);registerClaimDecoration(editor,()=>token);
editor.registerCommand(KEY_ENTER_COMMAND,event=>{event?.preventDefault();document.body.dataset.sent=String(Number(document.body.dataset.sent??0)+1);return true;},COMMAND_PRIORITY_CRITICAL);
const root=createRoot(document.querySelector('#dock'));
window.reset=(mode,task)=>{
 delete document.body.dataset.sent;
 token=mode==='discuss'?'/discuss ':'/delegate ';
 const input={phase:'claimed',claim:{name:mode,token},draft:token+task,attachmentIds:[],draftRev:1,occurrences:[],queue:[]};
 root.render(<DelegationDock sessionId="s" input={input} inputActions={{setDraft(){}}} t={key=>key} />);
 editor.update(()=>{const paragraph=$createParagraphNode().append($createTextNode(token).setStyle('color: var(--dsw-alias-state-warn-label)'));if(task)paragraph.append($createTextNode(task));$getRoot().clear().append(paragraph);paragraph.selectEnd();},{discrete:true});
 editor.focus();
};
// Safari composes without a keydown first; with the token's style on the selection, Lexical composes inside the token's node.
window.inheritTokenStyle=()=>editor.update(()=>$getSelection().setStyle('color: var(--dsw-alias-state-warn-label)'),{discrete:true});
window.selectedHarnesses=mode=>mode==='delegate'?optionsFor('s').harnesses:discussionFor('s');`,resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',
  alias:{react:require.resolve('react'),'react/jsx-runtime':require.resolve('react/jsx-runtime'),'react-dom/client':require.resolve('react-dom/client'),lexical:lexical('lexical'),'@lexical/plain-text':lexical('@lexical/plain-text')}});
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<div data-composer-seat><div id="dock"></div><div data-composer-card><div contenteditable style="white-space:pre-wrap"></div><button class="RVCQnG_primary">send</button></div></div>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const text=()=>page.locator('[contenteditable]').innerText();
  const settle=()=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));
  const reset=async(task,mode='delegate')=>{await page.evaluate(({mode,task})=>window.reset(mode,task),{mode,task});await page.locator(`.hp-delegate[data-hp-mode=${mode}]`).waitFor();await settle();};
  await reset('ab');
  for(let i=0;i<5;i++)await page.keyboard.press('Backspace');
  assert.equal(await text(),'/delegate ','held Backspace stops at the token');
  await reset('ab');
  await page.keyboard.press('Home');await settle();await page.keyboard.press('Backspace');await page.keyboard.press('Delete');
  assert.equal(await text(),'/delegate b','the caret never enters the token');
  await reset('ab');
  for(let i=0;i<4;i++)await page.keyboard.press('ArrowLeft');
  await settle();await page.keyboard.press('Backspace');
  assert.equal(await text(),'/delegate ab');
  await reset('ab');
  await page.keyboard.press('ControlOrMeta+a');await settle();await page.keyboard.press('Backspace');
  assert.equal(await text(),'/delegate ','select-all clears only the task');
  await reset('ab');
  await page.keyboard.press('Meta+Backspace');
  assert.equal(await text(),'/delegate ab');
  await reset('');
  assert.equal(await page.locator('[data-composer-card] button').evaluate(node=>getComputedStyle(node).pointerEvents),'none','an empty task greys out send');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>document.body.dataset.sent),undefined,'Enter does not send an empty task');
  await reset('ab');
  assert.equal(await page.locator('[data-composer-card] button').evaluate(node=>getComputedStyle(node).pointerEvents),'auto');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>document.body.dataset.sent),'1');
  await reset('ab','discuss');
  for(let i=0;i<5;i++)await page.keyboard.press('Backspace');
  assert.equal(await text(),'/discuss ','discussion holds its mode token');
  await reset('','discuss');
  assert.equal(await page.locator('[data-composer-card] button').evaluate(node=>getComputedStyle(node).pointerEvents),'none','an empty discussion greys out send');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>document.body.dataset.sent),undefined,'Enter does not start an empty discussion');
  await reset('');
  await page.evaluate(()=>window.inheritTokenStyle());
  const cdp=await page.context().newCDPSession(page);
  for(const text of ['w','wo'])await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});
  await settle();
  const composed=await page.locator('[contenteditable] p>span').first().evaluate(span=>{
   const text=span.firstChild,range=document.createRange();range.setStart(text,'/delegate '.length);range.setEnd(text,text.length);
   const box=span.getBoundingClientRect(),rest=range.getBoundingClientRect(),style=getComputedStyle(span);
   return {text:span.textContent.replace(/\u200b/g,''),width:Math.round(box.width),rest:Math.round(rest.width),left:box.left===span.closest('[contenteditable]').getBoundingClientRect().left,color:style.color,overflow:style.overflow};
  });
  assert.equal(composed.text,'/delegate wo','the IME composes inside the token node');
  assert.ok(composed.rest>0);
  assert.deepEqual({width:composed.width,left:composed.left,overflow:composed.overflow},{width:composed.rest,left:true,overflow:'clip'},'only the composed text shows, from the start of the line');
  assert.notEqual(composed.color,'rgba(0, 0, 0, 0)');
  await cdp.send('Input.insertText',{text:'我'});await settle();
  assert.equal(await text(),'/delegate 我');
  await page.keyboard.press('Backspace');await settle();
  assert.equal((await text()).replace(/\u200b/g,''),'/delegate ','输入法提交后可以删掉最后一个字符');
  // Both real mode docks allow independent toggles and keep at least one recipient.
  await reset('task');
  const selector=page.locator('.hp-delegate-harness');
  assert.equal(await selector.getByRole('checkbox',{name:'Codex',exact:true}).getAttribute('aria-checked'),'true');
  await selector.getByRole('checkbox',{name:'Claude Code',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.selectedHarnesses('delegate')),['codex','claude-code']);
  await selector.getByRole('checkbox',{name:'Codex',exact:true}).click();
  await selector.getByRole('checkbox',{name:'Claude Code',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.selectedHarnesses('delegate')),['claude-code'],'the last selected target cannot be cleared');
  await selector.getByRole('checkbox',{name:'native',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.selectedHarnesses('delegate')),['claude-code','dsh']);
  assert.equal(await page.getByRole('checkbox',{name:'worktree',exact:true}).isDisabled(),true);
  await reset('task','discuss');
  assert.equal(await selector.getByRole('checkbox',{name:'native',exact:true}).isDisabled(),true);
  assert.equal(await selector.getByRole('checkbox',{name:'Codex',exact:true}).getAttribute('aria-checked'),'true');
  assert.equal(await selector.getByRole('checkbox',{name:'Claude Code',exact:true}).getAttribute('aria-checked'),'true');
  await selector.getByRole('checkbox',{name:'Codex',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.selectedHarnesses('discuss')),['claude-code']);
  await selector.getByRole('checkbox',{name:'Codex',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.selectedHarnesses('discuss')),['claude-code','codex']);
 } finally {await browser.close();}
});
