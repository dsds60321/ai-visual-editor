import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { hash, inventory, safePath } from './files.js';

async function copyFiles(source:string,destination:string,files:[string,string][]){
  await fs.mkdir(destination,{recursive:true,mode:0o700});
  for(const [file,expected] of files){
    const from=await safePath(source,file),to=path.join(destination,file);
    await fs.mkdir(path.dirname(to),{recursive:true,mode:0o700});
    await fs.copyFile(from,to,constants.COPYFILE_FICLONE);
    if(hash(await fs.readFile(to))!==expected)throw Error('스냅샷 생성 중 파일이 변경되었습니다');
  }
}

async function verifyInventory(source:string,exclude:string[],files:Record<string,string>){
  const actual=await inventory(source,exclude);
  if(Object.keys(actual).length!==Object.keys(files).length||
    Object.entries(files).some(([file,expected])=>actual[file]!==expected))
    throw Error('스냅샷 생성 중 파일이 변경되었습니다');
}

export async function snapshot(source:string,destination:string,exclude:string[]){
  const files=await inventory(source,exclude);
  await copyFiles(source,destination,Object.entries(files));
  await verifyInventory(source,exclude,files);
  return files;
}

export async function finishCheckpoint(source:string,dir:string,exclude:string[],before:Record<string,string>){
  const after=await inventory(source,exclude);
  const oldFiles=Object.entries(before).filter(([file,digest])=>digest!==after[file]);
  const newFiles=Object.entries(after).filter(([file,digest])=>digest!==before[file]);
  const pending=path.join(dir,'pending');
  await copyFiles(pending,path.join(dir,'before'),oldFiles);
  await copyFiles(source,path.join(dir,'after'),newFiles);
  await verifyInventory(source,exclude,after);
  await fs.writeFile(path.join(dir,'after.json'),JSON.stringify(after),{mode:0o600});
  await fs.rm(pending,{recursive:true,force:true});
  return oldFiles.length>0||newFiles.length>0;
}
