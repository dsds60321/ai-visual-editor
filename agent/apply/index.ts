import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, inventory, safePath, allowed } from '../project/files.js';
import { diff } from '../diff/index.js';
type Task = {id:string; original:string;base:string;work:string;dir:string;exclude:string[]};
async function current(root:string,file:string) {try{return hash(await fs.readFile(await safePath(root,file)));}catch(e:any){if(e.code==='ENOENT')return null;throw e;}}
async function replace(root:string,file:string,data:Buffer|null,mode?:number) {
  const dest=await safePath(root,file);
  if(data===null) { await fs.unlink(dest); return; }
  await fs.mkdir(path.dirname(dest),{recursive:true});
  const temp=dest+'.ave-'+randomUUID();
  try {await fs.writeFile(temp,data,{flag:'wx',mode:mode??0o644});await safePath(root,file);await fs.rename(temp,dest);}
  finally {await fs.rm(temp,{force:true});}
}
export async function withLock<T>(original:string,dataDir:string,fn:()=>Promise<T>) {
  if(await fs.realpath(original)!==path.resolve(original))throw Error('프로젝트 루트 링크 또는 이동 감지');
  const lock=path.join(original,'.ave-apply-lock');
  try{await fs.mkdir(lock);}catch(e:any){if(e.code==='EEXIST')throw Error('프로젝트 적용 잠금 중입니다. 실행 중인 Agent를 확인하세요');throw e;}
  try {return await fn();}finally{await fs.rmdir(lock);}
}
export async function apply(task:Task,dataDir:string,revision:string,files:string[]) {
  return withLock(task.original,dataDir,async()=>{
    const d=await diff(task.base,task.work,task.exclude);
    if(revision!==d.revision)throw Error('검토 후 작업본이 변경되었습니다. Diff를 다시 확인하세요');
    if(new Set(files).size!==files.length||files.some(f=>!allowed(f,task.exclude)))throw Error('유효하지 않은 적용 파일');
    const changes=files.map(f=>{const c=d.changes.find(c=>c.file===f);if(!c)throw Error('Diff에 없는 파일');return c;});
    const baseline=await inventory(task.base,task.exclude), now=await inventory(task.original,task.exclude);
    if(JSON.stringify(Object.entries(baseline).sort())!==JSON.stringify(Object.entries(now).sort()))throw Error('원본 충돌: 작업 시작 후 원본이 변경되었습니다. 새 작업을 생성하세요');
    const backup=path.join(task.dir,'backup');await fs.mkdir(backup,{recursive:false});
    const records=[];
    for(const c of changes) {
      const target=await safePath(task.original,c.file);
      const mode=c.beforeHash?(await fs.stat(target)).mode:0o644;
      const data=c.beforeHash?await fs.readFile(target):null;
      if(data){const p=path.join(backup,c.file);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,data,{mode:0o600});}
      records.push({file:c.file,beforeHash:c.beforeHash,afterHash:c.afterHash,mode});
    }
    const history={taskId:task.id,at:new Date().toISOString(),state:'prepared',files:records};
    const journal=path.join(task.dir,'apply.json');
    await fs.writeFile(journal,JSON.stringify(history,null,2),{mode:0o600});
    const written:typeof records=[];
    try {
      for(const c of changes) {
        if(await current(task.original,c.file)!==c.beforeHash)throw Error('적용 중 원본 충돌');
        const record=records.find(r=>r.file===c.file)!;
        await replace(task.original,c.file,c.afterHash?Buffer.from(c.modified):null,record.mode);written.push(record);
      }
      history.state='applied';await fs.writeFile(journal,JSON.stringify(history,null,2));
      return history;
    }catch(error){
      const failures=[];
      for(const r of written.reverse())try{
        if(await current(task.original,r.file)!==r.afterHash)throw Error('원본이 다시 변경되어 자동 복구 차단');
        await replace(task.original,r.file,r.beforeHash?await fs.readFile(path.join(backup,r.file)):null,r.mode);
      }catch(e){failures.push(String(e));}
      history.state=failures.length?'recovery-required':'rolled-back';await fs.writeFile(journal,JSON.stringify({...history,failures},null,2));
      throw Error(`${error}; ${history.state}. 백업: ${backup}`);
    }
  });
}
export async function restore(task:Task,dataDir:string) {
  return withLock(task.original,dataDir,async()=>{
    const journal=path.join(task.dir,'apply.json'), h=JSON.parse(await fs.readFile(journal,'utf8'));
    if(h.state!=='applied')throw Error('자동 복구 가능한 적용 기록이 없습니다');
    for(const r of h.files)if(await current(task.original,r.file)!==r.afterHash)throw Error(`복구 충돌: ${r.file}`);
    h.state='restoring';await fs.writeFile(journal,JSON.stringify(h,null,2));
    for(const r of h.files)await replace(task.original,r.file,r.beforeHash?await fs.readFile(path.join(task.dir,'backup',r.file)):null,r.mode);
    h.state='restored';await fs.writeFile(journal,JSON.stringify(h,null,2));return h;
  });
}
