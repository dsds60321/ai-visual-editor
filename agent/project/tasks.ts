import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import type { Config, Project } from '../../shared/protocol.js';
import { redact } from '../../shared/protocol.js';
import { inventory, safePath, detect, allowed } from './files.js';
import { Runtime } from '../runtime/index.js';
import { Codex, listAvailableModels } from '../codex/index.js';
import { diff } from '../diff/index.js';
import { apply, restore } from '../apply/index.js';
import { preview } from '../preview/index.js';
import { openInteractivePreview, type Selection } from '../preview/interactive.js';
export type Task={id:string;project:Project;original:string;base:string;work:string;dir:string;exclude:string[];state:string;runtime:Runtime;codex:Codex;events:{seq:number;type:string;text:string}[];seq:number;busy:boolean;previewReady:boolean;previewBase:string;version:number;watcher?:FSWatcher;interactive?:Awaited<ReturnType<typeof openInteractivePreview>>;interactiveSelection?:{id:number;data:Selection}};
export class Tasks {
  tasks=new Map<string,Task>();
  private creatingPorts = new Set<number>();
  constructor(readonly config:Config){}
  async projects(){return Promise.all(this.config.projects.map(async p=>({id:p.id,name:p.name,runtime:p.runtime,port:p.port,...await detect(p.path)})));}
  event(t:Task,type:string,text:string){t.events.push({seq:++t.seq,type,text:redact(text.replaceAll(t.previewBase||'__no_preview__','[Preview URL]')).slice(0,12000)});if(t.events.length>500)t.events.shift();}
  async create(projectId:string){
    const p=this.config.projects.find(p=>p.id===projectId);if(!p)throw Error('이 PC에 등록되지 않은 프로젝트');
    if(this.creatingPorts.has(p.port))throw Error('해당 Preview 포트에서 작업을 준비 중입니다');
    const existing=[...this.tasks.values()].find(t=>t.project.port===p.port&&!['discarded','applied','restored'].includes(t.state));
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
      const t={} as Task;Object.assign(t,{id,project:p,original,dir,base,work,exclude:p.exclude,state:'ready',events:[],seq:0,busy:false,previewReady:false,version:0,previewBase:`/preview/${id}/${ticket}`});
      // An authenticated app can print session data in its own process output.
      t.runtime=new Runtime(p,work,t.previewBase,s=>{if(!t.interactive)this.event(t,'log',s);});
      t.codex=new Codex(work,(type,text)=>this.event(t,type,text),()=>{if(t.state==='editing'&&!t.busy)void this.afterEdit(t);});
      this.tasks.set(id,t);await fs.writeFile(path.join(dir,'task.json'),JSON.stringify({id,projectId:p.id,original,createdAt:new Date().toISOString()},null,2),{mode:0o600});
      try {await t.runtime.start();t.previewReady=true;this.event(t,'status','Preview 준비 완료');}catch(e){this.event(t,'error',String(e));}
      t.watcher=watch(work,{recursive:true},(_event,file)=>{if(file&&allowed(String(file).replaceAll('\\','/'),t.exclude))t.version++;});
      t.watcher.on('error',e=>this.event(t,'error',e.message));
      return this.status(t);
    }catch(e){const t=this.tasks.get(id);if(t){t.watcher?.close();await t.runtime.stop();t.codex.close();this.tasks.delete(id);}await fs.rm(dir,{recursive:true,force:true});throw e;}
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
  status(t:Task){return {id:t.id,projectId:t.project.id,state:t.state,running:t.codex.running,busy:t.busy,version:t.version,previewReady:t.previewReady&&t.runtime.running,previewBase:t.previewBase,previewPath:t.project.previewPath,interactiveAvailable:this.supportsInteractive(t),interactiveOrigin:t.interactive?.origin,interactiveSelection:t.interactiveSelection,events:t.events};}
  async command(method:string,p:any){
    if(method==='projects')return this.projects();if(method==='create')return this.create(p.projectId);
    if(method==='models')return listAvailableModels(this.config.dataDir);
    const t=this.get(p.taskId);
    if(method==='status')return this.status(t);
    if(method==='stop'){await t.codex.stop();return {ok:true};}
    if(method==='preview'){if(!t.previewReady||!t.runtime.running)throw Error('Preview 서버가 준비되지 않았습니다');return preview(t.project,p.path,t.previewBase);}
    if(method==='diff') {if(t.busy||t.codex.running)throw Error('작업 완료 후 Diff를 확인하세요');return diff(t.base,t.work,t.exclude);}
    if(t.busy)throw Error('작업 처리 중입니다');t.busy=true;
    try {
      if(method==='restore'){if(t.state!=='applied')throw Error('적용 완료 작업만 복구할 수 있습니다');const h=await restore(t,this.config.dataDir);t.state='restored';return h;}
      if(['applied','discarded','restored'].includes(t.state))throw Error('종료된 작업입니다. 새 작업을 생성하세요');
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
      if(method==='chat'){t.state='editing';try{await t.codex.chat(p.prompt,p.selection,p.model);}catch(e){t.state='review';throw e;}if(!t.codex.running)await this.afterEdit(t);return {ok:true};}
      if(method==='stop-preview'||method==='restart'){
        await t.runtime.stop();t.previewReady=false;
        if(method==='stop-preview')return {ok:true};
      }
      if(method==='start-preview'||method==='restart'){
        if(!t.previewReady||!t.runtime.running){t.previewReady=false;await t.runtime.start();t.previewReady=true;}
        return {ok:true};
      }
      if(method==='apply'){await t.runtime.stop();t.previewReady=false;const result=await apply(t,this.config.dataDir,p.revision,p.files);t.state='applied';t.interactive?.close();t.watcher?.close();t.codex.close();return result;}
      if(method==='discard'){t.watcher?.close();t.interactive?.close();await t.runtime.stop();t.previewReady=false;t.codex.close();await fs.rm(t.dir,{recursive:true,force:true});t.state='discarded';return {ok:true};}
      throw Error('지원하지 않는 동작');
    }finally{t.busy=false;}
  }
  async close(){for(const t of this.tasks.values()){t.watcher?.close();t.interactive?.close();await t.runtime.stop();t.codex.close();}}
}
