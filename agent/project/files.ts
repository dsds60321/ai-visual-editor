import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const excluded = new Set(['.ave-apply-lock','.ave-runtime','.git','node_modules','target','dist','build','.next','.nuxt','.gradle','.idea','.aws','.ssh','.codex','.agents','coverage','.DS_Store','.ave-runtime']);
export function allowed(rel:string, extra:string[] = []) {
  const parts = rel.split(/[\\/]/);
  return !parts.some(p=>excluded.has(p) || /^(?:application.*\.(?:properties|ya?ml)|\.npmrc|\.netrc|settings\.xml)$/i.test(p) || /^\.env(?:\.|$)/i.test(p) || /(?:credentials|secrets?|auth\.json|id_rsa|\.pem$|\.key$|\.p12$|\.jks$)/i.test(p)) && !extra.some(p=>rel===p||rel.startsWith(p+'/'));
}
export const hash = (data:Buffer|string) => createHash('sha256').update(data).digest('hex');
export async function safePath(root:string,rel:string) {
  if (!rel || rel.includes('\\') || path.isAbsolute(rel) || rel.split('/').some(p=>!p||p==='.'||p==='..') || !allowed(rel)) throw Error('허용되지 않은 파일 경로');
  const canonical = await fs.realpath(root);
  if (canonical !== path.resolve(root)) throw Error('프로젝트 루트 링크 또는 이동 감지');
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current,part);
    try { const s=await fs.lstat(current); if(s.isSymbolicLink()) throw Error('심볼릭 링크는 허용하지 않습니다'); }
    catch(e:any) { if(e.code!=='ENOENT') throw e; }
  }
  return current;
}
export async function inventory(root:string,extra:string[]=[]):Promise<Record<string,string>> {
  const result:Record<string,string>={};
  async function walk(dir:string, prefix='') {
    for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
      const rel=prefix+entry.name;
      if(!allowed(rel,extra)) continue;
      if(entry.isSymbolicLink()) throw Error(`심볼릭 링크를 제거하거나 제외하세요: ${rel}`);
      if(entry.isDirectory()) await walk(path.join(dir,entry.name),rel+'/');
      else if(entry.isFile()) result[rel]=hash(await fs.readFile(await safePath(root,rel)));
      else throw Error(`지원하지 않는 특수 파일: ${rel}`);
    }
  }
  await walk(root); return result;
}
export async function detect(root:string) {
  const names = await fs.readdir(root);
  if(names.includes('package.json')) {
    const p=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
    const d={...p.dependencies,...p.devDependencies};
    return {framework:d.next?'Next.js':d.nuxt?'Nuxt':d.vue?'Vue':d.react?'React':d.express?'Express':'Node.js', scripts:p.scripts||{}};
  }
  if(names.includes('pom.xml')||names.some(n=>n.startsWith('build.gradle'))) return {framework:'Java / Spring (실행 설정 필요)',scripts:{}};
  return {framework:'Static HTML',scripts:{}};
}
