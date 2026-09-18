import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import { HarnessService, inject } from '../dist/dsh.js';

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'harness-history-')),ctx=new Context(),events=[],calls=[];
  let outcome={status:'unknown',reason:'missing terminal'};
  const agent={id:'session',status:'idle',inbox:{nextTurn:[],nextStep:[]},async whenIdle(){},session:{header:{cwd:root},snapshotEvents:()=>events,
    append(type,data){const event={seq:events.length,type,data};events.push(event);return event;}}};
  class Commands extends Service {
    constructor(ctx){super(ctx,'sessionController');}
    async resolveAgent(){return {agent};} async prompt(){throw new Error('must never replay');}
    async fork(){return {sessionId:'child'};} async selectModel(){} updateQueue(){}
  }
  const ref={harnessId:'codex',nativeSessionId:'native',formatVersion:1};
  const turn=key=>({nativeTurnRef:{...ref,nativeTurnKey:key},input:[],items:[{item:{type:'agentMessage',itemId:key,text:'Recovered answer'},outcome:{status:'succeeded'}}],outcome});
  const adapter = {
    async close() {},
    async open(input) {
      calls.push(input);
      return { ok: true, value: {
        async close() {},
        async readSnapshot() { return { ok: true, value: { state: {nativeRef:ref}, turns: [turn('first'),turn('last')] } }; },
        async fork(key) { calls.push({fork:key}); return {ok:true,value:{...ref,nativeSessionId:'forked'}}; },
      } };
    },
  };
  await ctx.plugin(Typert);await ctx.plugin(Commands);
  ctx.provide('agents',{get:()=>agent});ctx.provide('sessions',{async flush(){}});ctx.provide('userQuestions',{});
  ctx.provide('attachments',{});ctx.provide('fileUploads',{});
  await ctx.plugin({inject,apply(scope){new HarnessService(scope,root,{codex:adapter,'claude-code':adapter});}});
  await ctx.harness.bindings.write({version:1,sessionId:'session',harness:'codex',cwd:root,locked:true,nativeRef:ref,pending:'dsh:session:2',pendingNative:'last',turns:[{turn:1,key:'first'},{turn:2,key:'last'}]});
  return {ctx,root,events,calls,agent,setOutcome(value){outcome=value;},async close(){await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}};
}

test('recovery checks terminal evidence, never resends uncertain work, and requires explicit unlock',async()=>{
  const f=await fixture();
  try {
    const h=f.ctx.harness;
    const states=await Promise.all([1,2,3].map(()=>h.state({sessionId:'session'})));
    assert.ok(states.every(state=>state.recoveryRequired));
    assert.equal((await h.state({sessionId:'session'})).recoveryRequired,true);
    assert.equal(f.calls.length,1); // UI reads share one automatic check and do not repeat it right away
    assert.equal(f.events.length,0);
    await assert.rejects(h.rollback({sessionId:'session'}),/未确认/);
    const checked=await h.recover({sessionId:'session',action:'check'});
    assert.equal(f.calls.length,2); // the user's own check always runs
    assert.equal(checked.recoveryRequired,true);assert.match(checked.detail,/（missing terminal）；没有重发任何请求/);
    const result=await h.recover({sessionId:'session',action:'unlock'});
    assert.equal(result.recoveryRequired,false);assert.equal(f.events.length,1);
    assert.equal((await h.bindings.read('session')).nativeRef.nativeSessionId,'native');
    assert.ok(f.calls.every(call=>call.kind==='resume'));
  } finally {await f.close();}
});

test('confirmed recovery is idempotent; rollback/fork preserve files and select native history boundaries',async()=>{
  const f=await fixture();
  try {
    const h=f.ctx.harness;f.setOutcome({status:'succeeded'});
    assert.equal((await h.state({sessionId:'session'})).recoveryRequired,false);
    assert.match(f.events[0].data.content[0].text,/Recovered answer/);
    await h.recover({sessionId:'session',action:'check'});assert.equal(f.events.length,1);
    await writeFile(join(f.root,'keep.txt'),'worktree changes');
    await h.rollback({sessionId:'session'});
    assert.equal(f.calls.find(call=>call.fork).fork,'first');
    assert.equal((await h.bindings.read('session')).nativeRef.nativeSessionId,'forked');
    assert.equal(await readFile(join(f.root,'keep.txt'),'utf8'),'worktree changes');
    f.events.push({seq:10,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
    const child=await f.ctx.sessionController.fork({sessionId:'session',atSeq:10});
    assert.equal((await h.bindings.read(child.sessionId)).nativeRef.nativeSessionId,'forked');
    assert.equal((await h.bindings.read(child.sessionId)).delegation,undefined);
  } finally {await f.close();}
});

test('editing a prompt forks before its turn, resends it with the kept attachments, and is idempotent',async()=>{
  const f=await fixture();
  try {
    const h=f.ctx.harness,followups=[];f.agent.followup=message=>followups.push(message);
    await h.bindings.write({version:1,sessionId:'session',harness:'codex',cwd:f.root,locked:true,nativeRef:{harnessId:'codex',nativeSessionId:'native',formatVersion:1},turns:[{turn:1,key:'first'},{turn:2,key:'last'}]});
    const user=(text,rpcId,extra=[])=>f.agent.session.append('user/message',{id:rpcId,content:[{type:'text',text},...extra],source:{kind:'user',rpcId}});
    const image={type:'image',attachment:{id:'img'}};
    f.agent.session.append('step/start',{turn:1,step:1});user('one','r1');
    f.agent.session.append('step/start',{turn:2,step:1});const second=user('two','r2',[image]);
    const queued=user('queued','r3');
    f.agent.session.append('assistant/message',{turn:2,step:1});const steering=user('steer','r4');
    await writeFile(join(f.root,'keep.txt'),'worktree changes');
    await assert.rejects(h.edit({sessionId:'session',seq:steering.seq,text:'x',requestId:'e0'}),/开头的用户消息/);
    const state=await h.edit({sessionId:'session',seq:second.seq,text:'two, edited',requestId:'e1'});
    assert.deepEqual(state.editableTurns,[1]);
    assert.deepEqual(f.calls.filter(call=>'fork' in call),[{fork:'first'}]);
    const binding=await h.bindings.read('session');
    assert.equal(binding.nativeRef.nativeSessionId,'forked');assert.deepEqual(binding.turns,[{turn:1,key:'first'}]);
    assert.equal(await readFile(join(f.root,'keep.txt'),'utf8'),'worktree changes');
    assert.equal(f.events.at(-1).data.source.summary,'消息已编辑');
    assert.equal(followups.length,2); // a message queued into the same turn is resent unchanged; steering is not
    assert.equal(followups[1].content[0].text,'queued');
    assert.deepEqual(followups[0].content,[{type:'text',text:'two, edited'},image]);assert.equal(followups[0].source.rpcId,'e1');
    // A retried request that already landed changes nothing.
    f.agent.session.append('user/message',followups[0]);
    await h.edit({sessionId:'session',seq:second.seq,text:'two, edited',requestId:'e1'});
    assert.equal(f.calls.filter(call=>'fork' in call).length,1);
    // The rewound turn no longer has a native boundary.
    await assert.rejects(h.edit({sessionId:'session',seq:second.seq,text:'again',requestId:'e2'}),/原生边界无法确认/);
  } finally {await f.close();}
});
