import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {GCodeFileExecution} from '../src/gcode/file-execution.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const directory=await mkdtemp(join(tmpdir(),'file-execution-bench-')),path=join(directory,'file.gcode');
const lines=100000,data=Array.from({length:lines},(_,i)=>`G1 X${i%250} Y${(i*7)%250}\n`).join(''),times:number[][]=[[],[]];
try{
 await writeFile(path,data);
 for(let run=0;run<13;run++)for(const variant of run%2?[1,0]:[0,1]){
  const reader=await GCodeFileReader.adopt(await open(path,'r'));let count=0,total=0,stops=0;
  const dispatch=new GCodeDispatch({output(){},shutdown(){stops++;}});dispatch.register('G1',command=>{count++;total+=Number(command.params.X)+Number(command.params.Y);});dispatch.setReady(true);
  const begin=performance.now();
  if(variant){const execution=new GCodeFileExecution(reader,dispatch);await execution.start();assert.equal(execution.status.phase,'eof');}
  else{const signal=new AbortController().signal;while(true){const batch=await reader.next(signal);if(!batch)break;await dispatch.execute(batch.script);reader.commit(batch);await new Promise<void>(resolve=>setImmediate(resolve));}await reader.close();}
  const elapsed=performance.now()-begin;assert.equal(count,lines);assert.equal(total,24900000);assert.equal(stops,0);assert.equal(reader.status.position,Buffer.byteLength(data));if(run>=2)times[variant].push(elapsed);
 }
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
 console.log(JSON.stringify({node:process.version,warmups:2,runs:11,lines,bytes:Buffer.byteLength(data),baseline:stats(times[0]),execution:stats(times[1]),extraNanosecondsPerLine:(times[1][5]-times[0][5])*1e6/lines,scope:'Same reader, parser, batch size and event-loop yields; mock G1 arithmetic; no motion device or print-speed claim'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
