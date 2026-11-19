import{test}from'node:test';import assert from'node:assert/strict';import{promises as fs}from'node:fs';import path from'node:path';import os from'node:os';
// The local registration UI uses the same compiled schema as the Agent.
test('local registration requires same-origin token, detects and saves without touching sources',async t=>{
 const{createRegistration}=await import('../../scripts/register.mjs');const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ave-register-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const source=path.join(dir,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'index.html'),'original');const config=path.join(dir,'config.json');await fs.writeFile(config,JSON.stringify({hub:'ws://127.0.0.1:8080/agent',user:'tester',token:'x'.repeat(32),dataDir:'data',projects:[]}));
 const{server,origin}=await createRegistration(config);t.after(()=>new Promise<void>(r=>server.close(()=>r())));const script=await(await fetch(origin+'/register.js')).text(),token=JSON.parse(script.match(/const token=("[a-f0-9]+")/)![1]);const project={id:'static-demo',name:'Demo',path:source,runtime:'static',port:18090,safePreview:true};
 let r=await fetch(origin+'/save',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://attacker.example'},body:JSON.stringify(project)});assert.equal(r.status,403);
 r=await fetch(origin+'/save',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Local-Token':token},body:JSON.stringify(project)});assert.equal(r.status,200);assert.equal(JSON.parse(await fs.readFile(config,'utf8')).projects[0].id,'static-demo');assert.equal(await fs.readFile(path.join(source,'index.html'),'utf8'),'original');
 const post=(route:string,body:object,withToken=true)=>fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(withToken?{'X-Local-Token':token}:{})},body:JSON.stringify(body)});
 assert.equal((await post('/project',{id:project.id},false)).status,403);
 assert.deepEqual(await (await post('/projects',{})).json(),[{id:project.id,name:project.name}]);
 const saved=await (await post('/project',{id:project.id})).json();
 assert.equal(saved.project.path,source);
 assert.equal((await post('/save',{...saved.project,name:'Without revision'})).status,409);
 const update={...saved.project,revision:saved.revision,name:'Renamed demo',port:18091,previewPath:'/init'};
 assert.equal((await post('/save',update)).status,200);
 assert.equal((await post('/save',{...update,name:'Stale overwrite'})).status,409);
 const updated=JSON.parse(await fs.readFile(config,'utf8'));
 assert.equal(updated.projects.length,1);
 assert.equal(updated.projects[0].name,'Renamed demo');
 assert.equal(updated.projects[0].port,18091);
 assert.equal(updated.projects[0].previewPath,'/init');
 assert.equal(updated.token,'x'.repeat(32));
});
