import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { allowed } from '../project/files.js';
import type { Project } from '../../shared/protocol.js';
export class Runtime {
  process?:ChildProcess; buildProcess?:ChildProcess; server?:Server;
  constructor(private project:Project,private work:string,private previewBase:string,private log:(s:string)=>void){}
  get running(){return !!(this.server?.listening||(this.process?.pid&&this.process.exitCode===null&&this.process.signalCode===null));}
  async start(skipBuild=false) {
    if(!this.project.safePreview)throw Error('테스트 환경 확인 전에는 실행할 수 없습니다');
    if(this.project.runtime==='static') {
      this.server=createServer(async(req,res)=>{
        try {
          const rel=decodeURIComponent(new URL(req.url!,'http://localhost').pathname);
          if(!allowed(rel)||rel.includes('\\')||rel.split('/').includes('..'))throw Error('경로 오류');
          const file=await fs.realpath(path.join(this.work,rel==='/'?'index.html':rel));
          if(!file.startsWith(this.work+path.sep))throw Error('경로 탈출');
          const ext=path.extname(file);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'} as Record<string,string>)[ext]||'application/octet-stream');
          res.end(await fs.readFile(file));
        } catch {res.writeHead(404);res.end('Not found');}
      });
      await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.project.port,'127.0.0.1',resolve);});
      return;
    }
    if(!this.project.startCommand.length)throw Error('로컬 설정에 실행 명령을 등록하세요');
    // A busy port must never attach this task to an unrelated original/production server.
    const probe=createServer();await new Promise<void>((r,j)=>{probe.once('error',j);probe.listen(this.project.port,'127.0.0.1',()=>probe.close(()=>r()));});
    if(!skipBuild&&this.project.buildCommand.length)await this.run(this.project.buildCommand,true);
    await this.run(this.project.startCommand,false);
    let lastStatus:number|undefined;
    for(const deadline=Date.now()+60_000;Date.now()<deadline;) {
      if(!this.running)throw Error('Preview 프로세스가 종료되었습니다. 로그를 확인하세요');
      try {const r=await fetch(`http://127.0.0.1:${this.project.port}${this.project.pathPrefix==='task'?this.previewBase:''}${this.project.readyPath}`,{signal:AbortSignal.timeout(1000),redirect:'manual'});lastStatus=r.status;await r.body?.cancel();if(r.status<400)return;}catch{}
      await new Promise(r=>setTimeout(r,500));
    }
    await this.stop();throw Error(lastStatus?`Preview 준비 확인 실패: ${this.project.readyPath}에서 HTTP ${lastStatus} 응답. 실행 로그를 확인하세요`:'Preview 준비 시간 초과 (60초). 실행 명령과 readyPath를 확인하세요');
  }
  private async run(command:string[],wait:boolean) {
    if(process.platform!=='darwin')throw Error('Command Preview requires the macOS sandbox adapter in this MVP. Static Preview is portable; Windows/Linux command isolation is not yet verified.');
    const privateDir=path.join(this.work,'.ave-runtime');await fs.mkdir(privateDir,{recursive:true});
    if((await fs.lstat(privateDir)).isSymbolicLink()||await fs.realpath(privateDir)!==privateDir)throw Error('Runtime 캐시 경로의 링크는 허용되지 않습니다');
    const policyDir=path.join(path.dirname(this.work),'runtime-policy');await fs.mkdir(policyDir,{recursive:true,mode:0o700});
    const profile=path.join(policyDir,wait?'build.sb':'runtime.sb');
    const rule=`(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(this.work)}) (literal "/dev/null"))${wait?'':'(deny network*)(allow network* (local ip "localhost:*") (remote ip "localhost:*"))'}`;
    await fs.writeFile(profile,rule);

    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,JAVA_HOME:process.env.JAVA_HOME,HOME:path.join(this.work,'.ave-runtime'),USERPROFILE:process.env.USERPROFILE,SystemRoot:process.env.SystemRoot,TEMP:privateDir,TMP:privateDir,TMPDIR:privateDir,npm_config_cache:path.join(privateDir,'npm'),npm_config_audit:'false',npm_config_fund:'false',npm_config_fetch_retries:'0',npm_config_fetch_timeout:'20000',JAVA_TOOL_OPTIONS:`-Duser.home=${privateDir} -Djava.io.tmpdir=${privateDir} -Djava.net.preferIPv4Stack=true`,PORT:String(this.project.port),HOST:'127.0.0.1',AVE_PREVIEW_BASE:this.previewBase+'/',NODE_ENV:'development',...this.project.environment};
    command=command.map(arg=>arg==='${AVE_PREVIEW_BASE}'?this.previewBase+'/':arg);
    const jar=command.indexOf('-jar');
    if(!wait&&/java(?:\.exe)?$/.test(command[0])&&jar>=0&&command[jar+1]){
      const source=await fs.realpath(path.resolve(this.work,command[jar+1]));if(!source.startsWith(this.work+path.sep))throw Error('JAR은 작업 사본 안에 있어야 합니다');
      const artifact=path.join(policyDir,'preview-'+randomUUID()+'.jar');await fs.copyFile(source,artifact,constants.COPYFILE_EXCL);command[jar+1]=artifact;
    }
    const cp=spawn('/usr/bin/sandbox-exec',['-f',profile,...command],{cwd:this.work,env,shell:false,detached:true,stdio:['ignore','pipe','pipe']});
    if(!wait)this.process=cp;else this.buildProcess=cp;
    cp.stdout?.on('data',b=>this.log(String(b)));cp.stderr?.on('data',b=>this.log(String(b)));
    await new Promise<void>((resolve,reject)=>{
      const timer=wait?setTimeout(()=>{if(cp.pid)try{process.kill(-cp.pid,'SIGKILL');}catch{}reject(Error('빌드 제한 시간 120초 초과. 네트워크와 로컬 빌드 설정을 확인하세요'));},120000):undefined;
      const finish=(error?:Error)=>{clearTimeout(timer);error?reject(error):resolve();};
      cp.once('error',finish);if(wait)cp.once('exit',code=>finish(code===0?undefined:Error(`빌드 실패: exit ${code}`)));else cp.once('spawn',()=>finish());
    });
    if(wait)this.buildProcess=undefined;
  }
  async rebuild(onRestart:()=>void) {
    if(this.project.buildCommand.length)await this.run(this.project.buildCommand,true);
    onRestart();
    await this.stop();await this.start(true);
  }
  async stop() {
    if(this.server)await new Promise<void>(r=>this.server!.close(()=>r()));this.server=undefined;
    const build=this.buildProcess;this.buildProcess=undefined;
    if(build?.pid&&build.exitCode===null){try{process.kill(-build.pid,'SIGKILL');}catch{}}
    const cp=this.process;this.process=undefined;
    if(!cp?.pid||cp.exitCode!==null)return;
    if(process.platform==='win32')await new Promise<void>(resolve=>{const killer=spawn('taskkill',['/pid',String(cp.pid),'/T','/F']);killer.once('exit',()=>resolve());killer.once('error',()=>resolve());});
    else {
      try{process.kill(-cp.pid,'SIGTERM');}catch{}
      await Promise.race([new Promise(r=>cp.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);
      try{process.kill(-cp.pid,'SIGKILL');}catch{}
    }
  }
}
