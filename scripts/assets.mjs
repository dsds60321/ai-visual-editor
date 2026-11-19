import { cp, mkdir } from 'node:fs/promises';
const out='hub/backend/src/main/resources/static';
await mkdir(out,{recursive:true});
await cp('hub/frontend',out,{recursive:true});
await cp('agent/inspector/inspector.js',out+'/inspector.js');
await mkdir('dist/agent/inspector',{recursive:true});
await cp('agent/inspector/inspector.js','dist/agent/inspector/inspector.js');
await cp('node_modules/monaco-editor/min/vs',out+'/vs',{recursive:true});
