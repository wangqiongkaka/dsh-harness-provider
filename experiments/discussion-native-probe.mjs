// Actual bundled ACP agents and local CLIs, with deterministic local model replies.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AcpAdapter } from '../dist/acp-adapter.js';
import { codexProfile, claudeProfile } from '../dist/acp-profiles.js';
const reference=resolve(process.env.DSH_REFERENCE_ROOT??'../../deepseek-harness');
const {startResponsesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-codex/tests/responses-fixture.ts')));
const {startMessagesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-claude-code/tests/messages-fixture.ts')));
const root=await realpath(await mkdtemp(join(tmpdir(),'discussion-native-')));
const workspace=join(root,'workspace'),codexHome=join(root,'codex'),claudeHome=join(root,'claude');
for(const dir of [workspace,codexHome,claudeHome])await mkdir(dir);
const codexFixture=await startResponsesFixture([
 {kind:'advertisedFunctionCall',choices:[{name:'exec_command',arguments:{cmd:'touch forbidden.txt'}},{name:'shell_command',arguments:{command:'touch forbidden.txt'}},{name:'shell',arguments:{command:['sh','-c','touch forbidden.txt']}}]},
 {kind:'complete',text:'checked'},
]);
const claudeFixture=await startMessagesFixture({kind:'tool-use',toolName:'Write',input:{file_path:join(workspace,'forbidden.txt'),content:'forbidden'},finalText:'checked'});
await writeFile(join(codexHome,'config.toml'),`model="fixture-model"
model_provider="fixture"
check_for_update_on_startup=false
[model_providers.fixture]
name="Local fixture"
base_url="${codexFixture.baseUrl}"
env_key="OPENAI_API_KEY"
wire_api="responses"
requires_openai_auth=false
[analytics]
enabled=false
`);
const environment={PATH:process.env.PATH,HOME:root,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome,
 OPENAI_API_KEY:'fixture-only',ANTHROPIC_API_KEY:'fixture-only',ANTHROPIC_BASE_URL:claudeFixture.baseUrl,
 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1',
 DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',NO_PROXY:'127.0.0.1,localhost'};
const unwrap=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result.value;};
const adapters=[];
const timer=setTimeout(()=>{console.error('原生只读探针超时');process.exitCode=1;for(const adapter of adapters)void adapter.close();},60000);
try {
 for(const harness of ['codex','claude-code']){
  const profile=harness==='codex'?codexProfile({command:process.env.CODEX_COMMAND??'/opt/homebrew/bin/codex',environment}):claudeProfile({command:process.env.CLAUDE_COMMAND??'/opt/homebrew/bin/claude',environment});
  const adapter=new AcpAdapter({profile,environment});adapters.push(adapter);
  const session=unwrap(await adapter.open({kind:'create',cwd:workspace,discussion:true,permissionModeId:harness==='codex'?'read-only':'plan'}));
  const outputs=session.outputs[Symbol.asyncIterator]();
  unwrap(await session.execute({type:'turn.start',turnId:'probe',input:[{type:'text',text:'Attempt the provided write, then report the result.'}]}));
  while(true){
   const next=await outputs.next();assert.equal(next.done,false);
   if(next.value.kind==='interaction'){
    const interaction=next.value.interaction;
    assert.equal(interaction.type,'approval');
    const action=interaction.actions.find(action=>action.effect==='denyOnce');assert.ok(action);
    unwrap(await session.execute({type:'interaction.respond',interactionId:interaction.interactionId,response:{type:'approval',actionId:action.id}}));
   } else if(next.value.event.type==='turn.completed'){
    assert.equal(next.value.event.outcome.status,'succeeded',JSON.stringify(next.value.event));break;
   }
  }
  await assert.rejects(access(join(workspace,'forbidden.txt')),{code:'ENOENT'});
  if(harness==='claude-code'){
   const names=claudeFixture.requests.filter(r=>Array.isArray(r.body.tools)).flatMap(r=>r.body.tools.map(t=>t.name));
   assert.ok(names.includes('Read'),JSON.stringify(names));
   for(const forbidden of ['Write','Edit','Bash','Agent','Task'])assert.ok(!names.includes(forbidden),forbidden);
  }else assert.ok(codexFixture.requests.length>=2,'write attempt must reach the CLI and return its result');
  await session.close();console.log(`通过：${harness} 实际工具写入被阻止`);
 }
} finally {clearTimeout(timer);await Promise.all(adapters.map(adapter=>adapter.close()));await codexFixture.close();await claudeFixture.close();await rm(root,{recursive:true,force:true});}
