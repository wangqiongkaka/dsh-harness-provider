import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LocalAttachments from '@deepseek-ai/dsh-attachment-local';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { harnessInput } from '../dist/media.js';
import { SecretQuestions } from '../dist/secret-questions.js';
import { DshOutput } from '../dist/dsh-output.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';

test('images/files use verified attachment storage and image tool output retains durable references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-media-')), ctx = new Context();
  try {
    await ctx.plugin(LocalAttachments, { dshHome: root });
    const content = await ctx.attachments.admitPromptContent([{ type:'image', mediaType:'image/png', data:png }]);
    const file = await ctx.attachments.saveFile({data:Buffer.from('attachment text'),name:'note.txt'});
    content.push({type:'file',attachment:file});
    const input = await harnessInput(ctx, [createUserMessage({source:{kind:'user'},content})], new AbortController().signal);
    assert.equal(input[0].type,'image');assert.ok(input[0].base64Data.length);
    assert.match(input[1].text,/note.txt/);
    await assert.rejects(ctx.attachments.admitPromptContent([{type:'image',mediaType:'image/png',data:Buffer.from('not an image').toString('base64')}]));
    const records=[];
    const agent={session:{append(type,data){records.push({type,data});return {seq:records.length};}}};
    const output=new DshOutput(ctx,agent,{turn:1,step:1},()=>1,()=>({provider:'test',model:'test'}));
    await output.complete({item:{type:'toolExecution',itemId:'image',toolName:'view',arguments:{},output:{content:[{type:'text',text:'image output'},{type:'image',mimeType:'image/png',base64Data:png}]}},outcome:{status:'succeeded'}});
    const result=records.find(r=>r.type==='tool/result');
    const parts=result.data.message.content;
    assert.equal(parts[0].text,'image output');assert.equal(parts[1].type,'image');
    assert.ok((await ctx.attachments.readImage(parts[1].attachment)).data.length);
    assert.equal(JSON.stringify(records).includes(png),false);
    await output.complete({item:{type:'toolExecution',itemId:'file-image',toolName:'view',arguments:{},output:{content:[{type:'imageFile',path:ctx.attachments.imageHostPath(content[0].attachment)}]}},outcome:{status:'succeeded'}});
    assert.equal(records.filter(r=>r.type==='tool/result').at(-1).data.message.content[0].type,'image');
  } finally { await ctx.fiber.dispose(); await rm(root,{recursive:true,force:true}); }
});

test('secret answers are session-scoped, single-use, cancellable, and absent from public state', async () => {
  const secrets = new SecretQuestions(), abort = new AbortController();
  const question={type:'question',interactionId:'secret',turnId:'turn',questions:[{id:'password',type:'text',prompt:'Password',secret:true,optional:false,multiline:false,prefill:'must-not-expose'}]};
  const pending=secrets.ask('session',question,abort.signal), state=secrets.read('session');
  assert.equal(JSON.stringify(state).includes('must-not-expose'),false);
  assert.equal(secrets.read('other'),null);
  assert.throws(()=>secrets.answer('other',state.id,{type:'question',answers:{password:['value']}}));
  assert.throws(()=>secrets.answer('session',state.id,{type:'question',answers:{}}));
  secrets.answer('session',state.id,{type:'question',answers:{password:['value']}});
  assert.deepEqual((await pending).answers,{password:['value']});assert.equal(secrets.read('session'),null);
  assert.throws(()=>secrets.answer('session',state.id,{type:'question',answers:{password:['value']}}));
  const cancelled=secrets.ask('session',question,abort.signal);abort.abort();
  await assert.rejects(cancelled,/取消/);assert.equal(secrets.read('session'),null);
  const closed=secrets.ask('session',question,new AbortController().signal);secrets.cancel('session','secret');
  assert.equal(await closed,undefined);
});
