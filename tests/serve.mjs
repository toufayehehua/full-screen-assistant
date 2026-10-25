import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const routes=new Map([
  ['/fixture.html',['tests/fixture.html','text/html; charset=utf-8']],
]);
const server=createServer(async(req,res)=>{
  const route=routes.get(new URL(req.url,'http://localhost').pathname);
  if(!route){res.writeHead(404).end();return;}
  try{res.writeHead(200,{'Content-Type':route[1],'Cache-Control':'no-store'}).end(await readFile(new URL(route[0],root)));}
  catch{res.writeHead(500).end();}
});
server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}/fixture.html PID=${process.pid}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
