import {AUTOSAVE_HEADER} from '../src/config/klipper-autosave.ts';
import {readNativeBedMesh} from '../src/config/native-bed-mesh.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {parseProductMachine} from '../src/config/product-machine.ts';
import {readProductMachine,loadProductMachineProfile} from '../src/runtime/product-machine-profile.ts';
import {runProductHost} from '../src/runtime/product-host.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {productMachineFixture} from './helpers/product-machine.ts';
const signal=()=>new AbortController().signal;
test('machine configuration rejects unknown, nonfinite, ambiguous and out-of-range policy without changing numeric data',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'machine-schema-')),f=await productMachineFixture(dir);try{
  const source=JSON.parse(JSON.stringify(f.config));source.print.parking.parkXY=[1.005,-1e-9];source.print.homingTimeoutMs=120000;const parsed=parseProductMachine(source);assert.deepEqual(parsed,source);source.print.parking.parkXY[0]=123;assert.equal(parsed.print.parking.parkXY[0],1.005);
  for(const alter of [(c:any)=>c.version=2,(c:any)=>c.extra=true,(c:any)=>c.printerConfig='relative',(c:any)=>c.mcus.mcu.rts='true',(c:any)=>c.mcus.mcu.nodeId=1,(c:any)=>c.print.parking.travelSpeed=0,(c:any)=>c.print.parking.lift=Infinity,(c:any)=>c.print.startupHoming.axes=[0,0],(c:any)=>c.deadlines={startMs:0},(c:any)=>c.hardware={beforeTarget:'code'},(c:any)=>c.limits.maxNozzle=NaN,(c:any)=>c.print.homingTimeoutMs=3600001]){const bad=JSON.parse(JSON.stringify(f.config));alter(bad);assert.throws(()=>parseProductMachine(bad),/Invalid product machine/);}
  const can=JSON.parse(JSON.stringify(f.config));can.mcus.mcu={transport:'can',nodeId:255,timeoutMs:60000};assert.equal(parseProductMachine(can).mcus.mcu.transport,'can');can.mcus.mcu.nodeId=256;assert.throws(()=>parseProductMachine(can));
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
test('machine data reads are bounded, UTF-8 strict, abortable and do not block on FIFOs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'machine-read-'));try{
  await assert.rejects(readProductMachine(dir,signal()),/regular file/);const path=join(dir,'config');await writeFile(path,Buffer.alloc(65537,32));await assert.rejects(readProductMachine(path,signal()),/65536/);
  await writeFile(path,Buffer.from([0xff]));await assert.rejects(readProductMachine(path,signal()));await assert.rejects(readProductMachine(path,AbortSignal.abort(new Error('cancelled'))),/cancelled/);
  // Only the Node/native process is instrumented. Do not preload its ASan
  // runtime into the unrelated system utility (same boundary as the PTY build).
  const utilityEnv={...process.env};delete utilityEnv.LD_PRELOAD;delete utilityEnv.ASAN_OPTIONS;
  const fifo=join(dir,'fifo');execFileSync('mkfifo',[fifo],{env:utilityEnv});await assert.rejects(readProductMachine(fifo,signal()),/regular file/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('profile preflight rejects topology and network errors before adapter or journal acquisition',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'machine-preflight-')),f=await productMachineFixture(dir);let factories=0;try{
  const factory=async()=>{factories++;return f.bindings;};const bad=structuredClone(f.config);delete bad.mcus.aux;await writeFile(f.path,JSON.stringify(bad));await assert.rejects(loadProductMachineProfile(f.path,factory,signal()),/cover every/);
  await writeFile(f.path,JSON.stringify(f.config));await writeFile(f.config.moonrakerConfig,'[server]\nport=99999');await assert.rejects(loadProductMachineProfile(f.path,factory,signal()));assert.equal(factories,0);await assert.rejects(access(f.config.journalPath));assert.deepEqual(f.transport.stops,[0,0]);
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
test('profile snapshots declarations, shares the maintenance gate and owns journal cleanup exactly once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'machine-profile-')),f=await productMachineFixture(dir);try{
  let gate:unknown;const p=await loadProductMachineProfile(f.path,async(config,_signal,shared)=>{gate=shared;config.limits.maxNozzle=1;config.print.parking.parkXY=[99,99];return {...f.bindings,print:{...f.bindings.print,motorCompletion:'release'} as any};},signal());
  assert.equal(p.product.limits.maxNozzle,300);assert.deepEqual(p.options.print.parking.parkXY,[0,0]);assert.equal(p.options.print.motorCompletion,'hold');assert.equal(p.product.maintenanceGate,gate);assert.deepEqual(f.transport.stops,[0,0]);
  await p.product.journal.reserve({version:1,requestId:'persist',fileId:'file',nozzle:0,bed:0});const a=p.release(),b=p.release();assert.equal(a,b);await a;assert.equal(f.releases,1);assert(p.product.maintenanceGate.status.closed);await assert.rejects(p.product.journal.get('persist'));
  const restored=await PrintJournal.open({path:f.config.journalPath,deviceId:'printer'});try{assert.equal((await restored.get('persist'))?.state,'interrupted');}finally{await restored.close();}
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
test('late cancellation and invalid bindings release transferred resources before rejecting',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'machine-cancel-')),f=await productMachineFixture(dir);try{
  const abort=new AbortController();await assert.rejects(loadProductMachineProfile(f.path,async()=>{abort.abort(new Error('late'));return f.bindings;},abort.signal),/late/);assert.equal(f.releases,1);
  await assert.rejects(loadProductMachineProfile(f.path,async()=>({...f.bindings,stops:new Map()}),signal()),/Incomplete/);assert.equal(f.releases,2);await assert.rejects(access(f.config.journalPath));assert.deepEqual(f.transport.stops,[0,0]);
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
test('journal acquisition failure retains both assembly and adapter cleanup errors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'machine-fail-')),f=await productMachineFixture(dir);try{
  await writeFile(f.path,JSON.stringify({...f.config,journalPath:dir}));let cleaned=0;await assert.rejects(loadProductMachineProfile(f.path,async()=>({...f.bindings,async release(){cleaned++;throw new Error('adapter cleanup');}}),signal()),(e:unknown)=>e instanceof AggregateError&&e.errors.length===2&&String(e.errors[1]).includes('adapter cleanup'));assert.equal(cleaned,1);assert.deepEqual(f.transport.stops,[0,0]);
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
test('file-backed machine profile runs authenticated native service and retires both UARTs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'machine-host-')),f=await productMachineFixture(dir),abort=new AbortController();let observed:Promise<void>|undefined;try{
  await runProductHost(s=>loadProductMachineProfile(f.path,async()=>({...f.bindings,server:{...f.bindings.server,authorize:(_m,_p,c)=>{assert.equal(c.request.headers['x-api-key'],'test');}}}),s),abort.signal,address=>{observed=(async()=>{try{const response=await fetch(`http://127.0.0.1:${address.port}/printer/print/status`,{headers:{'x-api-key':'test'}});assert.equal(response.status,200);assert.equal((await response.json() as any).result.state,'idle');}finally{abort.abort(new Error('done'));}})();});await observed;assert.equal(f.releases,1);assert.deepEqual(f.transport.stops,[1,1]);assert(f.transport.firmware.every(f=>f.motion.length===0));
 }finally{abort.abort();await f.close();await rm(dir,{recursive:true,force:true});}
});

test('product profile reads saved calibration with ordinary precedence and rejects corrupt autosave before acquisition',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'machine-autosave-')),f=await productMachineFixture(dir);let factories=0;
 try{
  const regular=await readFile(f.config.printerConfig,'utf8'),saved='[printer]\nmax_velocity: 999\n[bed_mesh saved]\nversion: 1\nmin_x: 0\nmax_x: 100\nmin_y: 0\nmax_y: 100\nx_count: 2\ny_count: 2\nmesh_x_pps: 0\nmesh_y_pps: 0\nalgo: direct\ntension: .2\npoints: .123456789012345,.2\n  .3,.4\n';
  await writeFile(f.config.printerConfig,regular+'\n[bed_mesh]\n'+AUTOSAVE_HEADER+saved.trimEnd().split('\n').map(l=>'#*# '+l).join('\n')+'\n');
  const p=await loadProductMachineProfile(f.path,async()=>{factories++;return f.bindings;},signal());
  try{assert.equal(p.reader.section('printer').getFloat('max_velocity'),100);assert.deepEqual(Array.from(readNativeBedMesh(p.reader)!.profiles.load('saved').probedValues()),[.123456789012345,.2,.3,.4]);}finally{await p.release();}
  await writeFile(f.config.printerConfig,regular+AUTOSAVE_HEADER+'modified tail\n');await assert.rejects(loadProductMachineProfile(f.path,async()=>{factories++;return f.bindings;},signal()),/Corrupt/);assert.equal(factories,1);assert.deepEqual(f.transport.stops,[0,0]);
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
