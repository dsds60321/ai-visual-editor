import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { Transform } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

const inspectorPath = '/__ave/inspector.js';
const selectionPath = '/__ave/selection';
const methods = new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const hopHeaders = ['connection','keep-alive','proxy-authenticate','proxy-authorization','proxy-connection','te','trailer','transfer-encoding','upgrade'];
const element = z.object({
  tag: z.string().regex(/^[a-z0-9:-]+$/).max(100),
  selector: z.string().regex(/^(?:[a-z0-9:-]+(?::nth-of-type\([1-9]\d{0,5}\))?(?: > [a-z0-9:-]+(?::nth-of-type\([1-9]\d{0,5}\))?){0,7})?$/).max(500),
  dataAttributes: z.array(z.string().regex(/^data-[a-z0-9_.:-]+$/).max(100)).max(50)
});
const selectionSchema = z.object({
  path: z.string().regex(/^\/(?!\/)[^?#\r\n]*$/).max(2000),
  rect: z.object({x:z.number(),y:z.number(),width:z.number().nonnegative(),height:z.number().nonnegative()}),
  elements: z.array(element.extend({children:z.array(element.extend({children:z.array(element).max(8)})).max(8)})).max(12)
});
export type Selection = z.infer<typeof selectionSchema>;

function forwardHeaders(headers:IncomingHttpHeaders){
  const forwarded={...headers};
  for(const name of [...hopHeaders,...(headers.connection||'').toLowerCase().split(',').map(value=>value.trim())])delete forwarded[name];
  return forwarded;
}

function injectInspector(hubOrigins:string[]){
  // shortcut: standard HTML heads are in the first 64 KiB, use an HTML parser for later heads.
  let pending=Buffer.alloc(0), done=false;
  const tag=Buffer.from(`<script src="${inspectorPath}" data-interactive="true" data-hub-origins="${hubOrigins.join(' ')}" defer></script>`);
  return new Transform({
    transform(chunk:Buffer,_encoding,callback){
      if(done){callback(null,chunk);return;}
      const length=Math.min(chunk.length,65536-pending.length);
      pending=Buffer.concat([pending,chunk.subarray(0,length)]);
      const head=/<head(?:\s[^>]*)?>/i.exec(pending.toString('latin1'));
      if(head){
        const offset=head.index+head[0].length;
        this.push(pending.subarray(0,offset));this.push(tag);this.push(pending.subarray(offset));
      }else if(pending.length===65536)this.push(pending);
      else{callback();return;}
      pending=Buffer.alloc(0);done=true;
      callback(null,chunk.subarray(length));
    },
    flush(callback){callback(null,pending);}
  });
}

export async function openInteractivePreview(upstreamPort:number,hubOrigins:string[],isReady:()=>boolean,onSelection:(value:Selection)=>void){
  const inspector=await readFile(new URL('../inspector/inspector.js',import.meta.url));
  const hostname=`ave-${randomBytes(16).toString('hex')}.localhost`;
  const upstreamOrigin=`http://127.0.0.1:${upstreamPort}`;
  let origin:string, host:string;
  const server=createServer(async(req,res)=>{
    const method=req.method||'GET', target=req.url||'';
    const read=method==='GET'||method==='HEAD';
    const fetchSite=req.headers['sec-fetch-site'];
    const destination=req.headers['sec-fetch-dest'];
    const navigation=read&&req.headers['sec-fetch-mode']==='navigate';
    const hubFrame=destination==='iframe'&&hubOrigins.some(value=>req.headers.referer?.startsWith(value+'/'));
    const reply=(status:number,text='')=>res.writeHead(status,{'Cache-Control':'no-store','Content-Type':'text/plain; charset=utf-8'}).end(text);
    if(req.headers.host!==host||!target.startsWith('/')||target.startsWith('//')||target.includes('\\'))return reply(403);
    if(!methods.has(method))return reply(405);
    if((req.headers.origin&&req.headers.origin!==origin)||
      (!read&&req.headers.origin!==origin&&fetchSite!=='same-origin')||
      (fetchSite&&fetchSite!=='same-origin'&&fetchSite!=='none'&&!(navigation&&(destination==='document'||hubFrame))))return reply(403);
    if(!isReady())return reply(503,'Preview 서버를 켜 주세요.');

    const pathname=target.split('?')[0];
    if(pathname===inspectorPath&&method==='GET'){
      return res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(inspector);
    }
    if(pathname===selectionPath&&method==='POST'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return reply(403);
      try{
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>12000)return reply(413);chunks.push(chunk);}
        const data=selectionSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if(!data.success)return reply(400);
        onSelection(data.data);
        return reply(204);
      }catch{return reply(400);}
    }

    const headers=forwardHeaders(req.headers);
    headers['accept-encoding']='identity';
    const upstream=request({hostname:'127.0.0.1',port:upstreamPort,path:target,method,headers,agent:false},source=>{
      const output=forwardHeaders(source.headers);
      const location=output.location;
      if(location){
        try{
          const url=new URL(location,origin);
          if(url.origin===upstreamOrigin||url.origin===`http://localhost:${upstreamPort}`){
            output.location=origin+url.pathname+url.search+url.hash;
          }
        }catch{/* preserve the application's redirect */}
      }
      if(output['set-cookie'])output['set-cookie']=output['set-cookie'].map(cookie=>{
        const [value,...attributes]=cookie.split(';');
        return [value,...attributes.map(attribute=>attribute.trim()).filter(attribute=>!/^(domain|samesite|secure|partitioned)(?:\s*=|$)/i.test(attribute)),
          'SameSite=None','Secure','Partitioned'].join('; ');
      });
      output['referrer-policy']='same-origin';
      const html=method!=='HEAD'&&source.statusCode===200&&String(output['content-type']).toLowerCase().startsWith('text/html')&&!output['content-encoding'];
      if(html){delete output['content-length'];delete output.etag;output['cache-control']='no-store';}
      const csp=output['content-security-policy'];
      const frameOptions=String(output['x-frame-options']||'').toUpperCase();
      const ancestors=frameOptions.includes('DENY')?"'none'":frameOptions.includes('SAMEORIGIN')?"'self'":`'self' ${hubOrigins.join(' ')}`;
      output['content-security-policy']=[...(csp?[csp].flat():[]),`frame-ancestors ${ancestors}`];
      res.writeHead(source.statusCode||502,output);
      source.on('error',()=>res.destroy());
      if(html)source.pipe(injectInspector(hubOrigins)).pipe(res);else source.pipe(res);
    });
    upstream.on('error',()=>{if(res.headersSent)res.destroy();else reply(502,'Preview 서버에 연결할 수 없습니다.');});
    res.once('close',()=>upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  host=`${hostname}:${(server.address() as AddressInfo).port}`;
  origin=`http://${host}`;
  return {origin,close(){server.close();server.closeAllConnections();}};
}
