import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {PrinterHeaters} from '../src/thermal/heaters.ts';
import {AsyncPrinterHeaters} from '../src/thermal/async-heaters.ts';
import {HeaterRuntime} from '../src/thermal/runtime.ts';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const directory=mkdtempSync(join(tmpdir(),'async-heaters-bench-'));
try{
 const source=execFileSync('git',['show','e40811b4:host/src/thermal/heaters.ts'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(_match,path:string)=>`from '${new URL(path,new URL('../src/thermal/heaters.ts',import.meta.url)).href}'`);
 const file=join(directory,'heaters.ts');writeFileSync(file,source);const {PrinterHeaters:Before}=await import(pathToFileURL(file).href) as {PrinterHeaters:typeof PrinterHeaters};
 async function fixture(kind:number){
  const group=kind===2?new AsyncPrinterHeaters(()=>{}):new (kind===0?Before:PrinterHeaters)(()=>{}),runtimes:(HeaterRuntime|AsyncHeaterRuntime)[]=[];let resets=0,reports=0;
  for(const [name,id] of [['bed','B'],['extruder','T']]){
   const config={minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},clock=()=>({system:1,print:1}),timer=()=>()=>{};
   if(group instanceof AsyncPrinterHeaters){const runtime=new AsyncHeaterRuntime(config,new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,initialPower:0,defaultPower:0},reset:async()=>{resets++;},setPWM:async()=>{},stop:async()=>{}},clock,{},timer);group.register(name,runtime,id);runtimes.push(runtime);}
   else{const runtime=new HeaterRuntime(config,new BangBangControl(1),{configureMaximumDuration(){},schedule(){},turnOff(){resets++;}},clock,{},timer);group.register(name,runtime,id);runtimes.push(runtime);}
  }
  await group.start();for(const runtime of runtimes)runtime.sample(1,25);
  const dispatch=new GCodeDispatch({output:line=>{assert.equal(line,'B:25.0 /60.0 T:25.0 /200.0');reports++;},shutdown:reason=>{void Promise.resolve(group.shutdown(reason)).catch(()=>{});}});group.attach(dispatch,{bed:'bed',extruders:['extruder']});dispatch.setReady(true);
  return {group,dispatch,get reports(){return reports;},get resets(){return resets;}};
 }
 const script=Array(100).fill('M104 S200\nM140 S60\nM105').join('\n'),commands:number[][]=[[],[],[]],off:number[][]=[[],[],[]];
 for(let run=0;run<13;run++)for(const kind of run%2?[2,1,0]:[0,1,2]){
  const f=await fixture(kind);let start=performance.now();for(let i=0;i<100;i++)await f.dispatch.execute(script);const commandMs=performance.now()-start;assert.equal(f.reports,10000);
  start=performance.now();for(let i=0;i<10000;i++)await f.group.turnOffAll();const offMs=performance.now()-start;assert.equal(f.resets,20002);await f.group.shutdown();if(run>=2){commands[kind].push(commandMs);off[kind].push(offMs);}
 }
 const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
 console.log(JSON.stringify({node:process.version,baseline:'e40811b4',warmups:2,runs:11,variants:['baselineSync','sharedCommandsSync','asyncGroup'],commandTriples:10000,commands:commands.map(stats),twoHeaterOffs:10000,off:off.map(stats),scope:'G-code parser, target barrier, M105 and synthetic immediate reset ACK; no physical timing'},null,2));
}finally{rmSync(directory,{recursive:true,force:true});}
