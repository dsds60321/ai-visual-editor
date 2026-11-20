import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import type { Config, Project } from '../../shared/protocol.js';
import { redact } from '../../shared/protocol.js';
import { inventory, safePath, detect, allowed } from './files.js';
import { finishCheckpoint, snapshot } from './checkpoints.js';
import { Runtime } from '../runtime/index.js';
import { Codex, listAvailableModels } from '../codex/index.js';
import { diff } from '../diff/index.js';
import { apply } from '../apply/index.js';
import { preview } from '../preview/index.js';
import { openInteractivePreview, type Selection } from '../preview/interactive.js';
type RequestChange={id:string;changed:boolean;reverted:boolean};
type TaskEvent={seq:number;type:string;text:string;requestId?:string};
export type Task={id:string;project:Project;original:string;base:string;work:string;dir:string;exclude:string[];state:string;runtime:Runtime;codex:Codex;events:TaskEvent[];requestEvents:TaskEvent[];seq:number;busy:boolean;previewReady:boolean;previewBase:string;version:number;requests:RequestChange[];currentRequest?:{id:string;before:Record<string,string>};revertedSinceChat?:boolean;finishing?:Promise<void>;watcher?:FSWatcher;interactive?:Awaited<ReturnType<typeof openInteractivePreview>>;interactiveSelection?:{id:number;data:Selection}};
export class Tasks {
  tasks=new Map<string,Task>();
  private closing = false;
  private creatingPorts = new Set<number>();
  constructor(readonly config:Config){}
  async projects(){return Promise.all(this.config.projects.map(async p=>({id:p.id,name:p.name,runtime:p.runtime,port:p.port,...await detect(p.path)})));}
  event(t:Task,type:string,text:string,requestId?:string){
    const entry={seq:++t.seq,type,text:redact(text.replaceAll(t.previewBase||'__no_preview__','[Preview URL]')).slice(0,12000),requestId};
    if(requestId)t.requestEvents.push(entry);
    else{t.events.push(entry);if(t.events.length>500)t.events.shift();}
  }
  async create(projectId:string){
    const p=this.config.projects.find(p=>p.id===projectId);if(!p)throw Error('이 PC에 등록되지 않은 프로젝트');
    if(this.creatingPorts.has(p.port))throw Error('해당 Preview 포트에서 작업을 준비 중입니다');
    const existing=[...this.tasks.values()].find(t=>t.project.port===p.port&&!['discarded','applied'].includes(t.state));
    if(existing){
      if(existing.project.id===p.id)return this.status(existing);
      throw Error('해당 Preview 포트에 활성 작업이 있습니다');
    }
    this.creatingPorts.add(p.port);
    try{return await this.createWorkspace(p);}finally{this.creatingPorts.delete(p.port);}
  }
  private async createWorkspace(p:Project){
    const original=await fs.realpath(p.path), data=path.resolve(this.config.dataDir);
    if(data===original||data.startsWith(original+path.sep)||original.startsWith(data+path.sep))throw Error('데이터 경로와 프로젝트 경로는 서로 분리해야 합니다');
    const id=randomUUID(),ticket=randomBytes(32).toString('hex'),dir=path.join(data,'workspaces',id),base=path.join(dir,'base'),work=path.join(dir,'work');
    try {
      await fs.mkdir(base,{recursive:true,mode:0o700});await fs.mkdir(work,{mode:0o700});
      const before=await inventory(original,p.exclude);
      for(const file of Object.keys(before)) {
        for(const dest of [base,work]){const target=path.join(dest,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(await safePath(original,file),target);}
      }
      const after=await inventory(original,p.exclude), copied=await inventory(base,p.exclude);
      if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(before)!==JSON.stringify(copied))throw Error('스냅샷 생성 중 원본 변경. 다시 시도하세요');
      const t={} as Task;Object.assign(t,{id,project:p,original,dir,base,work,exclude:p.exclude,state:'ready',events:[],requestEvents:[],requests:[],seq:0,busy:false,previewReady:false,version:0,previewBase:`/preview/${id}/${ticket}`});
      // An authenticated app can print session data in its own process output.
      t.runtime=new Runtime(p,work,t.previewBase,s=>{if(!t.interactive)this.event(t,'log',s);});
      t.codex=new Codex(work,(type,text)=>this.event(t,type,text),()=>{
        if(this.closing||t.state!=='editing'||t.busy)return;
        t.finishing=this.finishRequest(t).catch(error=>this.event(t,'error',String(error)));
      });
      this.tasks.set(id,t);await fs.writeFile(path.join(dir,'task.json'),JSON.stringify({id,projectId:p.id,original,createdAt:new Date().toISOString()},null,2),{mode:0o600});
      try {await t.runtime.start();t.previewReady=true;this.event(t,'status','Preview 준비 완료');}catch(e){this.event(t,'error',String(e));}
      t.watcher=watch(work,{recursive:true},(_event,file)=>{if(file&&allowed(String(file).replaceAll('\\','/'),t.exclude))t.version++;});
      t.watcher.on('error',e=>this.event(t,'error',e.message));
      return this.status(t);
    }catch(e){const t=this.tasks.get(id);if(t){t.watcher?.close();await t.runtime.stop();t.codex.close();this.tasks.delete(id);}await fs.rm(dir,{recursive:true,force:true});throw e;}
  }
  private async finishRequest(t:Task){
    t.busy=true;
    try{
      const request=t.currentRequest;
      t.currentRequest=undefined;
      if(request){
        const dir=path.join(t.dir,'requests',request.id);
        try{
          const changed=await finishCheckpoint(t.work,dir,t.exclude,request.before);
          t.requests.push({id:request.id,changed,reverted:false});
          this.event(t,'request-diff','',request.id);
        }catch(e){this.event(t,'error',`요청별 변경 기록을 저장하지 못했습니다: ${String(e)}`);}
      }
      await this.afterEdit(t);
    }finally{t.busy=false;}
  }
  async afterEdit(t:Task){
    t.state='review';t.version++;
    if(t.project.refresh==='restart'&&t.previewReady&&t.runtime.running){
      t.busy=true;t.state='rebuilding';
      try{await t.runtime.rebuild(()=>{t.previewReady=false;});t.previewReady=true;this.event(t,'status','Preview 재빌드 완료');}
      catch(e){this.event(t,'error',String(e));}
      finally{t.busy=false;t.state='review';t.version++;}
    }
  }
  get(id:string){const t=this.tasks.get(id);if(!t)throw Error('현재 Agent의 작업을 찾을 수 없습니다');return t;}
  private supportsInteractive(t:Task){return t.project.runtime==='command'&&t.project.pathPrefix==='root'&&['127.0.0.1','localhost','[::1]'].includes(new URL(this.config.hub).hostname);}
  status(t:Task){return {id:t.id,projectId:t.project.id,state:t.state,running:t.codex.running,busy:t.busy,version:t.version,previewReady:t.previewReady&&t.runtime.running,previewBase:t.previewBase,previewPath:t.project.previewPath,interactiveAvailable:this.supportsInteractive(t),interactiveOrigin:t.interactive?.origin,interactiveSelection:t.interactiveSelection,events:[...t.events,...t.requestEvents].sort((a,b)=>a.seq-b.seq),requests:t.requests};}
  async command(method:string,p:any){
    if(method==='projects')return this.projects();if(method==='create')return this.create(p.projectId);
    if(method==='models')return listAvailableModels(this.config.dataDir);
    const t=this.get(p.taskId);
    if(method==='status')return this.status(t);
    if(method==='stop'){await t.codex.stop();return {ok:true};}
    if(method==='preview'){if(!t.previewReady||!t.runtime.running)throw Error('Preview 서버가 준비되지 않았습니다');return preview(t.project,p.path,t.previewBase);}
    if(['applied','discarded'].includes(t.state)&&(method==='diff'||method==='request-diff'))throw Error('종료된 작업의 Diff는 더 이상 열 수 없습니다');
    if(method==='diff') {if(t.busy||t.codex.running)throw Error('작업 완료 후 Diff를 확인하세요');return diff(t.base,t.work,t.exclude);}
    if(method==='request-diff'){
      if(t.state==='discarded'||!t.requests.some(r=>r.id===p.requestId))throw Error('요청 변경 기록이 없습니다');
      const dir=path.join(t.dir,'requests',p.requestId);
      return diff(path.join(dir,'before'),path.join(dir,'after'),t.exclude);
    }
    if(t.busy)throw Error('작업 처리 중입니다');t.busy=true;
    try {
      if(method==='revert-request'){
        const request=t.requests.find(r=>r.id===p.requestId);
        if(!request||t.state==='discarded')throw Error('요청 변경 기록이 없습니다');
        const dir=path.join(t.dir,'requests',request.id),before=path.join(dir,'before'),after=path.join(dir,'after');
        const latest=t.requests.findLast(r=>r.changed&&!r.reverted);
        if(t.codex.running||['applied'].includes(t.state)||request!==latest)throw Error('진행 중인 작업이 끝난 뒤 최근 요청만 되돌릴 수 있습니다');
        const reverse=await diff(after,before,t.exclude);
        const expectedOriginal=JSON.parse(await fs.readFile(path.join(dir,'after.json'),'utf8')) as Record<string,string>;
        const attempt=await fs.mkdtemp(path.join(dir,'revert-'));
        await apply({id:t.id,original:t.work,base:after,work:before,dir:attempt,exclude:t.exclude,expectedOriginal},this.config.dataDir,reverse.revision,reverse.changes.map(c=>c.file),true);
        request.reverted=true;t.revertedSinceChat=true;
        await fs.rm(attempt,{recursive:true,force:true}).catch(e=>this.event(t,'error',String(e)));
        await this.afterEdit(t);
        return this.status(t);
      }
      if(['applied','discarded'].includes(t.state))throw Error('종료된 작업입니다. 새 작업을 생성하세요');
      if(method==='interactive-preview'){
        if(!this.supportsInteractive(t)||!t.previewReady||!t.runtime.running)throw Error('실행 중인 로컬 프로젝트에서 로그인 화면을 열 수 있습니다');
        if(!t.interactive){
          const hub=new URL(this.config.hub);
          const port=hub.port?':'+hub.port:'';
          const protocol=hub.protocol==='wss:'?'https:':'http:';
          const origins=[protocol+'//127.0.0.1'+port,protocol+'//localhost'+port];
          t.interactive=await openInteractivePreview(t.project.port,origins,()=>t.previewReady&&t.runtime.running,data=>{
            t.interactiveSelection={id:(t.interactiveSelection?.id||0)+1,data};
          });
        }
        return {url:t.interactive.origin+t.project.previewPath};
      }
      if(t.codex.running)throw Error('Codex 작업을 먼저 정지하세요');
      if(method==='chat'){
        const id=randomUUID(),dir=path.join(t.dir,'requests',id);
        try{t.currentRequest={id,before:await snapshot(t.work,path.join(dir,'pending'),t.exclude)};}
        catch(e){await fs.rm(dir,{recursive:true,force:true});throw e;}
        this.event(t,'user',p.prompt,id);
        t.state='editing';
        const prompt=t.revertedSinceChat?'A previous request was reverted. Read the current workspace before making changes.\n\n'+p.prompt:p.prompt;
        try{await t.codex.chat(prompt,p.selection,p.model,p.effort);t.revertedSinceChat=false;}
        finally{if(!t.codex.running)await this.finishRequest(t);}
        return {ok:true,requestId:id};
      }
      if(method==='stop-preview'||method==='restart'){
        await t.runtime.stop();t.previewReady=false;
        if(method==='stop-preview')return {ok:true};
      }
      if(method==='start-preview'||method==='restart'){
        if(!t.previewReady||!t.runtime.running){t.previewReady=false;await t.runtime.start();t.previewReady=true;}
        return {ok:true};
      }
      if(method==='apply'){
        await t.runtime.stop();t.previewReady=false;
        await apply(t,this.config.dataDir,p.revision,p.files);
        t.state='applied';
        try{await this.removeWorkspace(t);}
        catch{return {cleanupFailed:true};}
        return {ok:true};
      }
      if(method==='discard'){
        const journal=await this.applyJournal(t.dir);
        if(journal&&!['applied','restored','rolled-back'].includes(journal.state))throw Error('원본 복구에 필요한 작업 백업이 남아 있어 폐기를 중단했습니다');
        await this.removeWorkspace(t);t.state='discarded';
        return {ok:true};
      }
      throw Error('지원하지 않는 동작');
    }finally{
      if(t.currentRequest&&t.state==='editing'&&!t.codex.running)await this.finishRequest(t);
      t.busy=false;
    }
  }
  private async stopTask(t:Task){
    t.watcher?.close();t.interactive?.close();
    await t.runtime.stop();t.previewReady=false;t.codex.close();
  }
  private async removeWorkspace(t:Task){
    await this.stopTask(t);
    await fs.rm(t.dir,{recursive:true,force:true,maxRetries:2});
  }
  private async applyJournal(dir:string){
    try{return JSON.parse(await fs.readFile(path.join(dir,'apply.json'),'utf8'));}
    catch(error:any){if(error.code!=='ENOENT')throw error;}
  }
  async close(){
    this.closing=true;
    await Promise.all([...this.tasks.values()].map(async t=>{
      await t.finishing;
      await this.stopTask(t);
    }));
  }
  async purgeWorkspaces(){
    const data=await fs.realpath(this.config.dataDir), root=path.join(data,'workspaces');
    const originals=await Promise.all(this.config.projects.map(async p=>{
      try{return await fs.realpath(p.path);}
      catch(error:any){if(error.code==='ENOENT')return path.resolve(p.path);throw error;}
    }));
    if(originals.some(original=>original===root||original.startsWith(root+path.sep)))
      throw Error('작업 폴더 안에 등록된 원본 프로젝트가 있어 자동 정리를 중단했습니다');
    const skipped:string[]=[];
    if(await fs.realpath(root).catch(error=>{if(error.code==='ENOENT')return null;throw error;})===root){
      for(const entry of await fs.readdir(root,{withFileTypes:true})){
        if(!entry.isDirectory()||!/^([a-f0-9]{8}-)([a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(entry.name))continue;
        const dir=path.join(root,entry.name);
        try{
          const journal=await this.applyJournal(dir);
          if(journal&&!['applied','restored','rolled-back'].includes(journal.state)){skipped.push(entry.name);continue;}
          await fs.rm(dir,{recursive:true,force:true,maxRetries:2});
        }catch{skipped.push(entry.name);}
      }
      if(!(await fs.readdir(root)).length)await fs.rmdir(root);
    }
    for(const entry of await fs.readdir(data,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^model-list-[a-z0-9]{6}$/i.test(entry.name))continue;
      const dir=path.join(data,entry.name);
      if(originals.some(original=>original===dir||original.startsWith(dir+path.sep))){skipped.push(entry.name);continue;}
      await fs.rm(dir,{recursive:true,force:true,maxRetries:2}).catch(()=>skipped.push(entry.name));
    }
    return skipped;
  }
}
