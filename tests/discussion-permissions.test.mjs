import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DshRunner } from '../dist/dsh-runner.js';
import { claudeProfile } from '../dist/acp-profiles.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { discussionSandbox } from '../scripts/discussion-sandbox.mjs';
import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { Bindings } from '../dist/bindings.js';
import { HarnessOutputChannel } from '../dist/contracts.js';

test('discussion approvals never ask the user or grant persistent permissions', async () => {
 const commands=[];
 const ctx={effect(){},userQuestions:{ask(){throw new Error('unexpected UI');}}};
 const runner=new DshRunner(ctx,{async readDelegated(){return {delegation:{discussion:true}};}},{});
 const session={async execute(command){commands.push(command);return {ok:true,value:{accepted:true}};}};
 const interaction={type:'approval',interactionId:'approval',turnId:'turn',title:'Write / network / exit plan',actions:[
  {id:'always',effect:'allowAlways'},{id:'reject-always',effect:'denyAlways'},{id:'reject',effect:'denyOnce'},
 ]};
 await runner.answer({id:'child'},interaction,new AbortController().signal,session,{});
 assert.equal(commands[0].response.actionId,'reject');
 await assert.rejects(runner.answer({id:'child'},{...interaction,actions:interaction.actions.slice(0,2)},new AbortController().signal,session,{}),/安全拒绝/);
 assert.equal(commands.length,1);
 await runner.answer({id:'child'},{type:'question',interactionId:'question',questions:[]},new AbortController().signal,session,{});
 assert.deepEqual(commands.at(-1).response,{type:'question',answers:{},cancelled:true});
});

test('Claude discussion restricts tools and disables inherited execution hooks on create and resume', () => {
 const profile=claudeProfile({command:process.execPath,environment:{}});
 for(const kind of ['create','resume']) {
  const options=profile.sessionMeta(kind,'host',true).claudeCode.options;
  assert.deepEqual(options.tools,['Read','Glob','Grep','WebSearch','WebFetch']);
  assert.equal(options.allowDangerouslySkipPermissions,false);
  assert.deepEqual(options.settingSources,[]);
  assert.equal(options.settings.disableAllHooks,true);
  assert.equal(options.extraArgs['strict-mcp-config'],'');
 }
 assert.equal(profile.sessionMeta('create').claudeCode,undefined);
});

test('bundled Codex uses a real read-only sandbox; unpatched upstream remains writable', async () => {
 const source=await readFile('node_modules/@agentclientprotocol/codex-acp/dist/index.js','utf8');
 const patched=discussionSandbox(source);
 const mode=(code,discussion)=>{
  const start=code.indexOf('var AgentMode = class '),end=code.indexOf('  static ReadOnly',start);
  return JSON.parse(runInNewContext(`${code.slice(start,end)} }; JSON.stringify(new AgentMode('read-only','','','','on-request','user',{type:'workspaceWrite'},'workspace-write'));`,{process:{env:{DSH_DISCUSSION_READ_ONLY:discussion?'1':undefined}}}));
 };
 assert.equal(mode(source,true).sandboxPolicy.type,'workspaceWrite','old behavior demonstrates the upstream hole');
 assert.equal(mode(patched,true).sandboxPolicy.type,'readOnly');
 assert.equal(mode(patched,true).sandboxMode,'read-only');
 assert.equal(mode(patched,false).sandboxPolicy.type,'workspaceWrite');
 assert.throws(()=>discussionSandbox(patched),/seam changed/);
 const start=patched.indexOf('    if (process.env.DSH_DISCUSSION_READ_ONLY === "1") {',patched.indexOf('  async createSessionConfig'));
 const end=patched.indexOf('    if (mcpServers.length === 0)',start);
 const config=await runInNewContext(`(async function(){${patched.slice(start,end)}}).call({getConfigMcpServerNames:async()=>new Set(['inherited','project'])})`,{
  process:{env:{DSH_DISCUSSION_READ_ONLY:'1'}},projectPath:'/workspace',configWithWorkspaceRoots:{features:{apps:true,multi_agent:true}},
 });
 assert.equal(config.features.apps,false);assert.equal(config.features.multi_agent,false);
 for(const feature of ['hooks','plugins','computer_use','browser_use','browser_use_external','in_app_browser','in_app_local_automation','image_generation','code_mode_host','skill_mcp_dependency_install','workspace_dependencies'])assert.equal(config.features[feature],false,feature);
 assert.equal(config.mcp_servers.inherited.enabled,false);assert.equal(config.mcp_servers.project.enabled,false);
});

test('real discussion turns reject approvals, cancel questions, retain restrictions on resume and stop on unsafe modes', {timeout:10000}, async () => {
 const root=await mkdtemp(join(tmpdir(),'discussion-permissions-'));
 const ctx=new Context(),bindings=new Bindings(join(root,'bindings')),opens=[],commands=[];
 let modeMismatch=false,closed=0;
 const adapter={async open(input){
  opens.push(input);
  const channel=new HarnessOutputChannel();let active;
  const complete=outcome=>channel.emit({kind:'event',event:{type:'turn.completed',turnId:active,outcome}});
  return {ok:true,value:{initialState:{effectivePermissionModeId:modeMismatch?'agent':input.permissionModeId,nativeRef:{harnessId:'codex',nativeSessionId:'native',formatVersion:1}},outputs:channel.outputs,
   async close(){closed++;channel.end();},
   async execute(command){
    commands.push(command);
    if(command.type==='turn.cancel')complete({status:'cancelled'});
    if(command.type==='interaction.respond')complete({status:'succeeded'});
    if(command.type==='turn.start'){
     active=command.turnId;const text=command.input[0].text;
     if(text==='read')complete({status:'succeeded'});
     else if(text==='mode-change')channel.emit({kind:'event',event:{type:'session.state.changed',state:{effectivePermissionModeId:'agent'}}});
     else channel.emit({kind:'interaction',interaction:text==='question'?{type:'question',interactionId:'q',turnId:active,questions:[]}:
      {type:'approval',interactionId:'a',turnId:active,title:'Write or network',actions:[{id:'allow',effect:'allowAlways'},...(text==='unsafe'?[]:[{id:'deny',effect:'denyOnce'}])]}});
    }
    return {ok:true,value:{accepted:true}};
   },
  }};
 }};
 try {
  for(const plugin of [Llm,Sessions,Projections,Prompt,Tools,Agents])await ctx.plugin(plugin);
  ctx.provide('userQuestions',{ask(){throw new Error('unexpected UI');}});
  const runner=new DshRunner(ctx,bindings,{codex:adapter});
  ctx.on('agent/pre-step',async payload=>{await runner.run(payload,await bindings.read(payload.agent.id));return {kind:'enter',messages:[]};});
  await ctx.plugin(Loop,{agents:[]});
  const {agent}=await ctx.agents.create({sessionId:'discussion',meta:{cwd:root}});
  await bindings.write({version:1,sessionId:agent.id,harness:'codex',cwd:root,locked:true,permission:'agent',configs:{mode:'agent'},delegation:{parentSessionId:'parent',requestHash:'hash',discussion:true}});
  const prompt=async text=>{agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));await agent.whenIdle();return agent.session.snapshotEvents().filter(e=>e.type==='turn/end').at(-1).data.reason;};
  for(const text of ['read','approval','question'])assert.equal((await prompt(text)).kind,'completed');
  assert.equal(opens[0].permissionModeId,'read-only');assert.equal(opens[0].discussion,true);assert.equal(opens[0].configValues,undefined);
  assert.equal(commands.find(c=>c.type==='interaction.respond').response.actionId,'deny');
  await runner.live.get(agent.id).session.close();runner.live.delete(agent.id);
  assert.equal((await prompt('read')).kind,'completed');assert.equal(opens.at(-1).kind,'resume');assert.equal(opens.at(-1).permissionModeId,'read-only');
  const unsafe=await prompt('unsafe');assert.notEqual(unsafe.kind,'completed');assert.match(JSON.stringify(unsafe),/安全拒绝/);assert.equal(runner.live.size,0);
  assert.notEqual((await prompt('mode-change')).kind,'completed');assert.equal(runner.live.size,0);
  const binding=await bindings.read(agent.id);delete binding.pending;await bindings.write(binding);
  modeMismatch=true;const before=commands.length;
  assert.notEqual((await prompt('read')).kind,'completed');assert.equal(commands.length,before,'mode mismatch must fail before submitting input');assert.ok(closed>=3);
 } finally {await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
});
