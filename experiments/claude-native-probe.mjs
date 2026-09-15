import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClaudeCodeAdapter } from '../dist/claude-adapter.js';
const reference=resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const {startMessagesFixture}=await import(pathToFileURL(join(reference,'packages/subagent/subagent-claude-code/tests/messages-fixture.ts')));
const fixture=await startMessagesFixture({kind:'complete',text:'native-claude-reply'});
const root=await mkdtemp(join(tmpdir(),'dsh-claude-native-'));
const home=join(root,'claude');await mkdir(home);
await writeFile(join(home,'settings.json'),JSON.stringify({model:'claude-sonnet-4-6',permissions:{defaultMode:'default'}}));
const environment={PATH:process.env.PATH,HOME:root,CLAUDE_CONFIG_DIR:home,ANTHROPIC_API_KEY:'fixture-only',ANTHROPIC_BASE_URL:fixture.baseUrl,
 CODEXHOST_CLAUDE_COMMAND:process.env.CLAUDE_COMMAND ?? '/opt/homebrew/bin/claude',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
 CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',NO_PROXY:'127.0.0.1,localhost'};
const adapters=[];let nativeRef;
function unwrap(result){assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function turn(session,output,text){
 unwrap(await session.execute({type:'turn.start',turnId:'host-'+text,input:[{type:'text',text}]}));
 let reply='';
 while(true){const next=await output.next();assert.equal(next.done,false);const event=next.value.event;
  if(event?.type==='session.state.changed' && event.state.nativeRef)nativeRef=event.state.nativeRef;
  if(event?.type==='item.completed' && event.snapshot.item.type==='agentMessage')reply+=event.snapshot.item.text;
  if(event?.type==='turn.completed'){assert.equal(event.outcome.status,'succeeded',JSON.stringify(event));return reply;}
 }
}
try{
 const first=new ClaudeCodeAdapter({environment});adapters.push(first);
 const session=unwrap(await first.open({kind:'create',cwd:root}));const output=session.outputs[Symbol.asyncIterator]();
 assert.equal(await turn(session,output,'first'),'native-claude-reply');
 assert.equal(await turn(session,output,'second'),'native-claude-reply');
 assert.ok(nativeRef);const savedRef=nativeRef;await first.close();
 const second=new ClaudeCodeAdapter({environment});adapters.push(second);
 const resumed=unwrap(await second.open({kind:'resume',cwd:root,nativeRef:savedRef}));
 assert.equal(await turn(resumed,resumed.outputs[Symbol.asyncIterator](),'third'),'native-claude-reply');
 assert.deepEqual(nativeRef,savedRef);
 assert.ok(fixture.requests.some(r=>JSON.stringify(r.body.messages).includes('first')&&JSON.stringify(r.body.messages).includes('third')));
 console.log('PASS: real Claude Code multi-turn, saved native identity, and new-process resume using only a local model fixture');
}finally{await Promise.all(adapters.map(a=>a.close()));await fixture.close();await rm(root,{recursive:true,force:true});}
