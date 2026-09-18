import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Runs the real client entry with only the `@` source's services present.
test('the @ plugin source lists Harness plugins after files and inserts the native mention text', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({entryPoints:[resolve('src/client.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({remove(){}}),head:{append(){}}}});
 const notion={name:'notion',displayName:'Notion',description:'Notion docs and workflows',mention:'[@notion](plugin://notion@openai-curated)'};
 const sentry={name:'sentry',displayName:'Sentry',description:null,mention:'[@sentry](plugin://sentry@openai-curated)'};
 const plain=value=>value===undefined?value:JSON.parse(JSON.stringify(value)); // results come from another VM realm
 const sources=[],requests=[];
 const remote={harness:{async plugins(request){requests.push(request.sessionId);return {ok:true,value:[notion,sentry]};}}};
 const ctx={
  remote:{...remote,async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){if(keys.includes('inputTriggers'))apply({inputTriggers:{registerSource(source){sources.push(source);return ()=>{};}},remote,effect(fn){fn();}});},
 };
 await module.exports.apply(ctx);
 assert.equal(sources.length,1);
 const [source]=sources;
 assert.equal(source.trigger,'@');assert.ok(source.order>0,'plugins follow the file references');
 const signal=new AbortController().signal, session={sessionId:'s1'};
 const all=await source.candidates(session,{query:'',position:'inline',drilled:false,signal});
 assert.deepEqual(plain(all.map(item=>[item.name,item.description ?? null,item.section])),[['Notion','Notion docs and workflows','plugins'],['Sentry',null,'plugins']]);
 assert.deepEqual(plain((await source.candidates(session,{query:'NOT',position:'inline',drilled:false,signal})).map(item=>item.name)),['Notion']);
 assert.deepEqual(plain(await source.candidates(session,{query:'no',quoted:true,position:'inline',drilled:false,signal})),[],'a quoted @"path" is a file');
 assert.deepEqual(requests,['s1','s1']);
 const pick=source.onPick({candidate:all[0],session,position:'inline',via:'menu',action:'pick',span:{start:0,end:1,draftRev:0}});
 assert.deepEqual(plain(pick),{insert:{source:'harness-plugin',ref:notion.mention,label:'Notion',clipboardText:notion.mention}});
 assert.equal(await source.codec.serialize(pick.insert.ref,signal),'[@notion](plugin://notion@openai-curated)');
});

test('the DSH / command source keeps only file, goal, plan and compact in Harness sessions', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({entryPoints:[resolve('src/client.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({remove(){}}),head:{append(){}}}});
 const rows=['file','model','goal','plan','compact','export'];
 class CommandUi { async candidates(session){return rows.map(name=>({name,session:session.sessionId}));} async matchEnter(session,line){return 'handled:'+line;} }
 const commandUi=new CommandUi(), disposers=[], reads=[];
 let failing=true;
 const remote={harness:{async state({sessionId}){reads.push(sessionId);if(sessionId==='flaky'&&failing){failing=false;return {ok:false,error:{message:'offline'}};}return {ok:true,value:{harness:sessionId==='codex'?'codex':'dsh'}};}}};
 const ctx={
  remote:{...remote,async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){if(keys.includes('commandUi'))apply({commandUi,remote,effect(fn){disposers.push(fn());}});},
 };
 await module.exports.apply(ctx);
 const names=async id=>(await commandUi.candidates({sessionId:id},{query:''})).map(row=>row.name);
 assert.deepEqual(await names('codex'),['file','goal','plan','compact']);
 assert.equal(await commandUi.matchEnter({sessionId:'codex'},'/compact'),'handled:/compact','the server runs /compact on Codex');
 assert.equal(await commandUi.matchEnter({sessionId:'codex'},'/model gpt-5'),undefined,'a typed /model is sent to Codex as a prompt');
 assert.equal(await commandUi.matchEnter({sessionId:'native'},'/model'),'handled:/model');
 assert.deepEqual(await names('native'),rows);
 assert.equal(await commandUi.matchEnter({sessionId:'native'},'/compact'),'handled:/compact');
 assert.deepEqual(await names('flaky'),rows,'an unreadable session keeps the DSH menu');
 await commandUi.candidates({sessionId:'flaky'},{query:''});
 assert.deepEqual(reads,['codex','native','flaky','flaky'],'one read per session; a failed read is retried');
 for(const dispose of disposers)dispose?.();
 assert.equal(Object.hasOwn(commandUi,'candidates'),false);assert.equal(Object.hasOwn(commandUi,'matchEnter'),false);
});
