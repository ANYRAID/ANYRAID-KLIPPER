import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {buildProductHost} from '../scripts/build-product-host.ts';
import {configuredPrinterFixture} from '../test/helpers/configured-printer.ts';
import {productTransports} from '../test/helpers/product-transports.ts';
import {FrameDecoder} from '../src/protocol/codec.ts';

// The child loads only emitted JS, bundled addons and installed dependencies.
// PTY firmware stays in the parent; all product operations cross authenticated HTTP.
test('compiled process uploads sealed file, prints, pauses/resumes, cancels and reinitializes without Python or TS loading',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'compiled-journey-')),app=join(dir,'app'),f=await configuredPrinterFixture(false,false);
 const transports:Awaited<ReturnType<typeof productTransports>>[]=[],timers=new Set<ReturnType<typeof setTimeout>>();
 const printerConfig=join(dir,'printer.cfg'),configPath=join(dir,'moonraker.conf'),manifest=join(dir,'machine.json'),trace=join(dir,'events.jsonl');
 let poll:ReturnType<typeof setInterval>|undefined,child:ReturnType<typeof spawn>|undefined,ended:Promise<{code:number|null;signal:NodeJS.Signals|null}>|undefined,watchdog:ReturnType<typeof setTimeout>|undefined,homed=0,stderr='',base='';
 const ready:Array<string>=[];
 async function nextTransport(){
  if(poll)clearInterval(poll);assert.equal(timers.size,0);const transport=await productTransports(f.reader);transports.push(transport);
  await writeFile(printerConfig,Object.entries(transport.reader.source.original).map(([section,options])=>'['+section+']\n'+Object.entries(options).map(([key,value])=>key+': '+value.replaceAll('\n','\n  ')).join('\n')).join('\n\n'));
  const firmware=transport.firmware[0],decoder=new FrameDecoder();let cursor=0;
  firmware.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk))for(const command of firmware.dictionary.parseFrame(frame))if(command.name==='trsync_start'&&command.parameters.report_ticks===0)firmware.setTriggerReason(2,Number(command.parameters.oid));});
  poll=setInterval(()=>{for(;cursor<firmware.outputs.length;cursor++){const entry=firmware.outputs[cursor],p=entry.parameters;if(entry.name!=='endstop_home'||!Number(p.sample_count))continue;const timer=setTimeout(()=>{timers.delete(timer);homed++;const clock=Number(p.clock),oid=Number(p.trsync_oid);firmware.setTriggerReason(1,oid);firmware.setEndstopState({homing:0,pin_value:0,next_clock:clock+Number(p.rest_ticks)},Number(p.oid));firmware.emit('trsync_state',{oid,can_trigger:0,trigger_reason:1,clock});},150);timers.add(timer);}},2);
  return transport;
 }
 try{
  await buildProductHost(app);await symlink(fileURLToPath(new URL('../node_modules',import.meta.url)),join(app,'node_modules'),'dir');
  await writeFile(configPath,'[server]\nhost=127.0.0.1\nport=0');const gcode=Array.from({length:1000},(_,i)=>`G1 X${(i+1)/100} F600\n`).join(''),sha256=createHash('sha256').update(gcode).digest('hex');
  const transport=await nextTransport(),{output:discardOutput,open:discardOpen,lifecycle:discardLifecycle,...print}=f.options.print;
  await writeFile(manifest,JSON.stringify({version:1,deviceId:'printer',printerConfig,moonrakerConfig:configPath,journalPath:join(dir,'jobs.db'),mcus:Object.fromEntries([...transport.policies].map(([id,{stopDevice,...policy}])=>[id,policy])),machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},hardware:{heaterGcodeIds:f.options.hardware.heaterGcodeIds},print,limits:{maxNozzle:300,maxBed:130}}));
  const profile=join(app,'machine.mjs');await writeFile(profile,`import {appendFile} from 'node:fs/promises';
import {loadProductMachineProfile} from './host/src/runtime/product-machine-profile.js';
import {PublishedPrintFiles} from './host/src/storage/published-files.js';
import {NativePrintUploads} from './host/src/moonraker/native-print-uploads.js';
import {ApiError} from './host/src/moonraker/rpc.js';
let generation=0;
const record=event=>appendFile(${JSON.stringify(trace)},JSON.stringify(event)+'\\n');
export async function createProductHostProfile(signal){const current=++generation;await record({event:'factory',generation:current});return loadProductMachineProfile(${JSON.stringify(manifest)},async(_config,_signal,gate)=>{const files=await PublishedPrintFiles.open(${JSON.stringify(join(dir,'files'))}),uploads=new NativePrintUploads(files,gate,{stagingRoot:${JSON.stringify(dir)}});return {stops:new Map(['mcu','aux'].map(id=>[id,async cause=>{await record({event:'stop',generation:current,id,cause:String(cause)});} ])),print:{output(){},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}},async open(id,signal){await record({event:'open',generation:current});return files.acquire(id,signal);}},server:{nativeUploads:uploads,information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'compiled-journey',missingRequirements:[]},authorize:(_m,_p,context)=>{if(context.request.headers['x-api-key']!=='test')throw new ApiError(401,'Denied');return {username:'operator'};}},async release(){await uploads.close();await files.close();await record({event:'released',generation:current});}};},signal);}
`);
  const env:NodeJS.ProcessEnv={...process.env,PATH:'/no-programs',NODE_OPTIONS:'--no-experimental-strip-types',NODE_DISABLE_COMPILE_CACHE:'1'};for(const key of Object.keys(env))if(key.startsWith('ANYRAID_')&&key.endsWith('_ADDON'))delete env[key];
  child=spawn(process.execPath,[join(app,'scripts/product-host.js'),'--profile',profile],{env,stdio:['ignore','pipe','pipe']});let unread='';
  child.stdout!.on('data',chunk=>{unread+=chunk;for(let at=unread.indexOf('\n');at>=0;at=unread.indexOf('\n')){const line=unread.slice(0,at);unread=unread.slice(at+1);try{const event=JSON.parse(line);if(event.event==='ready')ready.push(`http://127.0.0.1:${event.address.port}`);}catch{}}});child.stderr!.on('data',chunk=>{stderr+=chunk;});
  ended=new Promise((resolve,reject)=>{child!.once('error',reject);child!.once('exit',(code,signal)=>resolve({code,signal}));});void ended.catch(()=>{});
  watchdog=setTimeout(()=>child!.kill('SIGKILL'),45000);
  async function waitReady(count:number){const until=performance.now()+10000;while(ready.length<count){assert(child!.exitCode===null&&child!.signalCode===null,stderr);assert(performance.now()<until,'ready timeout: '+stderr);await delay(5);}base=ready[count-1];}
  const headers={'x-api-key':'test','content-type':'application/json'};
  async function get(path='/printer/print/status'){const response=await fetch(base+path,{headers,signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return (await response.json() as any).result;}
  async function post(action:string,params:unknown,authorized=true){const response=await fetch(base+'/printer/print/'+action,{method:'POST',headers:authorized?headers:{'content-type':'application/json'},body:JSON.stringify(params),signal:AbortSignal.timeout(10000)});return {code:response.status,body:await response.json() as any};}
  async function wait(state:string){const until=performance.now()+12000;for(;;){const current=await get();assert.notEqual(current.state,'failed',JSON.stringify(current)+' '+stderr);if(current.state===state)return current;assert(performance.now()<until,JSON.stringify(current));await delay(5);}}
  const request=(id:string)=>({version:1,request_id:id,file_id:'authorized-file',nozzle:0,bed:0,expires_at:Date.now()+60000});
  async function action(name:string,id:string){const current=await get(),result=await post(name,{request_id:id,state_token:current.state_token});assert.equal(result.code,200,JSON.stringify(result.body));}
  await waitReady(1);
  const multipart=()=>{const form=new FormData();form.append('file',new Blob([gcode]),'journey.gcode');form.append('file_id','authorized-file');form.append('checksum',sha256);return form;};
  const deniedUpload=await fetch(base+'/server/files/upload',{method:'POST',body:multipart()});assert.equal(deniedUpload.status,401);await deniedUpload.arrayBuffer();
  const uploaded=await fetch(base+'/server/files/upload',{method:'POST',headers:{'x-api-key':'test'},body:multipart()});assert.equal(uploaded.status,200);const receipt=(await uploaded.json() as any).result;assert.equal(receipt.file.sha256,sha256);assert.equal(receipt.print_started,false);assert.equal(receipt.print_queued,false);assert.equal((await get()).state,'idle');
  assert.equal((await get('/printer/files/info?file_id=authorized-file')).sha256,sha256);
  assert.equal((await post('start',request('complete'),false)).code,401);assert(transport.firmware.every(f=>f.motion.length===0));
  let result=await post('start',request('complete'));assert.equal(result.code,200,JSON.stringify(result.body));await wait('printing');await action('pause','complete');const paused=await wait('paused');await action('resume','complete');assert.equal((await post('resume',{request_id:'complete',state_token:paused.state_token})).code,409);await wait('completed');
  assert.equal((await get('/printer/print/status?request_id=complete')).record.state,'completed');assert.equal(homed,3);assert(transport.firmware[0].motion.some(m=>m.name==='queue_step'));
  const objects=(await get('/printer/objects/query?toolhead=position&virtual_sdcard')).status;assert.deepEqual(objects.toolhead.position,[10,0,0,0]);assert.equal(objects.virtual_sdcard.is_active,false);
  await action('reset','complete');result=await post('start',request('cancel'));assert.equal(result.code,200,JSON.stringify(result.body));await wait('printing');await action('cancel','cancel');await wait('cancelled');assert.equal((await get('/printer/print/status?request_id=cancel')).record.state,'cancelled');assert.equal((await get('/server/info')).native_host.ready,false);
  const next=await nextTransport();child.kill('SIGHUP');await waitReady(2);assert.equal((await get()).state,'idle');assert.equal((await get('/printer/files/info?file_id=authorized-file')).sha256,sha256);assert.equal((await get('/printer/print/status?request_id=cancel')).record.state,'cancelled');assert(next.firmware.every(f=>f.motion.length===0));
  result=await post('start',request('fresh'));assert.equal(result.code,200,JSON.stringify(result.body));await wait('completed');assert.equal(homed,9);assert.equal((await get('/printer/print/status?request_id=fresh')).record.state,'completed');
  child.kill('SIGTERM');assert.deepEqual(await ended,{code:0,signal:null});
  const events=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(events.filter(e=>e.event==='open').length,3);assert.equal(events.filter(e=>e.event==='factory').length,2);assert(events.findIndex(e=>e.event==='released'&&e.generation===1)<events.findIndex(e=>e.event==='factory'&&e.generation===2));assert.equal(events.filter(e=>e.event==='released').length,2);assert.equal(events.filter(e=>e.event==='stop').length,4);
 }finally{if(watchdog)clearTimeout(watchdog);if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended?.catch(()=>{});if(poll)clearInterval(poll);for(const timer of timers)clearTimeout(timer);for(const transport of transports)await transport.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
