import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter } from '../dist/codex-adapter.js';

// Stateful protocol peer: notifications intentionally precede request replies.
const peer = `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const notice = (method, params) => send({method,params:{threadId:'native-thread',...params}});
let turn;
for await (const line of createInterface({input:process.stdin})) {
 const req=JSON.parse(line), p=req.params;
 if(req.method==='initialized') continue;
 if(req.method==='initialize') send({id:req.id,result:{}});
 else if(req.method==='thread/start' || req.method==='thread/resume') {
  if(req.method==='thread/start' && p.ephemeral!==false) process.exit(2);
  if(req.method==='thread/resume' && p.threadId!=='native-thread') process.exit(3);
  send({id:req.id,result:{thread:{id:'native-thread',cwd:p.cwd,ephemeral:false,turns:[]},model:'test-model',modelProvider:'test-provider'}});
 } else if(req.method==='turn/start') {
  if(p.threadId!=='native-thread') process.exit(4);
  notice('thread/tokenUsage/updated',{turnId:'previous-turn',tokenUsage:{}});
  turn={id:p.input[0].text,status:'inProgress',items:[]};
  notice('turn/started',{turn});
  send({id:req.id,result:{turn}});
  if(turn.id==='cancel') continue;
  if(turn.id==='approve') {send({id:90,method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,turnId:turn.id,command:'echo hello'}});continue;}
  notice('item/started',{turnId:turn.id,item:{id:'answer',type:'agentMessage',text:''}});
  notice('item/agentMessage/delta',{turnId:turn.id,itemId:'answer',delta:'reply:'+turn.id});
  notice('item/completed',{turnId:turn.id,item:{id:'answer',type:'agentMessage',text:'reply:'+turn.id}});
  notice('turn/completed',{turn:{...turn,status:'completed'}});
 } else if(req.method==='turn/interrupt') {
  if(p.turnId!==turn.id) process.exit(5);
  notice('turn/completed',{turn:{...turn,status:'interrupted'}});
  send({id:req.id,result:{}});
 } else if(req.id===90) {
  if(req.result.decision!=='decline') process.exit(6);
  notice('turn/completed',{turn:{...turn,status:'completed'}});
 } else if(req.method==='thread/read') send({id:req.id,result:{thread:{id:'native-thread',turns:[{id:'history',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'first'}]},{id:'a',type:'agentMessage',text:'remembered'}]}]}}});
 else process.exit(7);
}
`;
const options = {
 command: process.execPath, args: ['--input-type=module','-e',peer], environment:{},
 requestTimeoutMs:1000,shutdownTimeoutMs:100,maxFrameBytes:65536,
};
function value(result) { assert.equal(result.ok,true,JSON.stringify(result)); return result.value; }
async function until(iterator, type) {
 const seen=[];
 while(true) {const next=await iterator.next();assert.equal(next.done,false);seen.push(next.value);if(next.value.kind==='event' && next.value.event.type===type) return seen;}
}

test('native identity survives multiple turns, cancellation, approval, and a new adapter resume', {timeout:10000}, async()=>{
 const adapter=new CodexAdapter(options);
 let ref;
 try {
  const session=value(await adapter.open({kind:'create',cwd:process.cwd()}));
  ref=session.initialState.nativeRef;
  const output=session.outputs[Symbol.asyncIterator]();
  for(const text of ['first','second']) {
   value(await session.execute({type:'turn.start',turnId:'host-'+text,input:[{type:'text',text}]}));
   const seen=await until(output,'turn.completed');
   assert.equal(seen.filter(o=>o.event?.type==='turn.started').length,1);
   assert.equal(seen.find(o=>o.event?.type==='item.updated').event.update.text,'reply:'+text);
   assert.equal(seen.at(-1).event.nativeTurnRef.nativeSessionId,ref.nativeSessionId);
  }
  value(await session.execute({type:'turn.start',turnId:'host-cancel',input:[{type:'text',text:'cancel'}]}));
  value(await session.execute({type:'turn.cancel',turnId:'host-cancel'}));
  assert.equal((await until(output,'turn.completed')).at(-1).event.outcome.status,'cancelled');
  value(await session.execute({type:'turn.start',turnId:'host-approve',input:[{type:'text',text:'approve'}]}));
  let interaction;
  while(!interaction) { const o=await output.next(); if(o.value.kind==='interaction') interaction=o.value.interaction; }
  assert.equal((await session.execute({type:'interaction.respond',interactionId:interaction.interactionId,response:{type:'approval',actionId:'bogus'}})).ok,false);
  value(await session.execute({type:'interaction.respond',interactionId:interaction.interactionId,response:{type:'approval',actionId:'decline'}}));
  assert.equal((await until(output,'turn.completed')).at(-1).event.outcome.status,'succeeded');
  await session.close();
 } finally {await adapter.close();}
 const resumedAdapter=new CodexAdapter(options);
 try {
  const session=value(await resumedAdapter.open({kind:'resume',cwd:process.cwd(),nativeRef:ref}));
  assert.deepEqual(session.initialState.nativeRef,ref);
  assert.equal(value(await session.readSnapshot()).turns[0].items[0].item.text,'remembered');
  const output=session.outputs[Symbol.asyncIterator]();
  value(await session.execute({type:'turn.start',turnId:'host-third',input:[{type:'text',text:'third'}]}));
  assert.equal((await until(output,'turn.completed')).at(-1).event.outcome.status,'succeeded');
 } finally {await resumedAdapter.close();}
});
