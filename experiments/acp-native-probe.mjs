// Real codex-acp and claude-agent-acp (bundled in dist/) over the user's Codex / Claude Code CLIs, with local model fixtures.
import { delayedFixture } from './delayed-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AcpAdapter } from '../dist/acp-adapter.js';
import { claudeProfile, codexProfile } from '../dist/acp-profiles.js';
const reference=resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const {startResponsesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-codex/tests/responses-fixture.ts')));
const {startMessagesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-claude-code/tests/messages-fixture.ts')));
const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-acp-native-')));
// The workspace is separate from HOME: Claude Code skips project skills when the project directory is the home directory.
const codexHome=join(root,'codex'),claudeHome=join(root,'claude'),workspace=join(root,'workspace');
await mkdir(workspace);
await mkdir(join(codexHome,'skills','probe-skill'),{recursive:true});await mkdir(join(workspace,'.claude','skills','claude-probe-skill'),{recursive:true});await mkdir(claudeHome);
await writeFile(join(codexHome,'skills','probe-skill','SKILL.md'),'---\nname: probe-skill\ndescription: codex probe skill\n---\nPROBE_SKILL_BODY_MARKER\n');
await writeFile(join(workspace,'.claude','skills','claude-probe-skill','SKILL.md'),'---\nname: claude-probe-skill\ndescription: claude probe skill\n---\nCLAUDE_PROBE_SKILL_BODY\n');
const codexFixture=await startResponsesFixture([{kind:'complete',text:'native-one'},{kind:'complete',text:'native-two'},{kind:'complete',text:'native-three'},{kind:'complete',text:'native-four'},{kind:'complete',text:'native-five'}]);
const claudeFixture=await startMessagesFixture({kind:'complete',text:'native-claude-reply'});
const proxy=await delayedFixture(claudeFixture.baseUrl);
await writeFile(join(codexHome,'config.toml'),`model = "fixture-model"
model_provider = "fixture"
approval_policy = "on-request"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.fixture]
name = "Local fixture"
base_url = "${codexFixture.baseUrl}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
[analytics]
enabled = false
`);
await writeFile(join(claudeHome,'settings.json'),JSON.stringify({model:'claude-sonnet-4-6',permissions:{defaultMode:'default'}}));
const environment={PATH:process.env.PATH,HOME:root,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome,OPENAI_API_KEY:'fixture-only',ANTHROPIC_API_KEY:'fixture-only',ANTHROPIC_BASE_URL:proxy.baseUrl,
 CODEXHOST_CLAUDE_COMMAND:process.env.CLAUDE_COMMAND ?? '/opt/homebrew/bin/claude',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
 CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',NO_PROXY:'127.0.0.1,localhost'};
const profiles={codex:()=>codexProfile({command:process.env.CODEX_COMMAND ?? '/opt/homebrew/bin/codex',environment}),'claude-code':()=>claudeProfile({environment})};
const adapters=[];
function unwrap(result){assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
const iterators=new WeakMap();
async function turn(session,text,onStarted){
 if(!iterators.has(session))iterators.set(session,session.outputs[Symbol.asyncIterator]());
 const output=iterators.get(session);
 unwrap(await session.execute({type:'turn.start',turnId:'host-'+text,input:[{type:'text',text}]}));
 let reply='',key;
 while(true){const next=await output.next();assert.equal(next.done,false);const event=next.value.event;
  if(event?.type==='turn.started'){key=event.nativeTurnRef.nativeTurnKey;await onStarted?.();}
  if(event?.type==='item.completed' && event.snapshot.item.type==='agentMessage' && !event.snapshot.item.phase)reply+=event.snapshot.item.text;
  if(event?.type==='turn.completed'){assert.equal(event.outcome.status,'succeeded',JSON.stringify(event));assert.equal(event.nativeTurnRef.nativeTurnKey,key);return {reply,key};}}
}
try{
 for(const harness of ['codex','claude-code']){
  const fixture=harness==='codex'?codexFixture:claudeFixture, expected=harness==='codex'?['native-one','native-two','native-three']:['native-claude-reply','native-claude-reply','native-claude-reply'];
  const first=new AcpAdapter({profile:profiles[harness](),environment});adapters.push(first);
  const inspection=await first.inspect({cwd:workspace});
  assert.equal(inspection.status,'ready',JSON.stringify(inspection));
  assert.ok(inspection.catalog.models.length>0 && inspection.permissionModes.modes.length>=3,JSON.stringify(inspection)); // the fixture model has no effort metadata
  const skills=await first.listSkills({cwd:workspace});
  assert.ok(skills.some(skill=>skill.name===(harness==='codex'?'probe-skill':'claude-probe-skill')),skills.map(s=>s.name).join(','));
  console.log(`PASS: ${harness} catalogs (${inspection.catalog.models.length} models, modes ${inspection.permissionModes.modes.map(m=>m.id).join('/')}) and ${skills.length} slash entries read without a model request`);
  assert.equal(fixture.requests.length,0);
  const session=unwrap(await first.open({kind:'create',cwd:workspace}));const ref=session.initialState.nativeRef;
  const one=await turn(session,'first');assert.ok(one.reply.includes(expected[0]),one.reply);
  const two=await turn(session,'second');assert.ok(two.reply.includes(expected[1]),two.reply);
  const history=unwrap(await session.readSnapshot());
  assert.deepEqual(history.turns.map(t=>t.nativeTurnRef.nativeTurnKey),[one.key,two.key]);
  assert.ok(history.turns[0].input[0].text.endsWith('first') && history.turns.every(t=>t.outcome.status==='succeeded'));
  const forkRef=unwrap(await session.fork(one.key));assert.notEqual(forkRef.nativeSessionId,ref.nativeSessionId);
  const forked=unwrap(await first.open({kind:'resume',cwd:workspace,nativeRef:forkRef}));
  const forkHistory=unwrap(await forked.readSnapshot());assert.equal(forkHistory.turns.length,1,JSON.stringify(forkHistory));assert.ok(forkHistory.turns[0].input[0].text.endsWith('first'));
  await forked.close();
  console.log(`PASS: ${harness} history snapshot and selected-turn fork retain exactly the requested native history`);
  const skillTurn=await turn(session,`/${harness==='codex'?'probe-skill':'claude-probe-skill'} use it`);
  assert.ok(fixture.requests.some(r=>JSON.stringify(r.body).includes(harness==='codex'?'PROBE_SKILL_BODY_MARKER':'CLAUDE_PROBE_SKILL_BODY')),'skill body must reach the model: '+fixture.requests.length+' '+(await import('node:fs')).writeFileSync('/tmp/last-request.json',JSON.stringify(fixture.requests.map(r=>r.body.input??r.body.messages),null,1)));
  console.log(`PASS: ${harness} slash skill invocation reaches the native model request`);
  await session.close();await first.close();
  const second=new AcpAdapter({profile:profiles[harness](),environment});adapters.push(second);
  const resumed=unwrap(await second.open({kind:'resume',cwd:workspace,nativeRef:ref}));
  assert.deepEqual(resumed.initialState.nativeRef,ref);
  assert.deepEqual(unwrap(await resumed.readSnapshot()).turns.map(t=>t.nativeTurnRef.nativeTurnKey).slice(0,2),[one.key,two.key]);
  const three=await turn(resumed,'third');assert.ok(three.reply.length>0,three.reply); // the skill turn consumed one fixture reply
  const last=JSON.stringify(fixture.requests.at(-1).body);
  assert.ok(last.includes('first') && last.includes('second') && last.includes('third'),'resumed turn must carry prior context');
  if(harness==='claude-code'){
   const gate=proxy.hold();
   const steering=turn(resumed,'steer-original',async()=>{await gate.started.promise;unwrap(await resumed.steer([{type:'text',text:'steer-followup'}]));gate.release.resolve();});
   await steering;
   assert.ok(fixture.requests.some(r=>JSON.stringify(r.body.messages).includes('steer-followup')),'steering must reach the model');
   console.log('PASS: real Claude in-flight steering is consumed before the Host turn completes');
  }
  await resumed.close();await second.close();
  console.log(`PASS: real ${harness} multi-turn, durable turn keys, new-process resume and prior context sent to the local model fixture`);
 }
}finally{await Promise.allSettled(adapters.map(a=>a.close()));await proxy.close();await codexFixture.close();await claudeFixture.close();await rm(root,{recursive:true,force:true});}
