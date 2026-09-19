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

test('delegation mode rings only its own composer card in orange', async () => {
 const source=await readFile('src/client.tsx','utf8');
 const bundle=await build({stdin:{contents:source+'\nexport {styles};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'))});
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  const seat=(dock,id)=>`<div data-composer-seat><div>${dock}</div><div><div data-composer-card id="${id}"><div contenteditable><p><span style="color: var(--dsw-alias-state-warn-label);">/delegate </span><span>实现登录</span></p></div></div></div></div>`;
  await page.setContent(`<style>:root{--dsw-alias-state-warn-label:rgb(255, 128, 0)}${module.exports.styles}</style>`
   +seat('<div class="hp-delegate" data-hp-mode="delegate"><strong>委派模式</strong></div>','delegating')
   +seat('<div class="hp-delegate"><strong>讨论</strong></div>','discussing')+seat('','plain'));
  const shadow=id=>page.locator('#'+id).evaluate(node=>getComputedStyle(node).boxShadow);
  assert.match(await shadow('delegating'),/rgb\(255, 128, 0\)/);
  assert.equal(await shadow('discussing'),'none');assert.equal(await shadow('plain'),'none');
  assert.equal(await page.locator('.hp-delegate[data-hp-mode=delegate]>strong').evaluate(node=>getComputedStyle(node).color),'rgb(255, 128, 0)');
  // The /delegate token stays in the draft (and the submitted command) but is not shown in delegation mode.
  const token=id=>page.locator(`#${id} p>span`).first().evaluate(node=>({width:node.getBoundingClientRect().width,color:getComputedStyle(node).color}));
  assert.deepEqual(await token('delegating'),{width:0,color:'rgba(0, 0, 0, 0)'});
  assert.equal(await page.locator('#delegating [contenteditable]').innerText(),'/delegate 实现登录');
  assert.notEqual((await token('discussing')).width,0);assert.equal((await token('discussing')).color,'rgb(255, 128, 0)');
 } finally {await browser.close();}
});
