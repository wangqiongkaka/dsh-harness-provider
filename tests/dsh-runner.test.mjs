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
import { HarnessOutputChannel } from '../dist/contracts.js';
import { Bindings } from '../dist/bindings.js';
import { DshRunner, usageDelta } from '../dist/dsh-runner.js';
import { DshOutput } from '../dist/dsh-output.js';

function fakeAdapter(log,native) {
 const sessions=[];
 return {
  async open(input) {
   log.push(input);
   const channel=new HarnessOutputChannel();
   let active;
   const session={
    initialState:{nativeRef:{harnessId:'codex',nativeSessionId:'native-fixed',formatVersion:1},effectiveModel:{id:'fixture-model'}},
    // Thread-scoped counters, like Codex: the persisted usage is still the baseline after a reopen.
    initialUsage:input.usage??null,
    outputs:channel.outputs,
    async execute(command) {
     const emit=event=>channel.emit({kind:'event',event});
     if(command.type==='turn.cancel') {
      log.push({kind:'cancel'});
      emit({type:'turn.completed',turnId:command.turnId,outcome:{status:'cancelled'}});
      active=undefined;return {ok:true,value:{cancellationRequested:true}};
     }
     assert.equal(command.type,'turn.start');active=command.turnId;(native.inputs??=[]).push(command.input);
     emit({type:'turn.started',turnId:active});
     const text=command.input.map(p=>p.text).join('|');
     if(text==='broken'){emit({type:'item.completed',turnId:active,snapshot:{item:{type:'agentMessage',itemId:'answer',text:'reply:broken'},outcome:{status:'succeeded'}}});emit({type:'item.updated',turnId:active,itemId:'unknown-item',update:{type:'text.append',text:'invalid'}});return {ok:true,value:{turnId:active}};}
     emit({type:'item.started',turnId:active,item:{type:'reasoning',itemId:'reasoning',text:''}});
     emit({type:'item.updated',turnId:active,itemId:'reasoning',update:{type:'text.append',text:'Checking the workspace'}});
     emit({type:'item.completed',turnId:active,snapshot:{item:{type:'reasoning',itemId:'reasoning',text:'Checking the workspace'},outcome:{status:'succeeded'}}});
     emit({type:'item.started',turnId:active,item:{type:'agentMessage',itemId:'answer',text:''}});
     emit({type:'item.updated',turnId:active,itemId:'answer',update:{type:'text.append',text:'reply:'+text}});
     if(text==='wait') return {ok:true,value:{turnId:active}};
     emit({type:'item.completed',turnId:active,snapshot:{item:{type:'agentMessage',itemId:'answer',text:'reply:'+text},outcome:{status:'succeeded'}}});
     emit({type:'item.started',turnId:active,item:{type:'commandExecution',itemId:'tool',command:'pwd',description:'确认工作目录'}});
     emit({type:'item.completed',turnId:active,snapshot:{item:{type:'commandExecution',itemId:'tool',command:'pwd',description:'确认工作目录',output:'/workspace',exitCode:0},outcome:{status:'succeeded'}}});
     emit({type:'item.completed',turnId:active,snapshot:{item:{type:'contextCompaction',itemId:'compaction'},outcome:{status:'succeeded'}}});
     if(text!=='three'){emit({type:'item.started',turnId:active,item:{type:'agentMessage',itemId:'final',text:'done'}});
      emit({type:'item.completed',turnId:active,snapshot:{item:{type:'agentMessage',itemId:'final',text:'done'},outcome:{status:'succeeded'}}});}
     const turns=++native.turns;emit({type:'session.usage.changed',usage:{inputTokens:1000*turns,cachedInputTokens:100*turns,outputTokens:50*turns}});
     emit({type:'turn.completed',turnId:active,outcome:{status:'succeeded'}});
     active=undefined;return {ok:true,value:{turnId:command.turnId}};
    },
    async steer(input){log.push({kind:'steer',input});return {ok:true,value:{accepted:true}};},
    hasBackgroundTasks:()=>!!native.background,
    subagents:()=>native.subagents??[],
    async close(){if(active) await session.execute({type:'turn.cancel',turnId:active});channel.end();},
   };
   sessions.push(session);return {ok:true,value:session};
  },
  async close(){await Promise.all(sessions.map(s=>s.close()));},
 };
}

test('real DSH loop persists streams/tools, handles cancellation, and cold-resumes external identity', {timeout:10000}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-harness-runner-'));
 const contexts=[],logs=[],native={turns:0};
 const bindings=new Bindings(join(root,'bindings'));
 const id=SessionId('integration-session');
 const frames=[];
 async function mount() {
  const ctx=new Context();contexts.push(ctx);
  for(const plugin of [Llm,Sessions,Projections,Prompt,Tools,Agents]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence,{root:join(root,'sessions'),compression:'none'});
  const adapter=fakeAdapter(logs,native);
  const runner=new DshRunner(ctx,bindings,{codex:adapter});
  ctx.on('agent/assistant-stream',({frame})=>frames.push(frame));
  ctx.on('agent/inbox/inserted',({agent})=>runner.drainSteering(agent));
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
  const calls=agent.session.snapshotEvents().filter(e=>e.type==='tool/call');
  assert.deepEqual(calls.map(e=>e.data.name),['bash','bash']);
  assert.equal(JSON.parse(calls[0].data.arguments).command,'pwd');
  assert.equal(JSON.parse(calls[0].data.arguments).description,'确认工作目录');
  assert.equal(agent.session.snapshotEvents().find(e=>e.type==='assistant/message' && e.data.message.content[0].type==='tool-call').data.message.source.provider,'codex');
  assert.equal(frames.filter(f=>f.type==='chunk' && f.chunk.type==='text-delta').length,4);
  // The turn's usage delta rides the last agent message; earlier messages of the turn carry none.
  const answers=agent.session.snapshotEvents().filter(e=>e.type==='assistant/message' && e.data.message.content[0].type==='text');
  assert.deepEqual(answers.map(e=>e.data.usage),[undefined,{inputTokens:900,outputTokens:50,cacheReadTokens:100,cacheWriteTokens:0},undefined,{inputTokens:900,outputTokens:50,cacheReadTokens:100,cacheWriteTokens:0}]);
  assert.equal(frames.filter(f=>f.type==='end').length,6);
  // DSH's step row shows only a step's latest assistant message, so prose is never followed by another message in its step.
  const messages=agent.session.snapshotEvents().filter(e=>e.type==='assistant/message');
  assert.deepEqual(messages.filter((e,i)=>e.data.message.content[0].type!=='tool-call' && messages.slice(i+1).some(later=>later.data.turn===e.data.turn && later.data.step===e.data.step)).map(e=>e.data.message.content[0].text),[]);
  assert.deepEqual(messages.filter(e=>e.data.turn===1).map(e=>[e.data.step,e.data.message.content[0].type]),[[1,'reasoning'],[2,'text'],[3,'tool-call'],[4,'text']]);
  assert.deepEqual(frames.filter(f=>f.type==='chunk' && f.chunk.type==='reasoning-delta').map(f=>f.chunk.text),['Checking the workspace','Checking the workspace']);
  assert.deepEqual(agent.session.snapshotEvents().filter(e=>e.type==='assistant/message' && e.data.message.content[0].type==='reasoning').map(e=>e.data.message.content[0].text),['Checking the workspace','Checking the workspace']);
  assert.equal((await bindings.read(id)).pending,undefined);
  validateStoredEvents(agent.session.header,structuredClone(agent.session.snapshotEvents()));
  await first.ctx.fiber.dispose();await first.adapter.close();
  const second=await mount();
  const resumed=await second.ctx.agents.resume({resumeSessionId:id});
  await prompt(resumed.agent,'three');
  assert.equal(logs.length,2);
  assert.equal(logs[1].kind,'resume');assert.equal(logs[1].nativeRef.nativeSessionId,'native-fixed');
  assert.equal(resumed.agent.session.snapshotEvents().filter(e=>e.type==='user/message' && e.data.source.kind==='user').length,3);
  // A turn that ends without an agent message still records its usage on a surface-less attempt;
  // the baseline is restored from the binding, so the thread's pre-restart totals are not counted again.
  const attempt=resumed.agent.session.snapshotEvents().filter(e=>e.type==='assistant/attempt').at(-1);
  assert.deepEqual(attempt.data.stream.at(-1).chunk,{type:'usage',usage:{inputTokens:900,outputTokens:50,cacheReadTokens:100,cacheWriteTokens:0}});
  const started=Promise.withResolvers();
  const dispose=second.ctx.on('agent/assistant-stream',({frame})=>{if(frame.type==='chunk' && frame.chunk.type==='text-delta' && frame.chunk.text==='reply:wait') started.resolve();});
  const waiting=prompt(resumed.agent,'wait');await started.promise;
  resumed.agent.steer(createUserMessage({content:[{type:'text',text:'insert now'}],source:{kind:'user'}}));
  for(let i=0;i<100 && !logs.some(entry=>entry.kind==='steer');i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(logs.find(entry=>entry.kind==='steer').input,[{type:'text',text:'insert now'}]);
  assert.equal(resumed.agent.inbox.nextStep.length,0);
  assert.equal(resumed.agent.session.snapshotEvents().filter(e=>e.type==='user/message' && e.data.content[0]?.text==='insert now').length,1);
  resumed.agent.cancel({kind:'user'});await waiting;dispose();
  const events=resumed.agent.session.snapshotEvents();
  assert.equal(events.filter(e=>e.type==='turn/end').at(-1).data.reason.kind,'aborted');
  assert.equal(events.filter(e=>e.type==='assistant/message').at(-1).data.interrupted,true);
  assert.equal((await bindings.read(id)).pending,undefined);
  validateStoredEvents(resumed.agent.session.header,structuredClone(events));
  await prompt(resumed.agent,'broken');
  assert.ok((await bindings.read(id)).pending);
  assert.equal(logs.filter(entry=>entry.kind==='cancel').length,2);
  assert.equal(resumed.agent.session.snapshotEvents().filter(e=>e.type==='assistant/message').at(-1).data.message.content[0].text,'reply:broken');
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

test('usageDelta splits cumulative Harness counts into per-turn buckets',()=>{
 assert.equal(usageDelta(null,null),undefined);
 assert.equal(usageDelta({inputTokens:5,outputTokens:1},{inputTokens:5,outputTokens:1}),undefined);
 assert.deepEqual(usageDelta({inputTokens:1000,cachedInputTokens:100,outputTokens:10},{inputTokens:1600,cachedInputTokens:400,outputTokens:25}),
  {inputTokens:300,outputTokens:15,cacheReadTokens:300,cacheWriteTokens:0});
 assert.deepEqual(usageDelta(null,{inputTokens:2000,cachedInputTokens:1200,cacheWriteInputTokens:300,outputTokens:40}),{inputTokens:500,outputTokens:40,cacheReadTokens:1200,cacheWriteTokens:300});
});

test('Harness questions and edits land on DSH native ask_user_question and edit rows',async()=>{
 const appended=[];
 const agent={session:{append(type,data){appended.push({type,data});return {seq:appended.length};}}};
 const output=new DshOutput({},agent,{turn:1,step:1},()=>1,()=>({provider:'fixture',model:'fixture'}));
 const questions=[{id:'q',question:'Pick?',options:[{label:'A'}]}];
 const answer={answers:[{id:'q',selected:['A']}]};
 assert.equal(await output.question('i1',questions,async()=>answer),answer);
 const cancelled=Object.assign(new Error('dismissed'),{name:'UserQuestionError',code:'ASK_CANCELLED'});
 await assert.rejects(output.question('i2',questions,async()=>{throw cancelled;}),cancelled);
 await output.complete({item:{type:'toolExecution',itemId:'e',toolName:'edit',arguments:{file_path:'/a.txt',old_string:'old',new_string:'new'}},outcome:{status:'succeeded'}});
 const calls=appended.filter(e=>e.type==='tool/call'),results=appended.filter(e=>e.type==='tool/result');
 assert.deepEqual(calls.map(e=>[e.data.name,JSON.parse(e.data.arguments).questions?.[0].id]),[['ask_user_question','q'],['ask_user_question','q'],['edit',undefined]]);
 assert.deepEqual(JSON.parse(results[0].data.message.content[0].content[0].text),answer);
 assert.deepEqual(results[1].data.error,{name:'UserQuestionError',code:'ASK_CANCELLED'});
 assert.equal(results[1].data.message.content[0].isError,true);
 assert.deepEqual(results[2].data.meta.diffs,[{path:'/a.txt',oldText:'old',newText:'new'}]);
});

test('delegation instructions go to the adapter, not the user input, so a leading /skill and the native title stay the user\'s',{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-harness-delegation-order-')),ctx=new Context(),native={turns:0};
 const bindings=new Bindings(join(root,'bindings')),id=SessionId('delegation-order');
 try{
  for(const plugin of [Llm,Sessions,Projections,Prompt,Tools,Agents]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence,{root:join(root,'sessions'),compression:'none'});
  const opened=[],adapter=fakeAdapter(opened,native);
  const runner=new DshRunner(ctx,bindings,{codex:adapter},{environment:async()=>({DSH_DELEGATE_TOKEN:'fixture'})});
  ctx.on('agent/pre-step',async payload=>{await runner.run(payload,await bindings.read(id));return {kind:'enter',messages:[]};});
  await ctx.plugin(Loop,{agents:[]});
  await bindings.write({version:1,sessionId:id,harness:'codex',cwd:root,locked:true});
  const {agent}=await ctx.agents.create({sessionId:id,meta:{cwd:root}});
  agent.followup(createUserMessage({content:[{type:'text',text:'/review now'}],source:{kind:'user'}}));await agent.whenIdle();
  const [input]=native.inputs;
  assert.deepEqual(input,[{type:'text',text:'/review now'}]); // the user's words reach the adapter untouched
  // The adapter places the instructions (system prompt or developer instructions); a leading blank line keeps them apart from the feedback contract.
  assert.match(opened[0].instructions,/^\n\n\[DSH 会话能力，由宿主提供\]/);
  await adapter.close();
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});

test('an idle Harness session is closed after the idle window and the next turn resumes it', {timeout:15000}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-harness-idle-'));
 const logs=[],native={turns:0};
 const bindings=new Bindings(join(root,'bindings'));
 const id=SessionId('idle-session');
 const ctx=new Context();
 for(const plugin of [Llm,Sessions,Projections,Prompt,Tools,Agents]) await ctx.plugin(plugin);
 await ctx.plugin(Persistence,{root:join(root,'sessions'),compression:'none'});
 const adapter=fakeAdapter(logs,native);
 // A 120ms idle window stands in for the 1 minute default; the sweeper scales with it.
 const runner=new DshRunner(ctx,bindings,{codex:adapter},undefined,undefined,120);
 ctx.on('agent/inbox/inserted',({agent})=>runner.drainSteering(agent));
 ctx.on('agent/pre-step',async payload=>{await runner.run(payload,await bindings.read(id));return {kind:'enter',messages:[]};});
 try {
  await bindings.write({version:1,sessionId:id,harness:'codex',cwd:root,locked:true});
  await ctx.plugin(Loop,{agents:[]});
  const {agent}=await ctx.agents.create({sessionId:id,meta:{cwd:root}});
  agent.followup(createUserMessage({content:[{type:'text',text:'one'}],source:{kind:'user'}}));
  await agent.whenIdle();
  assert.deepEqual(logs.filter(entry=>entry.kind==='create'||entry.kind==='resume').map(entry=>entry.kind),['create']);
  assert.equal(runner.live.has(id),true);
  // Idling past the window closes the process on its own, with no prompt to trigger it.
  await new Promise(resolve=>setTimeout(resolve,700));
  assert.equal(runner.live.has(id),false);
  // The next turn resumes the native session instead of creating a new one, keeping the same identity.
  agent.followup(createUserMessage({content:[{type:'text',text:'two'}],source:{kind:'user'}}));
  await agent.whenIdle();
  assert.deepEqual(logs.filter(entry=>entry.kind==='create'||entry.kind==='resume').map(entry=>entry.kind),['create','resume']);
  assert.equal((await bindings.read(id)).nativeRef.nativeSessionId,'native-fixed');
  validateStoredEvents(agent.session.header,structuredClone(agent.session.snapshotEvents()));
  // A turn in flight is never reclaimed, however long the session stays open.
  agent.followup(createUserMessage({content:[{type:'text',text:'wait'}],source:{kind:'user'}}));
  for(let i=0;i<100 && !runner.live.get(id)?.turnId;i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(runner.live.get(id)?.turnId,'the turn is in flight');
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(runner.live.has(id),true);
  agent.cancel({kind:'user'});
  await new Promise(resolve=>setTimeout(resolve,50));
 } finally {await ctx.fiber.dispose();await adapter.close();await rm(root,{recursive:true,force:true});}
});

test('a Harness process stays open while its session is on screen or runs background tasks, and keeps its subagents once reclaimed', {timeout:15000}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-harness-viewed-'));
 const logs=[],native={turns:0,subagents:[{id:'s1',parentId:null,name:'explorer',task:'map',status:'completed',entries:[]}]};
 const bindings=new Bindings(join(root,'bindings'));
 const id=SessionId('viewed-session');
 const ctx=new Context();
 for(const plugin of [Llm,Sessions,Projections,Prompt,Tools,Agents]) await ctx.plugin(plugin);
 await ctx.plugin(Persistence,{root:join(root,'sessions'),compression:'none'});
 const adapter=fakeAdapter(logs,native);
 // A 120ms idle window stands in for the 1 minute default.
 const runner=new DshRunner(ctx,bindings,{codex:adapter},undefined,undefined,120);
 ctx.on('agent/pre-step',async payload=>{await runner.run(payload,await bindings.read(id));return {kind:'enter',messages:[]};});
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 try {
  await bindings.write({version:1,sessionId:id,harness:'codex',cwd:root,locked:true});
  await ctx.plugin(Loop,{agents:[]});
  const {agent}=await ctx.agents.create({sessionId:id,meta:{cwd:root}});
  agent.followup(createUserMessage({content:[{type:'text',text:'one'}],source:{kind:'user'}}));
  await agent.whenIdle();
  // On screen: reported every 50ms for well past the idle window, the process stays open.
  for(let i=0;i<12;i++){runner.viewed(id);await sleep(50);}
  assert.equal(runner.live.has(id),true);
  // Left the screen: closed once the idle window passes, keeping the subagent list it last had.
  await sleep(400);
  assert.equal(runner.live.has(id),false);
  assert.deepEqual(runner.retainedSubagents.get(id),native.subagents);
  // The next turn resumes it; a backgrounded task then holds it open with nobody watching.
  agent.followup(createUserMessage({content:[{type:'text',text:'two'}],source:{kind:'user'}}));
  await agent.whenIdle();
  assert.equal(runner.retainedSubagents.has(id),false);
  native.background=true;
  await sleep(600);
  assert.equal(runner.live.has(id),true);
  // Once the task ends the idle window starts over instead of closing at once.
  native.background=false;
  await sleep(60);
  assert.equal(runner.live.has(id),true);
  await sleep(500);
  assert.equal(runner.live.has(id),false);
  assert.deepEqual(logs.filter(entry=>entry.kind==='create'||entry.kind==='resume').map(entry=>entry.kind),['create','resume']);
 } finally {await ctx.fiber.dispose();await adapter.close();await rm(root,{recursive:true,force:true});}
});
