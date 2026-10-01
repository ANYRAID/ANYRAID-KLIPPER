import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {NativeConfigFiles} from '../src/moonraker/native-config-files.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const dir=await mkdtemp('/tmp/config-save-bench-'),root=join(dir,'config');await mkdir(root);
const bytes=Buffer.alloc(256*1024,120);await writeFile(join(root,'load.cfg'),bytes);
const files=await NativeConfigFiles.open({root,writable:['load.cfg']}),gate=new MaintenanceGate(),samples:number[]=[];
files.bindWriter(c=>({release:gate.acquire(),signal:c.signal}));let expected=createHash('sha256').update(bytes).digest('hex');
try{
 for(let run=0;run<10;run++){
  bytes[0]=97+run;const began=performance.now(),result=await files.save('load.cfg',bytes,expected,{transport:'http',signal:new AbortController().signal,authorize(){}}) as any;
  const elapsed=performance.now()-began;assert.equal(result.fileAndDirectorySynced,true);assert.deepEqual(await readFile(join(root,'load.cfg')),bytes);expected=result.sha256;if(run>=2)samples.push(elapsed);
 }
 samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,bytes:bytes.length,warmups:2,runs:samples.length,medianMs:(samples[3]+samples[4])/2,minMs:samples[0],maxMs:samples.at(-1),samplesMs:samples,exactSource:true,backup:true,fileAndDirectorySynced:true,interpretation:'Desktop config maintenance, no physical printer or Python comparison.'}));
}finally{await files.close();await rm(dir,{recursive:true,force:true});}
