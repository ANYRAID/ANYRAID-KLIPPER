import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../scripts/inspect-legacy-macros.ts',import.meta.url));
for(const newline of ['\n','\r\n','\r'])test(`archive inspection checks include boundaries before loading (${JSON.stringify(newline)})`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'legacy-macro-boundary-')),pack=join(root,'pack'),temporary=join(root,'temporary');
 try{
  await mkdir(pack);await mkdir(temporary);const outside=join(root,'outside.cfg');
  await writeFile(outside,'[gcode_macro OUTSIDE_SENTINEL]\ngcode = G1 X1\n');
  for(const [label,include,allowed] of [['absolute',outside,false],['parent','../outside.cfg',false],['inside','inside.cfg',true]] as const){
   const archive=join(root,label+'.zip'),output=join(root,label+'.json');
   await writeFile(join(pack,'printer.cfg'),['[printer]','[include '+include+']','[gcode_macro MAIN]','gcode = G1 X0',''].join(newline));
   await writeFile(join(pack,'inside.cfg'),['[gcode_macro INCLUDED]','gcode = G1 X2',''].join(newline));
   const zipped=spawnSync('zip',['-q',archive,'printer.cfg','inside.cfg'],{cwd:pack,encoding:'utf8',timeout:5000});assert.equal(zipped.status,0,zipped.stderr+String(zipped.error??''));
   const env:NodeJS.ProcessEnv={...process.env,TMPDIR:temporary};delete env.NODE_TEST_CONTEXT;
   const result=spawnSync(process.execPath,[cli,output,archive],{env,encoding:'utf8',timeout:10000,maxBuffer:1024**2});
   if(allowed){assert.equal(result.status,0,result.stderr);const inventory=JSON.parse(await readFile(output,'utf8'));assert.deepEqual(inventory.packages[0].macros.map((m:any)=>m.section),['gcode_macro INCLUDED','gcode_macro MAIN']);assert.equal(inventory.packages[0].macros.find((m:any)=>m.section==='gcode_macro MAIN').definitions[0].line,3);}
   else{assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/Include escapes archive/);await assert.rejects(readFile(output),{code:'ENOENT'});}
   assert.deepEqual(await readdir(temporary),[],'Inspection must clean its extracted directory on success and rejection');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
