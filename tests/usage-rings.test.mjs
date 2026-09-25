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
  const seat=(dock,id)=>`<div data-composer-seat><div>${dock}</div><div><div data-composer-card id="${id}"><div contenteditable><p><span>实现登录</span></p></div></div></div></div>`;
  await page.setContent(`<style>:root{--dsw-alias-state-warn-label:rgb(255, 128, 0);--dsw-static-blue-450:rgb(77, 107, 254)}${module.exports.styles}</style>`
   +seat('<div class="hp-delegate" data-hp-mode="delegate"><strong>委派模式</strong></div>','delegating')
   +seat('<div class="hp-delegate" data-hp-mode="discuss"><strong>讨论</strong></div>','discussing','/discuss ')+seat('','plain'));
  const shadow=id=>page.locator('#'+id).evaluate(node=>getComputedStyle(node).boxShadow);
  assert.match(await shadow('delegating'),/rgb\(255, 128, 0\)/);
  assert.match(await shadow('discussing'),/rgb\(77, 107, 254\)/);assert.equal(await shadow('plain'),'none');
  assert.equal(await page.locator('.hp-delegate[data-hp-mode=delegate]>strong').evaluate(node=>getComputedStyle(node).color),'rgb(255, 128, 0)');
  assert.equal(await page.locator('.hp-delegate[data-hp-mode=discuss]>strong').evaluate(node=>getComputedStyle(node).color),'rgb(77, 107, 254)');
  for(const id of ['delegating','discussing']){
   assert.equal(await page.locator(`#${id} [contenteditable]`).innerText(),'实现登录');
   assert.ok(await page.locator(`#${id} p>span`).evaluate(node=>node.getBoundingClientRect().width)>0);
  }
 } finally {await browser.close();}
});

test('settings harness choices match row typography without changing composer choices', async () => {
 const source=await readFile('src/client.tsx','utf8');
 const bundle=await build({stdin:{contents:source+'\nexport {styles};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'))});
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent(`<style>body{font-size:16px}${module.exports.styles}</style><div class="hp-set"><div class="hp-set-row"><div class="hp-set-title">委派默认目标</div><div class="hp-set-control"><div class="hp-delegate-harness"><button>Codex</button></div></div></div></div><div class="hp-delegate"><div class="hp-delegate-harness"><button>Codex</button></div></div>`);
  const sizes=await page.locator('.hp-set-title,.hp-set-control .hp-delegate-harness button,.hp-delegate .hp-delegate-harness button').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).fontSize));
  assert.deepEqual(sizes,['14px','14px','12px']);
 } finally {await browser.close();}
});

test('输入提示条与输入框在宽屏和窄屏下左右对齐', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {styles};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require});
 const hostCss=await readFile('node_modules/@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/InputBar.module.css','utf8');
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  for(const width of [375,1440]){
   await page.setViewportSize({width,height:600});
   await page.setContent(`<style>:root{--dsh-composer-side-clearance:16px;--dsh-composer-card-max-width:780px}${hostCss}${module.exports.styles}</style><div data-composer-seat><div class="root"><div class="notice" role="status">已创建委派会话</div><div class="card" data-composer-card>输入框</div></div></div>`);
   const bounds=await page.locator('[role=status],[data-composer-card]').evaluateAll(nodes=>nodes.map(node=>{const {left,right}=node.getBoundingClientRect();return {left,right};}));
   assert.deepEqual(bounds[0],bounds[1],`${width}px 下提示条与输入框边缘一致`);
  }
 } finally {await browser.close();}
});

// Exercise the actual mode facade and editor keymap with the plugin docks.
test('task modes edit only the body and submit through their own backend', async () => {
 const source=await readFile('src/client.tsx','utf8');
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const conversation=resolve('node_modules/@deepseek-ai/dsh-client-ui-conversation'), lexical=name=>resolve(conversation,'node_modules',name);
 const bundle=await build({stdin:{contents:source+`\nimport {createRoot} from 'react-dom/client';
import {$getRoot} from 'lexical';
import {SessionInputShell} from '${conversation}/src/client/input/facade.ts';
import {registerComposerKeymap} from '${conversation}/src/client/input/editor/keymap.ts';
document.head.append(Object.assign(document.createElement('style'),{textContent:styles}));
window.requests=[];
window.fail=false;
const respond=async(mode,request)=>{window.requests.push({mode,...request});if(window.delay)await new Promise(resolve=>window.finish=resolve);if(window.fail)throw new Error('retry');return {ok:true,value:{sessionId:'child',accepted:true}};};
const remote={delegateFromUser:request=>respond('delegate',request),startDiscussionFromUser:request=>respond('discuss',request)};
const commandUi={async candidates(){return [];},dispatch(){},matchSpace(){},async matchEnter(){}};
window.released=[];
const conversation={async sendSession(session,text){window.requests.push({mode:'plain',prompt:text});return {kind:'success'};},async serializeDraftAttachments(ids){return {attachments:ids.map(receiptId=>({type:'file',receiptId}))};},releaseDraftAttachment(id){window.released.push(id);}};
apply({remote:{harness:remote,async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},inject(keys,fn){if((keys.includes('conversation')&&keys.includes('remote.harness'))||keys.includes('commandUi'))fn({conversation,commandUi,remote:{harness:remote},effect(fn){fn();}});}});
const shell=new SessionInputShell({actx:{},defaultSink:(text,ids,mode,signal)=>conversation.sendSession({sessionId:'s'},text,ids,mode,signal),commandAttachments:{serialize:async()=>[],release(){},unsupportedNotice:()=>''}});
shell.editor.setRootElement(document.querySelector('[contenteditable]'));
const root=createRoot(document.querySelector('#dock'));
const render=()=>{
 const input=shell.snapshot;
 root.render(<DelegationDock sessionId="s" input={input} inputActions={shell.actions} t={key=>key} />);
 document.querySelector('#send').disabled=(!input.draft.trim()&&!input.attachmentIds.length)||input.phase==='submitting';
};
shell.state.subscribe(render);render();
document.querySelector('#send').onclick=()=>shell.submit();
registerComposerKeymap(shell.editor,{arbitrate:()=> 'pass',space:()=>false,dismissPopup(){},canSubmit:()=>!document.querySelector('#send').disabled,submit:()=>shell.submit(),intakeFiles(){},pasteText:text=>shell.paste(text)});
window.reset=(mode,task)=>{
 setTaskMode('s');
 const token=mode==='discuss'?'/discuss ':'/delegate ';
 shell.setDraft(token+task);
 const outcome=commandUi.matchSpace({sessionId:'s'},token.trim());
 shell.insertText(outcome.text,{start:0,end:token.length,draftRev:shell.snapshot.draftRev});
 shell.editor.update(()=>$getRoot().selectEnd(),{discrete:true});shell.focus();
};
window.snapshot=()=>({...shell.snapshot,taskMode:taskModes.get('s')?.task.name});
window.attach=()=>shell.addAttachments(['receipt']);
window.plain=text=>{setTaskMode('s');shell.setDraft(text);shell.submit();};
window.selectedHarnesses=mode=>mode==='delegate'?optionsFor('s').harnesses:discussionFor('s');`,resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',loader:{'.css':'empty','.module.css':'empty'},
  alias:{react:require.resolve('react'),'react/jsx-runtime':require.resolve('react/jsx-runtime'),'react-dom/client':require.resolve('react-dom/client'),lexical:lexical('lexical'),'@lexical/plain-text':lexical('@lexical/plain-text')}});
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<div data-composer-seat><div id="dock"></div><div data-composer-card><div contenteditable style="white-space:pre-wrap"></div><button id="send">send</button></div></div>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const text=()=>page.locator('[contenteditable]').textContent();
  const settle=()=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));
  const reset=async(task,mode='delegate')=>{await page.evaluate(({mode,task})=>window.reset(mode,task),{mode,task});await page.locator(`.hp-delegate[data-hp-mode=${mode}]`).waitFor();await settle();};
  for(const mode of ['delegate','discuss']){
   await reset('ffff',mode);
   assert.equal(await text(),'ffff','DOM 中只有正文');
   assert.equal((await page.evaluate(()=>window.snapshot())).draft,'ffff');
   for(let i=0;i<5;i++)await page.keyboard.press('Backspace');
   assert.equal(await text(),'');
   assert.equal((await page.evaluate(()=>window.snapshot())).draft,'');
   assert.equal((await page.evaluate(()=>window.snapshot())).taskMode,mode,'删空保留模式');
   await page.keyboard.press('Enter');
   assert.equal(await page.evaluate(()=>window.requests.length),0,'空正文不发送');
   await page.keyboard.type('ab');await page.keyboard.press('Home');await settle();await page.keyboard.press('Delete');
   assert.equal(await text(),'b','行首可以前向删除');
   await page.keyboard.press('ControlOrMeta+a');
   assert.equal(await page.evaluate(()=>document.getSelection().toString()),'b','选区没有隐藏指令');
   await page.keyboard.press('Backspace');
   const cdp=await page.context().newCDPSession(page);
   for(const value of ['w','wo'])await cdp.send('Input.imeSetComposition',{text:value,selectionStart:value.length,selectionEnd:value.length});
   await cdp.send('Input.insertText',{text:'我'});await settle();
   assert.equal(await text(),'我');
   await page.keyboard.press('Backspace');await settle();
   assert.equal(await text(),'');
   await page.keyboard.insertText('保留正文');
   await page.locator('.hp-delegate-exit').click();await settle();
   assert.equal(await text(),'保留正文');
   assert.equal((await page.evaluate(()=>window.snapshot())).phase,'plain');
  }
  await reset('task');
  const selector=page.locator('.hp-delegate-harness');
  await selector.getByRole('checkbox',{name:'Claude Code',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.selectedHarnesses('delegate')),['codex','claude-code']);
  await page.evaluate(()=>{window.fail=true;});
  await page.locator('#send').click();await settle();
  assert.equal(await text(),'task','失败保留正文');
  assert.equal((await page.evaluate(()=>window.snapshot())).taskMode,'delegate');
  await page.evaluate(()=>{window.fail=false;});
  await page.locator('#send').click();await settle();
  const requests=await page.evaluate(()=>window.requests);
  assert.equal(requests[0].prompt,'task');assert.equal(requests[1].prompt,'task');
  assert.deepEqual(requests[1].harnesses,['codex','claude-code']);
  assert.equal(requests[0].requestId,requests[1].requestId,'重试沿用请求标识');
  assert.equal(await text(),'');
  await reset('比较方案','discuss');
  await page.locator('#send').click();await settle();
  assert.equal((await page.evaluate(()=>window.requests)).at(-1).mode,'discuss');
  assert.equal((await page.evaluate(()=>window.requests)).at(-1).prompt,'比较方案');
  await reset('','delegate');
  await page.evaluate(()=>{window.attach();window.fail=true;});
  await page.locator('#send').click();await settle();
  assert.deepEqual((await page.evaluate(()=>window.snapshot())).attachmentIds,['receipt'],'附件失败后恢复');
  assert.deepEqual(await page.evaluate(()=>window.released),[]);
  await page.evaluate(()=>{window.fail=false;});
  await page.locator('#send').click();await settle();
  assert.deepEqual((await page.evaluate(()=>window.requests)).at(-1).attachments,[{type:'file',receiptId:'receipt'}]);
  assert.deepEqual(await page.evaluate(()=>window.released),['receipt']);
  await page.evaluate(()=>window.plain('普通消息'));await settle();
  assert.equal((await page.evaluate(()=>window.requests)).at(-1).mode,'plain');
  await page.evaluate(()=>{window.fail=true;window.plain('/delegate 粘贴任务');});await settle();
  await page.evaluate(()=>{window.fail=false;});await page.locator('#send').click();await settle();
  assert.equal((await page.evaluate(()=>window.requests)).at(-1).prompt,'粘贴任务','粘贴指令失败重试不会把指令混进正文');
  for(const mode of ['delegate','discuss']){
   await reset('延迟失败时保留的正文',mode);
   await page.evaluate(()=>{window.attach();window.delay=true;window.fail=true;});
   await page.locator('#send').click();await settle();
   assert.equal(await page.locator('[data-composer-seat]').evaluate(node=>node.inert),true,'发送中锁定整个输入区');
   await page.locator('[contenteditable]').evaluate(node=>node.focus());
   await page.keyboard.insertText('不能覆盖原稿');
   await page.keyboard.press('Enter');
   await page.evaluate(()=>window.finish());await settle();
   assert.equal(await text(),'延迟失败时保留的正文');
   assert.deepEqual((await page.evaluate(()=>window.snapshot())).attachmentIds,['receipt']);
   assert.equal((await page.evaluate(()=>window.snapshot())).taskMode,mode);
   assert.equal(await page.locator('[data-composer-seat]').evaluate(node=>node.inert),false,'失败后恢复编辑');
   await page.evaluate(()=>{window.delay=false;window.fail=false;});
   await page.locator('#send').click();await settle();
   assert.equal(await text(),'');
   assert.equal((await page.evaluate(()=>window.snapshot())).taskMode,undefined);
   assert.equal(await page.locator('[data-composer-seat]').evaluate(node=>node.inert),false,'成功后恢复编辑');
  }
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
