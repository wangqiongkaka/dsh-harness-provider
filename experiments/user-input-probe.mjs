// Real codex-acp (bundled in dist/) over the user's Codex CLI with a local model fixture: do Codex's two question tools reach the plugin in Default mode?
//   request_user_input        waits for the answer; Codex allows it outside Plan mode only with `features.default_mode_request_user_input`.
//   request_user_input_async  returns at once and posts the questions as a finished agent message; only models whose catalog entry
//                             offers it get the tool, so that case reads a Codex models cache (CODEX_MODELS_CACHE, default ~/.codex/models_cache.json).
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, copyFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AcpAdapter } from '../dist/acp-adapter.js';
import { codexProfile } from '../dist/acp-profiles.js';
const reference=resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const {startResponsesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-codex/tests/responses-fixture.ts')));

/** One native turn in which the fixture model calls `tool`; what the plugin saw and what Codex sent the model. */
async function run(tool,args,model,modelsCache){
 const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-user-input-')));
 const codexHome=join(root,'codex'),workspace=join(root,'workspace');
 await mkdir(workspace);await mkdir(codexHome);
 if(modelsCache) await copyFile(modelsCache,join(codexHome,'models_cache.json'));
 const fixture=await startResponsesFixture([{kind:'functionCall',name:tool,arguments:args},{kind:'complete',text:'final-after-question'},{kind:'complete',text:'spare'}]);
 await writeFile(join(codexHome,'config.toml'),`model = "${model}"
model_provider = "fixture"
approval_policy = "on-request"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.fixture]
name = "Local fixture"
base_url = "${fixture.baseUrl}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
[analytics]
enabled = false
`);
 const environment={PATH:process.env.PATH,HOME:root,CODEX_HOME:codexHome,OPENAI_API_KEY:'fixture-only',NO_PROXY:'127.0.0.1,localhost'};
 const adapter=new AcpAdapter({profile:codexProfile({command:process.env.CODEX_COMMAND ?? 'codex',environment}),environment});
 const questions=[],messages=[];
 try{
  const opened=await adapter.open({kind:'create',cwd:workspace});assert.equal(opened.ok,true,JSON.stringify(opened));
  const session=opened.value,output=session.outputs[Symbol.asyncIterator]();
  const started=await session.execute({type:'turn.start',turnId:'probe',input:[{type:'text',text:'ask me'}]});assert.equal(started.ok,true,JSON.stringify(started));
  const deadline=setTimeout(()=>{console.error('FAIL: the turn did not finish');process.exit(1);},60_000);
  while(true){
   const next=await output.next();assert.equal(next.done,false);
   const value=next.value;
   if(value.kind==='interaction'){
    assert.equal(value.interaction.type,'question');
    const question=value.interaction.questions[0];
    questions.push({prompt:question.prompt,options:question.options.map(option=>option.value)});
    await session.execute({type:'interaction.respond',interactionId:value.interaction.interactionId,response:{type:'question',answers:{[question.id]:[question.options[0].value]}}});
   } else if(value.event.type==='item.completed' && value.event.snapshot.item.type==='agentMessage') messages.push(value.event.snapshot.item.text);
   else if(value.event.type==='turn.completed'){assert.equal(value.event.outcome.status,'succeeded',JSON.stringify(value.event));break;}
  }
  clearTimeout(deadline);
  await session.close();
  const descriptions={};
  (function walk(value){
   if(Array.isArray(value)) value.forEach(walk);
   else if(value && typeof value==='object'){ if(typeof value.name==='string' && typeof value.description==='string') descriptions[value.name]=value.description; Object.values(value).forEach(walk); }
  })(fixture.requests[0].body);
  const toolOutput=fixture.requests.flatMap(request=>(Array.isArray(request.body.input)?request.body.input:[]).filter(entry=>entry.type==='function_call_output').map(entry=>typeof entry.output==='string'?entry.output:JSON.stringify(entry.output)))[0];
  return {questions,messages,descriptions,toolOutput};
 } finally { await adapter.close(); await fixture.close(); await rm(root,{recursive:true,force:true}); }
}

const waiting=await run('request_user_input',{questions:[{id:'range',header:'Range',question:'Pick a range?',options:[{label:'Keep five',description:'five'},{label:'Show all',description:'all'}]}]},'fixture-model');
assert.deepEqual(waiting.questions,[{prompt:'Pick a range?',options:['Keep five','Show all']}],`no question reached the plugin; Codex answered the model: ${waiting.toolOutput}`);
assert.match(waiting.toolOutput,/Keep five/);
console.log('PASS: request_user_input in Default mode opens a DSH question and returns the pick to the model');

const cache=process.env.CODEX_MODELS_CACHE ?? join(homedir(),'.codex','models_cache.json');
const catalog=await readFile(cache,'utf8').then(JSON.parse,()=>undefined);
const model=catalog?.models?.find(entry=>JSON.stringify(entry.model_messages ?? '').includes('request_user_input_async'))?.slug;
if(!model) console.log(`SKIP: no model in ${cache} offers request_user_input_async`);
else {
 const posted=await run('request_user_input_async',{questions:[{title:'Pick a range?',options:['Keep five','Show all']}]},model,cache);
 assert.equal(posted.toolOutput,'{"accepted":true}');
 assert.match(posted.descriptions.request_user_input,/Default/,'the waiting tool is offered in Default mode');
 const shown=posted.messages.filter(text=>text.includes('Pick a range?'));
 assert.equal(shown.length,1,`the posted questions must show exactly once; agent messages: ${JSON.stringify(posted.messages)}`);
 assert.match(shown[0],/Keep five[\s\S]*Show all/);
 assert.equal(posted.questions.length,0);
 console.log(`PASS: request_user_input_async (${model}) shows its questions and options as one message, and the waiting tool is offered in Default mode`);
}
console.log('Model replies came only from the local fixture server; no real model endpoint was used.');
