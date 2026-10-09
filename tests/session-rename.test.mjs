import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HarnessService } from '../dist/dsh.js';
import { Bindings } from '../dist/bindings.js';
import { DelegationBridge, delegationInstructions } from '../dist/delegation.js';
const exec = promisify(execFile);
const invalid = [{title:''},{title:' \n '},{title:12},{title:'x'.repeat(513)},{title:'ok',sessionId:'other'},{title:'ok',extra:true},null,[]];
const request = async (env, method, input, headers={}) => {
 const response=await fetch(`${env.DSH_DELEGATE_ENDPOINT}/${method}`,{method:'POST',headers:{authorization:`Bearer ${env.DSH_DELEGATE_TOKEN}`,...headers},body:JSON.stringify(input)});
 return {status:response.status,result:await response.json()};
};
test('rename bridge validates before callbacks, isolates credentials, and preserves existing operations', {timeout:10000}, async()=>{
 const calls=[];
 const bridge=new DelegationBridge(async(source,method,input)=>{calls.push({source,method,input});return {title:input.title,seq:37};});
 try {
  const first=await bridge.environment('first'),second=await bridge.environment('second');
  for(const env of [first,second]) assert.deepEqual(await request(env,'rename',{title:'  New title  '}),{status:200,result:{title:'New title',seq:37}});
  assert.deepEqual(calls.map(call=>call.source),['first','second']);
  assert.equal((await request(first,'rename',{title:'x'.repeat(512)})).status,200);
  const count=calls.length;
  assert.equal((await request(first,'rename',{title:'x'.repeat(256_001)})).status,413);
  assert.equal(calls.length,count,'oversized request never reaches callback');
  for(const input of invalid) assert.equal((await request(first,'rename',input)).status,400);
  assert.equal(calls.length,count,'invalid title/forged identity never reaches callback');
  assert.equal((await request(first,'rename',{title:'ok'},{authorization:'Bearer invalid'})).status,403);
  assert.equal((await request(first,'rename',{title:'ok'},{origin:'https://example.com'})).status,403);
  assert.equal((await request(first,'rename',{title:'ok'},{authorization:''})).status,403);
  assert.equal((await fetch(first.DSH_DELEGATE_ENDPOINT+'/rename',{headers:{authorization:'Bearer '+first.DSH_DELEGATE_TOKEN}})).status,404);
  assert.equal((await request(first,'unknown',{})).status,404);
  assert.equal((await request(first,'create',{})).status,403);
  for(const method of ['read','discuss','models']) assert.equal((await request(first,method,{})).status,200);
  assert.equal((await request(await bridge.environment('first',true),'create',{})).status,200);
  assert.deepEqual(calls.slice(count).map(call=>call.method),['read','discuss','models','create']);
 } finally {await bridge.close();}
});
test('rename service requires an existing binding, returns host acceptance and preserves all sidecars', {timeout:10000}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-rename-')),bindings=new Bindings(root),calls=[];
 const service=Object.create(HarnessService.prototype);
 Object.assign(service,{bindings,ctx:{sessionController:{async rename(input){calls.push(input);return {title:input.title.replace(/\s+/g,' '),seq:42};}}}});
 const contents=async()=>Object.fromEntries(await Promise.all((await readdir(root)).sort().map(async name=>[name,await readFile(join(root,name),'utf8')])));
 try {
  for(const [sessionId,harness] of [['one','codex'],['two','claude-code']]) await bindings.write({version:1,sessionId,harness,cwd:root,locked:true,permission:'agent',model:{id:'b64.Zml4dHVyZVsxbV0'},thinking:'high',nativeRef:{harnessId:harness,nativeSessionId:`native-${sessionId}`,formatVersion:1},turns:[{turn:1,key:'history-key'}],pending:'unchanged'});
  await bindings.writeDefaults({harness:'codex',codex:{model:{id:'b64.Zml4dHVyZVsxbV0'},thinking:'high'}});
  const before=await contents();
  for(const source of ['one','two']) assert.deepEqual(await service.renameCurrentSession(source,{title:'  Concise   title  '}),{title:'Concise title',seq:42});
  assert.deepEqual(calls.map(call=>call.sessionId),['one','two']);assert.ok(calls.every(call=>call.title==='Concise   title'));
  for(const input of invalid) await assert.rejects(service.renameCurrentSession('one',input));
  await assert.rejects(service.renameCurrentSession('missing',{title:'Title'}),/绑定|binding/i);
  assert.equal(calls.length,2);assert.deepEqual(await contents(),before);
  service.ctx.sessionController.rename=async()=>{throw new Error('host rename failed');};
  await assert.rejects(service.renameCurrentSession('one',{title:'Title'}),/host rename failed/);
  assert.deepEqual(await contents(),before);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('CLI rename sends JSON and reports errors without leaking credentials', {timeout:10000}, async()=>{
 const bridge=new DelegationBridge(async(source,method,input)=>{assert.equal(source,'own');assert.equal(method,'rename');if(input.title==='fail')throw new Error('host rejected');return {title:input.title,seq:9};});
 try {
  const env=await bridge.environment('own');
  const cli=value=>exec(process.execPath,[resolve('dist/delegate-cli.mjs'),'rename',value],{env:{...process.env,...env},timeout:3000});
  assert.deepEqual(JSON.parse((await cli('{"title":" Title "}')).stdout),{title:'Title',seq:9});
  for(const value of ['{"title":"fail"}','{"title":"ok","sessionId":"other"}','bad-json']) await assert.rejects(cli(value),error=>{assert.equal(error.code,1);assert.ok(!(error.stdout+error.stderr).includes(env.DSH_DELEGATE_TOKEN));return true;});
  assert.match(delegationInstructions(),/delegate-cli\.mjs' rename '\{"title":/);
  assert.match(delegationInstructions(),/明确.*当前 DSH.*标题/);
  assert.match(delegationInstructions(),/返回.*title.*seq.*成功/s);
 } finally {await bridge.close();}
});
