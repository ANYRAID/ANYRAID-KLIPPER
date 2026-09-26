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
const profiles=new Map<string,Awaited<ReturnType<typeof productHostFixture>>>();
export async function journeyProfile(id:string){return profiles.get(id)!.profile;}
test('host CLI HTTP journey homes, prints, pauses, resumes, completes, resets and cancels the next durable job', {timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-journey-')),f=await productHostFixture(dir),abort=new AbortController(),ready=Promise.withResolvers<string>();
 const timers=new Set<ReturnType<typeof setTimeout>>();let cursor=0,homed=0,opened=0;
 const path=join(dir,'job.gcode');await writeFile(path,Array.from({length:1000},(_,i)=>`G1 X${(i+1)/100} F600\n`).join(''));
 f.profile.options.print.open=async(request)=>{assert.equal(request,'authorized-file');opened++;return GCodeFileReader.adopt(await open(path,'r'));};
 // Emulate endstop hardware responses at the commanded clock. The real native
 // homing machinery, transport, queues and acknowledgement path remain active.
 const firmware=f.transport.firmware[0],decoder=new FrameDecoder();
 firmware.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk))for(const command of firmware.dictionary.parseFrame(frame)){
  if(command.name==='trsync_start'&&command.parameters.report_ticks===0)firmware.setTriggerReason(2,Number(command.parameters.oid));
 }});
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
 profiles.set(dir,f);const module=join(dir,'machine.mjs');await writeFile(module,`import {journeyProfile} from ${JSON.stringify(import.meta.url)};export const createProductHostProfile=()=>journeyProfile(${JSON.stringify(dir)});`);
 let hostFailure:unknown;
 const running=runProductHostCLI(['--profile',module],abort.signal,line=>{const event=JSON.parse(line);if(event.event==='ready')ready.resolve(`http://127.0.0.1:${event.address.port}`);});
 void running.catch(error=>{hostFailure=error;ready.reject(error);});
 try{
  const base=await ready.promise,headers={'x-api-key':'test','content-type':'application/json'};
  const get=async()=>{const response=await fetch(base+'/printer/print/status',{headers});assert.equal(response.status,200);return (await response.json() as any).result;};
  const post=async(action:string,params:unknown,authorized=true)=>{const response=await fetch(base+'/printer/print/'+action,{method:'POST',headers:authorized?headers:{'content-type':'application/json'},body:JSON.stringify(params)});return {code:response.status,body:await response.json() as any};};
  const wait=async(state:string)=>{const until=performance.now()+12000;for(;;){const current=await get();assert.notEqual(current.state,'failed',JSON.stringify(current));if(current.state===state)return current;assert(performance.now()<until,`waiting for ${state}: ${JSON.stringify(current)}`);await delay(5);}};
  const request=(id:string)=>({version:1,request_id:id,file_id:'authorized-file',nozzle:0,bed:0,expires_at:Date.now()+60000});
  const start=request('complete');assert.equal((await post('start',start,false)).code,401);assert.equal(opened,0);assert.equal(firmware.motion.length,0);
  const accepted=await post('start',start);assert.equal(accepted.code,200,JSON.stringify(accepted.body));await wait('printing');
  let current=await get();const pause={request_id:'complete',state_token:current.state_token};let result=await post('pause',pause);assert.equal(result.code,200,JSON.stringify(result.body));current=await wait('paused');
  assert.equal((await post('resume',pause)).code,409);result=await post('resume',{request_id:'complete',state_token:current.state_token});assert.equal(result.code,200,JSON.stringify(result.body));await wait('completed');
  assert.equal((await f.journal.get('complete'))?.state,'completed');assert.equal(homed,3);assert.equal(opened,1);assert(firmware.motion.some(m=>m.name==='queue_step'));
  const query=await fetch(base+'/printer/objects/query?toolhead=position&virtual_sdcard',{headers}),objects=(await query.json() as any).result.status;
  assert.deepEqual(objects.toolhead.position,[10,0,0,0]);assert.equal(objects.virtual_sdcard.is_active,false);
  current=await get();assert.equal((await post('reset',{request_id:'complete',state_token:current.state_token})).code,200);assert.equal((await get()).state,'idle');
  result=await post('start',request('cancel'));assert.equal(result.code,200,JSON.stringify(result.body));await wait('printing');current=await get();result=await post('cancel',{request_id:'cancel',state_token:current.state_token});assert.equal(result.code,200,JSON.stringify(result.body));await wait('cancelled');assert.equal((await f.journal.get('cancel'))?.state,'cancelled');
  abort.abort();await running;assert(f.released);assert.deepEqual(f.transport.stops,[1,1]);await assert.rejects(fetch(base+'/printer/print/status'));
 }catch(error){if(hostFailure)throw new AggregateError([hostFailure,error],'Host journey failed');throw error;}finally{abort.abort();await running.catch(()=>{});clearInterval(timer);for(const task of timers)clearTimeout(task);profiles.delete(dir);await f.profile.release();await rm(dir,{recursive:true,force:true});}
});
