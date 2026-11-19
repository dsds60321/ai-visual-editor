import type { Project } from '../../shared/protocol.js';
export async function preview(project:Project,resource:string,previewBase:string){
  if(!resource.startsWith('/')||resource.startsWith('//')||resource.includes('\\'))throw Error('잘못된 Preview 경로');
  const base=`http://127.0.0.1:${project.port}`;
  const url=new URL((project.pathPrefix==='task'?previewBase:'')+resource,base);if(url.origin!==base)throw Error('Preview 외부 주소는 허용되지 않습니다');
  const res=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'Accept-Encoding':'identity'}});
  if(res.status>=300&&res.status<400)throw Error('Preview 리디렉션은 수동 URL 설정이 필요합니다');
  if(Number(res.headers.get('content-length'))>8_000_000)throw Error('Preview 응답 8MB 제한');
  const chunks:Uint8Array[]=[];let size=0;
  for await(const chunk of res.body!){size+=chunk.length;if(size>8_000_000)throw Error('Preview 응답 8MB 제한');chunks.push(chunk);}
  let body=Buffer.concat(chunks);const type=res.headers.get('content-type')||'application/octet-stream';
  if(type.includes('text/html')) {
    const prefix=previewBase;
    // shortcut: root-relative HTML assets are rewritten; dynamic absolute URLs need a framework base/proxy configuration.
    let html=body.toString().replace(/\b(src|href|action)=(['"])(\/(?!\/)[^'"]*)/gi,(_m,attr,quote,url)=>`${attr}=${quote}${url.startsWith(prefix+'/')?url:prefix+url}`);
    html=html.replace(/<head([^>]*)>/i,`<head$1><base href="${prefix}/">`);
    const bridge=`<script src="/inspector.js" data-preview-base="${prefix}"></script>`;
    html=html.includes('</body>')?html.replace('</body>',bridge+'</body>'):html+bridge;body=Buffer.from(html);
  }
  return {status:res.status,type,body:body.toString('base64'),csp:res.headers.get('content-security-policy')||'',frameOptions:res.headers.get('x-frame-options')||''};
}
