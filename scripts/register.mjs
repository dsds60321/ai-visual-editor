import{createServer}from'node:http';
import{createHash,randomBytes}from'node:crypto';
import{readFileSync,renameSync}from'node:fs';
import{readFile,writeFile,realpath,rm}from'node:fs/promises';
import path from'node:path';
import{fileURLToPath}from'node:url';
import{projectSchema,configSchema}from'../dist/shared/protocol.js';
import{detect}from'../dist/agent/project/files.js';
const revision = project => createHash('sha256').update(JSON.stringify(project)).digest('hex');

export async function createRegistration(file){
 const token=randomBytes(32).toString('hex');let origin;
 const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><title>WebStudio · 프로젝트 등록</title><link rel="stylesheet" href="/style.css"><main><small>WebStudio · LOCAL AGENT</small><h1>내 PC 프로젝트 등록</h1><p>이 화면은 본인 PC에서만 열립니다. 실행 명령은 Hub로 전송하지 않습니다.</p><label>저장된 프로젝트<select id="saved-projects" disabled><option value="">새 프로젝트 등록</option></select></label><form><label>프로젝트 ID<input name="id" required pattern="[a-z0-9-]+" placeholder="my-project"></label><label>이름<input name="name" required></label><label>절대 경로<input name="path" required placeholder="/Users/me/work/project"></label><button type="button" id="detect">프레임워크 탐지</button><output id="detected"></output><label>실행 방식<select name="runtime"><option value="command">등록 명령 실행 (macOS)</option><option value="static">정적 HTML</option></select></label><label>빌드 명령 (JSON 인자 배열)<input name="buildCommand" value='[]'></label><label>시작 명령 (JSON 인자 배열, Vite는 --base와 작업 경로 인자 사용)<input name="startCommand" value='["npm","run","dev"]'></label><label>포트<input name="port" type="number" min="1024" max="65535" value="18090" required></label><label>준비 확인 경로<input name="readyPath" value="/"></label><label>처음 열 Preview 경로<input name="previewPath" value="/"></label><label>Preview 경로 접두사<select name="pathPrefix"><option value="root">기본 ( / )</option><option value="task">작업 경로 (Vite base 설정 필요)</option></select></label><label>변경 후 갱신<select name="refresh"><option value="reload">화면 새로고침 (Node / Vite / 정적)</option><option value="restart">재빌드·재시작 (Java)</option></select></label><label>재시작을 생략할 정적 리소스 폴더 (쉼표 구분)<input name="staticPreviewDirs" placeholder="webroot/assets, webroot/static"></label><label>정적 리소스 서버 캐시 대기 (ms)<input name="staticPreviewCacheMs" type="number" min="0" max="15000" value="0"></label><label>테스트 환경 변수 (JSON)<textarea name="environment">{}</textarea></label><label>제외 경로 (쉼표 구분)<input name="exclude" placeholder="uploads, config/private"></label><label class="check"><input type="checkbox" name="safePreview" required>운영 DB·API·메일·결제에 연결하지 않는 실행 설정임을 확인했습니다.</label><button type="submit">내 PC 설정에 저장</button></form><pre id="result" role="status"></pre></main><script src="/register.js"></script></html>`;
 const script=`const token=${JSON.stringify(token)};
const form=document.querySelector('form'), result=document.querySelector('#result');
const savedProjects=document.querySelector('#saved-projects'), submit=form.querySelector('[type=submit]');
let loadedRevision;
async function post(url,value){
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify(value)});
 const data=await response.json();
 if(!response.ok)throw Error(data.error);
 return data;
}
async function listProjects(selected=''){
 const projects=await post('/projects',{});
 savedProjects.replaceChildren(new Option('새 프로젝트 등록',''));
 for(const project of projects)savedProjects.add(new Option(project.name+' ('+project.id+')',project.id));
 savedProjects.value=selected;
}
function showProject({project,revision}){
 for(const [key,value] of Object.entries(project)){
  const field=form.elements[key];
  if(key==='safePreview')field.checked=value;
  else if(key==='exclude'||key==='staticPreviewDirs')field.value=value.join(', ');
  else field.value=typeof value==='object'?JSON.stringify(value):value;
 }
 form.elements.id.readOnly=true;
 submit.textContent='변경사항 저장';
 loadedRevision=revision;
}
savedProjects.onchange=async()=>{
 const previous=form.elements.id.readOnly?form.elements.id.value:'';
 savedProjects.disabled=submit.disabled=true;
 result.textContent='';
 document.querySelector('#detected').textContent='';
 try{
  if(savedProjects.value)showProject(await post('/project',{id:savedProjects.value}));
  else{
   form.reset();
   form.elements.id.readOnly=false;
   submit.textContent='내 PC 설정에 저장';
   loadedRevision=undefined;
  }
 }catch(e){savedProjects.value=previous;result.textContent=e.message;}
 finally{savedProjects.disabled=submit.disabled=false;}
};
document.querySelector('#detect').onclick=async()=>{
 try{document.querySelector('#detected').textContent=JSON.stringify(await post('/detect',{path:form.elements.path.value}));}
 catch(e){result.textContent=e.message;}
};
form.onsubmit=async e=>{
 e.preventDefault();
 savedProjects.disabled=submit.disabled=true;
 try{
  const v=Object.fromEntries(new FormData(form));
  for(const key of ['buildCommand','startCommand','environment'])v[key]=JSON.parse(v[key]);
  v.port=Number(v.port);
  v.staticPreviewCacheMs=Number(v.staticPreviewCacheMs);
  for(const key of ['exclude','staticPreviewDirs'])v[key]=v[key].split(',').map(s=>s.trim()).filter(Boolean);
  v.safePreview=form.elements.safePreview.checked;
  const saved=await post('/save',{...v,revision:loadedRevision});
  showProject(saved);
  await listProjects(saved.project.id);
  result.textContent=saved.message;
 }catch(e){result.textContent=e.message;}
 finally{savedProjects.disabled=submit.disabled=false;}
};
listProjects().then(()=>savedProjects.disabled=false).catch(e=>result.textContent=e.message);
`;
 const css=`
 *{box-sizing:border-box}
 body{margin:0;background:#fafafa;color:#171717;font:14px/1.6 sans-serif}
 main{max-width:620px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e5e5e5;border-radius:4px}
 small{color:#737373;font-size:10px;letter-spacing:1.2px}
 h1{margin:12px 0;font-size:24px;line-height:1.4;letter-spacing:-.6px;font-weight:600}
 p{margin:0 0 28px;color:#666}
 form{display:grid;gap:20px;margin-top:20px}
 label{display:grid;gap:7px;font-size:12px;font-weight:500}
 input,textarea,select{width:100%;min-width:0;padding:10px 12px;background:#fff;color:#171717;border:1px solid #d4d4d4;border-radius:3px;font:13px/1.5 monospace}
 input::placeholder,textarea::placeholder{color:#858585}
 input[readonly]{background:#f5f5f5}
 textarea{min-height:76px;resize:vertical}
 button{padding:11px 16px;border:1px solid #171717;border-radius:3px;background:#171717;color:#fff;font:inherit;cursor:pointer}
 button:hover{background:#333}
 #detect{justify-self:start;background:#fff;color:#404040;border-color:#d4d4d4;font-size:12px}
 #detect:hover{background:#f5f5f5}
 :is(input,textarea,select,button):focus-visible{outline:2px solid #171717;outline-offset:3px}
 :is(button,select):disabled{background:#f5f5f5;color:#858585;border-color:#e5e5e5;cursor:not-allowed}
 .check{display:flex;align-items:flex-start;gap:9px;color:#525252;font-size:12px;font-weight:400}
 .check input{width:auto;margin:3px 0 0;padding:0;accent-color:#171717}
 pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#404040;font-size:12px}
 output{color:#666;font:12px/1.6 monospace;overflow-wrap:anywhere}
 output:empty{display:none}
 @media(max-width:660px){main{margin:16px;padding:24px}}
 `;
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  if(req.headers.host!==new URL(origin).host)return json(403,{error:'Invalid Host'});
  if(req.method==='GET') {const entry={'/':['text/html; charset=utf-8',html],'/register.js':['text/javascript',script],'/style.css':['text/css',css]}[req.url];if(!entry)return json(404,{error:'Not found'});res.writeHead(200,{'Content-Type':entry[0]});res.end(entry[1]);return;}
  if(req.method!=='POST'||req.headers.origin!==origin||req.headers['x-local-token']!==token||req.headers['content-type']!=='application/json')return json(403,{error:'Local form authorization required'});
  try{
   let raw='';for await(const b of req){raw+=b;if(raw.length>32000)throw Error('입력 크기 초과');}const value=JSON.parse(raw);
   if(req.url==='/detect')return json(200,await detect(await realpath(value.path)));
   if(!['/projects','/project','/save'].includes(req.url))return json(404,{error:'Not found'});
   const before=await readFile(file,'utf8'),config=configSchema.parse(JSON.parse(before));
   if(req.url==='/projects')return json(200,config.projects.map(({id,name})=>({id,name})));
   const index=config.projects.findIndex(project=>project.id===value.id);
   const current=config.projects[index];
   if(req.url==='/project'){
    if(!current)return json(404,{error:'저장된 프로젝트를 찾을 수 없습니다'});
    return json(200,{project:current,revision:revision(current)});
   }
   if(current ? value.revision!==revision(current) : value.revision!==undefined){
    return json(409,{error:'설정이 이미 있거나 변경되었습니다. 저장된 프로젝트를 다시 불러오세요.'});
   }
   if(!path.isAbsolute(value.path))throw Error('절대 경로가 필요합니다');value.path=await realpath(value.path);
   const project=projectSchema.parse(value);
   if(project.runtime==='command'&&!project.startCommand.length)throw Error('실행 명령이 필요합니다');
   if(current)config.projects[index]=project;else config.projects.push(project);
   const temp=file+'.tmp-'+randomBytes(6).toString('hex');
   await writeFile(temp,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
   try{
    if(readFileSync(file,'utf8')!==before)return json(409,{error:'설정 충돌. 저장된 프로젝트를 다시 불러오세요.'});
    renameSync(temp,file);
   }finally{await rm(temp,{force:true});}
   return json(200,{project,revision:revision(project),message:'저장 완료. 실행 중인 Agent를 종료하고 npm run agent로 다시 연결하세요.'});
  }catch(e){json(400,{error:e.message});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;return {server,origin};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const {origin}=await createRegistration(path.resolve(process.argv[2]||'agent.config.json'));console.log('로컬 프로젝트 등록: '+origin+' (완료 후 Ctrl+C)');}
