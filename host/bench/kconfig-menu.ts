import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseKconfig} from '../src/kconfig/parser.ts';
import {KconfigEditorFiles} from '../src/kconfig/editor-files.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),directory=await mkdtemp(join(tmpdir(),'kconfig-menu-bench-'));
try{
 const reference=JSON.parse(await readFile(new URL('../contracts/kconfig-editor-reference.json',import.meta.url),'utf8'));
 const samples:number[]=[];
 for(let run=0;run<15;run++){
  const path=join(directory,'config-'+run),output=join(directory,'minimal-'+run);
  const input=[...reference.steps.map((s:{name:string;value:string})=>'set '+s.name+' '+s.value),'save','export '+output,'quit',''].join('\n');
  const start=performance.now();
  const result=spawnSync(process.execPath,[join(root,'scripts/kconfig-menuconfig.mjs'),'src/Kconfig'],{cwd:root,input,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,env:{...process.env,srctree:root,KCONFIG_CONFIG:path,KCONFIG_CONFIG_HEADER:'',CONFIG_:'CONFIG_'}});
  const elapsed=performance.now()-start;assert.equal(result.status,0,result.stderr);
  assert.equal(await readFile(path,'utf8'),reference.steps.at(-1).full);assert.equal(await readFile(output,'utf8'),reference.steps.at(-1).minimal);
  if(run>=3)samples.push(elapsed);
 }
 samples.sort((a,b)=>a-b);
 const tree=await parseKconfig(root),files=await KconfigEditorFiles.open(root,tree,join(directory,'save-config'));await files.save();
 const saves:number[]=[];
 for(let run=0;run<33;run++){
  const start=performance.now();files.editor.set('LOW_LEVEL_OPTIONS',run%2?'n':'y');await files.save();const elapsed=performance.now()-start;
  assert.equal(await readFile(files.path,'utf8'),files.editor.full());assert.equal(files.editor.dirty,false);if(run>=3)saves.push(elapsed);
 }
 saves.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,journey:{edits:15,warmups:3,runs:12,medianMs:(samples[5]+samples[6])/2,p95Ms:samples[11],scope:'New process, parse, line-menu redraws, 15 edits, full save, minimal export, exit; piped input/output, warm compile/filesystem cache'},save:{warmups:3,runs:30,medianMs:(saves[14]+saves[15])/2,p95Ms:saves[28],scope:'Edit, recompute, conflict checks, backup, atomic replacement and saved-state update; warm filesystem cache'},limitation:'No curses comparison or target board/printing timing claim; real PTY correctness is validated separately'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
