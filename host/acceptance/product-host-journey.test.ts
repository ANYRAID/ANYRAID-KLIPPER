import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import type {ProductHostProfile} from '../src/runtime/product-host.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {runProductHostCLI} from '../src/runtime/product-host-cli.ts';
import {FrameDecoder} from '../src/protocol/codec.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {productHostFixture} from '../test/helpers/product-host-profile.ts';

// The profile is imported by the real CLI. Only the test harness supplies it;
// HTTP handlers and host ownership are exercised without controller shortcuts.
const profiles=new Map<string,()=>Promise<ProductHostProfile>>();
export async function journeyProfile(id:string){return profiles.get(id)!();}
test('host CLI HTTP journey homes, prints, pauses, resumes, completes, cancels, reinitializes and prints a fresh durable job', {timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-journey-')),abort=new AbortController(),ready=Promise.withResolvers<string>(),control=new ProductHostControl();let f=await productHostFixture(dir),base='',deviceFailure:unknown;
 const observeStop=()=>{for(const policy of f.profile.policies.values()){const stop=policy.stopDevice;policy.stopDevice=async cause=>{deviceFailure=cause;await stop(cause);};}};observeStop();
 const timers=new Set<ReturnType<typeof setTimeout>>();let cursor=0,homed=0,opened=0;
 const path=join(dir,'job.gcode');await writeFile(path,Array.from({length:1000},(_,i)=>`G1 X${(i+1)/100} F600\n`).join(''));
 const openFile:typeof f.profile.options.print.open=async(request)=>{assert.equal(request,'authorized-file');opened++;return GCodeFileReader.adopt(await open(path,'r'));};f.profile.options.print.open=openFile;
 // Emulate endstop hardware responses at the commanded clock. The real native
 // homing machinery, transport, queues and acknowledgement path remain active.
 let firmware=f.transport.firmware[0];
 const observe=(firmware:typeof f.transport.firmware[0])=>{const decoder=new FrameDecoder();firmware.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk))for(const command of firmware.dictionary.parseFrame(frame)){
  if(command.name==='trsync_start'&&command.parameters.report_ticks===0)firmware.setTriggerReason(2,Number(command.parameters.oid));
 }});};observe(firmware);
 const timer=setInterval(()=>{
  for(;cursor<firmware.outputs.length;cursor++){
   const entry=firmware.outputs[cursor],p=entry.parameters;
   if(entry.name!=='endstop_home'||!Number(p.sample_count))continue;
   const task=setTimeout(()=>{timers.delete(task);homed++;const clock=Number(p.clock),oid=Number(p.trsync_oid);
    firmware.setTriggerReason(1,oid);firmware.setEndstopState({homing:0,pin_value:0,next_clock:clock+Number(p.rest_ticks)},Number(p.oid));
    firmware.emit('trsync_state',{oid,can_trigger:0,trigger_reason:1,clock});
   },150);timers.add(task);
  }
 },2);
 let first=true;profiles.set(dir,async()=>{if(first){first=false;return f.profile;}assert(f.released,'old profile must retire before creating its successor');assert.equal(timers.size,0);f=await productHostFixture(dir);deviceFailure=undefined;observeStop();f.profile.options.print.open=openFile;firmware=f.transport.firmware[0];cursor=0;observe(firmware);return f.profile;});const module=join(dir,'machine.mjs');await writeFile(module,`import {journeyProfile} from ${JSON.stringify(import.meta.url)};export const createProductHostProfile=()=>journeyProfile(${JSON.stringify(dir)});`);
 let hostFailure:unknown;
 const running=runProductHostCLI(['--profile',module],abort.signal,line=>{const event=JSON.parse(line);if(event.event==='ready'){base=`http://127.0.0.1:${event.address.port}`;ready.resolve(base);}},control);
 void running.catch(error=>{hostFailure=error;ready.reject(error);});
 try{
  await ready.promise;const headers={'x-api-key':'test','content-type':'application/json'};
  const get=async()=>{const response=await fetch(base+'/printer/print/status',{headers});assert.equal(response.status,200);return (await response.json() as any).result;};
  const post=async(action:string,params:unknown,authorized=true)=>{const response=await fetch(base+'/printer/print/'+action,{method:'POST',headers:authorized?headers:{'content-type':'application/json'},body:JSON.stringify(params)});return {code:response.status,body:await response.json() as any};};
  const wait=async(state:string)=>{const until=performance.now()+12000;for(;;){const current=await get();if(current.state==='failed'&&deviceFailure)throw deviceFailure;assert.notEqual(current.state,'failed',JSON.stringify(current));if(current.state===state)return current;assert(performance.now()<until,`waiting for ${state}: ${JSON.stringify(current)}`);await delay(5);}};
  const request=(id:string)=>({version:1,request_id:id,file_id:'authorized-file',nozzle:0,bed:0,expires_at:Date.now()+60000});
  const start=request('complete');assert.equal((await post('start',start,false)).code,401);assert.equal(opened,0);assert.equal(firmware.motion.length,0);
  const accepted=await post('start',start);assert.equal(accepted.code,200,JSON.stringify(accepted.body));await wait('printing');await assert.rejects(control.reinitialize(),/quiescent/);
  let current=await get();const pause={request_id:'complete',state_token:current.state_token};let result=await post('pause',pause);assert.equal(result.code,200,JSON.stringify(result.body));current=await wait('paused');
  assert.equal((await post('resume',pause)).code,409);result=await post('resume',{request_id:'complete',state_token:current.state_token});assert.equal(result.code,200,JSON.stringify(result.body));await wait('completed');
  assert.equal((await f.journal.get('complete'))?.state,'completed');assert.equal(homed,3);assert.equal(opened,1);assert(firmware.motion.some(m=>m.name==='queue_step'));
  const query=await fetch(base+'/printer/objects/query?toolhead=position&virtual_sdcard',{headers}),objects=(await query.json() as any).result.status;
  assert.deepEqual(objects.toolhead.position,[10,0,0,0]);assert.equal(objects.virtual_sdcard.is_active,false);
  current=await get();assert.equal((await post('reset',{request_id:'complete',state_token:current.state_token})).code,200);assert.equal((await get()).state,'idle');
  result=await post('start',request('cancel'));assert.equal(result.code,200,JSON.stringify(result.body));await wait('printing');current=await get();result=await post('cancel',{request_id:'cancel',state_token:current.state_token});assert.equal(result.code,200,JSON.stringify(result.body));await wait('cancelled');assert.equal((await f.journal.get('cancel'))?.state,'cancelled');
  const stoppedInfo=await fetch(base+'/server/info',{headers});assert.equal(stoppedInfo.status,200);assert.equal((await stoppedInfo.json() as any).result.native_host.ready,false);
  const cancelledRecord=await fetch(base+'/printer/print/status?request_id=cancel',{headers});assert.equal(cancelledRecord.status,200);assert.equal((await cancelledRecord.json() as any).result.record.state,'cancelled');
  current=await get();assert.equal((await post('reset',{request_id:'cancel',state_token:current.state_token})).code,200);
  const stepsBefore=firmware.motion.length;assert.equal((await post('start',request('requires-reinitialization'))).code,409);assert.equal(firmware.motion.length,stepsBefore);assert.equal(opened,2);
  await control.reinitialize();assert.equal(opened,2);assert.equal(firmware.motion.length,0);assert.equal((await get()).state,'idle');
  const restored=await fetch(base+'/printer/print/status?request_id=cancel',{headers});assert.equal((await restored.json() as any).result.record.state,'cancelled');
  result=await post('start',request('after-reinitialize'));assert.equal(result.code,200,JSON.stringify(result.body));await wait('completed');assert.equal(opened,3);assert.equal(homed,9);assert.equal((await f.journal.get('after-reinitialize'))?.state,'completed');
  // Exercise owner termination while motion is active, not only idle cleanup.
  current=await get();assert.equal((await post('reset',{request_id:'after-reinitialize',state_token:current.state_token})).code,200);
  result=await post('start',request('shutdown-active'));assert.equal(result.code,200,JSON.stringify(result.body));await wait('printing');
  const shutdownStart=performance.now();abort.abort(new Error('Product host termination requested'));await running;
  assert(performance.now()-shutdownStart<5000,'active print shutdown exceeded five seconds');
  assert(f.released);assert.deepEqual(f.transport.stops,[1,1]);await assert.rejects(fetch(base+'/printer/print/status'));
  // Reopen the on-disk journal after all resource owners have released it.
  // A successful shutdown must not leave a resumable or apparently active job.
  const shutdownJournal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'});
  try{assert.equal((await shutdownJournal.get('shutdown-active'))?.state,'cancelled');assert.equal((await shutdownJournal.get('after-reinitialize'))?.state,'completed');}
  finally{await shutdownJournal.close();}
 }catch(error){if(hostFailure)throw new AggregateError([hostFailure,error],'Host journey failed');throw error;}finally{abort.abort();await running.catch(()=>{});clearInterval(timer);for(const task of timers)clearTimeout(task);profiles.delete(dir);await f.profile.release();await rm(dir,{recursive:true,force:true});}
});
