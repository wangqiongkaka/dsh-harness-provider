import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

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
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime','react-dom','@deepseek-ai/dsh-client-ui-primitives']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({setAttribute(){},remove(){}}),head:{append(){}}}});
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
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim,linkPanels,linkable};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime','react-dom','@deepseek-ai/dsh-client-ui-primitives']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({setAttribute(){},remove(){}}),head:{append(){}},addEventListener(){},removeEventListener(){}}});
 const rows=['file','model','goal','plan','compact','clear','export'];
 let commandInjectKeys=[];
 let linkCommand;
 class CommandUi {
  // The Host lists a contributed command after its own rows, which puts it at the end of Commands.
  register(contribution){linkCommand=contribution;rows.push(contribution.name);return ()=>{};}
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
  remote:{...remote,async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>({clear:'清理',clearDescription:'清理上下文',delegate:'委派',delegateDescription:'创建独立会话执行任务',delegateTask:'任务',delegateCreated:'已创建委派会话',discuss:'讨论',discussDescription:'由主 Agent 分配多个会话并汇总',discussTask:'讨论任务',discussStarted:'已开始讨论',commands:'指令',linked:'关联项目',linkedHint:'可直接读写'})[key]??key},effect(fn){fn();},
  inject(keys,apply){if(keys.includes('commandUi')){commandInjectKeys=keys;apply({commandUi,remote,effect(fn){disposers.push(fn());}});}},
 };
 await module.exports.apply(ctx);
 const names=async id=>Array.from(await commandUi.candidates({sessionId:id},{query:''}),row=>row.name);
 assert.deepEqual(await names('codex'),['file','link','goal','plan','compact','delegate','discuss','clear']);
 const merged=await commandUi.candidates({sessionId:'codex'},{query:''});
 // Linked projects sit under Add, right below the file row.
 assert.equal(merged.find(row=>row.name==='link').section,'添加');
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
 // The row is an action: it opens the plugin's own panel for that session. The Host's select popup is not used, since it
 // always focuses its search field and would raise the on-screen keyboard.
 assert.equal(linkCommand.name,'link');assert.equal(linkCommand.label(),'关联项目');assert.equal(linkCommand.description(),'可直接读写');
 assert.equal(linkCommand.ui.kind,'action');
 assert.equal(module.exports.linkPanels.has('codex'),false);
 linkCommand.ui.run({sessionId:'codex'});
 assert.equal(module.exports.linkPanels.has('codex'),true);
 // Every registered project but the session's own, marked when linked; a link to a project the Host no longer has is not listed.
 assert.deepEqual(JSON.parse(JSON.stringify(module.exports.linkable(['web','removed'],[{id:'here',title:'work',path:'/code/work',current:true},{id:'api',title:'api',path:'/code/api',current:false},{id:'web',title:'web',path:'/code/web',current:false}]))),
  [{id:'api',title:'api',path:'/code/api',current:false,linked:false},{id:'web',title:'web',path:'/code/web',current:false,linked:true}]);
 assert.deepEqual(Array.from(module.exports.linkable(undefined,[{id:'api',title:'api',path:'/code/api',current:false}]),project=>project.linked),[false]);
 // Directories linked to the session alone follow the projects, named after their last folder; one that is a listed project is not repeated.
 assert.deepEqual(JSON.parse(JSON.stringify(module.exports.linkable([],[{id:'api',title:'api',path:'/code/api',current:false}],['/data/sets/images/','/code/api']))),
  [{id:'api',title:'api',path:'/code/api',current:false,linked:false},{id:'path:/data/sets/images/',title:'images',path:'/data/sets/images/',current:false,linked:true,custom:true}]);
 for(const dispose of disposers)dispose?.();
 for(const key of ['candidates','dispatch','matchSpace','matchEnter'])assert.equal(Object.hasOwn(commandUi,key),false);
});

test('after /delegate the / menu lists only this session\'s skills and the hand-off waits for them', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime','react-dom','@deepseek-ai/dsh-client-ui-primitives']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({setAttribute(){},remove(){}}),head:{append(){}},addEventListener(){},removeEventListener(){}}});
 class CommandUi {
  register(){return ()=>{};}
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
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime','react-dom','@deepseek-ai/dsh-client-ui-primitives']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({setAttribute(){},remove(){}}),head:{append(){}},body:{},querySelectorAll:()=>[]},
  MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval:()=>1,clearInterval(){}});
 // DSH 0.1.6 snapshots carry no `current`; the open session is the one retained by the main view.
 const snapshot={ids:['draft','other'],byId:{draft:{id:'draft',retainedBy:{mainView:1}},other:{id:'other',retainedBy:{}}}};
 const seats=new Map(),components=new Map();let api;
 const slots={
  entries:()=>[], subscribe:()=>()=>{},
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
 const original = () => null, entry = { options: { key: 'user' }, component: original };
 let listener, unsubscribed = false;
 const dispose = module.exports.wrapUserRenderers({ register: () => () => {}, entries: () => [entry], subscribe: (_key, fn) => { listener = fn; return () => { unsubscribed = true; }; } }, {});
 const renderSlotChain = () => 'source decoration';
 const decorated = entry.component({ renderSlotChain });
 assert.equal(decorated.props.renderSlotChain, renderSlotChain, 'the host child-slot capability survives decoration');
 assert.equal(decorated.props.host(), original);
 const wrapper = entry.component;
 listener(); assert.equal(entry.component, wrapper, 'slot updates do not wrap twice');
 dispose(); assert.equal(entry.component, original); assert.equal(unsubscribed, true);
 const disposeAgain = module.exports.wrapUserRenderers({ register: () => () => {}, entries: () => [entry], subscribe: () => () => {} }, {});
 const replacement = () => null; entry.component = replacement; disposeAgain();
 assert.equal(entry.component, replacement, 'unload preserves a later plugin replacement');
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
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {setTaskMode,delegationClaim,delegationOptions};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime','react-dom','@deepseek-ai/dsh-client-ui-primitives']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({setAttribute(){},remove(){}}),head:{append(){}},body:{},querySelectorAll:()=>[]},
  MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval:()=>1,clearInterval(){}});
 const components=new Map();
 const slots={inject(_name,register){return register();},register(options,component){components.set(options.name,component);return ()=>{};}};
 await module.exports.apply({remote:{harness:{},async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){if(keys.length===1&&keys[0]==='slots')apply({slots,effect(fn){fn();}});}});
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),Dock=components.get('conversation.input.dock');
 const t=(key,params)=>({pickDefault:'默认',native:'DSH 原生',pickModel:`${params?.harness} 的模型与推理强度`})[key]??key;
 const sent=[],read=[];
 const remote={models:async request=>{read.push(request);return {ok:true,value:{}};},delegateFromUser:async request=>{sent.push(request);return {ok:true,value:{sessionId:'child',harness:'codex',accepted:true}};}};
 const claim=module.exports.delegationClaim(remote,{sessionId:'draft'},t);
 module.exports.setTaskMode('draft',claim);
 const render=()=>renderToStaticMarkup(React.createElement(Dock,{sessionId:'draft',inputActions:{setDraft(){}},t,input:{phase:'claimed',claim:{name:'delegate',token:'/delegate '},draft:'/delegate task',attachmentIds:[],draftRev:1,occurrences:[],queue:[]}}));
 let html=render();
 assert.match(html,/aria-label="Codex 的模型与推理强度"/);assert.match(html,/Codex · 默认/);
 assert.doesNotMatch(html,/Claude Code · /,'only selected targets get a pick');
 assert.equal(read.length,0,'the catalog is read on first open, not on entering delegation mode');
 assert.match(html,/project · projectCurrent/,'a delegation stays in the session\'s own project until another is picked');
 const options=module.exports.delegationOptions;
 options.set('draft',{harnesses:['dsh','claude-code'],reportBack:false,worktree:false,workspaceId:'project',picks:{codex:{model:'fast'},'claude-code':{model:'deep',thinking:'high'}}});
 html=render();
 assert.match(html,/Claude Code · deep/);assert.match(html,/· effort\.high/);assert.doesNotMatch(html,/Codex · /);assert.doesNotMatch(html,/DSH 原生 · /);
 await claim.submit('Plan the migration',{},[]);
 assert.deepEqual(JSON.parse(JSON.stringify(sent[0].picks)),{'claude-code':{model:'deep',thinking:'high'}},'a deselected target keeps its pick in the dock but does not send it');
 assert.deepEqual(sent[0].harnesses,['dsh','claude-code']);
 assert.equal(sent[0].workspaceId,'project','the picked project travels with the delegation');
});

test('sidebar marks active turns as breathing, completed sessions as static, and closed sessions as gray', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {taskModes,setTaskMode,delegationClaim,discussionClaim};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime','react-dom','@deepseek-ai/dsh-client-ui-primitives']});
 const module={exports:{}},row={dataset:{},'__reactFiber$x':{memoizedProps:{node:{id:'s'}}}},styles=[];
 let refresh,processRunning=true;
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,
  document:{createElement:()=>({setAttribute(){},remove(){}}),head:{append(style){styles.push(style.textContent);}},body:{},querySelectorAll:selector=>selector.includes('treeitem')?[row]:[]},
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
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent(`<style>:root{--dsw-alias-label-tertiary:rgb(128, 128, 128)}${css}</style><div data-hp-harness="dsh" data-hp-closed=""><span><div data-slot="sidebar.session.row.leading"></div></span></div><div data-hp-harness="dsh" data-hp-closed=""><span><div data-slot="sidebar.session.row.leading"><span data-session-schedule-mark></span></div></span></div><div data-hp-harness="dsh" data-hp-closed="" data-hp-delegated=""><span><div data-slot="sidebar.session.row.leading"></div></span></div>`);
  const marks=await page.locator('[data-hp-harness="dsh"]').evaluateAll(rows=>rows.map(row=>{
   const cell=row.firstElementChild;
   return [getComputedStyle(cell,'::before').content,getComputedStyle(cell,'::before').backgroundColor,getComputedStyle(cell,'::after').content];
  }));
  assert.deepEqual(marks,[['""','rgb(128, 128, 128)','none'],['none','rgba(0, 0, 0, 0)','none'],['""','rgb(128, 128, 128)','""']], 'empty host slots show gray logos and delegation badges without covering schedule marks');
  // The host paints a selected row with its hover gray; the plugin's sheet loads after it and tints the row with its Harness color.
  await page.setContent(`<style>.sessionRow.selected{background:rgb(60, 60, 60)}${css}</style><div role="treeitem" class="sessionRow selected" aria-selected="true" data-hp-harness="antigravity" data-hp-closed=""></div><div role="treeitem" class="sessionRow selected" aria-selected="true" data-hp-harness="claude-code"></div><div role="treeitem" class="sessionRow" aria-selected="false" data-hp-harness="antigravity"></div><div role="treeitem" class="sessionRow selected" aria-selected="true"></div><div role="treeitem" class="sessionRow selected" aria-selected="true" data-hp-harness="codex" data-hp-running=""></div>`);
  const tint=()=>page.locator('[role="treeitem"]').evaluateAll(rows=>rows.map(row=>[getComputedStyle(row).backgroundColor,getComputedStyle(row).animationName]));
  const breathing=await tint();
  assert.deepEqual(breathing.map(([,animation])=>animation),['hp-row-breathe','hp-row-breathe','none','none','none'],'the selected Harness tint breathes; unselected, unmarked and running rows stay still');
  assert.equal(breathing[4][0],'rgba(0, 0, 0, 0)','a running selected row drops its background: the breathing logo already shows activity');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.deepEqual(await tint(),[['rgba(66, 133, 244, 0.24)','none'],['rgba(217, 119, 87, 0.24)','none'],['rgba(0, 0, 0, 0)','none'],['rgb(60, 60, 60)','none'],['rgba(0, 0, 0, 0)','none']],'reduced motion keeps a static Harness tint; unselected and unmarked rows keep the host style');
 } finally { await browser.close(); }
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

test('workspace header gains a collapse-all button that folds every expanded project', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {mountCollapseAll,markStyles};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime','react-dom','@deepseek-ai/dsh-client-ui-primitives']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({setAttribute(){},remove(){}}),head:{append(){}}}});
 const {mountCollapseAll,markStyles}=module.exports;
 // Host markup with hashed CSS-module names: the action cluster fits exactly two 28px buttons and clips the rest.
 const project=(key,expanded,hidden='')=>`<section ${hidden}><div role="treeitem" data-row-key="workspace:${key}" aria-expanded="${expanded}" onclick="this.setAttribute('aria-expanded',String(this.getAttribute('aria-expanded')!=='true'));window.toggled.push('${key}')"></div></section>`;
 const host=rail=>`<style>.h_headerActions{display:flex;gap:4px;max-width:60px;overflow:hidden}.h_headerActionsHidden{max-width:0}.h_iconButton{flex:none;width:28px;height:28px;padding:0}${markStyles}</style>
  <div class="h_root${rail?' h_rail':''}"><div class="h_sectionHeader"><div class="h_headerActions"><button class="h_iconButton h_wide">s</button><button class="h_iconButton">+</button></div></div>
  ${project('a',true)}${project('b',false)}${project('c',true,'hidden')}</div><script>window.toggled=[]</script>`;
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent(host(false));
  const mount=()=>page.evaluate(`(${mountCollapseAll})('Collapse all projects')`);
  await mount();await mount();
  const button=page.locator('[data-hp-collapse-all]');
  assert.equal(await button.count(),1,'repeated passes keep one button');
  assert.equal(await button.getAttribute('aria-label'),'Collapse all projects');
  assert.equal(await button.getAttribute('class'),'h_iconButton h_wide','the button borrows the host icon button look');
  const box=await page.evaluate(()=>{const b=document.querySelector('[data-hp-collapse-all]').getBoundingClientRect(),c=document.querySelector('.h_headerActions').getBoundingClientRect(),last=document.querySelector('.h_headerActions>button:last-child').getBoundingClientRect();return {inside:b.left>=c.left&&b.right<=c.right,lastInside:last.right<=c.right};});
  assert.deepEqual(box,{inside:true,lastInside:true},'the cluster widens so no host button is clipped');
  assert.equal(await button.isDisabled(),false);
  await button.click();
  assert.deepEqual((await page.evaluate('window.toggled')).sort(),['a','c'],'only expanded projects are clicked, including hidden tucked ones');
  await mount();
  assert.equal(await button.isDisabled(),true,'nothing left to fold disables the button');
  await page.evaluate(()=>document.querySelector('.h_headerActions').classList.add('h_headerActionsHidden'));
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.h_headerActions')).maxWidth),'0px','the search-expanded state still hides the cluster');
  await page.setContent(host(true));await mount();
  assert.equal(await page.locator('[data-hp-collapse-all]').isVisible(),false,'the rail has no project rows, so the button hides');
 } finally { await browser.close(); }
});

test('sidebar hides New Session and moves panel entries to a horizontal icon bar above the Agent board', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {syncPanelTooltips,markStyles};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime','react-dom','@deepseek-ai/dsh-client-ui-primitives']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({setAttribute(){},remove(){}}),head:{append(){}}}});
 const {syncPanelTooltips,markStyles}=module.exports;
 const hostCss=`
  html,body{margin:0;height:640px}
  .h_sidebarCol{width:336px;height:640px;overflow:hidden}
  .h_root{display:flex;flex-direction:column;height:100%;padding:6px 8px;box-sizing:border-box;--dsh-sidebar-inline-padding:8px;--dsh-sidebar-paint-inset:3px;--dsw-radius-md:12px}
  .h_logoRow{flex:none;height:60px}
  .h_newSessionRow{flex:none;display:flex;height:38px;margin:0 4px}
  .h_newSession{flex:1;height:38px}
  .h_scrollRegion{margin-top:4px;position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
  .h_root:not(.h_collapsed) .h_scrollRegion{container-type:size}
  .h_scrollArea{flex:1;min-height:0;display:grid;grid-template-columns:4px minmax(0,1fr) 6px;grid-template-rows:8px max-content 2px max-content;align-content:start;overflow-y:auto}
  .h_root:not(.h_collapsed) .h_scrollArea{container-type:scroll-state}
  .h_panelList{grid-column:2;grid-row:2;flex:none;display:flex;flex-direction:column;gap:2px;margin-bottom:8px}
  .h_panelEntry{position:relative;display:flex;border-inline:3px solid transparent}
  .h_panelEntryWide>*:first-child{flex:1;min-width:0}
  .h_panelEntryWide .h_panelRow{width:100%;padding-right:38px}
  .h_panelUnpin{position:absolute;right:0;top:2px;width:28px;height:28px}
  .h_moreAnchor{display:flex;flex-direction:column}
  .h_panelRow{display:flex;align-items:center;min-height:32px;padding:5px 9px;box-sizing:border-box;border:0;background:transparent}
  .h_panelGlyph{display:inline-flex;align-items:center;justify-content:center}
  .h_regionArea{grid-column:2;grid-row:4;min-height:0;min-width:0;display:flex;flex-direction:column}
  .ws_root{flex:none;max-height:100cqh;display:flex;flex-direction:column;min-height:0}
  .ws_sectionHeader{flex:none;height:36px}
  .ws_listArea{flex:1;min-height:0;overflow-y:auto}
  @container scroll-state(scrollable: bottom){.ws_root .ws_listArea{overflow-y:hidden}}
  .h_footArea{flex:none;height:44px}
  .h_collapsed .h_scrollArea{display:flex;flex-direction:column}
  .h_collapsed .h_panelList{gap:12px}
  .h_collapsed .h_panelRow{width:36px;height:36px;justify-content:center;padding:0}
  [data-hp-agents]{height:180px}
 `;
 const entry=(label,unpin=true)=>`<div class="h_panelEntry h_panelEntryWide"><span><button type="button" class="h_panelRow" aria-label="${label}"><span class="h_panelGlyph"><svg width="16" height="16"></svg></span><span class="h_panelTitle">${label}</span></button></span>${unpin?'<button type="button" class="h_panelUnpin">x</button>':''}</div>`;
 const pageHtml=({collapsed=false,remoteDrawer=false,legacy=false}={})=>`<!doctype html><head><style>${hostCss}${markStyles}</style>${remoteDrawer?'<style data-dsh-remote-control-drawer-selection></style>':''}</head><body>
  <div class="h_sidebarCol"><div class="h_root${collapsed?' h_collapsed':''}">
   <div class="h_logoRow">deepseek HARNESS</div>
   ${legacy?'<button type="button" class="h_newSession">新会话</button>':'<div class="h_newSessionRow"><div data-slot="sidebar.session.action" style="display:contents"><button type="button" class="h_newSession">新会话</button></div></div>'}
   <div data-hp-agents>Agent 运行</div>
   ${legacy
     ?`<nav class="h_panelList">${['插件','自动化任务','Superagent','更多'].map(l=>`<button type="button" class="h_panelRow" aria-label="${l}"><span class="h_panelGlyph"><svg width="16" height="16"></svg></span><span class="h_panelTitle">${l}</span></button>`).join('')}</nav><div class="h_regionArea"><div class="ws_root"><div class="ws_sectionHeader">工作区</div><div class="ws_listArea"><div style="height:900px"></div></div></div></div>`
     :`<div class="h_scrollRegion"><div class="h_scrollArea"><nav class="h_panelList">${entry('插件',false)}${entry('自动化任务')}${entry('Superagent')}<div class="h_moreAnchor"><span><button type="button" class="h_panelRow" aria-label="更多" aria-haspopup="menu"><span class="h_panelGlyph"><svg width="16" height="16"></svg></span><span class="h_panelTitle">更多</span></button></span></div></nav><div class="h_regionArea"><div class="ws_root"><div class="ws_sectionHeader">工作区</div><div class="ws_listArea"><div style="height:900px"></div></div></div></div></div><span class="h_scrollFade"></span></div>`}
   <div class="h_footArea">设置</div>
  </div></div>
  <div data-shell-leading><div class="h_controls"><span><button type="button" data-sidebar-opener aria-label="展开侧边栏">open</button></span><span><button type="button" aria-label="新会话">new</button></span></div></div>
 </body>`;
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:400,height:640}});
  await page.setContent(pageHtml());
  const sync=()=>page.evaluate(`(${syncPanelTooltips})()`);
  await sync();
  const expanded=await page.evaluate(()=>{
   const rect=s=>document.querySelector(s).getBoundingClientRect();
   const rows=[...document.querySelectorAll('.h_panelRow')];
   const listArea=document.querySelector('.ws_listArea');
   return {
    newSessionDisplay:getComputedStyle(document.querySelector('.h_newSessionRow')).display,
    logoBottom:rect('.h_logoRow').bottom,
    navTop:rect('.h_panelList').top,
    navBottom:rect('.h_panelList').bottom,
    agentsTop:rect('[data-hp-agents]').top,
    agentsBottom:rect('[data-hp-agents]').bottom,
    regionTop:rect('.h_regionArea').top,
    footTop:rect('.h_footArea').top,
    rowTops:rows.map(r=>Math.round(r.getBoundingClientRect().top)),
    rowLefts:rows.map(r=>Math.round(r.getBoundingClientRect().left)),
    rowWidths:rows.map(r=>Math.round(r.getBoundingClientRect().width)),
    titlesVisible:[...document.querySelectorAll('.h_panelTitle')].some(e=>getComputedStyle(e).display!=='none'),
    unpinsVisible:[...document.querySelectorAll('.h_panelUnpin')].some(e=>getComputedStyle(e).display!=='none'),
    titles:rows.map(r=>r.title),
    listScrollable:listArea.scrollHeight>listArea.clientHeight&&getComputedStyle(listArea).overflowY==='auto',
    listHeight:Math.round(listArea.getBoundingClientRect().height),
   };
  });
  assert.equal(expanded.newSessionDisplay,'none','New Session is hidden in expanded sidebar');
  assert.ok(expanded.navTop>=expanded.logoBottom-1&&expanded.navBottom<=expanded.agentsTop+1,'panel bar sits between logo row and Agent board');
  assert.ok(expanded.agentsBottom<=expanded.regionTop+1&&expanded.regionTop<expanded.footTop,'Agent board sits above workspaces and footer');
  assert.equal(new Set(expanded.rowTops).size,1,'all panel icons share one horizontal row');
  for (let i=1;i<expanded.rowLefts.length;i++) assert.ok(expanded.rowLefts[i]>expanded.rowLefts[i-1],'panel icons run left to right');
  assert.ok(Math.max(...expanded.rowWidths)-Math.min(...expanded.rowWidths)<=2,'panel icon buttons share equal width');
  assert.equal(expanded.titlesVisible,false,'panel labels stay hidden in the horizontal icon bar');
  assert.equal(expanded.unpinsVisible,false,'inline unpin controls stay hidden in the horizontal icon bar');
  assert.deepEqual(expanded.titles,['插件','自动化任务','Superagent','更多'],'hover tooltips mirror each entry aria-label');
  assert.equal(expanded.listScrollable,true,'workspace list keeps scrolling below the Agent board');
  assert.ok(expanded.listHeight>200,'workspace list fills the remaining vertical space');

  // Collapsed sidebar: hide New Session, Agent board, panel launchers, workspaces and footer, and hide the leading New Session control while keeping the reopen button.
  await page.evaluate(()=>document.querySelector('.h_root').classList.add('h_collapsed'));
  await sync();
  const rail=await page.evaluate(()=>{
   const display=s=>getComputedStyle(document.querySelector(s)).display;
   const rows=[...document.querySelectorAll('.h_panelRow')];
   return {
    logoDisplay:display('.h_logoRow'),
    newSessionDisplay:display('.h_newSessionRow'),
    agentsDisplay:display('[data-hp-agents]'),
    panelListDisplay:display('.h_panelList'),
    regionDisplay:display('.h_regionArea'),
    footDisplay:display('.h_footArea'),
    leadingOpenerDisplay:display('[data-shell-leading] [data-sidebar-opener]'),
    leadingNewDisplay:display('[data-shell-leading] button:not([data-sidebar-opener])'),
    titles:rows.map(r=>r.getAttribute('title')),
   };
  });
  assert.notEqual(rail.logoDisplay,'none','collapsed sidebar keeps the toggle row to reopen');
  assert.equal(rail.newSessionDisplay,'none','New Session stays hidden when collapsed');
  assert.equal(rail.agentsDisplay,'none','Agent board is hidden when collapsed');
  assert.equal(rail.panelListDisplay,'none','panel launchers are hidden when collapsed');
  assert.equal(rail.regionDisplay,'none','workspaces are hidden when collapsed');
  assert.equal(rail.footDisplay,'none','footer is hidden when collapsed');
  assert.notEqual(rail.leadingOpenerDisplay,'none','macOS leading reopen button stays visible');
  assert.equal(rail.leadingNewDisplay,'none','macOS leading New Session button is hidden');
  assert.deepEqual(rail.titles,[null,null,null,null],'collapsed sidebar removes plugin titles');

  // Legacy host markup (no scrollRegion/newSessionRow wrapper): still hides New Session and places the icon bar above Agent board.
  await page.setContent(pageHtml({legacy:true}));
  await sync();
  const legacy=await page.evaluate(()=>{
   const rows=[...document.querySelectorAll('.h_panelRow')];
   return {
    newSessionDisplay:getComputedStyle(document.querySelector('.h_newSession')).display,
    navBottom:document.querySelector('.h_panelList').getBoundingClientRect().bottom,
    agentsTop:document.querySelector('[data-hp-agents]').getBoundingClientRect().top,
    rowTops:rows.map(r=>Math.round(r.getBoundingClientRect().top)),
   };
  });
  assert.equal(legacy.newSessionDisplay,'none','legacy New Session button is hidden');
  assert.ok(legacy.navBottom<=legacy.agentsTop+1,'legacy panel bar sits above Agent board');
  assert.equal(new Set(legacy.rowTops).size,1,'legacy panel icons sit in one horizontal row');

  // Phone drawer (dsh-remote-control active): desktop sidebar rules step aside and do not set plugin titles.
  await page.setContent(pageHtml({remoteDrawer:true}));
  await sync();
  const drawer=await page.evaluate(()=>({
   direction:getComputedStyle(document.querySelector('.h_panelList')).flexDirection,
   titles:[...document.querySelectorAll('.h_panelRow')].map(r=>r.getAttribute('title')),
  }));
  assert.equal(drawer.direction,'column','phone drawer is left to dsh-remote-control');
  assert.deepEqual(drawer.titles,[null,null,null,null],'phone drawer does not receive desktop tooltip titles');
 } finally { await browser.close(); }
});

test('子代理开始页入口沿用原生卡片，不注册自绘渲染器', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8'),resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime','react-dom','@deepseek-ai/dsh-client-ui-primitives']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({setAttribute(){},remove(){}}),head:{append(){}}}});
 const cards=[], tabs=[];
 const slots={inject(_name,register){return register();},register(options){if(options.name==='sidebar.right.tab.guide.entry')cards.push(options);return ()=>{};}};
 const ctx={
  remote:{async $mount(){return ()=>{};}},locale:{register(){return ()=>{};},bind:()=>key=>key},effect(fn){fn();},
  inject(keys,apply){if(keys.includes('sidebarRightTabs'))apply({sidebarRightTabs:{register:definition=>{tabs.push(definition);return ()=>{};}},slots,remote:{harness:{}},effect(fn){fn();}});},
 };
 await module.exports.apply(ctx);
 assert.equal(tabs[0].kind,'harness-subagents');
 assert.equal(tabs[0].guide[0].title(),'subagents');
 assert.equal(tabs[0].guide[0].description(),'subagentsDescription');
 assert.deepEqual(cards,[], '交给宿主的默认入口渲染器');
});

test('the Harness settings page follows Agent presets in Settings, renders the live values, and seeds delegation and discussion defaults', async () => {
 const require=createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
 const bundle=await build({stdin:{contents:await readFile('src/client.tsx','utf8')+'\nexport {delegationClaim,discussionClaim,delegationOptions,discussionFor};',resolveDir:resolve('src'),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime','react-dom','@deepseek-ai/dsh-client-ui-primitives']});
 const module={exports:{}};
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,document:{createElement:()=>({setAttribute(){},remove(){}}),head:{append(){}},body:{},querySelectorAll:()=>[]},
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
 assert.equal((html.match(/aria-label="settingsReset"/g)??[]).length,1,'only the overridden field offers a reset');
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
