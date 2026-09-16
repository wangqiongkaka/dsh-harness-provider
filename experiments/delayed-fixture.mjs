import { createServer } from 'node:http';

/**
 * Delay one request to a local model fixture so steering can race an actual in-flight model call. The fixture answers
 * every request with the same message id; the proxy makes each id unique so message-addressed forks stay unambiguous.
 */
export async function delayedFixture(target) {
  let hold, served=0;
  const server=createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=Buffer.concat(chunks), pending=hold;
      if(pending && !pending.used && req.url.includes('/messages')){pending.used=true;pending.started.resolve();await pending.release.promise;}
      const response=await fetch(target+req.url,{method:req.method,headers:{'content-type':'application/json','x-api-key':'fixture-only'},body:req.method==='POST'?body:undefined});
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});
      const serial=++served;
      res.end((await response.text()).replaceAll('msg_dsh_fixture',`msg_dsh_fixture_${serial}`).replaceAll('"msg_fixture"',`"msg_fixture_${serial}"`));
    }catch{res.writeHead(500).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {baseUrl:`http://127.0.0.1:${server.address().port}`,hold(){hold={started:Promise.withResolvers(),release:Promise.withResolvers(),used:false};return hold;},
    async close(){hold?.release.resolve();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
