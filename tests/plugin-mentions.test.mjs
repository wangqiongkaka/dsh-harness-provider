import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

test('task mode dock follows the composer card width axis', async () => {
 const source=await readFile('src/client.tsx','utf8');
 const rule=source.match(/\.hp-delegate\{([^}]+)\}/)?.[1]??'';
 assert.match(rule,/width:calc\(100% - var\(--dsh-composer-side-clearance\) - var\(--dsh-composer-side-clearance\)\)/);
 assert.match(rule,/max-width:var\(--dsh-composer-card-max-width\)/);
 assert.match(rule,/margin:0 auto/);
});

// Runs the real client entry with only the `@` source's services present.
test('the @ plugin source lists Harness plugins after files and inserts the native mention text', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({remove(){}}),head:{append(){}}}});
 const notion={name:'notion',displayName:'Notion',description:'Notion docs and workflows',mention:'[@notion](plugin://notion@openai-curated)'};
 const sentry={name:'sentry',displayName:'Sentry',description:null,mention:'[@sentry](plugin://sentry@openai-curated)'};
 const plain=value=>value===undefined?value:JSON.parse(JSON.stringify(value)); // results come from another VM realm
 const sources=[],requests=[];
 const remote={harness:{async plugins(request){requests.push(request.sessionId);return {ok:true,value:[notion,sentry]};}}};
 const ctx={
  remote:{...remote,async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>({delegate:'委派',delegateDescription:'创建独立会话执行任务',delegateTask:'任务',delegateCreated:'已创建委派会话'})[key]??key},effect(fn){fn();},
  inject(keys,apply){if(keys.includes('inputTriggers')&&!keys.includes('sessions'))apply({inputTriggers:{registerSource(source){sources.push(source);return ()=>{};}},remote,effect(fn){fn();}});},
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

test('the DSH / command source keeps file, goal, plan, compact and localized clear beside delegate and discuss in Harness sessions', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({remove(){}}),head:{append(){}}}});
 const rows=['file','model','goal','plan','compact','clear','export'];
 let commandInjectKeys=[];
 class CommandUi {
  async candidates(session,{query=''}){return rows.filter(name=>!query||name.includes(query)).map(name=>({name,session:session.sessionId,section:['file','goal','plan'].includes(name)?'添加':'指令'}));}
  dispatch(pick){return 'handled:'+pick.candidate.name;} matchSpace(_session,token){return 'handled:'+token;} async matchEnter(_session,line){
   if(!commandInjectKeys.includes('remote.commands'))throw new Error('cannot get property "remote.commands" without inject');
   return 'handled:'+line;
  }
 }
 const commandUi=new CommandUi(), disposers=[], reads=[];
 let failing=true;
 const delegations=[], discussions=[];
 const remote={harness:{
  async state({sessionId}){reads.push(sessionId);if(sessionId==='flaky'&&failing){failing=false;return {ok:false,error:{message:'offline'}};}return {ok:true,value:{harness:sessionId==='codex'?'codex':'dsh'}};},
  async delegateFromUser(request){delegations.push(request);return {ok:true,value:{sessionId:'delegated',harness:request.harness,accepted:true}};},
  async startDiscussionFromUser(request){discussions.push(request);return {ok:true,value:{accepted:true}};},
 }};
 const ctx={
  remote:{...remote,async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>({clear:'清理',clearDescription:'清理上下文',delegate:'委派',delegateDescription:'创建独立会话执行任务',delegateTask:'任务',delegateCreated:'已创建委派会话',discuss:'讨论',discussDescription:'由主 Agent 分配多个会话并汇总',discussTask:'讨论任务',discussStarted:'已开始讨论',commands:'指令'})[key]??key},effect(fn){fn();},
  inject(keys,apply){if(keys.includes('commandUi')){commandInjectKeys=keys;apply({commandUi,remote,effect(fn){disposers.push(fn());}});}},
 };
 await module.exports.apply(ctx);
 const names=async id=>Array.from(await commandUi.candidates({sessionId:id},{query:''}),row=>row.name);
 assert.deepEqual(await names('codex'),['file','goal','plan','compact','delegate','discuss','clear']);
 const merged=await commandUi.candidates({sessionId:'codex'},{query:''});
 assert.deepEqual(Array.from(merged.filter(row=>['compact','delegate','discuss','clear'].includes(row.name)),row=>row.section),['指令','指令','指令','指令']);
 const clear=merged.find(row=>row.name==='clear');
 assert.deepEqual(JSON.parse(JSON.stringify(clear)),{name:'clear',session:'codex',section:'指令',label:'清理',description:'清理上下文'});
 assert.equal(typeof clear.icon,'function','clear keeps the command menu icon column');
 const session={sessionId:'codex'},candidate=(await commandUi.candidates(session,{query:'del'}))[0];
 const delegated=commandUi.dispatch({candidate,session,position:'leading',via:'menu',action:'pick',span:{start:0,end:4,draftRev:0}});
 assert.equal(delegated.text,'');const delegation=module.exports.taskModes.get(session.sessionId).task;
 module.exports.setTaskMode(session.sessionId);
 assert.equal(commandUi.matchSpace(session,'/delegate').text,'');
 assert.equal(await commandUi.matchEnter(session,'/delegate task'),undefined);
 const image={type:'image',mediaType:'image/png',data:'AA=='};
 assert.deepEqual(JSON.parse(JSON.stringify(await delegation.submit('处理图片',{},[image]))),{kind:'success',text:'已创建委派会话'});
 const submitted=JSON.parse(JSON.stringify(delegations[0]));delete submitted.requestId;
 assert.deepEqual(submitted,{sessionId:'codex',harnesses:['codex'],prompt:'处理图片',attachments:[image],reportBack:false,worktree:false,picks:{}});
 module.exports.setTaskMode(session.sessionId);
 const discussCandidate=(await commandUi.candidates(session,{query:'dis'}))[0];
 const discussed=commandUi.dispatch({candidate:discussCandidate,session,position:'leading',via:'menu',action:'pick',span:{start:0,end:4,draftRev:0}});
 assert.equal(discussed.text,'');const discussionTask=module.exports.taskModes.get(session.sessionId).task;
 assert.equal(commandUi.matchSpace(session,'/discuss'),undefined,'模式内不重复接管指令');
 assert.equal(await commandUi.matchEnter(session,'/discuss compare'),undefined);
 assert.deepEqual(JSON.parse(JSON.stringify(await discussionTask.submit('比较方案',{},[image]))),{kind:'success',text:'已开始讨论'});
 const discussion=JSON.parse(JSON.stringify(discussions[0]));delete discussion.requestId;
 assert.deepEqual(discussion,{sessionId:'codex',prompt:'比较方案',attachments:[image],harnesses:['codex','claude-code']});
 module.exports.setTaskMode(session.sessionId);
 assert.equal(await commandUi.matchEnter({sessionId:'codex'},'/compact'),'handled:/compact','the server runs /compact on Codex');
 assert.equal(await commandUi.matchEnter({sessionId:'codex'},'/model gpt-5'),undefined,'a typed /model is sent to Codex as a prompt');
 assert.equal(await commandUi.matchEnter({sessionId:'native'},'/model'),'handled:/model');
 assert.deepEqual(await names('native'),['file','model','goal','plan','compact','delegate','discuss','clear','export']);
 assert.equal(await commandUi.matchEnter({sessionId:'native'},'/compact'),'handled:/compact');
 assert.deepEqual(await names('flaky'),['file','model','goal','plan','compact','delegate','discuss','clear','export'],'an unreadable session keeps the DSH menu');
 await commandUi.candidates({sessionId:'flaky'},{query:''});
 assert.deepEqual(reads,['codex','native','flaky','flaky'],'one read per session; a failed read is retried');
 for(const dispose of disposers)dispose?.();
 for(const key of ['candidates','dispatch','matchSpace','matchEnter'])assert.equal(Object.hasOwn(commandUi,key),false);
});

test('after /delegate the / menu lists only this session\'s skills and the hand-off waits for them', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({remove(){}}),head:{append(){}}}});
 class CommandUi {
  async candidates(){return [{name:'compact'}];}
  dispatch(){return 'handled';} matchSpace(_session,token){return 'handled:'+token;} async matchEnter(){return 'handled';}
 }
 const commandUi=new CommandUi(), disposers=[];
 const remote={harness:{async state(){return {ok:true,value:{harness:'dsh'}};},async delegateFromUser(request){return {ok:true,value:{harness:request.harness,accepted:true}};}}};
 const ctx={
  remote:{...remote,async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){
   const scope={commandUi,remote,effect(fn){disposers.push(fn());}};
   if(keys.includes('commandUi'))apply(scope);
  },
 };
 await module.exports.apply(ctx);
 const session={sessionId:'s1'};
 commandUi.matchSpace(session,'/delegate');

 assert.deepEqual(Array.from(await commandUi.candidates(session,{query:'han',position:'inline'}),row=>row.name),[],'only skills: no command rows');
 assert.equal(commandUi.matchSpace(session,'/plan'),undefined,'a space after a skill does not claim a command');
 module.exports.setTaskMode(session.sessionId);

 commandUi.matchSpace(session,'/discuss');
 assert.equal(commandUi.matchSpace(session,'/goal'),undefined,'讨论正文中的空格不能触发宿主指令');
 assert.deepEqual(Array.from(await commandUi.candidates(session,{query:'',position:'leading'})),[],'讨论模式不列出宿主指令');
 assert.equal(commandUi.dispatch({candidate:{name:'goal'},session}),undefined,'过期菜单项不能绕过模式');
 assert.equal(await commandUi.matchEnter(session,'/goal task'),undefined);
 module.exports.setTaskMode(session.sessionId);

 assert.deepEqual(Array.from(await commandUi.candidates(session,{query:'',position:'inline'}),row=>row.name),['compact']);

 const delegated=commandUi.dispatch({candidate:{name:'delegate'},session,position:'leading',via:'menu',action:'pick',span:{start:0,end:4,draftRev:0}});
 const delegation=module.exports.taskModes.get(session.sessionId).task;
 assert.equal((await delegation.submit('/handoff 实现登录',{},[])).text,'delegatePrepared','no session yet while the skill runs here');
 for(const dispose of disposers)dispose?.();

});

test('the model seat follows the Harness of the main-view session and task modes render above the composer', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({remove(){}}),head:{append(){}},body:{},querySelectorAll:()=>[]},
  MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval:()=>1,clearInterval(){}});
 // DSH 0.1.6 snapshots carry no `current`; the open session is the one retained by the main view.
 const snapshot={ids:['draft','other'],byId:{draft:{id:'draft',retainedBy:{mainView:1}},other:{id:'other',retainedBy:{}}}};
 const seats=new Map(),components=new Map();let api;
 const slots={
  inject(_name,register){return register();},
  register(options,component){if(options.name==='conversation.input.left')api=options.inject();components.set(options.name,component);seats.set(options.name,(seats.get(options.name)??0)+1);return ()=>seats.set(options.name,seats.get(options.name)-1);},
 };
 const remote={harness:{}};
 const ctx={
  remote:{...remote,async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){
   if(keys.includes('sessions')&&!keys.includes('inputTriggers'))apply({sessions:{list:{getSnapshot:()=>snapshot,subscribe:()=>()=>{}}},slots,remote,on(){},effect(fn){fn();}});
   else if(keys.length===1&&keys[0]==='slots')apply({slots,effect(fn){fn();}});
  },
 };
 await module.exports.apply(ctx);
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),Dock=components.get('conversation.input.dock');
 assert.ok(Dock);
 const t=key=>({delegate:'委派',delegateMode:'委派模式',native:'DSH 原生',reportBack:'完成后回传到当前会话',reportBackOff:'结果仅保留在新会话，不唤醒当前会话',delegateExit:'退出委派模式',discuss:'讨论',discussHint:'主 Agent 自动选择 1–4 个会话；多个会话完成后互评一轮',discussExit:'退出讨论模式'})[key]??key;
 const common={sessionId:'draft',inputActions:{setDraft(){}},t};
 assert.equal(renderToStaticMarkup(React.createElement(Dock,{...common,input:{phase:'plain',draft:'',attachmentIds:[],draftRev:0,occurrences:[],queue:[]}})),'');
 module.exports.setTaskMode('draft',module.exports.delegationClaim({}, {sessionId:'draft'},t));
 const html=renderToStaticMarkup(React.createElement(Dock,{...common,input:{phase:'claimed',claim:{name:'delegate',token:'/delegate '},draft:'/delegate task',attachmentIds:[],draftRev:1,occurrences:[],queue:[]}}));
 assert.match(html,/委派模式/);assert.match(html,/data-hp-mode="delegate"/);assert.match(html,/DSH 原生/);assert.match(html,/Codex/);assert.match(html,/Claude Code/);assert.match(html,/完成后回传到当前会话/);assert.match(html,/type="checkbox"/);
 module.exports.setTaskMode('draft',module.exports.discussionClaim({}, {sessionId:'draft'},t));
 const discussionHtml=renderToStaticMarkup(React.createElement(Dock,{...common,input:{phase:'claimed',claim:{name:'discuss',token:'/discuss '},draft:'/discuss task',attachmentIds:[],draftRev:1,occurrences:[],queue:[]}}));
 assert.match(discussionHtml,/讨论/);assert.match(discussionHtml,/1–4/);assert.match(discussionHtml,/data-hp-mode="discuss"/);assert.doesNotMatch(discussionHtml,/type="checkbox"/);
 api.changed('other','claude-code');
 assert.equal(seats.get('conversation.input.model')??0,0,'a Harness on a background session leaves the DSH model seat');
 api.changed('draft','claude-code');
 assert.equal(seats.get('conversation.input.model'),1,'the Harness model seat replaces the DSH one');
 assert.equal(seats.get('conversation.composer.dock'),1,'the Harness context reading joins the dock under the composer');
 api.changed('draft','dsh');
 assert.equal(seats.get('conversation.input.model'),0,'switching back to DSH restores its model seat');
 assert.equal(seats.get('conversation.composer.dock'),0,'a DSH session keeps the host context meter');
});

test('the delegation dock offers a model and effort pick per selected Codex / Claude Code target and sends only those picks', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {setTaskMode,delegationClaim,delegationOptions};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({remove(){}}),head:{append(){}},body:{},querySelectorAll:()=>[]},
  MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval:()=>1,clearInterval(){}});
 const components=new Map();
 const slots={inject(_name,register){return register();},register(options,component){components.set(options.name,component);return ()=>{};}};
 await module.exports.apply({remote:{harness:{},async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){if(keys.length===1&&keys[0]==='slots')apply({slots,effect(fn){fn();}});}});
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),Dock=components.get('conversation.input.dock');
 const t=(key,params)=>({pickLast:'沿用上次',native:'DSH 原生',pickModel:`${params?.harness} 的模型与推理强度`})[key]??key;
 const sent=[],read=[];
 const remote={models:async request=>{read.push(request);return {ok:true,value:{}};},delegateFromUser:async request=>{sent.push(request);return {ok:true,value:{sessionId:'child',harness:'codex',accepted:true}};}};
 const claim=module.exports.delegationClaim(remote,{sessionId:'draft'},t);
 module.exports.setTaskMode('draft',claim);
 const render=()=>renderToStaticMarkup(React.createElement(Dock,{sessionId:'draft',inputActions:{setDraft(){}},t,input:{phase:'claimed',claim:{name:'delegate',token:'/delegate '},draft:'/delegate task',attachmentIds:[],draftRev:1,occurrences:[],queue:[]}}));
 let html=render();
 assert.match(html,/aria-label="Codex 的模型与推理强度"/);assert.match(html,/Codex · 沿用上次/);
 assert.doesNotMatch(html,/Claude Code · /,'only selected targets get a pick');
 assert.equal(read.length,0,'the catalog is read on first open, not on entering delegation mode');
 const options=module.exports.delegationOptions;
 options.set('draft',{harnesses:['dsh','claude-code'],reportBack:false,worktree:false,picks:{codex:{model:'fast'},'claude-code':{model:'deep',thinking:'high'}}});
 html=render();
 assert.match(html,/Claude Code · deep/);assert.match(html,/· effort\.high/);assert.doesNotMatch(html,/Codex · /);assert.doesNotMatch(html,/DSH 原生 · /);
 await claim.submit('Plan the migration',{},[]);
 assert.deepEqual(JSON.parse(JSON.stringify(sent[0].picks)),{'claude-code':{model:'deep',thinking:'high'}},'a deselected target keeps its pick in the dock but does not send it');
 assert.deepEqual(sent[0].harnesses,['dsh','claude-code']);
});

test('sidebar marks active turns as breathing, completed sessions as static, and closed sessions as gray', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}},row={dataset:{},'__reactFiber$x':{memoizedProps:{node:{id:'s'}}}},styles=[];
 let refresh,processRunning=true;
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,
  document:{createElement:()=>({remove(){}}),head:{append(style){styles.push(style.textContent);}},body:{},querySelectorAll:()=>[row]},
  MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:fn=>{queueMicrotask(fn);return 1;},cancelAnimationFrame(){},
  setInterval:fn=>{refresh=fn;return 1;},clearInterval(){}});
 const summary={id:'s',retainedBy:{},running:false};
 const snapshot={ids:['s'],byId:{s:summary}};
 const remote={harness:{harnesses:async()=>({ok:true,value:{s:{harness:'codex',delegated:true,running:processRunning}}})}};
 const slots={inject(){},register(){return ()=>{};}};
 await module.exports.apply({remote:{...remote,async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){if(keys.includes('sessions')&&!keys.includes('inputTriggers'))apply({sessions:{list:{getSnapshot:()=>snapshot,subscribe:()=>()=>{}}},slots,remote,on(){},effect(fn){fn();}});}});
 const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
 await settle();
 assert.deepEqual({...row.dataset},{hpHarness:'codex',hpDelegated:''});
 const css=styles.join('\n');
 assert.match(css,/data-hp-harness="codex"[^}]+width:14px;height:14px;background:#10A37F[^}]+mask:url/);
 assert.match(css,/\[data-hp-running\]>span:first-child>\*\{display:none\}/,'the breathing Harness logo replaces native running dots');
 assert.match(css,/\[data-hp-running\]>span:first-child::before\{animation:hp-logo-breathe 1\.4s ease-in-out infinite\}/);
 assert.match(css,/@media \(prefers-reduced-motion:reduce\)\{\[data-hp-running\][^}]+animation:none/);
 summary.running=true;refresh();await settle();
 assert.deepEqual({...row.dataset},{hpHarness:'codex',hpDelegated:'',hpRunning:''});
 summary.running=false;refresh();await settle();
 assert.deepEqual({...row.dataset},{hpHarness:'codex',hpDelegated:''});
 processRunning=false;refresh();await settle();
 assert.deepEqual({...row.dataset},{hpHarness:'codex',hpDelegated:'',hpClosed:''});
 processRunning=true;refresh();await settle();
 assert.deepEqual({...row.dataset},{hpHarness:'codex',hpDelegated:''});
});

test('the subagents guide card names the plugin that provides it and opens the tab in place', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const React=require('react'), {renderToStaticMarkup}=require('react-dom/server');
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
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
 module.exports.setTaskMode('draft',module.exports.delegationClaim({}, {sessionId:'draft'},t));
 const html=renderToStaticMarkup(React.createElement(cards[0].component,props));
 assert.match(html,/子代理/);assert.match(html,/由 dsh-harness-provider 插件提供/);
 assert.match(html,/<span class="hp-guide-row"><span class="hp-guide-title">子代理<\/span><span class="hp-guide-line" title="由 dsh-harness-provider 插件提供">由 dsh-harness-provider 插件提供<\/span><\/span>/);
 assert.match(renderToStaticMarkup(React.createElement(cards[0].component,{...props,description:'查看子代理'})),/<\/span><span class="hp-guide-line">查看子代理<\/span>/,'description occupies its own row below the title and provider');
 assert.match(html,/<svg width="22" height="22"/,'compact cards keep the small icon');
 assert.match(renderToStaticMarkup(React.createElement(cards[0].component,{...props,description:'查看子代理'})),/<svg width="26" height="26"/,'described cards use the host icon size');
 cards[0].component(props).props.onClick();
 assert.deepEqual(JSON.parse(JSON.stringify(opened)),[['harness-subagents',{replaceTab:true}]]);
});

test('the Harness settings page follows Agent presets in Settings, renders the live values, and seeds delegation and discussion defaults', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {delegationClaim,discussionClaim,delegationOptions,discussionFor};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({remove(){}}),head:{append(){}},body:{},querySelectorAll:()=>[]},
  MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval:()=>1,clearInterval(){}});
 const registered=[],writes=[];
 const slots={inject(_name,register){return register();},register(options,component){registered.push({options,component});return ()=>{};}};
 const value={codexCommand:'/opt/codex',idleCloseSeconds:30,delegateHarnesses:['dsh','claude-code'],delegateReportBack:true,delegateWorktree:true,discussHarnesses:['claude-code'],
  progressFeedback:false,progressFeedbackText:'[CUSTOM FEEDBACK]',requestTimeoutSeconds:60,sessionLoadTimeoutSeconds:120,discussionTimeoutMinutes:30,toolOutputChars:64000,
  peerReviewChars:12000,discussionResultChars:16000,catalogCacheSeconds:60,quotaCacheSeconds:60,pluginCacheSeconds:30,recoveryCheckSeconds:30,acpStderr:false};
 const snapshot={status:'ready',value,user:{idleCloseSeconds:30},writable:true,revision:1,base:undefined,mode:'host'};
 const form={getSnapshot:()=>snapshot,subscribe:()=>()=>{},set:async(field,next)=>{writes.push(['set',field,next]);return true;},unset:async field=>{writes.push(['unset',field]);return true;}};
 let served;
 const configForms={get:entry=>{assert.equal(entry,'harness-plugin');return form;},whileServed:(namespaces,register)=>{served=namespaces;return register(new Set(namespaces));}};
 await module.exports.apply({remote:{harness:{},async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){if(keys.includes('configForms'))apply({slots,configForms,effect(fn){fn();}});}});
 assert.deepEqual([...served],['harness-plugin'],'the page exists only while the Host serves the entry');
 const section=registered.find(entry=>entry.options.name==='settings.section');
 assert.deepEqual(JSON.parse(JSON.stringify([section.options.id,section.options.order,section.options.label()])),['harness',25,'settingsNav'],'after Agent presets (20)');
 const face=section.options.inject();
 assert.equal(face.form,form);assert.equal(face.hooks.harnessSettings,form);
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const t=key=>key;
 const html=renderToStaticMarkup(React.createElement(section.component,{useHarnessSettings:select=>select(snapshot),form,t}));
 for (const group of ['settingsGroup.sessions','settingsGroup.delegation','settingsGroup.feedback','settingsGroup.advanced']) assert.match(html,new RegExp(`aria-label="${group}"`));
 // The executables stay configurable in the profile patch but are not shown on the page.
 assert.doesNotMatch(html,/settingsGroup\.programs|codexCommand|claudeCommand|\/opt\/codex/);
 assert.match(html,/<textarea[^>]*disabled=""[^>]*>\[CUSTOM FEEDBACK\]<\/textarea>/,'the text is kept but not editable while the contract is off');
 assert.equal((html.match(/settingsReset/g)??[]).length,1,'only the overridden field offers a reset');
 assert.match(html,/role="switch" aria-checked="true" aria-label="setting.delegateReportBack"/);
 assert.equal((html.match(/role="switch"/g)??[]).length,4);
 // Unwritable: every control is disabled and the page says why.
 const readOnly=renderToStaticMarkup(React.createElement(section.component,{useHarnessSettings:select=>select({...snapshot,writable:false}),form,t}));
 assert.match(readOnly,/settingsReadOnly/);assert.doesNotMatch(readOnly,/<input(?![^>]*disabled)/);
 assert.match(renderToStaticMarkup(React.createElement(section.component,{useHarnessSettings:select=>select({...snapshot,status:'unavailable',value:undefined}),form,t})),/settingsUnavailable/);
 // Entering delegation or discussion mode preselects what the settings say; a native DSH target drops the worktree.
 module.exports.delegationClaim({}, {sessionId:'draft'},t);
 assert.deepEqual(JSON.parse(JSON.stringify(module.exports.delegationOptions.get('draft'))),{harnesses:['dsh','claude-code'],reportBack:true,worktree:false,picks:{}});
 module.exports.discussionClaim({}, {sessionId:'draft'},t);
 assert.deepEqual([...module.exports.discussionFor('draft')],['claude-code']);
});
