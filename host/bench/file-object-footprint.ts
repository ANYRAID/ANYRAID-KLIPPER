import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {readFileObjectFootprint} from '../src/gcode/file-object-footprint.ts';
const dir=await mkdtemp('/tmp/footprint-bench-'),path=dir+'/job.gcode',data='EXCLUDE_OBJECT_DEFINE NAME=part POLYGON=[[20,30],[40,30],[40,50],[20,50]]\n'+'G1 X30 Y40 E0.01 F6000\n'.repeat(100000),samples:number[]=[];
try{
 await writeFile(path,data);let digest='';for(let run=0;run<6;run++){const reader=await GCodeFileReader.adopt(await open(path,'r'));try{const start=performance.now(),result=await readFileObjectFootprint(reader,new AbortController().signal);if(run)samples.push(performance.now()-start);assert(result.complete);assert.equal(result.polygons.length,1);if(digest)assert.equal(result.digest,digest);digest=result.digest;}finally{await reader.close();}}
 const median=[...samples].sort((a,b)=>a-b)[2],result={node:process.version,bytes:Buffer.byteLength(data),lines:100001,samplesMs:samples,medianMs:median,medianMiBPerSecond:Buffer.byteLength(data)/1048576/(median/1000),passed:median<5000,scope:'Authorized local file streaming, normalized digest and object polygon extraction. No G-code dispatch or product calibration; warm filesystem cache.'};assert(result.passed);await writeFile(new URL('../contracts/file-object-footprint.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(result);
}finally{await rm(dir,{recursive:true,force:true});}
