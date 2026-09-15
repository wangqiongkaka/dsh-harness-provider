import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexRpc } from '../dist/codex-rpc.js';

test('correlates concurrent requests and rejects pending work when the peer exits', { timeout: 5000 }, async () => {
  const notices = [];
  const rpc = new CodexRpc({
    command: process.execPath,
    args: ['--input-type=module', '-e', `
      import { createInterface } from 'node:readline';
      const lines = createInterface({ input: process.stdin });
      for await (const line of lines) {
        const request = JSON.parse(line);
        if (request.method === 'exit') process.exit(1);
        if (request.method === 'wait') continue;
        process.stdout.write(JSON.stringify({ method: 'seen', params: request.method }) + '\\n');
        process.stdout.write(JSON.stringify({ id: request.id, result: request.params }) + '\\n');
      }
    `],
    cwd: process.cwd(), environment: { PATH: process.env.PATH },
    requestTimeoutMs: 1000, shutdownTimeoutMs: 100, maxFrameBytes: 1024,
    onMessage: message => notices.push(message), onFault: () => {},
  });
  try {
    assert.deepEqual(await Promise.all([rpc.request('one', 1), rpc.request('two', '中文')]), [1, '中文']);
    assert.equal(notices.length, 2);
    const pending = assert.rejects(rpc.request('wait', {}), /exited|closed/);
    await assert.rejects(rpc.request('exit', {}), /exited|closed/);
    await pending;
  } finally { await rpc.close(); }
});

test('malformed protocol output faults and shuts down the owned child', { timeout: 5000 }, async () => {
  let faults = 0;
  const rpc = new CodexRpc({
    command: process.execPath,
    args: ['-e', 'process.stdin.once("data", () => process.stdout.write("not-json\\n"));'],
    cwd: process.cwd(), environment: {}, requestTimeoutMs: 1000,
    shutdownTimeoutMs: 100, maxFrameBytes: 1024,
    onMessage: () => {}, onFault: () => { faults++; },
  });
  await assert.rejects(rpc.request('initialize', {}), /Invalid/);
  await rpc.close();
  assert.equal(faults, 1);
});

test('shutdown removes an owned descendant even after its parent exits', { timeout: 5000, skip: process.platform === 'win32' }, async()=>{
 const rpc=new CodexRpc({
  command:process.execPath,args:['--input-type=module','-e',`
   import {spawn} from 'node:child_process';
   const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
   child.unref();
   process.stdin.once('data',line=>process.stdout.write(JSON.stringify({id:JSON.parse(line).id,result:child.pid})+'\\n'));
   process.stdin.on('end',()=>process.exit(0));
  `],cwd:process.cwd(),environment:{},requestTimeoutMs:1000,shutdownTimeoutMs:300,maxFrameBytes:1024,
  onMessage:()=>{},onFault:()=>{throw new Error('observer failure must be contained');},
 });
 const pid=await rpc.request('pid',{});
 try {await rpc.close();assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}
 finally {try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
});
