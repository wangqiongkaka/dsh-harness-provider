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

test('the model seat follows the Harness of the main-view session', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({entryPoints:[resolve('src/client.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({remove(){}}),head:{append(){}},body:{},querySelectorAll:()=>[]},
  MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){}});
 // DSH 0.1.6 snapshots carry no `current`; the open session is the one retained by the main view.
 const snapshot={ids:['draft','other'],byId:{draft:{id:'draft',retainedBy:{mainView:1}},other:{id:'other',retainedBy:{}}}};
 const seats=new Map();let api;
 const slots={
  inject(_name,register){return register();},
  register(options){if(options.name==='conversation.input.left')api=options.inject();seats.set(options.name,(seats.get(options.name)??0)+1);return ()=>seats.set(options.name,seats.get(options.name)-1);},
 };
 const remote={harness:{}};
 const ctx={
  remote:{...remote,async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){if(keys.includes('sessions'))apply({sessions:{list:{getSnapshot:()=>snapshot,subscribe:()=>()=>{}}},slots,remote,on(){},effect(fn){fn();}});},
 };
 await module.exports.apply(ctx);
 api.changed('other','claude-code');
 assert.equal(seats.get('conversation.input.model')??0,0,'a Harness on a background session leaves the DSH model seat');
 api.changed('draft','claude-code');
 assert.equal(seats.get('conversation.input.model'),1,'the Harness model seat replaces the DSH one');
 api.changed('draft','dsh');
 assert.equal(seats.get('conversation.input.model'),0,'switching back to DSH restores its model seat');
});

test('the subagents guide card names the plugin that provides it and opens the tab in place', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const React=require('react'), {renderToStaticMarkup}=require('react-dom/server');
 const bundle=await build({entryPoints:[resolve('src/client.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({remove(){}}),head:{append(){}}}});
 const cards=[];
 const slots={inject(_name,register){return register();},register(options,component){if(options.name==='sidebar.right.tab.guide.entry')cards.push({key:options.key,component});return ()=>{};}};
 const ctx={
  remote:{async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){if(keys.includes('sidebarRightTabs'))apply({sidebarRightTabs:{register:()=>()=>{}},slots,remote:{harness:{}},effect(fn){fn();}});},
 };
 await module.exports.apply(ctx);
 assert.deepEqual(cards.map(card=>card.key),['dsh-harness-provider/subagents'],'only the plugin\'s own tab gets the card');
 const opened=[];
 const t=key=>({providedBy:'由 dsh-harness-provider 插件提供'})[key]??key;
 const props={kind:'harness-subagents',title:'子代理',useTabInfo:()=>({tab:{actions:{openTab:(...args)=>opened.push(args)}}}),t};
 const html=renderToStaticMarkup(React.createElement(cards[0].component,props));
 assert.match(html,/子代理/);assert.match(html,/由 dsh-harness-provider 插件提供/);
 assert.match(renderToStaticMarkup(React.createElement(cards[0].component,{...props,description:'查看子代理'})),/查看子代理/,'a description still shows while the host lists one');
 cards[0].component(props).props.onClick();
 assert.deepEqual(JSON.parse(JSON.stringify(opened)),[['harness-subagents',{replaceTab:true}]]);
});
