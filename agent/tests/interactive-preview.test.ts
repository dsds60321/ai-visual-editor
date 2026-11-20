import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openInteractivePreview } from '../preview/interactive.js';

test('interactive Preview forwards login and HTTP actions on an isolated origin',async t=>{
  const upstream=createServer(async(req,res)=>{
    if(req.url==='/login'&&req.method==='POST'){
      for await (const _ of req) {/* consume the form */}
      res.writeHead(303,{
        Location:`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/dashboard`,
        'Set-Cookie':['session=fixture; Domain=localhost; Path=/; HttpOnly','theme=light; Path=/']
      }).end();
      return;
    }
    if(req.headers.cookie!=='session=fixture'){res.writeHead(401).end();return;}
    if(req.url==='/style.css'){res.writeHead(200,{'Cache-Control':'max-age=3600','Content-Type':'text/css'}).end('body{}');return;}
    if(req.url==='/private'){res.writeHead(200,{'X-Frame-Options':'DENY'}).end();return;}
    res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"script-src 'self'"}).end('<html><head></head><body>Dashboard</body></html>');
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>upstream.close(()=>resolve())));
  let ready=true,selected:unknown;
  const hub='http://127.0.0.1:8080';
  const proxy=await openInteractivePreview((upstream.address() as AddressInfo).port,[hub],()=>ready,value=>{selected=value;},true);
  t.after(()=>proxy.close());
  const address=new URL(proxy.origin);
  function call(path:string,method='GET',headers:OutgoingHttpHeaders={},body?:string){
    return new Promise<{status:number;headers:IncomingHttpHeaders;body:string}>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:address.port,path,method,headers:{Host:address.host,...headers},agent:false},res=>{
        let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});
        res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:text}));
        res.on('error',reject);
      });
      req.on('error',reject);req.end(body);
    });
  }
  assert.equal((await call('/login','POST',{Origin:'https://external.example'})).status,403);
  assert.equal((await call('/dashboard','GET',{Host:'invalid.localhost'})).status,403);
  const login=await call('/login','POST',{Origin:proxy.origin},'user=fixture');
  assert.equal(login.status,303);
  assert.equal(login.headers.location,proxy.origin+'/dashboard');
  assert.deepEqual(login.headers['set-cookie'],['session=fixture; Path=/; HttpOnly; SameSite=None; Secure; Partitioned','theme=light; Path=/; SameSite=None; Secure; Partitioned']);
  const frameHeaders={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'iframe',Cookie:'session=fixture'};
  assert.equal((await call('/dashboard','GET',{...frameHeaders,Referer:'http://other.localhost/'})).status,403);
  const dashboard=await call('/dashboard','GET',{...frameHeaders,Referer:hub+'/'});
  assert.equal(dashboard.status,200);
  assert.equal(dashboard.headers['content-security-policy'],"script-src 'self', frame-ancestors 'self' "+hub);
  assert.match(dashboard.body,/data-interactive="true"/);
  const style=await call('/style.css','GET',{'Sec-Fetch-Site':'same-origin','Sec-Fetch-Dest':'style',Cookie:'session=fixture'});
  assert.equal(style.status,200);
  assert.equal(style.headers['cache-control'],'no-store');
  assert.equal((await call('/style.css')).status,401);
  assert.equal((await call('/private','GET',{...frameHeaders,Referer:hub+'/'})).headers['content-security-policy'],"frame-ancestors 'none'");
  const payload={path:'/dashboard',rect:{x:1,y:1,width:10,height:10},elements:[{tag:'h1',selector:'body > h1',dataAttributes:['data-subject'],children:[],value:'private'}]};
  const headers={Origin:proxy.origin,'Content-Type':'application/json'};
  assert.equal((await call('/__ave/selection','POST',headers,JSON.stringify(payload))).status,204);
  assert.deepEqual(selected,{...payload,elements:[{tag:'h1',selector:'body > h1',dataAttributes:['data-subject'],children:[]}]});
  ready=false;
  assert.equal((await call('/dashboard')).status,503);
});
