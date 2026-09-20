import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {GCodeFileExecution} from '../src/gcode/file-execution.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {PrintController} from '../src/operations/print.ts';
const directory=await mkdtemp(join(tmpdir(),'file-print-bench-')),path=join(directory,'file.gcode'),lines=100000;
const data=Array.from({length:lines},(_,i)=>`G1 X${i%250} Y${i*7%250}\n`).join(''),times:number[][]=[[],[]];
try{
 await writeFile(path,data);
 for(let run=0;run<13;run++)for(const variant of run%2?[1,0]:[0,1]){
  let count=0,total=0,stops=0;const dispatch=new GCodeDispatch({output(){},shutdown(){stops++;}});dispatch.register('G1',command=>{count++;total+=Number(command.params.X)+Number(command.params.Y);});dispatch.setReady(true);
  const begin=performance.now();
  if(variant){
   const finished=Promise.withResolvers<void>(),device=new FilePrintDevice({prepare:async()=>{},start:async()=>{},pause:async()=>{},resume:async()=>{},finish:async()=>{finished.resolve();},stop:async()=>{stops++;}},dispatch,async()=>GCodeFileReader.adopt(await open(path,'r'))),controller=new PrintController(device,{maxNozzle:300,maxBed:130});
   await controller.start({version:1,requestId:'job',fileId:'file',nozzle:0,bed:0});await finished.promise;await controller.complete('job');assert.equal(controller.state,'completed');assert.equal(device.status.file?.position,Buffer.byteLength(data));
  }else{const execution=new GCodeFileExecution(await GCodeFileReader.adopt(await open(path,'r')),dispatch);await execution.start();assert.equal(execution.status.phase,'eof');}
  const elapsed=performance.now()-begin;assert.equal(count,lines);assert.equal(total,24900000);assert.equal(stops,0);if(run>=2)times[variant].push(elapsed);
 }
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
 console.log(JSON.stringify({node:process.version,warmups:2,runs:11,lines,bytes:Buffer.byteLength(data),bareExecution:stats(times[0]),fileDeviceAndController:stats(times[1]),extraNanosecondsPerLine:(times[1][5]-times[0][5])*1e6/lines,scope:'Real cached file, identical parser/mock G1 arithmetic, automatic EOF and immediate motion drain. Excludes physical motion, heating and durable journal.'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
