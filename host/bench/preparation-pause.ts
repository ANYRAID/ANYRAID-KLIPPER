import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectAcceptanceBundle,assertAcceptanceBundleUnchanged} from '../test/helpers/acceptance-bundle.ts';
// Two independently installed compiled packages; no shared source import.
const paths=process.argv.slice(2);assert.equal(paths.length,2);assert(paths.every(isAbsolute));assert.notEqual(paths[0],paths[1]);
const bundles=await Promise.all(paths.map(inspectAcceptanceBundle));
assert.equal(bundles[0]!.dependenciesSha256,bundles[1]!.dependenciesSha256);
const dir=await mkdtemp(join(tmpdir(),'prepared-pause-bench-'));
const owners:any[]=[],times:number[][]=[[],[]],controls:number[][]=[[],[]];
const statusIterations=100000,controlCycles=10000;let checksum=0;
try{
 for(const [index,path] of paths.entries()){
  const load=(file:string)=>import(pathToFileURL(join(path,'host/src',file+'.js')).href);
  const [{PrintController},{PrintJournal},{MaintenanceGate},{ProductPrintApi}]=await Promise.all(['operations/print','operations/print-journal','operations/maintenance-gate','moonraker/product-print-api'].map(load));
  const journal=await PrintJournal.open({path:join(dir,index+'.sqlite'),deviceId:'bench'}),gate=new MaintenanceGate();
  let pauses=0,resumes=0;
  const device={async prepare(){},async start(){},async pause(){pauses++;},async resume(){resumes++;},async finish(){},async stop(){}};
  const controller=new PrintController(device,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});
  const api=new ProductPrintApi(controller,gate);owners.push({controller,api,journal,count:()=>({pauses,resumes})});
  await controller.start({version:1,requestId:'bench',fileId:'file',nozzle:0,bed:0});
 }
 for(let run=0;run<14;run++)for(const index of run%2?[1,0]:[0,1]){
  const owner=owners[index],begin=performance.now();
  for(let i=0;i<statusIterations;i++)checksum+=JSON.stringify(owner.api.status).length;
  if(run>=3)times[index]!.push((performance.now()-begin)*1000/statusIterations);
 }
 for(let run=0;run<9;run++)for(const index of run%2?[1,0]:[0,1]){
  const owner=owners[index],begin=performance.now();
  for(let i=0;i<controlCycles;i++){await owner.controller.pause();await owner.controller.resume();}
  if(run>=2)controls[index]!.push((performance.now()-begin)*1000/(controlCycles*2));
 }
 const stats=(samples:number[])=>{const sorted=[...samples].sort((a,b)=>a-b);return {medianUs:sorted[Math.floor(sorted.length/2)]!,p95Us:sorted[Math.floor(sorted.length*.95)]!,samplesUs:samples};};
 const status=times.map(stats),control=controls.map(stats);
 for(const owner of owners){assert.deepEqual(owner.count(),{pauses:90000,resumes:90000});assert.equal(owner.controller.state,'printing');}
 assert.equal(owners[1].api.status.pause_pending,false);assert.equal(owners[1].api.status.paused_before_file,false);assert(checksum>0);
 console.log(JSON.stringify({node:process.version,bundles,alternatingOrder:true,status:{iterations:statusIterations,warmups:3,runs:11,results:status,maximumAddedP95Us:5},controls:{cycles:controlCycles,warmups:2,runs:7,results:control},checksum,scope:'Compiled ProductPrintApi status plus JSON serialization and acknowledged mock-device ordinary pause/resume throughput; two durable owners, no per-control journal writes. Excludes network, physical MCU, heating and target-board speed.'}));
 assert(status[1]!.p95Us-status[0]!.p95Us<5);
}finally{
 for(const owner of owners){await owner.api.close();await owner.controller.retire();await owner.journal.close();}
 await rm(dir,{recursive:true,force:true});for(const bundle of bundles)await assertAcceptanceBundleUnchanged(bundle);
}
