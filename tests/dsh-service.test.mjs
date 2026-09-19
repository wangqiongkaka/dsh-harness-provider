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
  const childEvents=[
   {type:'user/message',data:{content:[{type:'text',text:'Map the repo\nthoroughly'}]}},
   {type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'plan'},{type:'text',text:'Looking'},{type:'tool-call',id:'c1',name:'bash',arguments:'{"command":"ls"}'},{type:'tool-call',id:'c2',name:'read',arguments:'{"file_path":"a.ts"}'}]}}},
   {type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:'c1',content:[{type:'text',text:'src'}],isError:false}]}}},
   {type:'turn/end',data:{reason:{kind:'completed'}}},
  ];
  ctx.provide('subagents',{listDescendants:async id=>id==='started'?[{kind:'child',id:'child',parentId:'started',depth:1,mode:'one-shot',label:'explorer'},{kind:'diagnostic',id:'bad',reason:'corrupt'},{kind:'child',id:'grandchild',parentId:'child',depth:2,mode:'one-shot'}]:[]});
  ctx.provide('sessionQuery',{observeSession:async id=>({events:id==='child'?childEvents:[],[Symbol.dispose](){}})});
  await ctx.plugin({inject,apply(scope){new HarnessService(scope,root,{codex:adapter,'claude-code':adapter});}});
  const h=ctx.harness;
  // DSH's own subagents: the descendant tree read from child logs, without loading the parent-owned child Agents.
  assert.deepEqual(await h.subagents({sessionId:'started'}),[
   {id:'child',parentId:null,name:'explorer',task:'Map the repo\nthoroughly',status:'completed',entries:[
    {kind:'thought',text:'plan'},{kind:'message',text:'Looking'},{kind:'tool',title:'bash · ls',status:'completed',output:'src'},{kind:'tool',title:'read · a.ts',status:'failed',output:null}]},
   {id:'grandchild',parentId:'child',name:'Subagent',task:null,status:'running',entries:[]},
  ]);
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
  // Sidebar marks read bindings only: an unbound fresh session stays native instead of adopting the remembered Harness.
  // A Harness session without a live process is closed (gray); a loaded DSH agent is running.
  assert.deepEqual(await h.harnesses({sessionIds:['bound','fresh','unknown']}),{bound:{harness:'codex',delegated:false,running:false},fresh:{harness:'dsh',delegated:false,running:true},unknown:{harness:'dsh',delegated:false,running:true}});
  assert.equal(inspections,2); // one per harness, cached per cwd afterwards
  const quota=await h.quota({sessionId:'bound'});
  assert.deepEqual(quota,{kind:'windows',source:'codex',plan:'pro',windows:[
   {id:'five_hour',label:'five_hour',usedPercent:40,resetsAt:null},{id:'product:Opus · 7-day',label:'Opus · 7-day',usedPercent:12,resetsAt:null}]});
  await h.quota({sessionId:'bound'});
  assert.equal(accounts,1);
  assert.equal(await h.usage({sessionId:'bound'}),null);
  // The subagents tab reads the live native session; without one, the list kept when its idle process was reclaimed.
  assert.deepEqual(await h.subagents({sessionId:'bound'}),[]);
  const harnessSubagent={id:'a',parentId:null,name:'explorer',task:null,status:'running',entries:[{kind:'message',text:'hi'}]};
  h.runner.live.set('bound',{session:{subagents:()=>[harnessSubagent]}});
  assert.deepEqual(await h.subagents({sessionId:'bound'}),[harnessSubagent]);
  h.runner.live.delete('bound');
  const kept={...harnessSubagent,status:'completed'};
  h.runner.retainedSubagents.set('bound',[kept]);
  assert.deepEqual(await h.subagents({sessionId:'bound'}),[kept]);
  // A client reporting the session on screen reaches the runner.
  const viewed=[];h.runner.viewed=id=>viewed.push(id);
  assert.equal(await h.viewing({sessionId:'bound'}),null);
  assert.deepEqual(viewed,['bound']);
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});

test('catalog probes are shared while running and a failed probe is not repeated on every read',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-harness-catalog-'));
 const ctx=new Context();
 const agent={id:'bound',status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:root},snapshotEvents:()=>[]}};
 class NativeCommands extends Service {
  constructor(ctx){super(ctx,'sessionController');}
  async resolveAgent(){return {agent};}
  async prompt(){return {accepted:true};} async fork(){return {};} async selectModel(){return {};} updateQueue(){return {};}
 }
 let inspections=0;
 const adapter={async inspect(){inspections++;await new Promise(resolve=>setTimeout(resolve,20));return {status:'notInstalled',error:{code:'notInstalled',message:'Codex is not installed'}};},async close(){}};
 try{
  await ctx.plugin(Typert);await ctx.plugin(NativeCommands);
  ctx.provide('agents',{get:()=>agent});ctx.provide('sessions',{});ctx.provide('userQuestions',{});ctx.provide('attachments',{});ctx.provide('fileUploads',{});
  await ctx.plugin({inject,apply(scope){new HarnessService(scope,root,{codex:adapter,'claude-code':adapter});}});
  const h=ctx.harness;
  await h.bindings.write({version:1,sessionId:'bound',harness:'codex',cwd:root,locked:false});
  const lists=await Promise.all([h.models({sessionId:'bound'}),h.models({sessionId:'bound'})]);
  assert.ok(lists.every(list=>list.error==='Codex is not installed'));
  assert.equal((await h.models({sessionId:'bound'})).error,'Codex is not installed');
  assert.equal(inspections,1);
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});

test('a finished turn re-probes the harness account in the background while quota reads answer the old value first',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-harness-quota-swr-'));
 const ctx=new Context();
 const agent={id:'bound',status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:root},snapshotEvents:()=>[],requestHeader:()=>undefined}};
 class NativeCommands extends Service {
  constructor(ctx){super(ctx,'sessionController');}
  async resolveAgent(id){return {agent:{bound:agent}[id]};}
  async prompt(){return {accepted:true};} async fork(){return {};} async selectModel(){return {};} updateQueue(){return {};}
 }
 let accounts=0,percent=40;
 const adapter={
  async inspect(){return {status:'ready',capabilities:{},catalog:{
   models:[{ref:{id:'m1'},label:'One',supportedThinkingOptionIds:['low']}],
   thinkingOptions:[{id:'low',label:'Low'}],defaultModel:{id:'m1'},defaultThinkingOptionId:'low',configOptions:[],
   permissionModes:{modes:[{id:'default',label:'Default'}],defaultModeId:'default'}}};},
  async inspectAccount(){accounts++;return {plan:'pro',credits:{usedPercent:percent,periodType:'five_hour'}};},
  async close(){},
 };
 try{
  await ctx.plugin(Typert);await ctx.plugin(NativeCommands);
  ctx.provide('agents',{get:()=>agent});ctx.provide('sessions',{});ctx.provide('userQuestions',{});
  ctx.provide('sessionProjections',{stateOf:(session,key)=>key==='permissions'?{sandbox:'danger-full-access'}:undefined});
  ctx.provide('attachments',{});ctx.provide('fileUploads',{});
  ctx.provide('subagents',{listDescendants:async()=>[]});ctx.provide('sessionQuery',{observeSession:async()=>({events:[],[Symbol.dispose](){}})});
  await ctx.plugin({inject,apply(scope){new HarnessService(scope,root,{codex:adapter,'claude-code':adapter});}});
  const h=ctx.harness;
  await h.select({sessionId:'bound',harness:'codex'});
  // A turn ending before any quota read (a delegated session nobody opened) still probes; reads then hit the cache.
  ctx.emit('session/event',{id:'bound'},{type:'turn/end',data:{reason:{kind:'completed'}}});
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(accounts,1);
  assert.equal((await h.quota({sessionId:'bound'})).windows[0].usedPercent,40);
  await h.quota({sessionId:'bound'});
  assert.equal(accounts,1);
  // A finished turn refreshes in the background on its own: no read is needed to start the probe.
  percent=55;
  ctx.emit('session/event',{id:'bound'},{type:'turn/end',data:{reason:{kind:'completed'}}});
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(accounts,2);
  assert.equal((await h.quota({sessionId:'bound'})).windows[0].usedPercent,55);
  await h.quota({sessionId:'bound'});
  assert.equal(accounts,2);
  // A DSH-native turn never touches the harness cache.
  await h.select({sessionId:'bound',harness:'dsh'});
  ctx.emit('session/event',{id:'bound'},{type:'turn/end',data:{reason:{kind:'completed'}}});
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(accounts,2);
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});
