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
// Prevent two local Agents using different connections from racing one project's locks.
const lock=path.join(config.dataDir,'agent.lock');try{await fs.mkdir(lock);}catch{throw Error('Agent가 이미 실행 중이거나 비정상 종료 잠금이 남아 있습니다. docs/security.md 참고');}
await fs.writeFile(path.join(lock,'pid'),String(process.pid),{mode:0o600});
const tasks=new Tasks(config);let socket:WebSocket;let closing=false;let heartbeat:NodeJS.Timeout;
function connect(){
  socket=new WebSocket(config.hub,{headers:{Authorization:`Bearer ${config.token}`,'X-Agent-User':config.user},maxPayload:16_000_000});
  socket.on('open',()=>console.log(`Agent connected for ${config.user}`));
  socket.on('message',async raw=>{
    let id:string|undefined;
    try {const input=JSON.parse(String(raw));id=input.id;const r=requestSchema.parse(input);const result=await tasks.command(r.method,r.params);if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id,result}));}
    catch(e){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id,error:redact(e instanceof Error?e.message:String(e))}));}
  });
  socket.on('error',()=>console.error('Hub connection error; retrying'));
  socket.on('close',()=>{clearInterval(heartbeat);if(!closing)setTimeout(connect,3000);});
  heartbeat=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.ping();},20000);
}
async function shutdown(){if(closing)return;closing=true;clearInterval(heartbeat);socket?.close();await tasks.close();await fs.rm(lock,{recursive:true});process.exit();}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
connect();
