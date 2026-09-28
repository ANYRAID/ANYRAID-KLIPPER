// Build the pinned external simulator core without its Python/SWIG tooling.
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export const SIMULAVR_REVISION='32985f745c237bf8dcd2718235d01c8b1fb0491d';
export function buildSimulavrCore(source:string,output:string):void{
 source=resolve(source);output=resolve(output);
 const run=(program:string,args:string[],capture=false)=>{
  const result=spawnSync(program,args,{encoding:'utf8',stdio:capture?'pipe':'inherit',timeout:120000});
  if(result.status!==0)throw new Error(`${program} failed: ${result.error??result.stderr??result.status}`);
  return result.stdout?.trim()??'';
 };
 if(run('git',['-C',source,'rev-parse','HEAD'],true)!==SIMULAVR_REVISION)throw new Error('Unsupported simulavr revision; use '+SIMULAVR_REVISION);
 if(run('git',['-C',source,'status','--porcelain','--untracked-files=normal'],true))throw new Error('simulavr source must be clean');
 const manifest=readFileSync(resolve(source,'libsim/CMakeLists.txt'),'utf8').match(/set\(libSrcs ([\s\S]*?)\)/)?.[1];
 const sources=manifest?.trim().split(/\s+/);if(!sources?.length||sources.some(s=>!/^([a-z0-9_]+\/)*[a-z0-9_]+\.cpp$/.test(s)))throw new Error('Invalid simulavr source manifest');
 mkdirSync(dirname(output),{recursive:true});const temp=mkdtempSync(resolve(dirname(output),'simulavr-build-'));
 try{
  writeFileSync(resolve(temp,'config.h'),'#define VERSION "'+SIMULAVR_REVISION+'"\n');
  const objects:string[]=[];
  for(const [index,name] of sources.entries()){
   const object=resolve(temp,index+'.o');run(process.env.CXX??'g++',['-std=c++11','-O2','-fPIC','-I'+temp,'-I'+resolve(source,'include'),'-I'+resolve(source,'include/elfio'),'-c',resolve(source,'libsim',name),'-o',object]);objects.push(object);
  }
  const archive=resolve(temp,'libsim.a');run(process.env.AR??'ar',['rcs',archive,...objects]);renameSync(archive,output);
 }finally{rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==4)throw new Error('Usage: node build-simulavr-core.ts SIMULAVR_SOURCE OUTPUT_ARCHIVE');
 buildSimulavrCore(process.argv[2],process.argv[3]);
}
