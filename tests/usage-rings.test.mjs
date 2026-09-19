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
 const bundle=await build({stdin:{contents:source+'\nexport {QuotaChip,ContextRing,styles};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.png':'dataurl'},external:['react','react/jsx-runtime']});
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
  // The ring matches the percentage printed beside it, not a per-model window that only the panel lists.
  const mixed=renderToStaticMarkup(React.createElement(QuotaChip,{quota:{kind:'windows',source:'test',plan:null,windows:[{id:'five_hour',label:'5h',usedPercent:1,resetsAt:null},{id:'product:opus',label:'Opus',usedPercent:40,resetsAt:null}]},t:key=>key}));
  assert.match(mixed,/ 99%/);
  assert.match(mixed,new RegExp(`stroke-dashoffset="${2*Math.PI*5.5/100}"`));
 } finally {await browser.close();}
});
