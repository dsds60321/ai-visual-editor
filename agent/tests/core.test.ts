import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:net';
import { inventory, safePath, detect, hash } from '../project/files.js';
import { diff } from '../diff/index.js';
import { apply,withLock } from '../apply/index.js';
import { Tasks } from '../project/tasks.js';
import { requestSchema, projectSchema } from '../../shared/protocol.js';
async function fixture(t:any){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ave-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const original=path.join(root,'original'),base=path.join(root,'base'),work=path.join(root,'work'),dir=path.join(root,'task'),data=path.join(root,'data');for(const p of[original,base,work,dir,data]){await fs.mkdir(p);if([original,base,work].includes(p))await fs.writeFile(path.join(p,'index.html'),'<h1>Original</h1>');}return {id:'test',root,original,base,work,dir,data,exclude:[]};}
test('snapshot captures uncommitted disk state, excludes secrets, and rejects symlinks',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.original,'.env'),'TOKEN=secret');await fs.mkdir(path.join(f.original,'node_modules'));await fs.writeFile(path.join(f.original,'node_modules','x'),'x');assert.deepEqual(Object.keys(await inventory(f.original)),['index.html']);await fs.symlink('/etc/hosts',path.join(f.original,'escape'));await assert.rejects(inventory(f.original),/심볼릭/);assert.deepEqual(Object.keys(await inventory(f.original,['escape'])),['index.html']);});
test('project inventory skips Codex conversation notes and keeps regular Markdown',async t=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.original,'.codex-notes'));
  await fs.mkdir(path.join(f.original,'docs'));
  for(const file of ['.codex-notes/ideas.md','codex-chat.md','docs/Codex_Notes-2026-11-20.md','README.md','docs/setup.md'])
    await fs.writeFile(path.join(f.original,file),'example');
  assert.deepEqual(Object.keys(await inventory(f.original)).sort(),['README.md','docs/setup.md','index.html']);
});
test('path traversal, absolute paths and parent symlinks are blocked',async t=>{const f=await fixture(t);for(const p of['../outside','/etc/passwd','a/../b','a\\b','.git/config','.env','a//b'])await assert.rejects(safePath(f.original,p));await fs.symlink(f.work,path.join(f.original,'link'));await assert.rejects(safePath(f.original,'link/file'),/심볼릭/);});
test('review -> add/modify/delete -> apply keeps originals intact until approval',async t=>{const f=await fixture(t);for(const p of[f.original,f.base,f.work])await fs.writeFile(path.join(p,'delete.txt'),'remove');await fs.writeFile(path.join(f.work,'index.html'),'<h1>Updated</h1>');await fs.writeFile(path.join(f.work,'query.sql'),'DELETE FROM orders;');await fs.unlink(path.join(f.work,'delete.txt'));const d=await diff(f.base,f.work);assert.equal(d.changes.length,3);assert.ok(d.changes.find(c=>c.sql)?.risks.length);assert.equal(await fs.readFile(path.join(f.original,'index.html'),'utf8'),'<h1>Original</h1>');await apply(f,f.data,d.revision,d.changes.map(c=>c.file));assert.equal(await fs.readFile(path.join(f.original,'index.html'),'utf8'),'<h1>Updated</h1>');await assert.rejects(fs.stat(path.join(f.original,'delete.txt')));assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,'apply.json'),'utf8')).state,'applied');assert.equal(await fs.readFile(path.join(f.dir,'backup','index.html'),'utf8'),'<h1>Original</h1>');});
test('file-level apply only writes selected reviewed changes',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.work,'index.html'),'changed');await fs.writeFile(path.join(f.work,'other.txt'),'unselected');const d=await diff(f.base,f.work);await apply(f,f.data,d.revision,['index.html']);await assert.rejects(fs.stat(path.join(f.original,'other.txt')));});
test('original conflicts and stale review revisions block all writes',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.work,'index.html'),'change');const d=await diff(f.base,f.work);await fs.writeFile(path.join(f.original,'index.html'),'user edit');await assert.rejects(apply(f,f.data,d.revision,['index.html']),/충돌/);assert.equal(await fs.readFile(path.join(f.original,'index.html'),'utf8'),'user edit');await fs.writeFile(path.join(f.work,'index.html'),'new change');await assert.rejects(apply(f,f.data,d.revision,['index.html']),/다시 확인/);});
test('project lock excludes concurrent applies',async t=>{const f=await fixture(t);await withLock(f.original,f.data,async()=>{await assert.rejects(withLock(f.original,f.data,async()=>{}),/잠금/);});});
test('binary changes cannot bypass review',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.work,'image.bin'),Buffer.from([0,1,2]));await assert.rejects(diff(f.base,f.work),/바이너리/);});
test('detector accepts Vue, Nuxt, Mustache configurations without claiming integration support',async t=>{const f=await fixture(t);for(const [dep,expected]of[['vue','Vue'],['nuxt','Nuxt']]){await fs.writeFile(path.join(f.work,'package.json'),JSON.stringify({dependencies:{[dep]:'1'},scripts:{dev:'custom'}}));assert.equal((await detect(f.work)).framework,expected);}await fs.unlink(path.join(f.work,'package.json'));await fs.writeFile(path.join(f.work,'pom.xml'),'<artifactId>spring-boot-starter-mustache</artifactId>');assert.match((await detect(f.work)).framework,/Java/);assert.ok(projectSchema.parse({id:'mustache',name:'Mustache',path:f.work,runtime:'command',startCommand:['java','-jar','app.jar'],port:18090,safePreview:true}));});
test('wire protocol cannot carry arbitrary commands or unapproved apply',()=>{assert.equal(requestSchema.safeParse({method:'exec',params:{command:'rm -rf'}}).success,false);assert.equal(requestSchema.safeParse({method:'apply',params:{taskId:'1',approved:false}}).success,false);});
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address()as any).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
test('real static preview, injected inspector, diff and discard preserve original',async t=>{const f=await fixture(t),port=await freePort();const tasks=new Tasks({hub:'ws://127.0.0.1:8080/agent',user:'tester',token:'x'.repeat(32),dataDir:f.data,projects:[projectSchema.parse({id:'demo',name:'Demo',path:f.original,runtime:'static',port,safePreview:true})]});t.after(()=>tasks.close());const originalHash=hash(await fs.readFile(path.join(f.original,'index.html')));const state=await tasks.create('demo');assert.equal(state.previewReady,true);const p:any=await tasks.command('preview',{taskId:state.id,path:'/'});assert.match(Buffer.from(p.body,'base64').toString(),/inspector.js/);const task=tasks.get(state.id);await fs.writeFile(path.join(task.work,'index.html'),'<h1>changed</h1>');assert.equal((await tasks.command('diff',{taskId:state.id})as any).changes.length,1);assert.equal(hash(await fs.readFile(path.join(f.original,'index.html'))),originalHash);await tasks.command('discard',{taskId:state.id});assert.equal(hash(await fs.readFile(path.join(f.original,'index.html'))),originalHash);});
test('stopping Preview releases the port and reopening keeps the same edited task',async t=>{
 const f=await fixture(t),port=await freePort();
 const project=projectSchema.parse({id:'demo',name:'Demo',path:f.original,runtime:'static',port,previewPath:'/init',safePreview:true});
 const tasks=new Tasks({hub:'ws://127.0.0.1:8080/agent',user:'tester',token:'x'.repeat(32),dataDir:f.data,projects:[project,{...project,id:'other'}]});
 t.after(()=>tasks.close());
 const {id,previewPath}=await tasks.create(project.id),params={taskId:id},url=`http://127.0.0.1:${port}/`;
 assert.equal(previewPath,'/init');
 await fs.writeFile(path.join(tasks.get(id).work,'index.html'),'<h1>Still edited</h1>');
 await tasks.command('stop-preview',params);
 assert.equal((await tasks.create(project.id)).id,id);
 assert.equal(tasks.status(tasks.get(id)).previewReady,false);
 await assert.rejects(fetch(url));
 await assert.rejects(tasks.create('other'),/활성 작업/);
 await tasks.command('start-preview',params);
 await tasks.command('start-preview',params);
 assert.equal(tasks.status(tasks.get(id)).previewReady,true);
 assert.match(await (await fetch(url)).text(),/Still edited/);
 assert.match(await fs.readFile(path.join(f.original,'index.html'),'utf8'),/Original/);
});
test('automatic Preview rebuild reports ready only once the replacement is ready',async t=>{
 const f=await fixture(t),port=await freePort();
 const project=projectSchema.parse({id:'restart',name:'Restart',path:f.original,runtime:'static',refresh:'restart',port,safePreview:true});
 const tasks=new Tasks({hub:'ws://127.0.0.1:8080/agent',user:'tester',token:'x'.repeat(32),dataDir:f.data,projects:[project]});
 t.after(()=>tasks.close());
 const {id}=await tasks.create(project.id),task=tasks.get(id);
 let resume=()=>{},switchServer=()=>{};
 const switching=new Promise<void>(resolve=>{switchServer=resolve;});
 const replacement=new Promise<void>(resolve=>{resume=resolve;});
 task.runtime.rebuild=async onRestart=>{onRestart();switchServer();await replacement;};
 const rebuild=tasks.afterEdit(task);
 await switching;
 assert.equal(tasks.status(task).state,'rebuilding');
 assert.equal(tasks.status(task).previewReady,false);
 resume();await rebuild;
 assert.equal(tasks.status(task).previewReady,true);
 assert.equal(tasks.status(task).state,'review');
});
test('macOS runtime sandbox blocks a build from writing the original', {skip:process.platform!=='darwin'},async t=>{const {Runtime}=await import('../runtime/index.js');const f=await fixture(t),port=await freePort();const p=projectSchema.parse({id:'sandbox',name:'Sandbox',path:f.original,runtime:'command',port,safePreview:true,buildCommand:[process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(path.join(f.original,'index.html'))},'unsafe')`],startCommand:[process.execPath,'-e','setTimeout(()=>{},60000)']});const runtime=new Runtime(p,f.work,'/preview/test/token',()=>{});t.after(()=>runtime.stop());await assert.rejects(runtime.start(),/빌드 실패/);assert.equal(await fs.readFile(path.join(f.original,'index.html'),'utf8'),'<h1>Original</h1>');});
test('partial apply failure restores already-written files from backup',async t=>{const f=await fixture(t);for(const p of[f.original,f.base,f.work])await fs.writeFile(path.join(p,'second.txt'),'before');await fs.writeFile(path.join(f.work,'index.html'),'changed');await fs.writeFile(path.join(f.work,'second.txt'),'changed second');const d=await diff(f.base,f.work),rename=fs.rename;fs.rename=async(a,b)=>{if(String(b)===path.join(f.original,'second.txt'))throw Error('injected write failure');return rename(a,b);};try{await assert.rejects(apply(f,f.data,d.revision,['index.html','second.txt']),/rolled-back/);}finally{fs.rename=rename;}assert.equal(await fs.readFile(path.join(f.original,'index.html'),'utf8'),'<h1>Original</h1>');assert.equal(await fs.readFile(path.join(f.original,'second.txt'),'utf8'),'before');assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,'apply.json'),'utf8')).state,'rolled-back');});
test('runtime refuses a cache symlink before writing policies or artifacts', {skip:process.platform!=='darwin'},async t=>{const{Runtime}=await import('../runtime/index.js');const f=await fixture(t),port=await freePort();await fs.symlink(f.original,path.join(f.work,'.ave-runtime'));const p=projectSchema.parse({id:'link',name:'Link',path:f.original,runtime:'command',port,safePreview:true,startCommand:[process.execPath,'-e','0']});const runtime=new Runtime(p,f.work,'/preview/test/token',()=>{});await assert.rejects(runtime.start(),/링크/);assert.deepEqual(await fs.readdir(f.original),['index.html']);});
test('an immediately completed Codex turn still enters review',async t=>{const f=await fixture(t),port=await freePort();const tasks=new Tasks({hub:'ws://127.0.0.1:8080/agent',user:'tester',token:'x'.repeat(32),dataDir:f.data,projects:[projectSchema.parse({id:'fast',name:'Fast',path:f.original,runtime:'static',port,safePreview:true})]});t.after(()=>tasks.close());const state=await tasks.create('fast'),task=tasks.get(state.id);task.codex.chat=async()=>{task.codex.running=false;};await tasks.command('chat',{taskId:state.id,prompt:'edit'});assert.equal(task.state,'review');assert.equal(task.busy,false);});
test('locally registered Vite base argument resolves without modifying project config',{skip:process.platform!=='darwin'},async t=>{const{Runtime}=await import('../runtime/index.js');const f=await fixture(t),port=await freePort();const p=projectSchema.parse({id:'base',name:'Base',path:f.original,runtime:'command',port,safePreview:true,buildCommand:[process.execPath,'-e',"require('fs').writeFileSync('base.txt',process.argv[1])",'${AVE_PREVIEW_BASE}'],startCommand:[process.execPath,'-e',"require('http').createServer((q,s)=>s.end('ready')).listen(process.env.PORT,'127.0.0.1')"]});const runtime=new Runtime(p,f.work,'/preview/task/capability',()=>{});t.after(()=>runtime.stop());await runtime.start();assert.equal(await fs.readFile(path.join(f.work,'base.txt'),'utf8'),'/preview/task/capability/');assert.deepEqual(await fs.readdir(f.original),['index.html']);});

test('per-request diffs retain history and rollback only the latest workspace changes',async t=>{
  const f=await fixture(t),port=await freePort();
  await fs.writeFile(path.join(f.original,'script.sh'),'echo old',{mode:0o755});
  await fs.writeFile(path.join(f.original,'unchanged.txt'),'keep');
  const project=projectSchema.parse({id:'demo',name:'Demo',path:f.original,runtime:'static',port,safePreview:true});
  const tasks=new Tasks({hub:'ws://127.0.0.1:8080/agent',user:'tester',token:'x'.repeat(32),dataDir:f.data,projects:[project]});
  t.after(()=>tasks.close());
  const {id:taskId}=await tasks.create('demo'),task=tasks.get(taskId);
  const file=path.join(task.work,'index.html');
  task.codex.chat=async prompt=>{
    if(prompt==='no change')return;
    await fs.writeFile(file,prompt);
    if(prompt==='second'){
      await fs.unlink(path.join(task.work,'script.sh'));
      await fs.writeFile(path.join(task.work,'new.txt'),'new file');
    }
  };
  await tasks.command('chat',{taskId,prompt:'first'});
  await tasks.command('chat',{taskId,prompt:'second'});
  await tasks.command('chat',{taskId,prompt:'no change'});
  const [first,second,noChange]=task.requests;
  const checkpoint=(id:string,part:string)=>path.join(task.dir,'requests',id,part);
  assert.deepEqual(await fs.readdir(checkpoint(first.id,'before')),['index.html']);
  assert.deepEqual(await fs.readdir(checkpoint(first.id,'after')),['index.html']);
  assert.deepEqual((await fs.readdir(checkpoint(second.id,'before'))).sort(),['index.html','script.sh']);
  assert.deepEqual((await fs.readdir(checkpoint(second.id,'after'))).sort(),['index.html','new.txt']);
  assert.deepEqual(await fs.readdir(checkpoint(noChange.id,'before')),[]);
  assert.deepEqual(await fs.readdir(checkpoint(noChange.id,'after')),[]);
  for(const request of task.requests)
    await assert.rejects(fs.stat(checkpoint(request.id,'pending')),{code:'ENOENT'});
  for(let i=0;i<501;i++)tasks.event(task,'log','preview');
  assert.ok(tasks.status(task).events.some(event=>event.type==='request-diff'&&event.requestId===first.id));
  const getDiff=(requestId:string)=>tasks.command('request-diff',{taskId,requestId}) as ReturnType<typeof diff>;
  const undo=(requestId:string)=>tasks.command('revert-request',{taskId,requestId,approved:true});
  assert.equal((await getDiff(first.id)).changes[0].original,'<h1>Original</h1>');
  assert.equal((await getDiff(second.id)).changes[0].original,'first');
  assert.deepEqual((await getDiff(noChange.id)).changes,[]);
  await assert.rejects(undo(first.id),/최근 요청/);
  const unchanged=path.join(task.work,'unchanged.txt');
  await fs.writeFile(unchanged,'later unrelated edit');
  await assert.rejects(undo(second.id),/충돌/);
  assert.equal(await fs.readFile(unchanged,'utf8'),'later unrelated edit');
  await fs.writeFile(unchanged,'keep');
  await fs.writeFile(file,'later manual edit');
  await assert.rejects(undo(second.id),/충돌/);
  assert.equal(await fs.readFile(file,'utf8'),'later manual edit');
  await fs.writeFile(file,'second');
  await undo(second.id);
  assert.equal(task.previewReady,true);
  assert.equal(await fs.readFile(file,'utf8'),'first');
  assert.equal((await fs.stat(path.join(task.work,'script.sh'))).mode&0o777,0o755);
  await assert.rejects(fs.stat(path.join(task.work,'new.txt')),{code:'ENOENT'});
  assert.equal((await getDiff(second.id)).changes[0].modified,'second');
  assert.equal(await fs.readFile(path.join(f.original,'index.html'),'utf8'),'<h1>Original</h1>');
  await undo(first.id);
  assert.deepEqual((await diff(task.base,task.work)).changes,[]);
});

test('final apply purges workspace even for a partial selection',async t=>{
  const f=await fixture(t),port=await freePort();
  const project=projectSchema.parse({id:'demo',name:'Demo',path:f.original,runtime:'static',port,safePreview:true});
  const tasks=new Tasks({hub:'ws://127.0.0.1:8080/agent',user:'tester',token:'x'.repeat(32),dataDir:f.data,projects:[project]});
  t.after(()=>tasks.close());
  const {id:taskId}=await tasks.create('demo'),task=tasks.get(taskId);
  task.codex.chat=async()=>{
    await fs.writeFile(path.join(task.work,'index.html'),'edited');
    await fs.writeFile(path.join(task.work,'unselected.txt'),'new changes');
  };
  await tasks.command('chat',{taskId,prompt:'edit two files'});
  const {revision}=await diff(task.base,task.work);

  await assert.rejects(tasks.command('apply',{taskId,revision:'stale',files:['index.html'],approved:true}),/다시 확인/);
  assert.equal(await fs.readFile(path.join(task.work,'unselected.txt'),'utf8'),'new changes');
  await tasks.command('apply',{taskId,revision,files:['index.html'],approved:true});
  assert.equal(task.state,'applied');
  assert.equal(await fs.readFile(path.join(f.original,'index.html'),'utf8'),'edited');
  await assert.rejects(fs.stat(path.join(f.original,'unselected.txt')),{code:'ENOENT'});
  await assert.rejects(fs.stat(task.dir),{code:'ENOENT'});
  await assert.rejects(tasks.command('diff',{taskId}),/종료된 작업/);
});

test('shutdown cleanup removes current and old workspaces but leaves recovery-required backups and configuration',async t=>{
  const f=await fixture(t),port=await freePort();
  const project=projectSchema.parse({id:'demo',name:'Demo',path:f.original,runtime:'static',port,safePreview:true});
  const tasks=new Tasks({hub:'ws://127.0.0.1:8080/agent',user:'tester',token:'x'.repeat(32),dataDir:f.data,projects:[project]});
  t.after(()=>tasks.close());
  const {id}=await tasks.create('demo'), task=tasks.get(id),root=path.dirname(task.dir);
  const old=path.join(root,'12345678-1234-1234-1234-123456789abc');
  const recoveryId='12345678-1234-1234-1234-123456789def',recovery=path.join(root,recoveryId);
  const model=path.join(f.data,'model-list-abcdef'),config=path.join(f.data,'config.json');
  for(const folder of [old,recovery,model])await fs.mkdir(folder);
  await fs.writeFile(path.join(recovery,'apply.json'),JSON.stringify({state:'recovery-required'}));
  await fs.writeFile(config,'keep');

  await tasks.close();
  assert.deepEqual(await tasks.purgeWorkspaces(),[recoveryId]);
  for(const folder of [task.dir,old,model])await assert.rejects(fs.stat(folder),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(f.original,'index.html'),'utf8'),'<h1>Original</h1>');
  assert.equal(await fs.readFile(config,'utf8'),'keep');
  await fs.access(path.join(recovery,'apply.json'));
});
