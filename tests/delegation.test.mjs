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
import LocalAttachments from '@deepseek-ai/dsh-attachment-local';
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
   permissionModes:{modes:[{id:'read-only',label:'Read only'},{id:'plan',label:'Plan'},{id:'agent',label:'Agent'},{id:'default',label:'Default'},{id:'acceptEdits',label:'Accept edits'}],defaultModeId:'read-only'}}; },
  async open(input) {
   opens.push({harness,input});
   if (harness === 'codex' && !input.discussion) assert.ok(input.environment?.DSH_DELEGATE_TOKEN);
   const channel=new HarnessOutputChannel();
   return {ok:true,value:{initialState:{effectivePermissionModeId:input.permissionModeId},outputs:channel.outputs,async close(){channel.end();},async execute(command){
    if (harness === 'claude-code') {
     channel.emit({kind:'event',event:{type:'turn.completed',turnId:command.turnId,outcome:{status:'succeeded'}}});
     return {ok:true,value:{turnId:command.turnId}};
    }
    turns.push(command);assert.equal(command.type,'turn.start');
    channel.emit({kind:'event',event:{type:'item.completed',turnId:command.turnId,snapshot:{item:{type:'agentMessage',itemId:'answer',text:reply},outcome:{status:'succeeded'}}}});
    channel.emit({kind:'event',event:{type:'turn.completed',turnId:command.turnId,outcome:{status:'succeeded'}}});
    return {ok:true,value:{turnId:command.turnId}};
   }}};
  }, async close() {}, async listSkills() { return [{name:'handoff',description:'Write a hand-off',modelInvocable:true}]; },
 });
 try {
  await ctx.plugin(LocalAttachments,{dshHome:root});
  for (const plugin of [Llm,Sessions,Projections,Prompt,Tools,Agents,Typert]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence,{root:join(root,'sessions'),compression:'none'});
  await ctx.plugin(Commands);
  ctx.provide('userQuestions',{});ctx.provide('workspaceRegistry',{list:()=>[workspace]});
  const stagedFile=await ctx.attachments.saveFile({data:Buffer.from('attachment text'),name:'note.txt'});
  let receiptCommitted=false;
  ctx.provide('fileUploads',{
   resolve:(agent,id)=>agent.id==='other'&&id==='receipt-note'?stagedFile:undefined,
   bindPrompt:()=>({commit(){receiptCommitted=true;},[Symbol.dispose](){}}),
  });ctx.provide('sessionTitle',{});ctx.provide('sessionSkillCatalog',{async list(){return {skills:[]};}});
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
  const environment=await h.delegation.environment('parent',true);
  const cli = async (method,value,env=environment) => JSON.parse((await exec(process.execPath,[resolve('dist/delegate-cli.mjs'),method,typeof value==='string'?value:JSON.stringify(value)],{env:{...process.env,...env}})).stdout);
  const bridge = async (method,value,env) => {
   const response=await fetch(`${env.DSH_DELEGATE_ENDPOINT}/${method}`,{method:'POST',headers:{authorization:`Bearer ${env.DSH_DELEGATE_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(value)});
   const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
  };
  const request={requestId:'review-1',harness:'codex',prompt:'Review this diff without editing',reportBack:false};
  const [first,retry] = await Promise.all([cli('create',request),cli('create',request)]);
  assert.equal(first.sessionId,retry.sessionId);assert.equal(created.length,1);
  const child=ctx.agents.get(first.sessionId);await child.whenIdle();
  assert.deepEqual(turns[0].input,[{type:'text',text:'Review this diff without editing'}]);
  assert.equal(opens.length,1);assert.equal(opens[0].harness,'codex');assert.equal(opens[0].input.kind,'create');
  assert.equal(opens[0].input.cwd,root);assert.equal(opens[0].input.permissionModeId,'agent');
  assert.equal(opens[0].input.nativeRef,undefined);
  // Without a title the list shows the harness and the task's first line.
  assert.deepEqual(renamed,[{sessionId:first.sessionId,title:'Codex · Review this diff without editing'}]);
  assert.ok(workspace.sessionIds.includes(first.sessionId));
  assert.deepEqual(await h.bindings.readDefaults(),{harness:'claude-code'});
  assert.equal((await h.bindings.read('parent')).harness,'claude-code');
  assert.equal((await h.state({sessionId:first.sessionId})).harness,'codex');
  const result=await cli('read',first.sessionId);
  assert.equal(result.status,'completed');assert.equal(result.text,'Review complete: no findings');
  assert.equal(child.session.snapshotEvents().filter(e=>e.type==='user/message').length,1);
  assert.equal(JSON.stringify(child.session.snapshotEvents()).includes(environment.DSH_DELEGATE_TOKEN),false);
  await cli('create',request);assert.equal(turns.length,1);
  await h.notifyDelegation(first.sessionId);
  await ctx.agents.get('parent').whenIdle();
  const notifications=ctx.agents.get('parent').session.snapshotEvents().filter(e=>e.type==='user/message' && e.data.source.kind==='plugin');
  assert.equal(notifications.length,0,'reportBack=false does not wake the source session');
  assert.equal(ctx.tools.get('harness_delegate'),undefined);assert.ok(ctx.tools.get('harness_delegate_read'));
  const readOnlyEnvironment=await h.delegation.environment('parent');
  const otherEnvironment=await h.delegation.environment('other');
  await assert.rejects(cli('create',{...request,requestId:'model-must-not-create'},readOnlyEnvironment),error=>/Forbidden/.test(error.stdout));
  await assert.rejects(cli('create',{...request,prompt:'changed'}),error => /不同任务/.test(error.stdout));
  await assert.rejects(cli('create',{...request,harness:'unknown'}));
  await assert.rejects(cli('create',{...request,prompt:'  '}));
  await assert.rejects(cli('read',first.sessionId,otherEnvironment),error => /只能读取/.test(error.stdout));
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
  const nativeChild=await h.delegate('other',{...request,requestId:'native-source',reportBack:true});
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
  await assert.rejects(h.delegate('other',{requestId:'native-dsh',harness:'dsh',prompt:'Handle this with DSH',reportBack:true}),/model unavailable/);
  ctx.sessionController.prompt=prompt;
  await created.race;
  assert.equal((await h.bindings.readDelegated(created.at(-1).sessionId))?.harness,'dsh');
  assert.equal((await h.readDelegation('other',{sessionId:created.at(-1).sessionId})).status,'not-started');
  const dshChild=await h.delegate('other',{requestId:'native-dsh',harness:'dsh',prompt:'Handle this with DSH',reportBack:true});
  await ctx.agents.get(dshChild.sessionId).whenIdle();
  assert.equal(opens.length,opensBeforeNative);
  assert.equal(nativePrompts.filter(entry=>entry.sessionId===dshChild.sessionId).length,1);
  assert.deepEqual(presetSets,[[dshChild.sessionId,'read-only']]);
  assert.equal(nativePrompts.at(-1).sessionId,dshChild.sessionId);
  assert.equal((await h.state({sessionId:dshChild.sessionId})).harness,'dsh');
  // Sidebar marks badge delegated children of either kind; the source session is not delegated.
  assert.deepEqual(await h.harnesses({sessionIds:[first.sessionId,dshChild.sessionId,'other']}),
   {[first.sessionId]:{harness:'codex',delegated:true,running:true},[dshChild.sessionId]:{harness:'dsh',delegated:true,running:true},other:{harness:'dsh',delegated:false,running:true}});
  const dshRead=await h.readDelegation('other',{sessionId:dshChild.sessionId});
  assert.equal(dshRead.harness,'dsh');assert.equal(dshRead.status,'completed');
  const nativePromptCount=nativePrompts.length;
  assert.equal((await h.delegate('other',{requestId:'native-dsh',harness:'dsh',prompt:'Handle this with DSH',reportBack:true})).sessionId,dshChild.sessionId);
  assert.equal(nativePrompts.length,nativePromptCount);
  await h.notifyDelegation(dshChild.sessionId);await nativeAgent.whenIdle();
  assert.ok(nativeAgent.session.snapshotEvents().some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted?.some(message=>message.source.kind==='plugin'&&message.source.summary.startsWith(`DSH delegation ${dshChild.sessionId}:`))));
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
  const nested=await h.delegate(dshChild.sessionId,{...request,requestId:'nested-native'});
  await ctx.agents.get(nested.sessionId).whenIdle();
  assert.equal((await h.bindings.readDelegated(nested.sessionId)).delegation.parentSessionId,dshChild.sessionId);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';
  const rich=await h.delegateFromUser({sessionId:'other',requestId:'rich-user',harness:'codex',reportBack:false,prompt:'Inspect these inputs',attachments:[
   {type:'image',mediaType:'image/png',data:png,name:'pixel.png'},{type:'file',receiptId:'receipt-note'},
  ]});
  await ctx.agents.get(rich.sessionId).whenIdle();
  const richInput=turns.at(-1).input;
  assert.equal(richInput[0].type,'image');assert.ok(richInput[0].base64Data.length);
  assert.match(richInput[1].text,/note.txt/);assert.deepEqual(richInput[2],{type:'text',text:'Inspect these inputs'});
  assert.equal(receiptCommitted,true);
  // Discussion is a one-shot user authorization. The main agent chooses the participants; multiple workers get one peer-review round.
  reply='Worker result';
  const turnsBeforeDiscussion=turns.length, createdBeforeDiscussion=created.length;
  let discussionPrompt;
  const stopDiscussionPrompt=ctx.on('agent/inbox/inserted',({agent,message})=>{if(agent.id==='other'&&message.source.kind==='user'&&message.source.rpcId==='discussion-1')discussionPrompt=message;});
  await h.startDiscussionFromUser({sessionId:'other',requestId:'discussion-1',harnesses:['codex'],prompt:'Compare both approaches',attachments:[{type:'image',mediaType:'image/png',data:png,name:'pixel.png'}]});
  await stopDiscussionPrompt();
  assert.equal(discussionPrompt.content[0].text,'/discuss Compare both approaches\n\n参与 Harness：codex；每个选中的 Harness 至少分配一个参与者，只使用这些 Harness。');
  await ctx.agents.get('other').whenIdle();
  await assert.rejects(h.discuss('other',{assignments:[{harness:'codex',task:'Too late'}]}),/请先由用户使用 \/discuss/,'unused authorization expires with the source turn');
  h.discussions.set('other',{requestId:'discussion-1',content:[...discussionPrompt.content.slice(1),{type:'text',text:'Compare both approaches'}]});
  const discussionAssignments={assignments:[
   {harness:'codex',role:'correctness',task:'Check correctness'},
   {harness:'codex',role:'simplicity',task:'Find the simplest design'},
  ]};
  const discussion=await bridge('discuss',discussionAssignments,otherEnvironment);
  assert.equal(discussion.participants.length,2);assert.equal(discussion.peerReview,true);
  for (const participant of discussion.participants) {
   const binding=await h.bindings.readDelegated(participant.sessionId);
   assert.equal(binding.delegation.discussion,true);
   assert.equal(binding.permission,'read-only');
   await assert.rejects(h.selectPermission({sessionId:participant.sessionId,permission:'agent'}),/讨论/);
   await assert.rejects(h.selectConfig({sessionId:participant.sessionId,configId:'anything',value:true}),/讨论/);
   await assert.rejects(h.delegate(participant.sessionId,{...request,requestId:'nested-discussion'}),/讨论/);
  }
  assert.equal(created.length,createdBeforeDiscussion+2);
  assert.equal(turns.length,turnsBeforeDiscussion+4,'two workers each run once and review once');
  assert.ok(turns.slice(turnsBeforeDiscussion,turnsBeforeDiscussion+2).every(turn=>JSON.stringify(turn.input).includes('Compare both approaches')));
  assert.ok(turns.slice(turnsBeforeDiscussion,turnsBeforeDiscussion+2).every(turn=>turn.input.some(part=>part.type==='image')));
  assert.ok(turns.slice(-2).every(turn=>JSON.stringify(turn.input).includes('讨论互评')&&JSON.stringify(turn.input).includes('Worker result')));
  const retried=await bridge('discuss',discussionAssignments,otherEnvironment);
  assert.deepEqual(retried.participants.map(participant=>participant.sessionId),discussion.participants.map(participant=>participant.sessionId));
  assert.equal(created.length,createdBeforeDiscussion+2);assert.equal(turns.length,turnsBeforeDiscussion+4);
  h.discussions.delete('other');
  await assert.rejects(h.discuss('parent',{assignments:[{harness:'codex',task:'Not user authorized'}]}),/请先由用户使用 \/discuss/);
  const singleTurns=turns.length;
  h.discussions.set('other',{requestId:'discussion-single',content:[{type:'text',text:'Handle one focused task'}]});
  await assert.rejects(h.discuss('other',{assignments:Array.from({length:5},(_,i)=>({harness:'codex',task:`Task ${i}`}))}),/最多|4/);
  await assert.rejects(h.startDiscussionFromUser({sessionId:'other',requestId:'discussion-overlap',prompt:'Overlap',attachments:[]}),/讨论仍在进行|当前轮次/);
  const singleTool=await ctx.tools.execute({callId:'native-discuss',name:'harness_discussion_dispatch',arguments:{assignments:[{harness:'codex',task:'Focused task'}]},agent:nativeAgent,signal:new AbortController().signal});
  assert.equal(singleTool.isError,false,JSON.stringify(singleTool));
  const single=JSON.parse(singleTool.content[0].text);
  assert.equal(single.peerReview,false);assert.equal(turns.length,singleTurns+1,'one worker skips peer review');
  h.discussions.delete('other');
  h.discussions.set('other',{requestId:'discussion-claude',content:[{type:'text',text:'Analyze'}]});
  unavailable=false;
  h.catalogs.clear();
  const multiRequest={sessionId:'other',requestId:'multi-delegate',harnesses:['codex','claude-code'],prompt:'Same task for both',attachments:[],reportBack:false};
  const multi=await h.delegateFromUser(multiRequest);
  assert.deepEqual(multi.sessions.map(session=>session.harness),['codex','claude-code']);
  for(const session of multi.sessions){
   const agent=ctx.agents.get(session.sessionId);await agent.whenIdle();
   assert.equal(agent.session.snapshotEvents().find(event=>event.type==='user/message').data.content[0].text,'Same task for both');
  }
  const beforeMultiRetry=created.length;
  assert.deepEqual((await h.delegateFromUser(multiRequest)).sessions,multi.sessions);
  assert.equal(created.length,beforeMultiRetry);
  await assert.rejects(h.delegateFromUser({...multiRequest,requestId:'empty-multi',harnesses:[]}),/至少|1/);
  await assert.rejects(h.delegateFromUser({...multiRequest,requestId:'duplicate-multi',harnesses:['codex','codex']}),/重复/);
  await assert.rejects(h.delegateFromUser({...multiRequest,requestId:'native-worktree-multi',harnesses:['dsh','codex'],worktree:true}),/仅支持 Codex/);
  const claudeDiscussion=await h.discuss('other',{assignments:[{harness:'claude-code',task:'Analyze'}]});
  assert.equal((await h.bindings.read(claudeDiscussion.participants[0].sessionId)).permission,'plan');
  assert.equal(opens.at(-1).input.discussion,true);
  h.discussions.delete('other');
  h.discussions.set('other',{requestId:'discussion-native-denied',content:[{type:'text',text:'Analyze'}]});
  const beforeNativeDenied=created.length;
  await assert.rejects(h.discuss('other',{assignments:[{harness:'codex',task:'Analyze'},{harness:'dsh',task:'Analyze'}]}),/暂不支持强制只读/);
  assert.equal(created.length,beforeNativeDenied,'reject unsupported assignments before creating any workers');
  h.discussions.delete('other');
  // Delegation is for any work the user hands off, not only review.
  h.discussions.set('other',{requestId:'selected-discussion',content:[{type:'text',text:'Analyze'}],harnesses:['codex','claude-code']});
  await assert.rejects(h.discuss('other',{assignments:[{harness:'codex',task:'Analyze'}]}),/选中/);
  await assert.rejects(h.discuss('other',{assignments:[{harness:'dsh',task:'Analyze'},{harness:'codex',task:'Analyze'}]}),/选中/);
  const selected=await h.discuss('other',{assignments:[{harness:'codex',task:'Analyze'},{harness:'claude-code',task:'Analyze'}]});
  assert.deepEqual(selected.participants.map(participant=>participant.harness),['codex','claude-code']);
  h.discussions.delete('other');
  assert.doesNotMatch(delegationInstructions(),/只审查|review\/审查|codex exec review/);
  assert.doesNotMatch(delegationInstructions(),/ create /);
  assert.match(delegationInstructions(),/完成通知/);
  assert.match(delegationInstructions(),/不要.*sleep.*read.*轮询/s);
  assert.match(delegationInstructions(),/not-started.*进入目标会话/s);
  assert.match(delegationInstructions(),/interrupted.*目标会话/s);
  assert.match(delegationInstructions(),/\/discuss.*1.?4/s);
  assert.match(ctx.tools.get('harness_delegate_read').description,/not-started.*进入目标会话/s);
  assert.match(ctx.tools.get('harness_discussion_dispatch').description,/1.?4/);
  // `/delegate /handoff task`: the source Harness runs its own skill first; its reply goes to the delegated Harness.
  await ctx.agents.create({sessionId:'handoff-source',meta:{cwd:root}});workspace.sessionIds.push('handoff-source');
  await h.bindings.write({version:1,sessionId:'handoff-source',harness:'codex',cwd:root,locked:true,permission:'agent'});
  reply='Hand-off notes in HANDOFF.md';
  const turnsBeforeHandoff=turns.length, createdBeforeHandoff=created.length;
  const handoffRequest={sessionId:'handoff-source',requestId:'handoff-1',harness:'codex',reportBack:false,prompt:'/handoff 实现登录',attachments:[]};
  const handoff=await h.delegateFromUser(handoffRequest);
  assert.equal(handoff.sessionId,undefined,'no delegated session until the skill turn ends');
  // Two turns: the skill in the source session, then the task in the delegated one.
  for (let i=0;i<200&&turns.length<turnsBeforeHandoff+2;i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(created.length,createdBeforeHandoff+1);
  assert.deepEqual(turns[turnsBeforeHandoff].input,[{type:'text',text:'/handoff 实现登录'}],'the source session runs the skill');
  const handoffChild=created.at(-1).sessionId;await ctx.agents.get(handoffChild).whenIdle();
  assert.equal((await h.bindings.readDelegated(handoffChild)).harness,'codex');
  const handedOff=ctx.agents.get(handoffChild).session.snapshotEvents().find(event=>event.type==='user/message');
  assert.deepEqual(handedOff.data.content,[{type:'text',text:'实现登录\n\n[来源会话 /handoff 的结果]\nHand-off notes in HANDOFF.md'}]);
  await h.delegateFromUser(handoffRequest);await ctx.agents.get('handoff-source').whenIdle();
  assert.equal(created.length,createdBeforeHandoff+1,'a retried request neither reruns the skill nor delegates twice');
  assert.equal(turns.length,turnsBeforeHandoff+2);
  const plainSlash=await h.delegateFromUser({...handoffRequest,requestId:'not-a-skill',prompt:'/tmp/app 修复构建'});
  assert.ok(plainSlash.sessionId,'a leading path that is no skill is delegated directly');
  await ctx.agents.get(plainSlash.sessionId).whenIdle();
  const beforeMultiSkill=created.length;
  const multiSkillRequest={sessionId:'handoff-source',requestId:'multi-skill',harnesses:['codex','claude-code'],prompt:'/handoff 多目标',attachments:[]};
  await h.delegateFromUser(multiSkillRequest);
  await ctx.agents.get('handoff-source').whenIdle();
  for(let i=0;i<200&&created.length<beforeMultiSkill+2;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(created.length,beforeMultiSkill+2);
  for(const child of created.slice(beforeMultiSkill)){
   const agent=ctx.agents.get(child.sessionId);await agent.whenIdle();
   assert.match(agent.session.snapshotEvents().find(event=>event.type==='user/message').data.content[0].text,/多目标\n\n\[来源会话 \/handoff 的结果\]/);
  }
  await h.delegateFromUser(multiSkillRequest);
  assert.equal(created.length,beforeMultiSkill+2);
 } finally { await ctx.fiber.dispose();await rm(root,{recursive:true,force:true}); }
});
