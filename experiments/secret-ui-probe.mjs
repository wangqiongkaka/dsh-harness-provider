import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { chromium } from '@playwright/test';
const reference = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const require = createRequire(resolve(reference,'packages/client/web/package.json'));
const compiled = await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SecretPanel} from './src/client.tsx';
const pending={id:'question-1',title:'凭据输入',questions:[{id:'password',type:'text',prompt:'密码',secret:true,multiline:false,optional:false}]};
const read=async()=>pending;
const answer=async(...args)=>{window.received=args;return {accepted:true};};
createRoot(document.getElementById('root')).render(<SecretPanel sessionId="session" read={read} answer={answer}/>);
`},bundle:true,jsx:'automatic',format:'iife',write:false,alias:{react:dirname(require.resolve('react')), 'react-dom/client':require.resolve('react-dom/client')},define:{'process.env.NODE_ENV':'"production"'}});
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({content:compiled.outputFiles[0].text});
  const input=page.getByLabel('密码',{exact:true});await input.waitFor();
  assert.equal(await input.getAttribute('type'),'password');
  await input.fill('fixture-password');await page.getByRole('button',{name:'提交',exact:true}).click();
  await page.waitForFunction(()=>window.received);
  assert.deepEqual(await page.evaluate(()=>window.received),['session','question-1',{password:['fixture-password']},false]);
  assert.equal(await page.locator('input').count(),0);
  console.log('PASS: actual password component masks input, sends the scoped answer, and clears/unmounts the form');
} finally {await browser.close();}
