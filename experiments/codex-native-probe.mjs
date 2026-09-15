import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { CodexAdapter } from '../dist/codex-adapter.js';
const reference=resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const {startResponsesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-codex/tests/responses-fixture.ts')));
const fixture=await startResponsesFixture([{kind:'complete',text:'native-one'},{kind:'complete',text:'native-two'},{kind:'complete',text:'native-three'}]);
const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-codex-native-')));
const home=join(root,'codex');await mkdir(home);
await writeFile(join(home,'config.toml'),`model = "fixture-model"
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
const options={command:process.env.CODEX_COMMAND ?? '/opt/homebrew/bin/codex',environment:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,OPENAI_API_KEY:'test-only',NO_PROXY:'127.0.0.1,localhost'},requestTimeoutMs:15000,shutdownTimeoutMs:1000,maxFrameBytes:16*1024*1024};
const adapters=[];
function unwrap(result){assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
const iterators=new WeakMap();
async function turn(session,text){
 if(!iterators.has(session))iterators.set(session,session.outputs[Symbol.asyncIterator]());
 const output=iterators.get(session);
 unwrap(await session.execute({type:'turn.start',turnId:'host-'+text,input:[{type:'text',text}]}));
 const chunks=[];
 while(true){const next=await output.next();assert.equal(next.done,false);const event=next.value.event;if(event?.type==='item.updated' && event.update.type==='text.append')chunks.push(event.update.text);if(event?.type==='turn.completed'){assert.equal(event.outcome.status,'succeeded',JSON.stringify(event));return chunks.join('');}}
}
try{
 const first=new CodexAdapter(options);adapters.push(first);
 const session=unwrap(await first.open({kind:'create',cwd:root}));const ref=session.initialState.nativeRef;
 assert.equal(await turn(session,'first'),'native-one');assert.equal(await turn(session,'second'),'native-two');
 assert.equal(unwrap(await session.readSnapshot()).turns.length,2);
 await first.close();
 const second=new CodexAdapter(options);adapters.push(second);
 const resumed=unwrap(await second.open({kind:'resume',cwd:root,nativeRef:ref}));
 assert.deepEqual(resumed.initialState.nativeRef,ref);
 assert.equal(await turn(resumed,'third'),'native-three');
 assert.equal(unwrap(await resumed.readSnapshot()).turns.length,3);
 assert.equal(fixture.requests.length,3);
 const third=JSON.stringify(fixture.requests[2].body.input);
 assert.ok(third.includes('first') && third.includes('native-one') && third.includes('second'));
 console.log('PASS: real Codex CLI two turns, durable history, new-process resume and prior context sent to local model fixture');
}finally{await Promise.all(adapters.map(a=>a.close()));await fixture.close();await rm(root,{recursive:true,force:true});}
