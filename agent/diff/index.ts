import { promises as fs } from 'node:fs';
import path from 'node:path';
import { diffLines } from 'diff';
import { inventory, hash, safePath } from '../project/files.js';
export async function diff(base:string,work:string,exclude:string[]=[]) {
  const before=await inventory(base,exclude), after=await inventory(work,exclude);
  const changes=[];
  for(const file of [...new Set([...Object.keys(before),...Object.keys(after)])].sort()) {
    if(before[file]===after[file]) continue;
    const a=before[file]?await fs.readFile(await safePath(base,file)):Buffer.alloc(0);
    const b=after[file]?await fs.readFile(await safePath(work,file)):Buffer.alloc(0);
    if(a.length>2_000_000||b.length>2_000_000||a.includes(0)||b.includes(0)||!a.equals(Buffer.from(a.toString('utf8')))||!b.equals(Buffer.from(b.toString('utf8')))) throw Error(`바이너리/2MB 초과 변경은 적용할 수 없습니다: ${file}`);
    const original=a.toString('utf8'), modified=b.toString('utf8');
    if(!Buffer.from(original).equals(a)||!Buffer.from(modified).equals(b))throw Error(`UTF-8 이외 파일은 적용할 수 없습니다: ${file}`);
    const lines=diffLines(original,modified);
    const sql=/\.sql$/i.test(file)||/\b(select\s+.+?\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from|alter\s+table|drop\s+|truncate\s+)/is.test(original+'\n'+modified);
    // shortcut: SQL in templates cannot be parsed uniformly; require human review for every detected SQL change.
    const risks=sql?['SQL 변경: DB 자동 실행 없음',...(/\b(drop|truncate|delete|alter|trigger|index|update)\b/i.test(modified)?['파괴적/구조 변경 가능 — 전체 문맥 검토 필요']:[])]:[];
    changes.push({file,kind:!before[file]?'added':!after[file]?'deleted':'modified',original,modified,beforeHash:before[file]??null,afterHash:after[file]??null,added:lines.filter(l=>l.added).reduce((s,l)=>s+(l.count||0),0),removed:lines.filter(l=>l.removed).reduce((s,l)=>s+(l.count||0),0),sql,risks});
  }
  return {revision:hash(JSON.stringify(changes)),changes};
}
