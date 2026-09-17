import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { HarnessOutputChannel } from '../dist/contracts.js';
import { HarnessService, inject } from '../dist/dsh.js';
import { delegationInstructions } from '../dist/delegation.js';

const exec = promisify(execFile);
test('session CLI creates a visible independent harness session, reads its result, and rejects duplicate changes and foreign access', {timeout:15000}, async () => {
 const root = await mkdtemp(join(tmpdir(), 'dsh-delegate-'));
 const ctx = new Context();
 const opens = [], turns = [], created = [], renamed = [], nativePrompts = [], presetSets = [];
 let raceState = false, renameUnavailable = false, unavailable = false, reply = 'Review complete: no findings';
 const workspace = {id:'workspace',path:root,sessionIds:['parent','other']};
 class Commands extends Service {
  constructor(ctx) { super(ctx, 'sessionController'); }
  async resolveAgent(id) { const agent=ctx.agents.get(id); return agent ? {agent} : {error:new Error('missing session')}; }
  async create(request) {
   created.push(request);assert.equal(request.workspaceId,workspace.id);
   let agent=ctx.agents.get(request.sessionId);
   if (!agent) ({agent}=await ctx.agents.create({sessionId:request.sessionId,meta:{cwd:root}}));
   // A UI state read that passes its fresh-session checks before the native delegation record is written.
   if (raceState) { raceState=false;const state=ctx.harness.state({sessionId:agent.id});await new Promise(resolve=>setTimeout(resolve,20));created.race=state; }
   workspace.sessionIds.push(agent.id);return {sessionId:agent.id};
  }
  async prompt(request) {
   if (await ctx.harness.bindings.read(request.sessionId)) throw new Error('Must route through selected Harness');
   nativePrompts.push(request);
   ctx.agents.get(request.sessionId).followup(createUserMessage({content:request.content,source:{kind:'user',rpcId:request.requestId}}));
   return {accepted:true};
  }
  async rename(request) { if (renameUnavailable) throw new Error('rename unavailable'); renamed.push(request); }
  async fork() {} async selectModel() {} updateQueue() {}
 }
 const adapter = harness => ({
  async inspect() { return unavailable ? {status:'unavailable',error:{message:'fixture unavailable'}} : {status:'ready',catalog:{models:[],thinkingOptions:[]},
   permissionModes:{modes:[{id:'read-only',label:'Read only'},{id:'agent',label:'Agent'},{id:'default',label:'Default'},{id:'acceptEdits',label:'Accept edits'}],defaultModeId:'read-only'}}; },
  async open(input) {
   opens.push({harness,input});
   if (harness === 'codex') assert.equal(input.environment,undefined);
   const channel=new HarnessOutputChannel();
   return {ok:true,value:{initialState:{},outputs:channel.outputs,async close(){channel.end();},async execute(command){
    if (harness === 'claude-code') {
     channel.emit({kind:'event',event:{type:'turn.completed',turnId:command.turnId,outcome:{status:'succeeded'}}});
     return {ok:true,value:{turnId:command.turnId}};
    }
    turns.push(command);assert.equal(command.type,'turn.start');
    assert.deepEqual(command.input,[{type:'text',text:'Review this diff without editing'}]);
    channel.emit({kind:'event',event:{type:'item.completed',turnId:command.turnId,snapshot:{item:{type:'agentMessage',itemId:'answer',text:reply},outcome:{status:'succeeded'}}}});
    channel.emit({kind:'event',event:{type:'turn.completed',turnId:command.turnId,outcome:{status:'succeeded'}}});
    return {ok:true,value:{turnId:command.turnId}};
   }}};
  }, async close() {},
 });
 try {
  for (const plugin of [Llm,Sessions,Projections,Prompt,Tools,Agents,Typert]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence,{root:join(root,'sessions'),compression:'none'});
  await ctx.plugin(Commands);
  ctx.provide('userQuestions',{});ctx.provide('workspaceRegistry',{list:()=>[workspace]});
  ctx.provide('attachments',{});ctx.provide('fileUploads',{});ctx.provide('sessionTitle',{});
  const permissionPresets={names:['read-only','workspace-write'],current:()=>'read-only',resolve:name=>({sandbox:name}),set:(session,name)=>presetSets.push([session.id,name])};
  let disposePermissionPresets=ctx.provide('permissionPresets',permissionPresets);
  await ctx.plugin({inject,apply(scope){new HarnessService(scope,join(root,'bindings'),{codex:adapter('codex'),'claude-code':adapter('claude-code')});}});
  ctx.on('agent/pre-step',async(payload,next)=>payload.agent.id==='other'||!(await ctx.harness.bindings.read(payload.agent.id))?{kind:'enter',messages:[]}:next());
  await ctx.plugin(Loop,{agents:[]});
  await ctx.agents.create({sessionId:'parent',meta:{cwd:root}});
  await ctx.agents.create({sessionId:'other',meta:{cwd:root}});
  const h=ctx.harness;
  await h.bindings.write({version:1,sessionId:'parent',harness:'claude-code',cwd:root,locked:true,permission:'default'});
  await h.bindings.writeDefaults({harness:'claude-code'});
  const environment=await h.delegation.environment('parent');
  const cli = async (method,value,env=environment) => JSON.parse((await exec(process.execPath,[resolve('dist/delegate-cli.mjs'),method,typeof value==='string'?value:JSON.stringify(value)],{env:{...process.env,...env}})).stdout);
  const request={requestId:'review-1',harness:'codex',prompt:'Review this diff without editing'};
  const [first,retry] = await Promise.all([cli('create',request),cli('create',request)]);
  assert.equal(first.sessionId,retry.sessionId);assert.equal(created.length,1);
  const child=ctx.agents.get(first.sessionId);await child.whenIdle();
  assert.equal(opens.length,1);assert.equal(opens[0].harness,'codex');assert.equal(opens[0].input.kind,'create');
  assert.equal(opens[0].input.cwd,root);assert.equal(opens[0].input.permissionModeId,'agent');
  assert.equal(opens[0].input.nativeRef,undefined);
  // Without a title the list shows the harness and the task's first line.
  assert.deepEqual(renamed,[{sessionId:first.sessionId,title:'Codex · Review this diff without editing'}]);
  assert.ok(workspace.sessionIds.includes(first.sessionId));
  assert.deepEqual(await h.bindings.readDefaults(),{harness:'claude-code'});
  assert.equal((await h.bindings.read('parent')).harness,'claude-code');
  assert.equal((await h.state({sessionId:first.sessionId})).harness,'codex');
  await assert.rejects(h.delegate(first.sessionId,{...request,requestId:'nested-review'}),/委派子会话不能再次委派/);
  const result=await cli('read',first.sessionId);
  assert.equal(result.status,'completed');assert.equal(result.text,'Review complete: no findings');
  assert.equal(child.session.snapshotEvents().filter(e=>e.type==='user/message').length,1);
  assert.equal(JSON.stringify(child.session.snapshotEvents()).includes(environment.DSH_DELEGATE_TOKEN),false);
  await cli('create',request);assert.equal(turns.length,1);
  await h.notifyDelegation(first.sessionId);
  await ctx.agents.get('parent').whenIdle();
  const notifications=ctx.agents.get('parent').session.snapshotEvents().filter(e=>e.type==='user/message' && e.data.source.kind==='plugin');
  assert.equal(notifications.length,1);
  assert.match(notifications[0].data.content[0].text,/分页读取完整结果/);
  assert.ok(ctx.tools.get('harness_delegate'));assert.ok(ctx.tools.get('harness_delegate_read'));
  await assert.rejects(cli('create',{...request,prompt:'changed'}),error => /不同任务/.test(error.stdout));
  await assert.rejects(cli('create',{...request,harness:'unknown'}));
  await assert.rejects(cli('create',{...request,prompt:'  '}));
  await assert.rejects(cli('read',first.sessionId,await h.delegation.environment('other')),error => /只能读取/.test(error.stdout));
  const denied=await fetch(environment.DSH_DELEGATE_ENDPOINT+'/read',{method:'POST',body:'{}'});
  assert.equal(denied.status,403);
  const browser=await fetch(environment.DSH_DELEGATE_ENDPOINT+'/read',{method:'POST',headers:{authorization:'Bearer '+environment.DSH_DELEGATE_TOKEN,origin:'https://example.com'},body:'{}'});
  assert.equal(browser.status,403);
  const oversized=await fetch(environment.DSH_DELEGATE_ENDPOINT+'/create',{method:'POST',headers:{authorization:'Bearer '+environment.DSH_DELEGATE_TOKEN},body:' '.repeat(256001)});
  assert.equal(oversized.status,413);
  unavailable=true;
  await assert.rejects(cli('create',{...request,requestId:'unavailable',harness:'claude-code'}),error => /fixture unavailable/.test(error.stdout));
  assert.equal(created.length,1);
  const prompt=ctx.sessionController.prompt;
  ctx.sessionController.prompt=async()=>{throw new Error('admission unavailable');};
  const retryRequest={...request,requestId:'retry-admission'};
  await assert.rejects(cli('create',retryRequest),error=>/admission unavailable/.test(error.stdout));
  assert.equal(created.length,2);
  ctx.sessionController.prompt=prompt;
  reply='完整结果'.repeat(20000);
  const admitted=await cli('create',retryRequest);await ctx.agents.get(admitted.sessionId).whenIdle();
  assert.equal(created.length,2);assert.equal(turns.length,2);
  let page=await cli('read',admitted.sessionId), full=page.text;
  while(page.nextOffset!==null){page=await cli('read',JSON.stringify({sessionId:admitted.sessionId,offset:page.nextOffset,throughSeq:page.throughSeq}));full+=page.text;}
  assert.equal(full,reply);
  // A cold, locked admission without a recorded turn must not silently replay.
  ctx.sessionController.prompt=async()=>{throw new Error('admission unavailable');};
  const uncertainRequest={...request,requestId:'uncertain-admission'};
  await assert.rejects(cli('create',uncertainRequest));
  ctx.sessionController.prompt=prompt;
  const uncertainId=created.at(-1).sessionId;
  const uncertain=await h.bindings.read(uncertainId);uncertain.locked=true;await h.bindings.write(uncertain);
  await assert.rejects(cli('create',uncertainRequest),error=>/禁止自动重发/.test(error.stdout));
  assert.equal((await cli('read',uncertainId)).status,'recovery-required');assert.equal(turns.length,2);
  const nativeAgent=ctx.agents.get('other');
  const createdBeforeMissingPresets=created.length;
  await disposePermissionPresets();
  await assert.rejects(h.delegate('other',{requestId:'missing-presets',harness:'dsh',prompt:'Handle this with DSH'}),/权限预设服务不可用/);
  assert.equal(created.length,createdBeforeMissingPresets);
  disposePermissionPresets=ctx.provide('permissionPresets',permissionPresets);
  permissionPresets.names.splice(0);
  await assert.rejects(h.delegate('other',{requestId:'missing-preset',harness:'dsh',prompt:'Handle this with DSH'}),/不支持来源会话的权限模式/);
  assert.equal(created.length,createdBeforeMissingPresets);
  permissionPresets.names.push('read-only','workspace-write');
  let stopNativeNotice;
  const nativeNotice=new Promise(resolve=>{stopNativeNotice=ctx.on('agent/inbox/inserted',({agent,message})=>{
   if(agent.id==='other'&&message.source.kind==='plugin'&&message.source.summary.startsWith('DSH delegation '))resolve(message);
  });});
  const delegated=await ctx.tools.execute({callId:'native-delegate',name:'harness_delegate',arguments:{...request,requestId:'native-source'},agent:nativeAgent,signal:new AbortController().signal});
  assert.equal(delegated.isError,false,JSON.stringify(delegated));
  const nativeChild=JSON.parse(delegated.content[0].text);
  await ctx.agents.get(nativeChild.sessionId).whenIdle();
  let nativeNoticeTimeout;
  const notice=await Promise.race([nativeNotice,new Promise((_,reject)=>{nativeNoticeTimeout=setTimeout(()=>reject(new Error('missing automatic delegation notice')),1000);})]);
  clearTimeout(nativeNoticeTimeout);await stopNativeNotice();
  assert.ok(notice.source.summary.startsWith(`DSH delegation ${nativeChild.sessionId}:`));
  const nativeRead=await ctx.tools.execute({callId:'native-read',name:'harness_delegate_read',arguments:{sessionId:nativeChild.sessionId},agent:nativeAgent,signal:new AbortController().signal});
  assert.equal(nativeRead.isError,false,JSON.stringify(nativeRead));
  assert.equal(JSON.parse(nativeRead.content[0].text).status,'completed');
  const opensBeforeNative=opens.length;
  // A rejected native admission leaves the child unstarted; retrying the same request resends it once.
  ctx.sessionController.prompt=async()=>{throw new Error('model unavailable');};
  raceState=true;
  const rejected=await ctx.tools.execute({callId:'native-dsh-rejected',name:'harness_delegate',arguments:{requestId:'native-dsh',harness:'dsh',prompt:'Handle this with DSH'},agent:nativeAgent,signal:new AbortController().signal});
  ctx.sessionController.prompt=prompt;
  assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/model unavailable/);
  await created.race;
  assert.equal((await h.bindings.readDelegated(created.at(-1).sessionId))?.harness,'dsh');
  assert.equal((await h.readDelegation('other',{sessionId:created.at(-1).sessionId})).status,'not-started');
  const dshDelegated=await ctx.tools.execute({callId:'native-dsh-delegate',name:'harness_delegate',arguments:{requestId:'native-dsh',harness:'dsh',prompt:'Handle this with DSH'},agent:nativeAgent,signal:new AbortController().signal});
  assert.equal(dshDelegated.isError,false,JSON.stringify(dshDelegated));
  const dshChild=JSON.parse(dshDelegated.content[0].text);
  await ctx.agents.get(dshChild.sessionId).whenIdle();
  assert.equal(opens.length,opensBeforeNative);
  assert.equal(nativePrompts.filter(entry=>entry.sessionId===dshChild.sessionId).length,1);
  assert.deepEqual(presetSets,[[dshChild.sessionId,'read-only']]);
  assert.equal(nativePrompts.at(-1).sessionId,dshChild.sessionId);
  assert.equal((await h.state({sessionId:dshChild.sessionId})).harness,'dsh');
  // Sidebar marks badge delegated children of either kind; the source session is not delegated.
  assert.deepEqual(await h.harnesses({sessionIds:[first.sessionId,dshChild.sessionId,'other']}),
   {[first.sessionId]:{harness:'codex',delegated:true},[dshChild.sessionId]:{harness:'dsh',delegated:true},other:{harness:'dsh',delegated:false}});
  const dshRead=await h.readDelegation('other',{sessionId:dshChild.sessionId});
  assert.equal(dshRead.harness,'dsh');assert.equal(dshRead.status,'completed');
  const nativePromptCount=nativePrompts.length;
  assert.equal((await h.delegate('other',{requestId:'native-dsh',harness:'dsh',prompt:'Handle this with DSH'})).sessionId,dshChild.sessionId);
  assert.equal(nativePrompts.length,nativePromptCount);
  await h.notifyDelegation(dshChild.sessionId);await nativeAgent.whenIdle();
  assert.ok(nativeAgent.session.snapshotEvents().some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted?.some(message=>message.source.kind==='plugin'&&message.source.summary.startsWith(`DSH delegation ${dshChild.sessionId}:`))));
  await assert.rejects(h.delegate(dshChild.sessionId,{...request,requestId:'nested-native'}),/委派子会话不能再次委派/);
  assert.deepEqual(renamed.at(-1),{sessionId:dshChild.sessionId,title:'DSH 原生 · Handle this with DSH'});
  // A crash before admission leaves an unlocked record; if the user then uses the child, retry must not append the task.
  renameUnavailable=true;
  const interruptedCreate={requestId:'native-unlocked',harness:'dsh',prompt:'Handle this with DSH'};
  await assert.rejects(h.delegate('other',interruptedCreate),/rename unavailable/);
  renameUnavailable=false;
  const unlockedId=created.at(-1).sessionId, unlockedAgent=ctx.agents.get(unlockedId);
  unlockedAgent.session.append('turn/start',{turn:1});
  const promptsBeforeUnlockedRetry=nativePrompts.length;
  assert.equal((await h.delegate('other',interruptedCreate)).sessionId,unlockedId);
  assert.equal(nativePrompts.length,promptsBeforeUnlockedRetry);
  assert.equal((await h.readDelegation('other',{sessionId:unlockedId})).status,'interrupted');
  // An external source maps to the native preset of the same sandbox level.
  const fromExternal=await h.delegate('parent',{requestId:'external-to-dsh',harness:'dsh',prompt:'Handle this with DSH'});
  assert.deepEqual(presetSets.at(-1),[fromExternal.sessionId,'workspace-write']);
  const titled=await cli('create',{...request,requestId:'titled-task',title:'修复登录错误'});
  assert.deepEqual(renamed.at(-1),{sessionId:titled.sessionId,title:'修复登录错误'});
  // Delegation is for any work the user hands off, not only review.
  assert.doesNotMatch(delegationInstructions(),/只审查|review\/审查|codex exec review/);
  assert.match(delegationInstructions(),/harness 支持 dsh、codex、claude-code/);
  assert.match(delegationInstructions(),/结束当前轮次.*等待.*完成通知/s);
  assert.match(delegationInstructions(),/不要.*sleep.*read.*轮询/s);
  assert.match(delegationInstructions(),/not-started.*相同.*重试/s);
  assert.match(delegationInstructions(),/interrupted.*目标会话/s);
  assert.match(ctx.tools.get('harness_delegate').description,/结束当前轮次.*等待.*通知/s);
  assert.match(ctx.tools.get('harness_delegate').description,/不要.*轮询/s);
  assert.match(ctx.tools.get('harness_delegate_read').description,/not-started.*相同.*重试/s);
 } finally { await ctx.fiber.dispose();await rm(root,{recursive:true,force:true}); }
});
