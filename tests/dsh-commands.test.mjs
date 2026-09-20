import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context,Service} from '@deepseek-ai/cordis';
import LocalAttachments from '@deepseek-ai/dsh-attachment-local';
import Typert from '@deepseek-ai/dsh-typert-registry';
import {HarnessService,inject} from '../dist/dsh.js';

test('public command wrapper preserves native routing, deduplicates external admission, and restores on unload',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-command-wrapper-'));
 const ctx=new Context();let nativePrompts=0;
 const agent={id:'bound',status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:root},snapshotEvents:()=>[]},followup(message){this.inbox.nextTurn.push(message);}};
 class NativeCommands extends Service {
  constructor(ctx){super(ctx,'sessionController');}
  async resolveAgent(id){assert.equal(id,'bound');return {agent};}
  async prompt(){nativePrompts++;return {accepted:true};}
  async fork(){return {};}
  async selectModel(){return {};}
  updateQueue(){return {};}
 }
 try{
  await ctx.plugin(LocalAttachments,{dshHome:root});
  ctx.provide('fileUploads',{resolve:()=>undefined});
  await ctx.plugin(Typert);await ctx.plugin(NativeCommands);
  ctx.provide('agents',{get:()=>agent});ctx.provide('sessions',{});ctx.provide('userQuestions',{});
  const adapter={async close(){}};
  const fiber=ctx.plugin({inject,apply(scope){new HarnessService(scope,root,{codex:adapter,'claude-code':adapter});}});
  await fiber;
  const controller=ctx.sessionController;
  const request={sessionId:'bound',requestId:'unique-request',content:[{type:'text',text:'hello'}]};
  const signal=new AbortController().signal;
  await controller.prompt(request,signal);assert.equal(nativePrompts,1);
  await ctx.harness.select({sessionId:'bound',harness:'codex'});
  await controller.prompt(request,signal);await controller.prompt(request,signal);
  assert.equal(nativePrompts,1);assert.equal(agent.inbox.nextTurn.length,1);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';
  await controller.prompt({...request,requestId:'image-request',content:[{type:'image',mediaType:'image/png',data:png}]},signal);
  assert.equal(agent.inbox.nextTurn[1].content[0].type,'image');
  assert.ok((await ctx.attachments.readImage(agent.inbox.nextTurn[1].content[0].attachment)).data.length);
  await assert.rejects(controller.prompt({...request,requestId:'file-request',content:[{type:'file',receiptId:'foreign'}]},signal),/附件不属于/);

  await assert.rejects(ctx.harness.select({sessionId:'bound',harness:'claude-code'}),/新建会话/);
  assert.equal(ctx.typert.local.get('harness/state').service,'harness');
  await fiber.dispose();
  for(const name of ['prompt','fork','selectModel','updateQueue'])assert.equal(Object.hasOwn(controller,name),false);
  await controller.prompt(request,signal);assert.equal(nativePrompts,2);
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});

test('Harness sessions keep /goal /plan /compact, add /clear, hide the other DSH commands, and hide session mentions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-native-slash-'));
 const ctx=new Context();
 const agents=Object.fromEntries(['claude','codex','native'].map(id=>[id,{id,status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:root},snapshotEvents:()=>[]},sent:[],followup(message){this.sent.push(message);}}]));
 class NativeCommands extends Service {
  constructor(ctx){super(ctx,'sessionController');}
  async resolveAgent(id){return {agent:agents[id]};}
  async prompt(){} async fork(){} async selectModel(){} updateQueue(){}
 }
 const names=['compact','export','feedback','goal','permission','plan'];
 const executed=[];
 class Commands extends Service {
  constructor(ctx){super(ctx,'commands');}
  list(){return names.map(name=>({name,description:name}));}
  async execute(agent,line){executed.push(`${agent.id} ${line}`);return {commandId:'c',result:{kind:'success'}};}
 }
 class References extends Service {
  constructor(ctx){super(ctx,'sessionReferenceResolver');}
  async remoteExportCandidates(){return [{sessionId:'other',label:'other',mention:'@[other](dsh-session://other)'}];}
 }
 class Skills extends Service {
  constructor(ctx){super(ctx,'sessionSkillCatalog');}
  async list(){return {skills:[]};}
 }
 const skill=name=>({name,description:name,modelInvocable:true});
 const ready=extra=>({status:'ready',capabilities:{},catalog:{models:[],thinkingOptions:[],...extra.catalog},...extra.root});
 const claude={async inspect(){return ready({root:{permissionModes:{modes:[{id:'default',label:'Manual'},{id:'acceptEdits',label:'Accept edits'},{id:'plan',label:'Plan'}],defaultModeId:'default'}}});},
  async listSkills(){return [skill('compact'),skill('goal'),skill('review')];},async close(){}};
 const codex={async inspect(){return ready({catalog:{configOptions:[{id:'collaboration_mode',label:'Mode',currentValue:'default',choices:[{value:'default',label:'Default'},{value:'plan',label:'Plan'}]}]}});},
  async listSkills(){return [skill('plan'),skill('compact'),skill('goal'),skill('status')];},async close(){}};
 try{
  await ctx.plugin(LocalAttachments,{dshHome:root});
  await ctx.plugin(Typert);await ctx.plugin(NativeCommands);await ctx.plugin(Commands);await ctx.plugin(References);await ctx.plugin(Skills);
  ctx.provide('agents',{get:id=>agents[id]});ctx.provide('sessions',{});ctx.provide('userQuestions',{});ctx.provide('fileUploads',{resolve:()=>undefined});
  const fiber=ctx.plugin({inject,apply(scope){new HarnessService(scope,root,{codex,'claude-code':claude});}});
  await fiber;
  await ctx.harness.select({sessionId:'claude',harness:'claude-code'});
  await ctx.harness.select({sessionId:'codex',harness:'codex'});
  await ctx.harness.select({sessionId:'native',harness:'dsh'});
  const signal=new AbortController().signal;
  const listed=async id=>(await ctx.commands.list(agents[id])).map(command=>command.name);
  assert.deepEqual(await listed('claude'),['compact','goal','plan','clear']);
  assert.deepEqual(await listed('native'),names);
  const skills=async id=>(await ctx.sessionSkillCatalog.list({sessionId:id},signal)).skills.map(entry=>entry.name);
  assert.deepEqual(await skills('claude'),['review'],'native entries the kept rows cover are not listed twice');
  assert.deepEqual(await skills('codex'),['status']);
  const sent=id=>agents[id].sent.map(message=>message.content.map(part=>part.type==='text'?part.text:part.type));
  const run=async(id,line,attachments=[])=>(await ctx.commands.execute(agents[id],line,attachments,signal))?.result;

  // /compact and /goal reach the Harness as typed, attachments included.
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';
  assert.deepEqual(await run('claude','/compact'),{kind:'success'});
  assert.deepEqual(await run('claude','/goal ship it',[{type:'image',mediaType:'image/png',data:png}]),{kind:'success'});
  assert.deepEqual(sent('claude'),[['/compact'],['/goal ship it','image']]);
  assert.equal(await ctx.commands.execute(agents.claude,'/export',[],signal),undefined,'a hidden DSH command stays a prompt');

  // /clear drops the native identity and context-only state; the next prompt creates a fresh native session.
  const binding=await ctx.harness.bindings.read('claude');
  Object.assign(binding,{nativeRef:{harnessId:'claude-code',nativeSessionId:'old',formatVersion:1},usage:{contextUsedTokens:12,totalTokens:20},turns:[{turn:1,key:'native-1'}]});
  await ctx.harness.bindings.write(binding);
  await assert.rejects(ctx.commands.execute(agents.claude,'/clear now',[],signal),/不接受参数或附件/);
  await assert.rejects(ctx.commands.execute(agents.claude,'/clear',[{type:'image',mediaType:'image/png',data:png}],signal),/不接受参数或附件/);
  let closed=0;
  ctx.harness.runner.live.set('claude',{session:{close:async()=>{closed++;}}});
  ctx.harness.runner.retainedSubagents.set('claude',[{id:'old-agent'}]);
  assert.deepEqual(await run('claude','/clear'),{kind:'success'});
  assert.equal(closed,1);
  assert.equal(ctx.harness.runner.live.has('claude'),false);
  assert.equal(ctx.harness.runner.retainedSubagents.has('claude'),false);
  assert.deepEqual(await ctx.harness.bindings.read('claude'),{
   version:1,sessionId:'claude',harness:'claude-code',cwd:root,locked:true,
  });
  assert.deepEqual(sent('claude'),[['/compact'],['/goal ship it','image']],'clear is handled by the host, not sent as a prompt');

  // Claude Code: /plan toggles the plan permission mode and returns to the mode it left.
  await ctx.harness.selectPermission({sessionId:'claude',permission:'acceptEdits'});
  const permission=async id=>(await ctx.harness.state({sessionId:id})).permission;
  await run('claude','/plan');assert.equal(await permission('claude'),'plan');
  await run('claude','/plan');assert.equal(await permission('claude'),'acceptEdits');
  await run('claude','/plan off');assert.equal(await permission('claude'),'acceptEdits','off outside plan mode changes nothing');
  await run('claude','/plan write tests');assert.equal(await permission('claude'),'plan');
  await run('claude','/plan write more');assert.equal(await permission('claude'),'plan','text in plan mode stays in plan mode');
  assert.deepEqual(sent('claude').slice(2),[['write tests'],['write more']]);
  await run('claude','/plan off');assert.equal(await permission('claude'),'acceptEdits');
  await assert.rejects(ctx.commands.execute(agents.claude,'/plan off',[{type:'image',mediaType:'image/png',data:png}],signal),/不能附带附件/);

  // Codex: /plan toggles its collaboration mode.
  const mode=async()=>(await ctx.harness.state({sessionId:'codex'})).configs.collaboration_mode;
  await run('codex','/plan');assert.equal(await mode(),'plan');
  await run('codex','/plan');assert.equal(await mode(),'default');
  assert.deepEqual(sent('codex'),[]);
  for(const id of ['codex','claude']) {
   const binding=await ctx.harness.bindings.read(id);
   await ctx.harness.bindings.write({...binding,permission:id==='codex'?'read-only':'plan',delegation:{parentSessionId:'parent',requestHash:'discussion',discussion:true}});
   await assert.rejects(ctx.commands.execute(agents[id],'/plan off',[],signal),/讨论/);
  }

  await ctx.commands.execute(agents.native,'/compact',[],signal);
  assert.deepEqual(executed,['native /compact']);
  assert.deepEqual(await ctx.sessionReferenceResolver.remoteExportCandidates(agents.claude,'',signal),[]);
  assert.equal((await ctx.sessionReferenceResolver.remoteExportCandidates(agents.native,'',signal)).length,1);
  await fiber.dispose();
  assert.equal(Object.hasOwn(ctx.commands,'list'),false);assert.equal(Object.hasOwn(ctx.commands,'execute'),false);
  assert.equal(Object.hasOwn(ctx.sessionReferenceResolver,'remoteExportCandidates'),false);
  assert.equal(ctx.commands.list(agents.claude).length,names.length);
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});

test('the @ plugin menu lists the Harness plugins of bound sessions, shares one catalog read and retries failures',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-plugin-menu-'));
 const ctx=new Context();
 const agents=Object.fromEntries(['bound','native'].map(id=>[id,{id,status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:root},snapshotEvents:()=>[]}}]));
 class NativeCommands extends Service {
  constructor(ctx){super(ctx,'sessionController');}
  async resolveAgent(id){return {agent:agents[id]};}
  async prompt(){} async fork(){} async selectModel(){} updateQueue(){}
 }
 const notion={name:'notion',displayName:'Notion',description:'Notion docs',mention:'[@notion](plugin://notion@openai-curated)'};
 let reads=0,fail=false;
 const codex={async listPlugins({cwd}){assert.equal(cwd,root);reads++;if(fail)throw new Error('app-server unavailable');return [notion];},async close(){}};
 try{
  await ctx.plugin(Typert);await ctx.plugin(NativeCommands);
  ctx.provide('agents',{get:id=>agents[id]});ctx.provide('sessions',{});ctx.provide('userQuestions',{});ctx.provide('attachments',{});ctx.provide('fileUploads',{});
  await ctx.plugin({inject,apply(scope){new HarnessService(scope,root,{codex,'claude-code':{async close(){}}});}});
  await ctx.harness.select({sessionId:'native',harness:'dsh'});
  assert.deepEqual(await ctx.harness.plugins({sessionId:'native'}),[]);
  await ctx.harness.select({sessionId:'bound',harness:'claude-code'});
  assert.deepEqual(await ctx.harness.plugins({sessionId:'bound'}),[],'a Harness without plugins lists none');
  await ctx.harness.select({sessionId:'bound',harness:'codex'});
  fail=true;await assert.rejects(ctx.harness.plugins({sessionId:'bound'}),/app-server unavailable/);
  fail=false;
  assert.deepEqual(await Promise.all([ctx.harness.plugins({sessionId:'bound'}),ctx.harness.plugins({sessionId:'bound'})]),[[notion],[notion]]);
  assert.deepEqual(await ctx.harness.plugins({sessionId:'bound'}),[notion]);
  assert.equal(reads,2,'the failed read is retried, then one read serves the keystrokes');
  assert.equal(ctx.typert.local.get('harness/plugins').service,'harness');
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});
