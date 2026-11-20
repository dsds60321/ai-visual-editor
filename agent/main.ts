import { promises as fs } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { configSchema, requestSchema, redact } from '../shared/protocol.js';
import { Tasks } from './project/tasks.js';
const file=path.resolve(process.argv[2]||'agent.config.json');
const config=configSchema.parse(JSON.parse(await fs.readFile(file,'utf8')));
config.dataDir=path.resolve(path.dirname(file),config.dataDir);
for(const p of config.projects)p.path=path.resolve(path.dirname(file),p.path);
if(new Set(config.projects.map(p=>p.id)).size!==config.projects.length)throw Error('중복 프로젝트 ID');
const url=new URL(config.hub);
if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('원격 Hub 연결에는 WSS가 필요합니다');
await fs.mkdir(config.dataDir,{recursive:true,mode:0o700});
config.dataDir=await fs.realpath(config.dataDir);
// Prevent two local Agents using different connections from racing one project's locks.
const lock=path.join(config.dataDir,'agent.lock');try{await fs.mkdir(lock);}catch{throw Error('Agent가 이미 실행 중이거나 종료되지 않은 잠금이 있습니다. agent.lock/pid의 프로세스가 종료됐는지 확인하세요');}
await fs.writeFile(path.join(lock,'pid'),String(process.pid),{mode:0o600});
let socket:WebSocket;let closing=false;let heartbeat:NodeJS.Timeout;
const tasks=new Tasks(config,(taskId,event)=>{
  if(!closing&&socket?.readyState===WebSocket.OPEN&&socket.bufferedAmount<1_000_000)
    socket.send(JSON.stringify({taskId,event}));
});
const inFlight=new Set<Promise<void>>();
function connect(){
  if(closing)return;
  socket=new WebSocket(config.hub,{headers:{Authorization:`Bearer ${config.token}`,'X-Agent-User':config.user},maxPayload:16_000_000});
  socket.on('open',()=>console.log(`Agent connected for ${config.user}`));
  socket.on('message',raw=>{
    if(closing)return;
    const request=handle(raw);
    inFlight.add(request);
    void request.finally(()=>inFlight.delete(request));
  });
  async function handle(raw:WebSocket.RawData){
    let id:string|undefined;
    try {const input=JSON.parse(String(raw));id=input.id;const r=requestSchema.parse(input);const result=await tasks.command(r.method,r.params);if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id,result}));}
    catch(e){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id,error:redact(e instanceof Error?e.message:String(e))}));}
  }
  socket.on('error',()=>console.error('Hub connection error; retrying'));
  socket.on('close',code=>{
    clearInterval(heartbeat);
    if(code===4000)void shutdown();
    else if(!closing)setTimeout(connect,3000);
  });
  heartbeat=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.ping();},20000);
}
async function shutdown(){
  if(closing)return;
  closing=true;clearInterval(heartbeat);socket?.close();
  try{
    // Let an apply already in progress finish or roll back before touching its backup.
    await Promise.allSettled(inFlight);
    await tasks.close();
    const skipped=await tasks.purgeWorkspaces();
    if(skipped.length)console.error('복구가 필요하거나 지우지 못한 작업 폴더:',skipped.join(', '));
  }catch(error){
    console.error('작업 폴더 자동 정리 실패:',error);process.exitCode=1;
  }finally{
    await fs.rm(lock,{recursive:true,force:true});
  }
}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
connect();
