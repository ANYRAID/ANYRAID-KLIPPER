import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createSealedPrintReader} from '../src/gcode/sealed-file.ts';
import {FilePrintDevice,type FilePrintMotion} from '../src/operations/file-print-device.ts';
import {ThermalPrintDevice} from '../src/operations/thermal-print-device.ts';
import {PrintController,type PrintDevice,type StartPrint} from '../src/operations/print.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {GCodeDispatch,GCodeError,type CommandContext} from '../src/gcode/dispatch.ts';
import {AsyncPrinterHeaters} from '../src/thermal/async-heaters.ts';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
const request:StartPrint={version:1,requestId:'job',fileId:'file',nozzle:200,bed:60};
const until=async(check:()=>boolean)=>{const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw new Error('file print condition timed out');await new Promise(resolve=>setImmediate(resolve));}};
async function fixture(script='G1 X1\n',handler:(command:CommandContext)=>void|Promise<void>=()=>{}){
 const directory=await mkdtemp(join(tmpdir(),'file-print-')),path=join(directory,'file.gcode');await writeFile(path,script);
 const members:AsyncHeaterRuntime[]=[];const group=new AsyncPrinterHeaters(()=>{}),resets:ReturnType<typeof Promise.withResolvers<void>>[][]=[[],[]],events:string[]=[],finish=Promise.withResolvers<void>();
 for(const [i,name] of ['extruder','bed'].entries()){
  const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,initialPower:0,defaultPower:0},reset(){const job=Promise.withResolvers<void>();resets[i].push(job);if(resets[i].length===1)job.resolve();return job.promise;},setPWM:async()=>{},stop:async cause=>{for(const job of resets[i])job.reject(cause);}},()=>({system:1,print:1}),{},()=>()=>{});group.register(name,runtime);
  // Sample only after group startup below.
  members.push(runtime);
 }
 await group.start();members[0].sample(1,220);members[1].sample(1,80);
 const dispatch=new GCodeDispatch({output(){},shutdown(){events.push('dispatch-stop');}});dispatch.register('G1',handler);
 const motion:FilePrintMotion={prepare:async()=>{events.push('prepare');dispatch.setReady(true);},start:async()=>{events.push('start');},pause:async()=>{events.push('pause');},resume:async()=>{events.push('resume');},finish:async()=>{events.push('drain');await finish.promise;events.push('drained');},stop:async()=>{events.push('stop');}};
 const device=new FilePrintDevice(motion,dispatch,async(id,signal)=>{assert.equal(id,'file');const source=await open(path,'r');try{return (await createSealedPrintReader(source,createHash('sha256').update(script).digest('hex'),signal,{batchLines:1})).reader;}finally{await source.close();}}),thermal=new ThermalPrintDevice(device,group,{nozzle:'extruder',bed:'bed'}),controller=new PrintController(thermal,{maxNozzle:300,maxBed:130});
 return {group,resets,events,finish,motion,device,thermal,controller,dispatch,path,async close(){finish.resolve();for(const list of resets)for(const reset of list)reset.resolve();await group.shutdown().catch(()=>{});await thermal.stop().catch(()=>{});await rm(directory,{recursive:true,force:true});}};
}
test('file EOF automatically completes only after motion drain and heater reset ACKs',async()=>{
 const f=await fixture();try{await f.controller.start(request);await until(()=>f.events.includes('drain'));assert.equal(f.controller.state,'finishing');assert.equal(f.device.status.file?.eof,true);assert.equal(f.resets[0].length,1);
 f.finish.resolve();await until(()=>f.resets[1].length===2);assert.equal(f.controller.state,'finishing');f.resets[0][1].resolve();f.resets[1][1].resolve();await until(()=>f.controller.state==='completed');assert.deepEqual(f.events.slice(0,4),['prepare','start','drain','drained']);}finally{await f.close();}
});
test('empty file EOF cannot bypass startup persistence boundary or lose completion event',async()=>{
 const f=await fixture('');try{await f.controller.start(request);await until(()=>f.events.includes('drain'));assert.equal(f.controller.state,'finishing');f.finish.resolve();await until(()=>f.resets[1].length===2);for(const resets of f.resets)resets[1].resolve();await until(()=>f.controller.state==='completed');}finally{await f.close();}
});
test('cancellation before EOF aborts command and never invokes normal finish',async()=>{
 const entered=Promise.withResolvers<void>();let moves=0;const f=await fixture('G1 X1\nG1 X2\n',command=>{moves++;entered.resolve();return new Promise((_resolve,reject)=>command.signal.addEventListener('abort',()=>reject(command.signal.reason),{once:true}));});
 try{await f.controller.start(request);await entered.promise;const cancel=f.controller.cancel();await until(()=>f.resets[1].length===2);for(const resets of f.resets)resets[1].resolve();await cancel;assert.equal(f.controller.state,'cancelled');assert.equal(moves,1);assert.equal(f.events.includes('drain'),false);assert.equal(f.device.status.file?.position,0);}finally{await f.close();}
});
test('script failure propagates to controller fault and initiates motion and heater stop',async()=>{
 const f=await fixture('G1 X1\n',()=>{throw new GCodeError('move refused');});try{await f.controller.start(request).catch(()=>{});await until(()=>f.controller.state==='failed');assert.match(String(f.controller.failure),/move refused/);await until(()=>f.resets[1].length===2);for(const resets of f.resets)resets[1].resolve();await f.controller.fault(new Error('later'));assert.ok(f.events.includes('stop'));assert.equal(f.events.includes('drain'),false);}finally{await f.close();}
});

test('EOF during pause is retained until resume completes',async()=>{
 let eof:(id:string)=>void=()=>{},finishes=0;
 const device:PrintDevice={subscribeEOF(listener){eof=listener;return ()=>{};},prepare:async()=>{},start:async()=>{},pause:async()=>{eof('job');},resume:async()=>{},finish:async()=>{finishes++;},stop:async()=>{}};
 const controller=new PrintController(device,{maxNozzle:300,maxBed:130});await controller.start(request);await controller.pause();assert.equal(controller.state,'paused');assert.equal(finishes,0);await controller.resume();await until(()=>controller.state==='completed');assert.equal(finishes,1);
});
test('EOF received before durable started acknowledgement waits for that transition',async()=>{
 let eof:(id:string)=>void=()=>{},finishes=0;const started=Promise.withResolvers<void>(),transitions:string[]=[];
 const device:PrintDevice={subscribeEOF(listener){eof=listener;return ()=>{};},prepare:async()=>{},start:async()=>{eof('job');},pause:async()=>{},resume:async()=>{},finish:async()=>{finishes++;},stop:async()=>{}};
 const journal={reserve:async()=>({created:true,record:{request,state:'reserved',revision:1}}),transition:async(_id:string,revision:number,state:string)=>{transitions.push(state);if(state==='started')await started.promise;return {request,state,revision:revision+1};}} as unknown as import('../src/operations/print-journal.ts').PrintJournal;
 const controller=new PrintController(device,{maxNozzle:300,maxBed:130},{},{journal}),starting=controller.start(request);await until(()=>transitions.includes('started'));assert.equal(controller.state,'preparing');assert.equal(finishes,0);started.resolve();await starting;await until(()=>controller.state==='completed');assert.deepEqual(transitions,['started','completed']);assert.equal(finishes,1);
});
test('late authorized reader returned after stop is closed and never prepared or started',async()=>{
 const f=await fixture(),acquired=Promise.withResolvers<GCodeFileReader>(),signal=new AbortController().signal;
 const device=new FilePrintDevice(f.motion,f.dispatch,()=>acquired.promise);
 try{const preparing=device.prepare(request,signal),rejected=assert.rejects(preparing,/invalidated/);await device.stop();const reader=await GCodeFileReader.adopt(await open(f.path,'r'));acquired.resolve(reader);await rejected;assert.equal(reader.status.closed,true);assert.equal(f.events.includes('prepare'),false);assert.equal(f.events.includes('start'),false);}finally{await f.close();}
});

test('failed controller subscription or restoration detaches prior device observers',async()=>{
 const listeners=new Set<(cause:unknown)=>void>();const device:PrintDevice={subscribeFault(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},subscribeEOF(){throw new Error('EOF bind failed');},prepare:async()=>{},start:async()=>{},pause:async()=>{},resume:async()=>{},finish:async()=>{},stop:async()=>{}};
 assert.throws(()=>new PrintController(device,{maxNozzle:300,maxBed:130}),/bind failed/);assert.equal(listeners.size,0);
 delete device.subscribeEOF;const journal={active:async()=>{throw new Error('journal unavailable');}} as unknown as import('../src/operations/print-journal.ts').PrintJournal;
 await assert.rejects(PrintController.restore(device,{maxNozzle:300,maxBed:130},{},{journal}),/journal unavailable/);assert.equal(listeners.size,0);
});

test('automatic completion failure remains observable and waits for safe stop',async()=>{
 const f=await fixture(),cause=new Error('motion drain failed');f.motion.finish=async()=>{throw cause;};
 try{await f.controller.start(request);await until(()=>f.controller.state==='failed');assert.equal(f.controller.failure,cause);await until(()=>f.resets[1].length===2);for(const resets of f.resets)resets[1].resolve();await assert.rejects(f.controller.complete('job'),cause);assert.ok(f.events.includes('stop'));}finally{await f.close();}
});
