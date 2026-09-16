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
  if(!p.developerInstructions?.includes('进展反馈')) process.exit(10);
  if(req.method==='thread/start' && p.ephemeral!==false) process.exit(2);
  if(req.method==='thread/resume' && p.threadId!=='native-thread') process.exit(3);
  send({id:req.id,result:{thread:{id:'native-thread',cwd:p.cwd,ephemeral:false,turns:[]},model:'test-model',modelProvider:process.env.DSH_TEST_SESSION ?? 'test-provider',sandbox:{type:p.sandbox==='read-only'?'readOnly':'dangerFullAccess'}}});
 } else if(req.method==='model/list') send({id:req.id,result:{data:[
   {model:'gpt-5.5',displayName:'GPT-5.5',isDefault:true,hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low',description:''},{reasoningEffort:'high',description:''}],defaultReasoningEffort:'high'},
   {model:'gpt-5.5-mini',displayName:'Mini',isDefault:false,hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low',description:''}],defaultReasoningEffort:'low'},
   {model:'secret',displayName:'Hidden',isDefault:false,hidden:true,supportedReasoningEfforts:[],defaultReasoningEffort:null}],nextCursor:null}});
 else if(req.method==='config/read') send({id:req.id,result:{config:{sandbox_mode:'danger-full-access',model:'gpt-6-astra'},origins:{},layers:null}});
 else if(req.method==='account/rateLimits/read') send({id:req.id,result:{rateLimits:{planType:'plus',primary:{usedPercent:62,windowDurationMins:300,resetsAt:1700000000},secondary:{usedPercent:31,windowDurationMins:10080,resetsAt:1700500000}}}});
 else if(req.method==='turn/start') {
  if(p.threadId!=='native-thread') process.exit(4);
  notice('thread/tokenUsage/updated',{turnId:'previous-turn',tokenUsage:{}});
  turn={id:p.input[0].text,status:'inProgress',items:[],effort:p.effort??null,sandboxPolicy:p.sandboxPolicy??null,approvalPolicy:p.approvalPolicy??null};
  notice('turn/started',{turn});
  send({id:req.id,result:{turn}});
  notice('thread/tokenUsage/updated',{turnId:turn.id,tokenUsage:{total:{totalTokens:1200,inputTokens:1000,cachedInputTokens:100,outputTokens:100,reasoningOutputTokens:0},last:{totalTokens:700,inputTokens:500,cachedInputTokens:100,outputTokens:100,reasoningOutputTokens:0},modelContextWindow:200000}});
  if(turn.id==='cancel') continue;
  if(turn.id==='approve') {send({id:90,method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,turnId:turn.id,command:'echo hello'}});continue;}
  if(turn.id==='mcp') {send({id:91,method:'mcpServer/elicitation/request',params:{threadId:p.threadId,turnId:turn.id,serverName:'probe',mode:'form',message:'Choose region',requestedSchema:{type:'object',required:['region'],properties:{region:{type:'string',title:'Region',enum:['us','eu']},features:{type:'array',title:'Features',items:{type:'string',enum:['logs','metrics']}}}}}});continue;}
  if(turn.id==='mcp-approval') {send({id:93,method:'mcpServer/elicitation/request',params:{threadId:p.threadId,turnId:turn.id,serverName:'probe',mode:'form',message:'Allow ask?',_meta:{codex_approval_kind:'mcp_tool_call',persist:['session','always'],tool_description:'Ask through MCP'},requestedSchema:{type:'object',properties:{}}}});continue;}
  if(turn.id==='permissions') {send({id:92,method:'item/permissions/requestApproval',params:{threadId:p.threadId,turnId:turn.id,itemId:'perm',cwd:process.cwd(),startedAtMs:Date.now(),reason:'Needs network',permissions:{network:{enabled:true}}}});continue;}
  if(turn.id==='activity') {notice('item/started',{turnId:turn.id,item:{id:'sleep',type:'sleep',durationMs:10}});notice('item/completed',{turnId:turn.id,item:{id:'sleep',type:'sleep',durationMs:10}});notice('turn/completed',{turn:{...turn,status:'completed'}});continue;}
  if(turn.id==='subagent') {const item={id:'collab',type:'collabAgentToolCall',tool:'spawnAgent',senderThreadId:'native-thread',receiverThreadIds:['child'],agentsStates:{child:{status:'completed',message:'done'}},status:'completed',prompt:'review',model:'gpt-test',reasoningEffort:'high'};notice('item/started',{turnId:turn.id,item});notice('item/completed',{turnId:turn.id,item});notice('turn/completed',{turn:{...turn,status:'completed'}});continue;}
  if(turn.id==='hook') {const base={id:'h1',eventName:'userPromptSubmit',executionMode:'sync',handlerType:'command',scope:'turn',sourcePath:'/tmp/hook',startedAt:1,displayOrder:1};notice('hook/started',{turnId:turn.id,run:{...base,status:'running',entries:[]}});notice('hook/completed',{turnId:turn.id,run:{...base,status:'blocked',durationMs:2,entries:[{kind:'stop',text:'blocked by hook'}]}});notice('turn/completed',{turn:{...turn,status:'completed'}});continue;}
  if(turn.id==='progress') {notice('item/started',{turnId:turn.id,item:{id:'cmd',type:'commandExecution',command:'echo hi',cwd:process.cwd(),status:'inProgress'}});notice('item/commandExecution/outputDelta',{turnId:turn.id,itemId:'cmd',delta:'hi\\n'});notice('item/completed',{turnId:turn.id,item:{id:'cmd',type:'commandExecution',command:'echo hi',cwd:process.cwd(),aggregatedOutput:'hi\\n',exitCode:0,status:'completed'}});notice('turn/completed',{turn:{...turn,status:'completed'}});continue;}
  notice('item/started',{turnId:turn.id,item:{id:'answer',type:'agentMessage',text:''}});
  notice('item/agentMessage/delta',{turnId:turn.id,itemId:'answer',delta:'reply:'+turn.id});
  notice('item/completed',{turnId:turn.id,item:{id:'answer',type:'agentMessage',text:'reply:'+turn.id}});
  notice('turn/completed',{turn:{...turn,status:'completed'}});
 } else if(req.method==='turn/steer') {
  if(p.expectedTurnId!==turn.id || p.input[0].text!=='steer-now') process.exit(9);
  send({id:req.id,result:{turnId:turn.id}});
 } else if(req.method==='turn/interrupt') {
  if(p.turnId!==turn.id) process.exit(5);
  notice('turn/completed',{turn:{...turn,status:'interrupted'}});
  send({id:req.id,result:{}});
 } else if(req.method==='skills/list') send({id:req.id,result:{data:[{cwd:p.cwds[0],skills:[{name:'probe-skill',description:'probe',enabled:true,path:'/tmp/probe',scope:'repo'}],errors:[]}]}});
 else if(req.method==='hooks/list') send({id:req.id,result:{data:[]}});
 else if(req.method==='mcpServerStatus/list') send({id:req.id,result:{data:[],nextCursor:null}});
 else if(req.method==='thread/compact/start') send({id:req.id,result:{}});
 else if(req.method==='review/start') {turn={id:'review-native',status:'inProgress',items:[]};notice('turn/started',{turn});send({id:req.id,result:{reviewThreadId:'native-thread',turn}});notice('item/started',{turnId:turn.id,item:{id:'review-answer',type:'agentMessage',text:''}});notice('item/completed',{turnId:turn.id,item:{id:'review-answer',type:'agentMessage',text:'reviewed'}});notice('turn/completed',{turn:{...turn,status:'completed'}});}
 else if(req.id===90) {
  if(req.result.decision!=='decline') process.exit(6);
  notice('turn/completed',{turn:{...turn,status:'completed'}});
 } else if(req.id===91) {
  if(req.result.action!=='accept'||req.result.content.region!=='eu'||req.result.content.features.join(',')!=='logs,metrics') process.exit(11);
  notice('turn/completed',{turn:{...turn,status:'completed'}});
 } else if(req.id===92) {
  if(req.result.scope!=='session'||req.result.permissions.network.enabled!==true) process.exit(12);
  notice('turn/completed',{turn:{...turn,status:'completed'}});
 } else if(req.id===93) {
  if(req.result.action!=='accept'||req.result.content!==null||req.result._meta.persist!=='session') process.exit(13);
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
  const started=seen.find(v=>v.kind==='event'&&v.event.type==='turn.started');assert.ok(started);
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

test('routes supported Codex slash commands without sending them to the model', {timeout:10000}, async()=>{
 const adapter=new CodexAdapter(options);
 try {
  const session=value(await adapter.open({kind:'create',cwd:process.cwd()}));const output=session.outputs[Symbol.asyncIterator]();
  value(await session.execute({type:'turn.start',turnId:'slash-help',input:[{type:'text',text:'/help'}]}));
  let seen=await until(output,'turn.completed');
  assert.match(seen.find(o=>o.event?.type==='item.completed').event.snapshot.item.text,/\/skills/);
  value(await session.execute({type:'turn.start',turnId:'slash-skills',input:[{type:'text',text:'/skills'}]}));
  seen=await until(output,'turn.completed');
  assert.match(seen.find(o=>o.event?.type==='item.completed').event.snapshot.item.text,/probe-skill/);
  value(await session.execute({type:'turn.start',turnId:'slash-review',input:[{type:'text',text:'/review check this'}]}));
  seen=await until(output,'turn.completed');
  assert.equal(seen.at(-1).event.outcome.status,'succeeded');
 } finally {await adapter.close();}
});

test('bridges Codex MCP elicitation and additional-permission requests', {timeout:10000}, async()=>{
 const adapter=new CodexAdapter(options);
 try {
  const session=value(await adapter.open({kind:'create',cwd:process.cwd()}));
  const output=session.outputs[Symbol.asyncIterator]();
  value(await session.execute({type:'turn.start',turnId:'host-mcp',input:[{type:'text',text:'mcp'}]}));
  let next=await output.next(); while(next.value.kind!=='interaction') next=await output.next();
  assert.equal(next.value.interaction.questions[0].id,'region');
  assert.equal(next.value.interaction.questions[1].multiple,true);
  value(await session.execute({type:'interaction.respond',interactionId:next.value.interaction.interactionId,response:{type:'question',answers:{region:['eu'],features:['logs','metrics']}}}));
  await until(output,'turn.completed');
  value(await session.execute({type:'turn.start',turnId:'host-permissions',input:[{type:'text',text:'permissions'}]}));
  next=await output.next(); while(next.value.kind!=='interaction') next=await output.next();
  assert.match(next.value.interaction.description,/network/iu);
  value(await session.execute({type:'interaction.respond',interactionId:next.value.interaction.interactionId,response:{type:'approval',actionId:'session'}}));
  await until(output,'turn.completed');
  value(await session.execute({type:'turn.start',turnId:'host-mcp-approval',input:[{type:'text',text:'mcp-approval'}]}));
  next=await output.next(); while(next.value.kind!=='interaction') next=await output.next();
  assert.deepEqual(next.value.interaction.actions.map(action=>action.id),['accept','session','always','decline']);
  value(await session.execute({type:'interaction.respond',interactionId:next.value.interaction.interactionId,response:{type:'approval',actionId:'session'}}));
  await until(output,'turn.completed');
 } finally {await adapter.close();}
});

test('unknown native activities degrade safely and command output streams', {timeout:10000}, async()=>{
 const adapter=new CodexAdapter(options);
 try {
  const session=value(await adapter.open({kind:'create',cwd:process.cwd()}));const output=session.outputs[Symbol.asyncIterator]();
  value(await session.execute({type:'turn.start',turnId:'host-activity',input:[{type:'text',text:'activity'}]}));
  const activity=await until(output,'turn.completed');
  assert.ok(activity.some(o=>o.event?.type==='item.completed'&&o.event.snapshot.item.type==='toolExecution'&&o.event.snapshot.item.toolName==='sleep'));
  value(await session.execute({type:'turn.start',turnId:'host-progress',input:[{type:'text',text:'progress'}]}));
  const progress=await until(output,'turn.completed');
  assert.ok(progress.some(o=>o.event?.type==='item.updated'&&o.event.update.type==='output.append'&&o.event.update.text==='hi\n'));
  value(await session.execute({type:'turn.start',turnId:'host-subagent',input:[{type:'text',text:'subagent'}]}));
  const subagent=await until(output,'turn.completed');
  assert.ok(subagent.some(o=>o.event?.type==='item.completed'&&o.event.snapshot.item.type==='subagentDelegation'&&o.event.snapshot.item.subagents[0].status==='completed'));
  value(await session.execute({type:'turn.start',turnId:'host-hook',input:[{type:'text',text:'hook'}]}));
  const hook=await until(output,'turn.completed');
  assert.ok(hook.some(o=>o.event?.type==='item.completed'&&o.event.snapshot.item.type==='toolExecution'&&o.event.snapshot.item.output.content[0].text==='blocked by hook'));
 } finally {await adapter.close();}
});

test('catalog exposes reasoning efforts, thinking.select rides turn/start, token usage and rate limits surface', {timeout:10000}, async()=>{
 const adapter=new CodexAdapter(options);
 try {
  const inspection=await adapter.inspect({cwd:process.cwd()});
  assert.equal(inspection.status,'ready');
  assert.deepEqual(inspection.catalog.models.map(m=>[m.ref.id,m.supportedThinkingOptionIds]),[['gpt-5.5',['low','high']],['gpt-5.5-mini',['low']]]);
  assert.deepEqual(inspection.catalog.thinkingOptions,[{id:'low',label:'Low'},{id:'high',label:'High'}]);
  assert.equal(inspection.catalog.defaultThinkingOptionId,'high');
  assert.equal(inspection.catalog.defaultModel.id,'gpt-6-astra');
  assert.equal(inspection.capabilities.configuration.selectThinkingOption,true);
  assert.deepEqual(inspection.permissionModes.modes.map(m=>m.id),['readOnly','workspaceWrite','dangerFullAccess']);
  assert.equal(inspection.permissionModes.defaultModeId,'dangerFullAccess');
  const account=await adapter.inspectAccount();
  assert.equal(account.plan,'plus');assert.equal(account.credits.usedPercent,62);assert.equal(account.credits.periodType,'five_hour');
  assert.equal(account.credits.productUsage[0].usagePercent,31);
  const session=value(await adapter.open({kind:'create',cwd:process.cwd(),thinkingOptionId:'low',permissionModeId:'readOnly'}));
  assert.equal(session.initialState.effectiveThinkingOptionId,'low');
  assert.equal(session.initialState.effectivePermissionModeId,'readOnly');
  const output=session.outputs[Symbol.asyncIterator]();
  value(await session.execute({type:'permissionMode.select',permissionModeId:'workspaceWrite'}));
  assert.equal((await output.next()).value.event.state.effectivePermissionModeId,'workspaceWrite');
  value(await session.execute({type:'thinking.select',thinkingOptionId:'high'}));
  const changed=await output.next();
  assert.equal(changed.value.event.type,'session.state.changed');assert.equal(changed.value.event.state.effectiveThinkingOptionId,'high');
  value(await session.execute({type:'turn.start',turnId:'host-effort',input:[{type:'text',text:'effort'}]}));
  const seen=await until(output,'turn.completed');
  const started=seen.find(v=>v.kind==='event'&&v.event.type==='turn.started');assert.ok(started);
  const usage=seen.find(v=>v.kind==='event'&&v.event.type==='session.usage.changed').event.usage;
  assert.deepEqual(usage,{inputTokens:1000,cachedInputTokens:100,outputTokens:100,totalTokens:1200,contextUsedTokens:700,contextWindowTokens:200000});
  await session.close();
 } finally { await adapter.close(); }
});

 test('per-session environment reaches the Codex process on create and resume', async()=>{
 const adapter=new CodexAdapter({...options,environment:{DSH_TEST_SESSION:'base'}});
 try {
  const first=value(await adapter.open({kind:'create',cwd:process.cwd(),environment:{DSH_TEST_SESSION:'first'}}));
  assert.equal(first.sourceProvider,'first');
  const second=value(await adapter.open({kind:'resume',cwd:process.cwd(),nativeRef:first.initialState.nativeRef,environment:{DSH_TEST_SESSION:'second'}}));
  assert.equal(second.sourceProvider,'second');
 } finally {await adapter.close();}
 });


test('Codex routes steering to the exact active native turn',async()=>{
 const adapter=new CodexAdapter(options);
 try {
  const session=value(await adapter.open({kind:'create',cwd:process.cwd()}));
  const output=session.outputs[Symbol.asyncIterator]();
  value(await session.execute({type:'turn.start',turnId:'host-cancel',input:[{type:'text',text:'cancel'}]}));
  value(await session.steer([{type:'text',text:'steer-now'}]));
  value(await session.execute({type:'turn.cancel',turnId:'host-cancel'}));
  await until(output,'turn.completed');
  assert.equal((await session.steer([{type:'text',text:'late'}])).ok,false);
 } finally {await adapter.close();}
});
