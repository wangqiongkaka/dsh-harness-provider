import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context,Service} from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import {HarnessService,inject} from '../dist/dsh.js';

test('thinking selection validates against the catalog, persists, and quota reads the account snapshot once per minute',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-harness-service-'));
 const ctx=new Context();
 const agent={id:'bound',status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:root},snapshotEvents:()=>[],requestHeader:()=>undefined}};
 const fresh={...agent,id:'fresh',session:{...agent.session}};
 const started={...agent,id:'started',session:{...agent.session,snapshotEvents:()=>[{type:'user/message'}]}};
 class NativeCommands extends Service {
  constructor(ctx){super(ctx,'sessionController');}
  async resolveAgent(id){return {agent:{bound:agent,fresh,started}[id]};}
  async prompt(){return {accepted:true};} async fork(){return {};} async selectModel(){return {};} updateQueue(){return {};}
 }
 let inspections=0, accounts=0;
 const adapter={
  async inspect(){inspections++;return {status:'ready',capabilities:{},catalog:{
   models:[{ref:{id:'m1'},label:'One',resolvedModelLabel:'one-2026',supportedThinkingOptionIds:['low','high']},{ref:{id:'m2'},label:'Two',supportedThinkingOptionIds:['low']}],
   thinkingOptions:[{id:'low',label:'Low'},{id:'high',label:'High'}],defaultModel:{id:'m1'},defaultThinkingOptionId:'high',
   configOptions:[{id:'collaboration_mode',label:'Collaboration mode',currentValue:'default',choices:[{value:'default',label:'Default'},{value:'plan',label:'Plan'}]},{id:'fast-mode',label:'Fast mode',currentValue:false}]},
   permissionModes:{modes:[{id:'default',label:'Default'},{id:'bypassPermissions',label:'Bypass',dangerous:true}],defaultModeId:'default'}};},
  async inspectAccount(){accounts++;return {plan:'pro',credits:{usedPercent:40,periodType:'five_hour',productUsage:[{product:'Opus · 7-day',usagePercent:12}]}};},
  async close(){},
 };
 try{
  await ctx.plugin(Typert);await ctx.plugin(NativeCommands);
  ctx.provide('agents',{get:()=>agent});ctx.provide('sessions',{});ctx.provide('userQuestions',{});
  ctx.provide('sessionProjections',{stateOf:(session,key)=>{assert.equal(session.header.cwd,root);return key==='permissions'?{sandbox:'danger-full-access'}:undefined;}});
  ctx.provide('attachments',{});ctx.provide('fileUploads',{});
  await ctx.plugin({inject,apply(scope){new HarnessService(scope,root,{codex:adapter,'claude-code':adapter});}});
  const h=ctx.harness;
  assert.equal(await h.quota({sessionId:'bound'}),null); // native session, no provider route exposed here
  // Native full access carries over when the Harness offers the matching mode; Codex ids differ from this catalog, so nothing is seeded.
  assert.equal((await h.select({sessionId:'bound',harness:'claude-code'})).permission,'bypassPermissions');
  await h.select({sessionId:'bound',harness:'dsh'});
  assert.equal((await h.select({sessionId:'bound',harness:'codex'})).permission,null);
  const catalog=await h.models({sessionId:'bound'});
  assert.deepEqual(catalog.thinkingOptions,[{id:'low',label:'Low'},{id:'high',label:'High'}]);
  assert.equal(catalog.defaultThinkingOptionId,'high');
  assert.deepEqual(catalog.models[1],{id:'m2',label:'Two',resolved:null,thinkingOptionIds:['low']});
  assert.deepEqual(catalog.defaultModel,{id:'m1',label:'One',resolved:'one-2026'});
  assert.deepEqual(catalog.permissionModes,[{id:'default',label:'Default',dangerous:false},{id:'bypassPermissions',label:'Bypass',dangerous:true}]);
  assert.equal(catalog.defaultPermissionModeId,'default');
  assert.deepEqual(catalog.configOptions.map(option=>[option.id,option.currentValue]),[['collaboration_mode','default'],['fast-mode',false]]);
  assert.equal((await h.selectConfig({sessionId:'bound',configId:'collaboration_mode',value:'plan'})).configs.collaboration_mode,'plan');
  assert.equal((await h.selectConfig({sessionId:'bound',configId:'fast-mode',value:true})).configs['fast-mode'],true);
  await assert.rejects(h.selectConfig({sessionId:'bound',configId:'collaboration_mode',value:'invalid'}),/未提供/);
  assert.equal((await h.selectPermission({sessionId:'bound',permission:'bypassPermissions'})).permission,'bypassPermissions');
  await assert.rejects(h.selectPermission({sessionId:'bound',permission:'root'}),/不支持/);
  let state=await h.selectThinking({sessionId:'bound',thinking:'low'});
  assert.equal(state.thinking,'low');
  assert.equal((await h.state({sessionId:'bound'})).thinking,'low');
  await assert.rejects(h.selectThinking({sessionId:'bound',thinking:'ultra'}),/不支持/);
  state=await h.selectModel({sessionId:'bound',model:'m2'});
  assert.equal(state.thinking,'low');
  state=await h.selectThinking({sessionId:'bound',thinking:'high'}).catch(e=>e);
  assert.match(state.message,/不支持/); // m2 lacks 'high'
  state=await h.selectModel({sessionId:'bound',model:'m1'});
  await h.selectThinking({sessionId:'bound',thinking:'high'});
  state=await h.selectModel({sessionId:'bound',model:'m2'});
  assert.equal(state.thinking,null); // unsupported level dropped on model switch
  // The last pick per Harness seeds the next session bound to it; a level the remembered model lacks is not carried over.
  await h.selectModel({sessionId:'bound',model:'m1'});await h.selectThinking({sessionId:'bound',thinking:'high'});
  await h.select({sessionId:'bound',harness:'dsh'});
  state=await h.select({sessionId:'bound',harness:'codex'});
  assert.equal(state.model,'m1');assert.equal(state.thinking,'high');
  await h.selectModel({sessionId:'bound',model:'m2'});
  await h.select({sessionId:'bound',harness:'dsh'});
  state=await h.select({sessionId:'bound',harness:'codex'});
  assert.equal(state.model,'m2');assert.equal(state.thinking,null);
  // A fresh session starts on the last picked Harness with its remembered choices; a started one stays native; picking native clears it.
  state=await h.state({sessionId:'fresh'});
  assert.equal(state.harness,'codex');assert.equal(state.model,'m2');
  assert.equal((await h.state({sessionId:'started'})).harness,'dsh');
  await h.select({sessionId:'bound',harness:'dsh'});
  await h.select({sessionId:'fresh',harness:'dsh'});
  assert.equal((await h.state({sessionId:'fresh'})).harness,'dsh');
  await h.select({sessionId:'bound',harness:'codex'});
  assert.equal(inspections,2); // one per harness, cached per cwd afterwards
  const quota=await h.quota({sessionId:'bound'});
  assert.deepEqual(quota,{kind:'windows',source:'codex',plan:'pro',windows:[
   {id:'five_hour',label:'five_hour',usedPercent:40,resetsAt:null},{id:'product:Opus · 7-day',label:'Opus · 7-day',usedPercent:12,resetsAt:null}]});
  await h.quota({sessionId:'bound'});
  assert.equal(accounts,1);
  assert.equal(await h.usage({sessionId:'bound'}),null);
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});
