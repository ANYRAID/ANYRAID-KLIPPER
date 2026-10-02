import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {createSealedPrintReader} from '../src/gcode/sealed-file.ts';
const directory=await mkdtemp(join(tmpdir(),'sealed-file-bench-')),path=join(directory,'file');
const text=Array.from({length:100000},(_,i)=>`G1 X${i%250} Y${i*7%250} E${(i*.01).toFixed(2)} F12000\n`).join(''),digest=createHash('sha256').update(text).digest('hex'),setup:number[][]=[[],[]],read:number[][]=[[],[]];
try{
 await writeFile(path,text);
 for(let run=0;run<13;run++)for(const variant of run%2?[1,0]:[0,1]){
  const source=await open(path,'r'),signal=new AbortController().signal;let reader:GCodeFileReader|undefined;
  try{
   let begin=performance.now();reader=variant?(await createSealedPrintReader(source,digest,signal)).reader:await GCodeFileReader.adopt(source);const preparation=performance.now()-begin;
   const hash=createHash('sha256');let lines=0;begin=performance.now();while(true){const batch=await reader.next(signal);if(!batch)break;hash.update(batch.script+'\n');lines+=batch.lines;reader.commit(batch);}const reading=performance.now()-begin;
   assert.equal(lines,100000);assert.equal(reader.status.position,Buffer.byteLength(text));assert.equal(hash.digest('hex'),digest);if(run>=2){setup[variant].push(preparation);read[variant].push(reading);}
  }finally{await reader?.close();await source.close();}
 }
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
 console.log(JSON.stringify({node:process.version,warmups:2,runs:11,lines:100000,bytes:Buffer.byteLength(text),variants:['authorizedSource','kernelSealedCopy'],setup:setup.map(stats),read:read.map(stats),scope:'Cached temporary source, SHA-256 verified copy and batched reads; no disk durability, memory-pressure or target-board timing claim'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
