import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context,Service} from '@deepseek-ai/cordis';
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
  await assert.rejects(ctx.harness.select({sessionId:'bound',harness:'claude-code'}),/新建会话/);
  assert.equal(ctx.typert.local.get('harness/state').service,'harness');
  await fiber.dispose();
  for(const name of ['prompt','fork','selectModel','updateQueue'])assert.equal(Object.hasOwn(controller,name),false);
  await controller.prompt(request,signal);assert.equal(nativePrompts,2);
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});
