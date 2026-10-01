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
import { defaultSettings } from '../dist/settings.js';

const exec = promisify(execFile);
test('delegation and discussion start sessions on a validated model and thinking pick without changing the remembered defaults', {timeout:15000}, async () => {
 const root = await mkdtemp(join(tmpdir(), 'dsh-delegate-models-'));
 const ctx = new Context();
 const opens = [], created = [];
 let inspects = 0, reply = 'done', current = defaultSettings();
 const workspace = {id:'workspace',path:root,sessionIds:['source']};
 class Commands extends Service {
  constructor(ctx) { super(ctx, 'sessionController'); }
  async resolveAgent(id) { const agent=ctx.agents.get(id); return agent ? {agent} : {error:new Error('missing session')}; }
  async create(request) { created.push(request);const {agent}=await ctx.agents.create({sessionId:request.sessionId,meta:{cwd:root}});workspace.sessionIds.push(agent.id);return {sessionId:agent.id}; }
  async prompt(request) { ctx.agents.get(request.sessionId).followup(createUserMessage({content:request.content,source:{kind:'user',rpcId:request.requestId}}));return {accepted:true}; }
  async rename() {} async fork() {} async selectModel() {} updateQueue() {}
 }
 // `fast` offers only low thinking; `deep` offers every level.
 const catalog={models:[{ref:{id:'fast'},label:'Fast',supportedThinkingOptionIds:['low']},{ref:{id:'deep'},label:'Deep'}],
  thinkingOptions:[{id:'low',label:'Low'},{id:'high',label:'High'}],defaultModel:{id:'deep'}};
 const adapter = harness => ({
  async inspect() { inspects++; return {status:'ready',catalog,permissionModes:{modes:[{id:'read-only',label:'Read only'},{id:'plan',label:'Plan'},{id:'agent',label:'Agent'},{id:'acceptEdits',label:'Accept edits'},{id:'auto',label:'Auto'}],defaultModeId:'agent'}}; },
  async open(input) {
   opens.push({harness,input});
   const channel=new HarnessOutputChannel();
   return {ok:true,value:{initialState:{effectivePermissionModeId:input.permissionModeId},outputs:channel.outputs,async close(){channel.end();},async execute(command){
    channel.emit({kind:'event',event:{type:'item.completed',turnId:command.turnId,snapshot:{item:{type:'agentMessage',itemId:'answer',text:reply},outcome:{status:'succeeded'}}}});
    channel.emit({kind:'event',event:{type:'turn.completed',turnId:command.turnId,outcome:{status:'succeeded'}}});
    return {ok:true,value:{turnId:command.turnId}};
   }}};
  }, async close() {}, async listSkills() { return []; },
 });
 try {
  await ctx.plugin(LocalAttachments,{dshHome:root});
  for (const plugin of [Llm,Sessions,Projections,Prompt,Tools,Agents,Typert]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence,{root:join(root,'sessions'),compression:'none'});
  await ctx.plugin(Commands);
  ctx.provide('userQuestions',{});ctx.provide('workspaceRegistry',{list:()=>[workspace]});
  ctx.provide('fileUploads',{resolve:()=>undefined,bindPrompt:()=>({commit(){},[Symbol.dispose](){}})});
  ctx.provide('sessionSkillCatalog',{async list(){return {skills:[]};}});
  await ctx.plugin({inject,apply(scope){new HarnessService(scope,join(root,'bindings'),{codex:adapter('codex'),'claude-code':adapter('claude-code')},()=>current);}});
  ctx.on('agent/pre-step',async(payload,next)=>payload.agent.id==='source'?{kind:'enter',messages:[]}:next());
  await ctx.plugin(Loop,{agents:[]});
  await ctx.agents.create({sessionId:'source',meta:{cwd:root}});
  const h=ctx.harness;
  const remembered={codex:{model:{id:'deep'},thinking:'high'}};
  await h.bindings.writeDefaults(remembered);
  const openOf=async sessionId=>{await ctx.agents.get(sessionId).whenIdle();return opens.at(-1).input;};
  const user={sessionId:'source',prompt:'Plan the migration',attachments:[],reportBack:false};

  // An explicit pick reaches the new native session and leaves the remembered defaults alone.
  const picked=await h.delegateFromUser({...user,requestId:'picked',harness:'codex',picks:{codex:{model:'fast',thinking:'low'}}});
  let input=await openOf(picked.sessionId);
  assert.equal(input.model.id,'fast');assert.equal(input.thinkingOptionId,'low');
  assert.deepEqual(await h.bindings.readDefaults(),remembered);
  assert.equal((await h.state({sessionId:picked.sessionId})).model,'fast');

  // Picking a model that lacks the remembered thinking level drops that level instead of sending it.
  const modelOnly=await h.delegateFromUser({...user,requestId:'model-only',harness:'codex',picks:{codex:{model:'fast'}}});
  input=await openOf(modelOnly.sessionId);
  assert.equal(input.model.id,'fast');assert.equal(input.thinkingOptionId,undefined);
  // Thinking alone applies to the remembered model.
  const thinkingOnly=await h.delegateFromUser({...user,requestId:'thinking-only',harness:'codex',picks:{codex:{thinking:'low'}}});
  input=await openOf(thinkingOnly.sessionId);
  assert.equal(input.model.id,'deep');assert.equal(input.thinkingOptionId,'low');
  // Without a pick the remembered model and thinking still apply.
  const plain=await h.delegateFromUser({...user,requestId:'plain',harness:'codex'});
  input=await openOf(plain.sessionId);
  assert.equal(input.model.id,'deep');assert.equal(input.thinkingOptionId,'high');

  // A bad pick for any target is rejected with the valid values before any session exists.
  const before=created.length;
  await assert.rejects(h.delegateFromUser({...user,requestId:'bad-model',harnesses:['codex','claude-code'],picks:{codex:{model:'deep'},'claude-code':{model:'missing'}}}),/没有模型 missing.*fast、deep/);
  await assert.rejects(h.delegateFromUser({...user,requestId:'bad-thinking',harness:'codex',picks:{codex:{model:'fast',thinking:'high'}}}),/不支持推理强度 high.*low/);
  await assert.rejects(h.delegate('source',{requestId:'native-pick',harness:'dsh',prompt:'Plan',model:'deep'}),/DSH 原生/);
  assert.equal(created.length,before);
  // A deselected Harness's pick is ignored.
  const ignored=await h.delegateFromUser({...user,requestId:'ignored',harness:'codex',picks:{'claude-code':{model:'missing'}}});
  assert.ok(ignored.sessionId);

  // The dock reads a target's catalog without binding the source session to it.
  const listed=await h.models({sessionId:'source',harness:'claude-code'});
  assert.deepEqual(listed.models.map(model=>model.id),['fast','deep']);assert.equal(listed.error,null);
  assert.equal(await h.bindings.read('source'),undefined);

  // The main agent lists the choices, and a rejected pick frees the turn's authorization for corrected assignments.
  const environment=await h.delegation.environment('source');
  const cli=async(...args)=>JSON.parse((await exec(process.execPath,[resolve('dist/delegate-cli.mjs'),...args],{env:{...process.env,...environment}})).stdout);
  const choices=await cli('models');
  assert.deepEqual(choices.codex.models,[{id:'fast',label:'Fast',thinking:['low']},{id:'deep',label:'Deep',thinking:['low','high']}]);
  assert.deepEqual(choices['claude-code'],choices.codex);
  await assert.rejects(cli('models','{}'),error=>/Usage/.test(error.stderr));
  const tool=await ctx.tools.execute({callId:'models',name:'harness_models',arguments:{},agent:ctx.agents.get('source'),signal:new AbortController().signal});
  assert.equal(tool.isError,false,JSON.stringify(tool));assert.deepEqual(JSON.parse(tool.content[0].text),choices);
  h.discussions.set('source',{requestId:'discussion',content:[{type:'text',text:'Compare designs'}]});
  const beforeDiscussion=created.length;
  await assert.rejects(h.discuss('source',{assignments:[{harness:'codex',task:'Quick check',model:'fast'},{harness:'claude-code',task:'Deep review',model:'deep',thinking:'max'}]}),/不支持推理强度 max/);
  assert.equal(created.length,beforeDiscussion,'no participant starts before every pick is valid');
  const discussion=await h.discuss('source',{assignments:[{harness:'codex',task:'Quick check',model:'fast',thinking:'low'},{harness:'claude-code',task:'Deep review',model:'deep',thinking:'high'}]});
  assert.equal(discussion.participants.length,2);
  const participantOpens=opens.slice(-2).map(entry=>[entry.harness,entry.input.model?.id,entry.input.thinkingOptionId,entry.input.discussion]);
  assert.deepEqual(participantOpens.sort(),[['claude-code','deep','high',true],['codex','fast','low',true]]);
  assert.deepEqual(await h.bindings.readDefaults(),remembered);
  assert.match(delegationInstructions(),/复杂度.*model 与 thinking.*delegate-cli.mjs' models/s);
  assert.match(ctx.tools.get('harness_discussion_dispatch').description,/harness_models/);

  // The catalog cache and the synthesis read follow the live settings.
  h.catalogs.clear();current={...current,catalogCacheSeconds:0};
  let inspected=inspects;
  await h.models({sessionId:'source',harness:'codex'});await h.models({sessionId:'source',harness:'codex'});
  assert.equal(inspects,inspected+2,'a zero cache reads the catalog every time');
  current={...current,catalogCacheSeconds:60};inspected=inspects;
  await h.models({sessionId:'source',harness:'codex'});await h.models({sessionId:'source',harness:'codex'});
  assert.equal(inspects,inspected+1);
  h.discussions.delete('source');
  reply='x'.repeat(1500);current={...current,discussionResultChars:1000};
  h.discussions.set('source',{requestId:'discussion-chars',content:[{type:'text',text:'Answer at length'}]});
  const long=await h.discuss('source',{assignments:[{harness:'codex',task:'Long answer'}]});
  assert.equal(long.participants[0].text,'x'.repeat(1000));

  // The dock's "default" is what a delegation without a pick starts with: the last pick while still offered, else the Harness default.
  await h.bindings.writeDefaults({codex:{model:{id:'fast'},thinking:'low'},'claude-code':{model:{id:'fast'},thinking:'high'}});
  let dock=await h.models({sessionId:'source',harness:'codex'});
  assert.deepEqual([dock.defaultModel?.id,dock.defaultModel?.label,dock.defaultThinkingOptionId],['fast','Fast','low']);
  dock=await h.models({sessionId:'source',harness:'claude-code'});
  assert.deepEqual([dock.defaultModel?.id,dock.defaultThinkingOptionId],['fast',null],'a remembered level the default model lacks is not shown');
  await h.bindings.writeDefaults({codex:{model:{id:'gone'}}});
  dock=await h.models({sessionId:'source',harness:'codex'});
  assert.equal(dock.defaultModel?.id,'deep','a remembered model the catalog no longer offers falls back to the Harness default');

  // Live menus follow this session's directory; a delegation still uses a fresh target/default directory.
  await h.bindings.write({version:1,sessionId:'source',harness:'codex',cwd:root,locked:false,configs:{flag:false}});
  const beforeLive=inspects;
  const liveCatalog={...catalog,models:[{ref:{id:'live'},label:'Live'}],configOptions:[{id:'flag',label:'Flag',currentValue:true}]};
  h.runner.live.set('source',{session:{harnessId:'codex',initialState:{},inspect:()=>({status:'ready',catalog:liveCatalog}),async close(){}},queue:[],activeAt:Date.now()});
  assert.equal((await h.models({sessionId:'source'})).models[0].id,'live');
  assert.equal((await h.models({sessionId:'source'})).configOptions[0].currentValue,true);
  assert.equal(inspects,beforeLive);
  assert.equal((await h.models({sessionId:'source',harness:'codex'})).models[0].id,'fast');

  // A live session of another Harness stands in for neither this binding's directory nor its values.
  catalog.configOptions=[{id:'flag',label:'Flag',currentValue:true}];h.catalogs.clear();
  h.runner.live.set('source',{session:{harnessId:'claude-code',initialState:{},inspect:()=>({status:'ready',catalog:liveCatalog}),async close(){}},queue:[],activeAt:Date.now()});
  const other=await h.models({sessionId:'source'});
  assert.equal(other.models[0].id,'fast');
  assert.equal(other.configOptions[0].currentValue,false);
  h.runner.live.delete('source');

  // One login reported with more or fewer fields keeps the caches and stays visible while idle; another login drops them.
  const account=(email,extra={})=>({kind:'account',label:'Pro',account:{email,...extra}});
  const probes=inspects;
  h.runner.authChanged('codex',account('a@example.com'));
  h.runner.authChanged('codex',account('a@example.com',{organization:'Org'}));
  await h.models({sessionId:'source',harness:'codex'});
  assert.equal(inspects,probes);
  assert.equal((await h.state({sessionId:'source'})).authStatus.account.organization,'Org');
  h.runner.authChanged('codex',account('b@example.com'));
  await h.models({sessionId:'source',harness:'codex'});
  assert.equal(inspects,probes+1);
  h.runner.authChanged('codex',{kind:'none',label:'未登录'});
  await h.models({sessionId:'source',harness:'codex'});
  assert.equal(inspects,probes+2);
 } finally { await ctx.fiber.dispose();await rm(root,{recursive:true,force:true}); }
});
