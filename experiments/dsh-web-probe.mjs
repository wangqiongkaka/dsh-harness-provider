import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, readFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const reference=resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const require=createRequire(import.meta.url);
const {chromium,expect}=require('@playwright/test');
const {startResponsesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-codex/tests/responses-fixture.ts')));
const {startMessagesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-claude-code/tests/messages-fixture.ts')));
const codex=await startResponsesFixture([{kind:'complete',text:'Codex native first'},{kind:'complete',text:'Codex native second'},{kind:'complete',text:'Codex native resumed'},{kind:'complete',text:'Codex after rollback'}]);
const delegationProbe=process.env.DSH_DELEGATION_PROBE === '1';
const quote=text=>"'"+text.replaceAll("'","'\\''")+"'";
const delegateCommand=[process.execPath,resolve('dist/delegate-cli.mjs'),'create',JSON.stringify({requestId:'web-review',harness:'codex',prompt:'Review this workspace without editing'})].map(quote).join(' ');
const claude=await startMessagesFixture(delegationProbe
 ? {kind:'tool-use',toolName:'Bash',input:{command:delegateCommand,description:'Create visible Codex review'},finalText:'Claude native reply'}
 : {kind:'complete',text:'Claude native reply'});
await mkdir('.cache',{recursive:true});
const root=await mkdtemp(resolve('.cache/web-probe-'));
const dshHome=join(root,'dsh'),codexHome=join(root,'codex'),claudeHome=join(root,'claude'),workspace=join(root,'workspace');
await Promise.all([codexHome,claudeHome,workspace].map(path=>mkdir(path)));
await writeFile(join(codexHome,'config.toml'),`model = "fixture-model"
model_provider = "fixture"
approval_policy = "on-request"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.fixture]
name = "Fixture"
base_url = "${codex.baseUrl}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
[analytics]
enabled = false
`);
await writeFile(join(claudeHome,'settings.json'),JSON.stringify({model:'claude-sonnet-4-6',permissions:{defaultMode:'default'}}));
const env={PATH:process.env.PATH,HOME:root,DSH_HOME:dshHome,DSH_TELEMETRY_DISABLED:'1',CODEX_HOME:codexHome,
 CODEXHOST_CLAUDE_COMMAND:process.env.CLAUDE_COMMAND ?? '/opt/homebrew/bin/claude',CLAUDE_CONFIG_DIR:claudeHome,
 OPENAI_API_KEY:'fixture-only',ANTHROPIC_API_KEY:'fixture-only',ANTHROPIC_BASE_URL:claude.baseUrl,
 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1',
 DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',NO_PROXY:'127.0.0.1,localhost'};
const pkg=JSON.parse(await readFile('package.json','utf8'));
const tar=resolve(process.env.DSH_PLUGIN_TAR ?? `${pkg.name}-${pkg.version}.tgz`);
const hash=createHash('sha256').update(await readFile(tar)).digest('hex').slice(0,12);
const installedTar=join(root,`plugin-${hash}.tgz`);await copyFile(tar,installedTar);
execFileSync('dsh',['plugin','--profile','web','add','--offline',installedTar],{env,stdio:'pipe'});
let child,browser,page,logs='';
async function boot(){
 const ready=Promise.withResolvers();
 child=spawn('dsh',['--profile','web','--no-open','--port','0'],{env,cwd:workspace,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>{const text=chunk.toString();const match=text.match(/dsh web: (http:\/\/[^\s]+)/);if(match)ready.resolve(match[1]);});
 child.stderr.on('data',chunk=>{logs=(logs+chunk.toString()).slice(-10000);});
 child.once('error',ready.reject);child.once('exit',()=>ready.reject(new Error('DSH exited before ready')));
 const timer=setTimeout(()=>ready.reject(new Error('DSH startup timed out')),30000);
 try{return await ready.promise;}finally{clearTimeout(timer);}
}
async function stop(){
 if(!child || child.exitCode!==null || child.signalCode!==null)return;
 const target=child,exit=new Promise(resolve=>target.once('exit',resolve));target.kill('SIGINT');
 let forced=false;
 const timer=setTimeout(()=>{forced=true;target.kill('SIGKILL');},10000);
 try{await exit;if(forced)throw new Error('DSH graceful shutdown timed out');}finally{clearTimeout(timer);}
}
async function rpc(method,request){
 const result=await page.evaluate(async ({method,request})=>{
  const response=await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{request}}})});
  if(!response.ok)throw new Error('RPC HTTP '+response.status+' '+method);
  return (await response.json()).result;
 },{method,request});
 assert.equal(result.ok,true,JSON.stringify(result));return result.value;
}
async function dismiss(){
 await page.waitForTimeout(800);
 for(const name of ['Continue','Configure later']){
  const button=page.getByRole('button',{name,exact:true});
  const visible = await button.waitFor({state:'visible',timeout:name==='Continue'?1200:6000}).then(()=>true,error=>{if(error.name==='TimeoutError')return false;throw error;});
  if(visible){await button.click();await delay(300);}
 }
}
async function send(text,reply){
 const replies=page.getByText(reply,{exact:true});
 const before=await replies.count();
 const editor=page.locator('[contenteditable="true"][role="textbox"]');
 await editor.fill(text);await editor.press('Enter');
 await expect(replies).toHaveCount(before+1,{timeout:45000});
 await expect(page.getByLabel('Select Harness model',{exact:true})).toBeEnabled({timeout:45000});
}

try{
 let url=await boot();
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1320,height:900}});
 page.setDefaultTimeout(10000);
 page.on('pageerror',error=>{logs+='\nBrowser: '+error.message;});
 await page.goto(url);await dismiss();
 const created=await rpc('workspace/create',{path:workspace});
 if(process.env.DSH_IMAGE_PROBE === '1'){
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC','base64');
  for(const [harness,label,reply] of [['codex','Codex','Codex native first'],['claude-code','Claude Code','Claude native reply']]){
   if(harness==='codex'){
    await rpc('session/create',{workspaceId:created.workspace.workspaceId,sessionId:'image-'+harness});
    await page.reload();
   }else await page.getByRole('button').filter({hasText:'New Session'}).first().click();
   await dismiss();
   const selector=page.getByLabel('Select Harness',{exact:true});await selector.click();
   await page.getByRole('menuitemradio',{name:label,exact:true}).click();
   await page.locator('input[type="file"]').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});
   await page.locator('[contenteditable="true"][role="textbox"]').fill('Describe the attached image');
   const responsePromise=page.waitForResponse(response=>response.url().includes('/api/session/prompt'));
   await page.getByRole('button',{name:'Send message',exact:true}).click();
   const response=await responsePromise; const payload=await response.json();
   assert.equal(payload.result?.ok,true,JSON.stringify(payload));
   await expect(page.getByText(reply,{exact:true})).toBeVisible({timeout:45000});
   const requests=harness==='codex'?codex.requests:claude.requests;
   assert.ok(requests.some(request=>JSON.stringify(request.body).includes(harness==='codex'?'input_image':'"type":"image"')),'native model request must contain image');
   console.log('PASS: '+label+' composer image upload reaches the native model request');
  }
 }else if(delegationProbe){
  const sessionId='claude-delegation-parent';
  await rpc('session/create',{workspaceId:created.workspace.workspaceId,sessionId});
  await rpc('harness/select',{sessionId,harness:'claude-code'});
  await rpc('harness/selectPermission',{sessionId,permission:'bypassPermissions'});
  await page.reload();await dismiss();
  await rpc('session/prompt',{sessionId,requestId:'delegate-web-parent',mode:'queue',content:[{type:'text',text:'Use Codex to review this workspace'}]});
  const review=page.getByText('Codex review',{exact:true});
  await review.waitFor({timeout:60000});
  await page.getByRole('button',{name:'1 tool call',exact:true}).click();
  await expect(page.getByText('Create visible Codex review',{exact:true})).toBeVisible({timeout:10000});
  console.log('PASS: Bash activity displays its purpose description instead of a raw command');
  await review.click();
  await page.getByText('Codex native first',{exact:true}).waitFor({timeout:60000});
  const childId='session-'+createHash('sha256').update(JSON.stringify([sessionId,'web-review'])).digest('hex');
  assert.equal((await rpc('harness/state',{sessionId:childId})).harness,'codex');
  assert.equal((await rpc('harness/state',{sessionId})).harness,'claude-code');
  await expect.poll(()=>claude.requests.some(request=>JSON.stringify(request.body.messages).includes(`委派会话 ${childId} 已结束`)),{timeout:60000}).toBe(true);
  await page.screenshot({path:resolve('.cache/delegation-web.png')});
  console.log('PASS: real Claude Code tool created a Codex review in the live DSH sidebar; selecting it displayed its native reply');
  console.log('PASS: delegation completion automatically woke the source Claude Code session with the result-reading instruction');
 }else{
 await rpc('session/create',{workspaceId:created.workspace.workspaceId,sessionId:'codex-web-probe'});
 await page.reload();await dismiss();
 const selector=page.getByLabel('Select Harness',{exact:true});await selector.waitFor();
 // The Harness selector is a menu: open it, pick the option; the chip then shows the bound Harness.
 const choose=async name=>{await selector.click();await page.getByRole('menuitemradio',{name,exact:true}).click();await expect(selector).toHaveText(name);};
 await choose('Codex');
 await page.getByLabel('Select Harness model',{exact:true}).waitFor();
 await send('Remember first marker','Codex native first');
 await send('Continue with second marker','Codex native second');
 await page.screenshot({path:resolve('.cache/codex-web.png')});
 console.log('PASS: original DSH composer selected Codex and displayed two native replies');
 await stop();url=await boot();await page.goto(url);await dismiss();
 await page.getByText('Remember first marker',{exact:true}).first().click();
 await expect(selector).toHaveText('Codex');
 await page.getByText('Codex native second',{exact:true}).waitFor();
 await send('Continue after restart','Codex native resumed');
 assert.ok(JSON.stringify(codex.requests[2].body.input).includes('Remember first marker'));
 console.log('PASS: DSH restart preserves the session list, transcript, and native Codex context');
 await page.getByRole('button',{name:'会话操作',exact:true}).click();
 await page.getByRole('button',{name:'回退最后一轮（保留文件）',exact:true}).click();
 await page.getByText('已回退最后一轮对话上下文，文件未改动。',{exact:true}).waitFor({timeout:30000});
 await page.getByRole('button',{name:'会话操作',exact:true}).click();
 await send('After rollback marker','Codex after rollback');
 const afterRollback=JSON.stringify(codex.requests.at(-1).body.input);
 assert.ok(afterRollback.includes('Remember first marker'));
 assert.equal(afterRollback.includes('Continue after restart'),false);
 const bindingPath=join(dshHome,'harness-plugin',createHash('sha256').update('codex-web-probe').digest('hex')+'.json');
 const uncertain=JSON.parse(await readFile(bindingPath,'utf8'));uncertain.pending='probe-uncertain';uncertain.pendingNative='not-in-native-history';
 await writeFile(bindingPath,JSON.stringify(uncertain));
 await page.reload();await dismiss();
 await page.getByRole('button',{name:'会话操作',exact:true}).click();
 await page.getByRole('button',{name:'核对原生记录',exact:true}).click();
 await page.getByText('无法确认原请求的执行结果；没有重发任何请求。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'解除暂停，不重发',exact:true}).click();
 await page.getByRole('button',{name:'回退最后一轮（保留文件）',exact:true}).waitFor();
 assert.equal((await rpc('harness/state',{sessionId:'codex-web-probe'})).recoveryRequired,false);
 assert.equal(codex.requests.length,4);
 await page.getByRole('button',{name:'会话操作',exact:true}).click();
 console.log('PASS: recovery UI keeps unknown results paused until explicit unlock, without model resubmission');
 const fork=await rpc('session/fork',{sessionId:'codex-web-probe'});
 assert.equal((await rpc('harness/state',{sessionId:fork.sessionId})).harness,'codex');
 console.log('PASS: rollback UI removes the last native turn from future context; session fork retains Harness binding');
 await page.getByRole('button').filter({hasText:'New Session'}).first().click();
 await dismiss();
 await selector.waitFor();await choose('Claude Code');
 await page.getByLabel('Select Harness model',{exact:true}).waitFor();
 await send('Claude first marker','Claude native reply');
 await send('Claude second marker','Claude native reply');
 assert.ok(claude.requests.some(request=>JSON.stringify(request.body.messages).includes('Claude first marker')&&JSON.stringify(request.body.messages).includes('Claude second marker')));
 await page.screenshot({path:resolve('.cache/claude-web.png')});
 console.log('PASS: original DSH composer selected Claude Code and maintained its native context');
 await stop();url=await boot();await page.goto(url);await dismiss();
 await page.getByText('Claude first marker',{exact:true}).first().click();
 await expect(selector).toHaveText('Claude Code');
 await send('Claude after restart','Claude native reply');
 assert.ok(claude.requests.some(request=>JSON.stringify(request.body.messages).includes('Claude first marker')&&JSON.stringify(request.body.messages).includes('Claude after restart')));
 console.log('PASS: DSH restart and the original session list resume Claude Code with prior context');
 }
 console.log('Native replies came only from local fixture servers; no real model endpoint was used.');
} catch(error){
 if(page){console.error((await page.locator('body').innerText()).slice(-7000));await page.screenshot({path:resolve('.cache/web-failure.png')});}
 console.error(logs.replace(/token=[\w-]+/g,'token=[redacted]'));throw error;
} finally {
 await browser?.close();await stop();await Promise.all([codex.close(),claude.close()]);
 if(process.env.KEEP_DSH_PROBE)console.log('Retained test directory:',root);else await rm(root,{recursive:true,force:true});
}
