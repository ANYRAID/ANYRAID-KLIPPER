import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,renameSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSimulavrCore} from './build-simulavr-core.ts';
const host=fileURLToPath(new URL('..',import.meta.url));
if(process.argv.length!==3)throw new Error('Usage: node host/scripts/build-avrsim.ts SIMULAVR_SOURCE');
const source=resolve(process.argv[2]),output=resolve(host,'build/avrsim');
mkdirSync(dirname(output),{recursive:true});const dir=mkdtempSync(resolve(dirname(output),'avrsim-build-'));
try{
 const archive=resolve(dir,'libsim.a');buildSimulavrCore(source,archive);
 const binary=resolve(dir,'avrsim');
 const result=spawnSync(process.env.CXX??'g++',['-std=c++11','-O2','-Wall','-Wextra','-I'+resolve(source,'include'),resolve(host,'native/avrsim.cpp'),'-Wl,--whole-archive',archive,'-Wl,--no-whole-archive','-o',binary],{stdio:'inherit',timeout:120000});
 if(result.status!==0)throw new Error('AVR engine build failed: '+(result.error??result.status));
 const addon=resolve(dir,'simulator-pty.node'),include=process.env.NODE_INCLUDE??resolve(dirname(process.execPath),'../include/node');
 const pty=spawnSync(process.env.CC??'cc',['-shared','-fPIC','-O2','-Wall','-Wextra','-I'+include,resolve(host,'native/simulator-pty.c'),'-o',addon],{stdio:'inherit',timeout:60000});
 if(pty.status!==0)throw new Error('Simulator PTY build failed: '+(pty.error??pty.status));
 renameSync(addon,resolve(host,'build/simulator-pty.node'));renameSync(binary,output);
}finally{rmSync(dir,{recursive:true,force:true});}
