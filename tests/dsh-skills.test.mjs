import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import { HarnessService, inject } from '../dist/dsh.js';

test('real slash skill source follows Harness selection, invalidates pending catalogs, retries and restores DSH', async () => {
 const root=await mkdtemp(join(tmpdir(),'dsh-skills-')), ctx=new Context();
 const agents=Object.fromEntries(['one','two','remembered'].map(id=>[id,{id,status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:root,agentPreset:'default'},snapshotEvents:()=>[],requestHeader(){}}}]));
 class Commands extends Service {
  constructor(ctx){super(ctx,'sessionController');}
  async resolveAgent(id){if(!agents[id])return {error:new Error('not authorized')};return {agent:agents[id]};}
  async prompt(){} async fork(){} async selectModel(){} updateQueue(){}
 }
 const skill=name=>({name,description:name,modelInvocable:true});
 let dshCalls=0, codexCalls=0, fail=false, pending;
 class Catalog extends Service {
  constructor(ctx){super(ctx,'sessionSkillCatalog');}
  async list(){dshCalls++;return {skills:[skill('dsh-only')]};}
 }
 const adapter=name=>({
  async listSkills({cwd}) {assert.equal(cwd,root);if(name==='codex'){codexCalls++;if(fail)throw new Error('catalog unavailable');if(pending){pending.entered.resolve();await pending.promise;}}return [skill(name+'-only')];},
  async close(){},
 });
 const disposers=[];
 try {
  await ctx.plugin(Typert);await ctx.plugin(Commands);await ctx.plugin(Catalog);
  ctx.provide('agents',{get:id=>agents[id]});ctx.provide('sessions',{});ctx.provide('userQuestions',{});ctx.provide('attachments',{});ctx.provide('fileUploads',{});
  const original=Object.getOwnPropertyDescriptor(ctx.sessionSkillCatalog,'list');
  const fiber=await ctx.plugin({inject,apply(scope){new HarnessService(scope,root,{codex:adapter('codex'),'claude-code':adapter('claude')});}});
  // Execute the shipped DSH browser source, including its real per-session cache and invalidation callbacks.
  let plugin,source;
  runInNewContext(await readFile('node_modules/@deepseek-ai/dsh-client-ui-skill/lib/client.js','utf8'),{
   AbortController,console,window:{__ModuleLoader__:{load(entry){plugin=entry.factory(name=>name.includes('primitives')?{rankByName:(items,query)=>items.filter(item=>item.name.includes(query))}:{});}}},
  });
  plugin.apply({
   locale:{register(){},bind(){return key=>key;}},slots:{inject(){}},
   sessions:{subagentAddress(){},list:{getSnapshot(){return {byId:{}};}}},
   remote:{skills:{async list(request,signal){return {ok:true,value:await ctx.sessionSkillCatalog.list(request,signal)};}},$on(event,fn){disposers.push(ctx.on(event,fn));}},
   on(){},get(){return {registerSource(value){source=value;return ()=>{};}};},effect(fn){const dispose=fn();if(dispose)disposers.push(dispose);},
  });
  const candidates=async(id='one',query='')=>Array.from(await source.candidates({sessionId:id},{query,signal:new AbortController().signal}),entry=>entry.name);
  assert.deepEqual(await candidates(),['dsh-only']);
  await ctx.harness.select({sessionId:'one',harness:'codex'});
  assert.deepEqual(await candidates(),['codex-only']);
  assert.deepEqual(await candidates('one','codex'),['codex-only']);assert.equal(codexCalls,1);
  assert.equal(source.onPick({candidate:{name:'codex-only'}}).text,'/codex-only ');
  // Scope-birth warmup must honor the remembered Harness, even before its selector has mounted.
  assert.deepEqual(await candidates('remembered'),['codex-only']);
  await ctx.harness.select({sessionId:'two',harness:'dsh'});
  assert.deepEqual(await candidates('two'),['dsh-only']);
  await ctx.harness.select({sessionId:'one',harness:'claude-code'});
  assert.deepEqual(await candidates(),['claude-only']);
  assert.deepEqual(await candidates('two'),['dsh-only']);
  await ctx.harness.select({sessionId:'one',harness:'codex'});
  fail=true;await assert.rejects(candidates(),/catalog unavailable/);
  fail=false;assert.deepEqual(await candidates(),['codex-only']);
  await assert.rejects(ctx.sessionSkillCatalog.list({sessionId:'denied'},new AbortController().signal),/not authorized/);
  // A switch during a pending fetch must not repopulate the menu with the old catalog.
  await ctx.harness.select({sessionId:'one',harness:'codex'});
  pending={...Promise.withResolvers(),entered:Promise.withResolvers()};const stale=candidates();
  await pending.entered.promise;
  const switched=ctx.harness.select({sessionId:'one',harness:'claude-code'});
  pending.resolve();await switched;await stale.catch(()=>{});pending=undefined;
  assert.deepEqual(await candidates(),['claude-only']);
  await ctx.harness.select({sessionId:'one',harness:'dsh'});
  assert.deepEqual(await candidates(),['dsh-only']);assert.ok(dshCalls>=3);
  for(const dispose of disposers.splice(0).reverse())dispose();
  await fiber.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(ctx.sessionSkillCatalog,'list'),original);
  assert.deepEqual(await ctx.sessionSkillCatalog.list({sessionId:'one'},new AbortController().signal),{skills:[skill('dsh-only')]});
 } finally {for(const dispose of disposers.reverse())dispose();await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});
