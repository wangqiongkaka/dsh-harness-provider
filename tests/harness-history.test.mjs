import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import { HarnessService, inject } from '../dist/dsh.js';
import { checkpoint, repository } from '../dist/checkpoints.js';

async function fixture(harness = 'codex') {
  const root=await mkdtemp(join(tmpdir(),'harness-history-')),ctx=new Context(),events=[],calls=[];
  let outcome={status:'unknown',reason:'missing terminal'};
  const agent={id:'session',status:'idle',inbox:{nextTurn:[],nextStep:[]},async whenIdle(){},session:{header:{cwd:root},snapshotEvents:()=>events,
    append(type,data){const event={seq:events.length,type,data};events.push(event);return event;}}};
  class Commands extends Service {
    constructor(ctx){super(ctx,'sessionController');}
    async resolveAgent(){return {agent};} async prompt(){throw new Error('must never replay');}
    async fork(){return {sessionId:'child'};} async selectModel(){} updateQueue(){}
  }
  const ref={harnessId:harness,nativeSessionId:'native',formatVersion:1};
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
  await ctx.harness.bindings.write({version:1,sessionId:'session',harness,cwd:root,locked:true,nativeRef:ref,pending:'dsh:session:2',pendingNative:'last',turns:[{turn:1,key:'first'},{turn:2,key:'last'}]});
  return {ctx,root,events,calls,agent,setOutcome(value){outcome=value;},async close(){await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}};
}

async function checkpointFixture(harness) {
 const f = await fixture(harness);
 const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
 git('init'); await writeFile(join(f.root, '.gitignore'), '*.json\n'); await writeFile(join(f.root, 'file.txt'), 'before'); git('add', '.'); git('commit', '-m', 'initial');
 const before = await checkpoint(f.root, 'before');
 await writeFile(join(f.root, 'file.txt'), 'after');
 const after = await checkpoint(f.root, 'after');
 const binding = await f.ctx.harness.bindings.read('session');
 delete binding.pending; delete binding.pendingNative;
 binding.turns = [{ turn: 1, key: 'first' }, { turn: 2, key: 'last', checkpoint: { before, after } }];
 await f.ctx.harness.bindings.write(binding);
 f.agent.session.append('turn/start', { turn: 1 }); f.agent.session.append('turn/start', { turn: 2 });
 return f;
}

for (const harness of ['codex', 'claude-code']) test('文件 rewind 先预览再确认，同时恢复文件和原生对话边界：' + harness, async () => {
 const f = await checkpointFixture(harness);
 try {
  const h = f.ctx.harness;
  const preview = await h.previewRewind({ sessionId: 'session', turn: 2 });
  assert.deepEqual(preview.paths, ['file.txt']); assert.deepEqual(preview.conflicts, []);
  assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), 'after');
  assert.equal(f.calls.some(call => 'fork' in call), false);
  const result = await h.confirmRewind({ sessionId: 'session', token: preview.token });
  assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), 'before');
  assert.equal((await h.bindings.read('session')).nativeRef.nativeSessionId, 'forked');
  assert.deepEqual((await h.bindings.read('session')).turns, [{ turn: 1, key: 'first' }]);
  assert.deepEqual(result.supersededTurns, [2]);
  assert.equal(f.calls.find(call => 'fork' in call).fork, 'first');
 } finally { await f.close(); }
});

test('文件 rewind 预览后工作区变化时不切换对话也不覆盖文件', async () => {
 const f = await checkpointFixture();
 try {
  const h = f.ctx.harness, preview = await h.previewRewind({ sessionId: 'session', turn: 2 });
  await writeFile(join(f.root, 'file.txt'), 'later edit');
  await assert.rejects(h.confirmRewind({ sessionId: 'session', token: preview.token }), /工作区已变化/);
  assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), 'later edit');
  assert.equal((await h.bindings.read('session')).nativeRef.nativeSessionId, 'native');
 } finally { await f.close(); }
});

test('文件 rewind 在保存绑定时中断后可重试，且重复确认不重复执行', async () => {
 const f = await checkpointFixture();
 try {
  const h = f.ctx.harness, preview = await h.previewRewind({ sessionId: 'session', turn: 2 });
  const write = h.bindings.write.bind(h.bindings);
  let reject = true;
  h.bindings.write = async binding => { if (binding.fileRewind?.applied && reject) { reject = false; throw new Error('存储中断'); } return write(binding); };
  await assert.rejects(h.confirmRewind({ sessionId: 'session', token: preview.token }), /存储中断/);
  assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), 'before');
  assert.equal((await h.bindings.read('session')).nativeRef.nativeSessionId, 'native');
  assert.equal((await h.bindings.read('session')).fileRewind.token, preview.token);
  await assert.rejects(h.harnessCommand('session', 'clear', '/clear', '', [], new AbortController().signal), /恢复/);
  h.rewindPreviews.clear();
  await h.confirmRewind({ sessionId: 'session', token: preview.token });
  await h.confirmRewind({ sessionId: 'session', token: preview.token });
  assert.equal((await h.bindings.read('session')).nativeRef.nativeSessionId, 'forked');
  assert.equal((await h.bindings.read('session')).fileRewind, undefined);
  assert.equal(f.events.filter(event => event.data.source?.rewindToken === preview.token).length, 1);
  assert.equal(f.calls.filter(call => 'fork' in call).length, 1);
 } finally { await f.close(); }
});

test('文件 rewind 有冲突时不改变文件与对话', async () => {
 const f = await checkpointFixture();
 try {
  const h = f.ctx.harness;
  await writeFile(join(f.root, 'file.txt'), 'user edit');
  const preview = await h.previewRewind({ sessionId: 'session', turn: 2 });
  assert.deepEqual(preview.conflicts, ['file.txt']);
  await assert.rejects(h.confirmRewind({ sessionId: 'session', token: preview.token }), /冲突/);
  assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), 'user edit');
  assert.equal((await h.bindings.read('session')).nativeRef.nativeSessionId, 'native');
  assert.equal(f.calls.some(call => 'fork' in call), false);
 } finally { await f.close(); }
});

test('同仓库正在启动的其他轮次阻止文件 rewind', async () => {
 const f = await checkpointFixture();
 try {
  f.ctx.harness.runner.fileTurns.set('other', await repository(f.root));
  await assert.rejects(f.ctx.harness.previewRewind({ sessionId: 'session', turn: 2 }), /同一 Git 仓库/);
  assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), 'after');
 } finally { await f.close(); }
});

test('文件 rewind 说明消息落盘失败后重试仍会保存说明', async () => {
 const f = await checkpointFixture();
 try {
  const h = f.ctx.harness, preview = await h.previewRewind({ sessionId: 'session', turn: 2 });
  let saved = false, reject = true;
  f.ctx.sessions.flush = async () => { if (reject) { reject = false; throw new Error('消息落盘失败'); } saved = true; };
  await assert.rejects(h.confirmRewind({ sessionId: 'session', token: preview.token }), /消息落盘失败/);
  assert.ok((await h.bindings.read('session')).fileRewind);
  await h.confirmRewind({ sessionId: 'session', token: preview.token });
  assert.equal(saved, true);
  assert.equal((await h.bindings.read('session')).fileRewind, undefined);
 } finally { await f.close(); }
});

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
    f.agent.session.append('turn/start',{turn:1});f.agent.session.append('step/start',{turn:1,step:1});user('one','r1');
    f.agent.session.append('turn/start',{turn:2});f.agent.session.append('step/start',{turn:2,step:1});const second=user('two','r2',[image]);
    const queued=user('queued','r3');
    f.agent.session.append('assistant/message',{turn:2,step:1});const steering=user('steer','r4');
    await writeFile(join(f.root,'keep.txt'),'worktree changes');
    await assert.rejects(h.edit({sessionId:'session',seq:steering.seq,text:'x',requestId:'e0'}),/开头的用户消息/);
    const state=await h.edit({sessionId:'session',seq:second.seq,text:'two, edited',requestId:'e1'});
    assert.deepEqual(state.editableTurns,[1]);
    assert.deepEqual(state.supersededTurns,[2]);
    assert.deepEqual((await h.state({sessionId:'session'})).supersededTurns,[2]);
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
    f.agent.session.append('turn/start',{turn:3});f.agent.session.append('step/start',{turn:3,step:1});
    const replacement=user('two, edited','e1-replayed');
    await h.bindings.write({...await h.bindings.read('session'),turns:[{turn:1,key:'first'},{turn:3,key:'last'}]});
    const editedAgain=await h.edit({sessionId:'session',seq:replacement.seq,text:'two, edited again',requestId:'e3'});
    assert.deepEqual(editedAgain.supersededTurns,[2,3]);
    assert.deepEqual((await h.state({sessionId:'session'})).supersededTurns,[2,3]);
  } finally {await f.close();}
});
