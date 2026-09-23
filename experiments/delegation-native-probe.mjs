import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DelegationBridge, delegationInstructions } from '../dist/delegation.js';
import { AcpAdapter } from '../dist/acp-adapter.js';
import { claudeProfile, codexProfile } from '../dist/acp-profiles.js';
const reference=resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const {startResponsesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-codex/tests/responses-fixture.ts')));
const {startMessagesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-claude-code/tests/messages-fixture.ts')));
const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-delegation-native-')));
const calls=[];
const bridge=new DelegationBridge(async(source,method,input)=>{calls.push({source,method,input});return {sessionId:'fixture-child',accepted:true};});
const quote=text=>"'"+text.replaceAll("'","'\\''")+"'";
const command=[process.execPath,resolve('dist/delegate-cli.mjs'),'create',JSON.stringify({requestId:'native-review',harness:'codex',prompt:'Review only'})].map(quote).join(' ');
const codex=await startResponsesFixture([{kind:'advertisedFunctionCall',choices:[
 {name:'exec_command',arguments:{cmd:command,max_output_tokens:1000}},
 {name:'shell_command',arguments:{command,timeout_ms:10000}},
 {name:'shell',arguments:{command:['/bin/sh','-c',command],timeout_ms:10000}},
]},{kind:'complete',text:'Delegation finished'}]);
const claude=await startMessagesFixture({kind:'tool-use',toolName:'Bash',input:{command,description:'Create DSH review session'},finalText:'Delegation finished'});
const codexHome=join(root,'codex'),claudeHome=join(root,'claude');
await mkdir(codexHome);await mkdir(claudeHome);
await writeFile(join(codexHome,'config.toml'),`model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "danger-full-access"
check_for_update_on_startup = false
[model_providers.fixture]
name = "Fixture"
base_url = "${codex.baseUrl}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
[analytics]
enabled = false
`);
await writeFile(join(claudeHome,'settings.json'),JSON.stringify({model:'claude-sonnet-4-6'}));
const environment={PATH:process.env.PATH,HOME:root,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome,
 OPENAI_API_KEY:'fixture-only',ANTHROPIC_API_KEY:'fixture-only',ANTHROPIC_BASE_URL:claude.baseUrl,
 CLAUDE_COMMAND_PATH:process.env.CLAUDE_COMMAND ?? '/opt/homebrew/bin/claude',
 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1',
 DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',NO_PROXY:'127.0.0.1,localhost'};
const adapters=[new AcpAdapter({profile:codexProfile({command:process.env.CODEX_COMMAND ?? '/opt/homebrew/bin/codex',environment}),environment}),
 new AcpAdapter({profile:claudeProfile({environment}),environment})];
try {
 for (const [index,harness] of ['codex','claude-code'].entries()) {
  const result=await adapters[index].open({kind:'create',cwd:root,permissionModeId:index?'bypassPermissions':'agent-full-access',environment:{...environment,...await bridge.environment(harness)}});
  assert.equal(result.ok,true,JSON.stringify(result));const session=result.value;
  const start=await session.execute({type:'turn.start',turnId:'probe',input:[{type:'text',text:delegationInstructions()},{type:'text',text:'Use Codex to review this workspace'}]});
  assert.equal(start.ok,true,JSON.stringify(start));
  const timer=setTimeout(()=>void session.close(),45000);
  let completed=false;const outputs=[];
  try {for await (const output of session.outputs) {
   outputs.push(output);
   if(output.event?.type==='turn.completed') {assert.equal(output.event.outcome.status,'succeeded',JSON.stringify(output));completed=true;break;}
  }} finally {clearTimeout(timer);}
  assert.ok(completed,'native turn did not complete');
  assert.ok(calls.some(call=>call.source===harness && call.input.requestId==='native-review'),JSON.stringify(outputs).slice(-6000));
  assert.ok(calls.every(call=>call.method==='create'));
  await session.close();
  console.log(`PASS: real ${harness} shell tool inherited session credentials and invoked bundled delegation CLI`);
 }
} finally {await Promise.allSettled(adapters.map(adapter=>adapter.close()));await bridge.close();await codex.close();await claude.close();await rm(root,{recursive:true,force:true});}
