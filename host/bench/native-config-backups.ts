import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,statfs} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {NativeConfigFiles} from '../src/moonraker/native-config-files.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import type {RpcContext} from '../src/moonraker/rpc.ts';
const dir=await mkdtemp(join(resolve(process.argv[2]??process.cwd()),'.config-backups-bench-')),root=join(dir,'config');await mkdir(root);
const bytes=Buffer.alloc(256*1024,120),digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');await writeFile(join(root,'load.cfg'),bytes);
const filesystem=await statfs(root),files=await NativeConfigFiles.open({root,writable:['load.cfg']}),gate=new MaintenanceGate(),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
files.bindWriter(c=>({release:gate.acquire(),signal:c.signal}));let expected=digest(bytes),selected='';const rotation:number[]=[],restore:number[]=[],query:number[]=[];
const summarize=(samples:number[])=>{samples.sort((a,b)=>a-b);return {runs:samples.length,medianMs:(samples[3]+samples[4])/2,minMs:samples[0],maxMs:samples.at(-1)};};
try{
 for(let run=0;run<18;run++){bytes[0]=65+run;const result=await files.save('load.cfg',bytes,expected,context) as any;expected=result.sha256;selected=result.backup;}
 const recoveryBytes=await readFile(join(root,selected)),backupDigest=digest(recoveryBytes);
 for(let run=0;run<8;run++){
  bytes[1]=97+run;const began=performance.now(),result=await files.save('load.cfg',bytes,expected,context) as any;rotation.push(performance.now()-began);expected=result.sha256;assert(result.rotatedBackup);assert(result.fileAndDirectorySynced);assert.deepEqual(await readFile(join(root,'load.cfg')),bytes);
  const queryBegin=performance.now(),listed=await files.backups('load.cfg',context) as any;query.push(performance.now()-queryBegin);assert.equal(listed.backups.length,16);
 }
 for(let run=0;run<8;run++){
  const began=performance.now(),result=await files.restore('load.cfg',selected,expected,backupDigest,context) as any;restore.push(performance.now()-began);expected=result.sha256;assert(result.rotatedBackup);assert.equal(result.applied,false);assert(result.restartRequired);assert.deepEqual(await readFile(join(root,'load.cfg')),recoveryBytes);
 }
 assert.equal((await files.backups('load.cfg',context) as any).backups.length,16);assert.equal(files.status.snapshots.reservations,0);assert.equal(gate.status.maintenance,false);
 console.log(JSON.stringify({node:process.version,bytes:bytes.length,warmupSaves:18,filesystemType:'0x'+filesystem.type.toString(16),rotation:summarize(rotation),restore:summarize(restore),query:summarize(query),exactBytes:true,capacity:16,noImplicitApply:true,interpretation:'Desktop maintenance on the tagged filesystem; not physical power-loss durability, target-board printing or Python comparison.'}));
}finally{await files.close();await rm(dir,{recursive:true,force:true});}
