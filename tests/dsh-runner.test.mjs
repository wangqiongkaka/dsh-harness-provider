import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { HarnessOutputChannel } from '@codexhost/harness-adapter';
import { Bindings } from '../dist/bindings.js';
import { DshRunner } from '../dist/dsh-runner.js';

function fakeAdapter(log) {
 const sessions=[];
 return {
  async open(input) {
   log.push(input);
   const channel=new HarnessOutputChannel();
   let active;
   const session={
    initialState:{nativeRef:{harnessId:'codex',nativeSessionId:'native-fixed',formatVersion:1},effectiveModel:{id:'fixture-model'}},
    outputs:channel.outputs,
    async execute(command) {
     const emit=event=>channel.emit({kind:'event',event});
     if(command.type==='turn.cancel') {
      log.push({kind:'cancel'});
      emit({type:'turn.completed',turnId:command.turnId,outcome:{status:'cancelled'}});
      active=undefined;return {ok:true,value:{cancellationRequested:true}};
     }
     assert.equal(command.type,'turn.start');active=command.turnId;
     emit({type:'turn.started',turnId:active});
     const text=command.input.map(p=>p.text).join('|');
     if(text==='broken'){emit({type:'item.updated',turnId:active,itemId:'unknown-item',update:{type:'text.append',text:'invalid'}});return {ok:true,value:{turnId:active}};}
     emit({type:'item.started',turnId:active,item:{type:'agentMessage',itemId:'answer',text:''}});
     emit({type:'item.updated',turnId:active,itemId:'answer',update:{type:'text.append',text:'reply:'+text}});
     if(text==='wait') return {ok:true,value:{turnId:active}};
     emit({type:'item.completed',turnId:active,snapshot:{item:{type:'agentMessage',itemId:'answer',text:'reply:'+text},outcome:{status:'succeeded'}}});
     emit({type:'item.started',turnId:active,item:{type:'commandExecution',itemId:'tool',command:'pwd'}});
     emit({type:'item.completed',turnId:active,snapshot:{item:{type:'commandExecution',itemId:'tool',command:'pwd',output:'/workspace',exitCode:0},outcome:{status:'succeeded'}}});
     emit({type:'item.completed',turnId:active,snapshot:{item:{type:'contextCompaction',itemId:'compaction'},outcome:{status:'succeeded'}}});
     emit({type:'turn.completed',turnId:active,outcome:{status:'succeeded'}});
     active=undefined;return {ok:true,value:{turnId:command.turnId}};
    },
    async close(){if(active) await session.execute({type:'turn.cancel',turnId:active});channel.end();},
   };
   sessions.push(session);return {ok:true,value:session};
  },
  async close(){await Promise.all(sessions.map(s=>s.close()));},
 };
}

test('real DSH loop persists streams/tools, handles cancellation, and cold-resumes external identity', {timeout:10000}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-harness-runner-'));
 const contexts=[],logs=[];
 const bindings=new Bindings(join(root,'bindings'));
 const id=SessionId('integration-session');
 const frames=[];
 async function mount() {
  const ctx=new Context();contexts.push(ctx);
  for(const plugin of [Llm,Sessions,Projections,Prompt,Tools,Agents]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence,{root:join(root,'sessions'),compression:'none'});
  const adapter=fakeAdapter(logs);
  const runner=new DshRunner(ctx,bindings,{codex:adapter});
  ctx.on('agent/assistant-stream',({frame})=>frames.push(frame));
  ctx.on('agent/pre-step',async payload=>{await runner.run(payload,await bindings.read(id));return {kind:'enter',messages:[]};});
  await ctx.plugin(Loop,{agents:[]});return {ctx,adapter};
 }
 async function prompt(agent,text) {agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));await agent.whenIdle();}
 try {
  await bindings.write({version:1,sessionId:id,harness:'codex',cwd:root,locked:true});
  const first=await mount();
  const {agent}=await first.ctx.agents.create({sessionId:id,meta:{cwd:root}});
  await prompt(agent,'one');await prompt(agent,'two');
  const ends=agent.session.snapshotEvents().filter(e=>e.type==='turn/end');
  assert.deepEqual(ends.map(e=>e.data.reason.kind),['completed','completed']);
  assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='tool/result').length,2);
  assert.equal(frames.filter(f=>f.type==='chunk' && f.chunk.type==='text-delta').length,2);
  assert.equal((await bindings.read(id)).pending,undefined);
  validateStoredEvents(agent.session.header,structuredClone(agent.session.snapshotEvents()));
  await first.ctx.fiber.dispose();await first.adapter.close();
  const second=await mount();
  const resumed=await second.ctx.agents.resume({resumeSessionId:id});
  await prompt(resumed.agent,'three');
  assert.equal(logs.length,2);
  assert.equal(logs[1].kind,'resume');assert.equal(logs[1].nativeRef.nativeSessionId,'native-fixed');
  assert.equal(resumed.agent.session.snapshotEvents().filter(e=>e.type==='user/message' && e.data.source.kind==='user').length,3);
  const started=Promise.withResolvers();
  const dispose=second.ctx.on('agent/assistant-stream',({frame})=>{if(frame.type==='chunk' && frame.chunk.type==='text-delta' && frame.chunk.text==='reply:wait') started.resolve();});
  const waiting=prompt(resumed.agent,'wait');await started.promise;
  resumed.agent.cancel({kind:'user'});await waiting;dispose();
  const events=resumed.agent.session.snapshotEvents();
  assert.equal(events.filter(e=>e.type==='turn/end').at(-1).data.reason.kind,'aborted');
  assert.equal(events.filter(e=>e.type==='assistant/message').at(-1).data.interrupted,true);
  assert.equal((await bindings.read(id)).pending,undefined);
  validateStoredEvents(resumed.agent.session.header,structuredClone(events));
  await prompt(resumed.agent,'broken');
  assert.ok((await bindings.read(id)).pending);
  assert.equal(logs.filter(entry=>entry.kind==='cancel').length,2);
  assert.equal(resumed.agent.session.snapshotEvents().filter(e=>e.type==='turn/end').at(-1).data.reason.kind,'error');
  await second.ctx.fiber.dispose();await second.adapter.close();
 } finally {
  await Promise.all(contexts.map(ctx=>ctx.fiber.dispose()));await rm(root,{recursive:true,force:true});
 }
});

test('cancellation during native session initialization never starts a native turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-open-cancel-')),ctx=new Context();
 const bindings=new Bindings(root),abort=new AbortController();let starts=0;
 const binding={version:1,sessionId:'cancel-open',harness:'codex',cwd:root,locked:true};
 const channel=new HarnessOutputChannel();
 const session={initialState:{nativeRef:{harnessId:'codex',nativeSessionId:'saved-empty-session',formatVersion:1}},outputs:channel.outputs,
  async execute(){starts++;throw new Error('must not submit');},async close(){channel.end();}};
 const adapter={async open(){abort.abort();return {ok:true,value:session};}};
 const runner=new DshRunner(ctx,bindings,{codex:adapter});
 const agent={id:'cancel-open',ctx,session:{header:{cwd:root},append(){throw new Error('must not append a step');}}};
 try{
  await assert.rejects(runner.run({agent,messages:[createUserMessage({content:[{type:'text',text:'cancelled'}],source:{kind:'user'}})],turn:1,step:1,signal:abort.signal},binding),{name:'AbortError'});
  assert.equal(starts,0);assert.equal((await bindings.read(agent.id)).pending,undefined);
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});
