// Real Linux SocketCAN integration, confined to a disposable user/net namespace.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readlinkSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
import {connectCAN} from '../src/protocol/can.ts';
import {mcuDumpChunks,serialMcuDumpReader} from '../src/diagnostics/mcu-dump.ts';
import {NativeSerialQueue,type SerialEvent} from '../src/protocol/serial-queue.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
import {openCanDiscovery,queryCanDevices} from '../src/diagnostics/can-query.ts';
const script=fileURLToPath(import.meta.url),host=fileURLToPath(new URL('..',import.meta.url));
function utilityEnv(){const env={...process.env};delete env.LD_PRELOAD;delete env.ASAN_OPTIONS;return env;}
function command(name:string,args:string[]){const r=spawnSync(name,args,{encoding:'utf8',timeout:30000,env:name===process.execPath?process.env:utilityEnv()});assert.equal(r.status,0,r.stderr.slice(0,4000)||String(r.error||r.signal));return r.stdout;}
async function inside(peer:string,serialPeer:string,firmwareBridge:string){
 // Refuse interface changes unless both namespaces differ from the invoking host.
 assert.notEqual(readlinkSync('/proc/self/ns/net'),process.env.CAN_TEST_PARENT_NET);
 assert.notEqual(readlinkSync('/proc/self/ns/user'),process.env.CAN_TEST_PARENT_USER);
 assert.ok(process.env.CAN_TEST_PARENT_NET&&process.env.CAN_TEST_PARENT_USER);
 command('ip',['link','add','dev','vcan-test','type','vcan']);command('ip',['link','set','dev','vcan-test','up']);
 async function withPeer(run:()=>Promise<void>,executable=peer,args:string[]=[]){
  const child=spawn(executable,args,{stdio:['ignore','pipe','pipe'],env:utilityEnv()});let stderr='';child.stderr.on('data',b=>stderr+=b);
  const ended=new Promise<number|null>((res,rej)=>{child.once('error',rej);child.once('close',res);});void ended.catch(()=>{});
  try{await new Promise<void>((res,rej)=>{let text='';const timer=setTimeout(()=>rej(new Error('Peer readiness timeout')),5000);child.stdout.on('data',b=>{text+=b;if(text.includes('READY\n')){clearTimeout(timer);res();}});void ended.then(()=>{clearTimeout(timer);rej(new Error('Peer exited before ready: '+stderr));},rej);});await run();assert.equal(await ended,0,stderr);}catch(error){throw new Error(`Peer exit=${child.exitCode}: ${stderr}`,{cause:error});}finally{if(child.exitCode===null)child.kill('SIGKILL');await ended;}
 }
 const native=createRequire(import.meta.url)(process.env.ANYRAID_CAN_QUERY_ADDON??'../build/can-query.node');
 await withPeer(async()=>{
  const h=native.open('vcan-test');try{native.sendQuery(h);assert.throws(()=>native.sendQuery(h),/already sent/);const frames=[];const deadline=performance.now()+300;while(performance.now()<deadline){let frame;while((frame=native.read(h))!==null)frames.push(frame);await delay(2);}assert.equal(frames.length,6,'kernel must exclude wrong ID, extended and RTR frames');assert.ok(frames.every(f=>f.id===0x3f1));assert.deepEqual([...frames[0].data],[32,0,0,0,0,0,0]);}finally{native.close(h);native.close(h);}assert.throws(()=>native.read(h),/closed/);
 });
 await withPeer(async()=>{
  const output=command(process.execPath,[resolve(host,'../scripts/canbus_query.ts'),'vcan-test']);
  assert.equal(output,'Found canbus_uuid=000000000000, Application: Klipper\nFound canbus_uuid=ffffffffffff, Application: CanBoot\nFound canbus_uuid=11aa22bb33cc, Application: Unknown\nTotal 3 uuids found\n');
 });
 const serialNative=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../build/serialqueue.node');
 const payload=Uint8Array.from({length:59},(_,i)=>i),response=encodeFrame(2,Uint8Array.from({length:30},(_,i)=>i+50));
 await withPeer(async()=>{
  const fd=serialNative.openCAN('vcan-test',0x180);let queue:NativeSerialQueue|undefined;
  try{assert.throws(()=>new NativeSerialQueue(fd),/explicit CAN client ID/);queue=new NativeSerialQueue(fd,0x180);queue.configure(1000000,256);const events:SerialEvent[]=[];let fault:unknown;queue.watch(()=>{let event;while((event=queue!.pull()))events.push(event);},e=>fault=e);const id=queue.send(payload);const deadline=performance.now()+3000;
   while(!events.some(e=>e.notifyId===id)){if(fault)throw fault;assert.ok(performance.now()<deadline,'CAN serial ACK timeout: '+queue.stats+' events='+JSON.stringify(events,(_k,v)=>typeof v==='bigint'?String(v):v));await delay(2);}
   assert.deepEqual(Uint8Array.from(events.find(e=>e.data.length)!.data),response);assert.equal(events.filter(e=>e.notifyId===id).length,1);assert.ok(events.every(e=>e.receiveTime>=e.sentTime));
  }finally{queue?.close();closeSync(fd);}
 },serialPeer,[Buffer.from(encodeFrame(1,payload)).toString('hex'),Buffer.concat([Buffer.from(response),Buffer.from(encodeFrame(2,new Uint8Array()))]).toString('hex')]);
 for(const mode of ['match','uuid','node','cancel','timeout'] as const){
  const bridge=spawn(firmwareBridge,[],{stdio:['pipe','pipe','pipe'],env:utilityEnv()});let diagnostic='';bridge.stderr.on('data',b=>diagnostic+=b);bridge.stdin.on('error',()=>{});
  const ended=new Promise<number|null>((resolve,reject)=>{bridge.once('error',reject);bridge.once('close',resolve);});void ended.catch(()=>{});
  const firmware=await serialFirmware({fd:-1,peer:{on(_event:'data',callback:(chunk:Buffer|string)=>void){bridge.stdout.on('data',callback);},write(data:Uint8Array){return bridge.stdin.write(data);}},async close(){bridge.stdin.end();const timer=setTimeout(()=>bridge.kill('SIGKILL'),3000);try{assert.equal(await ended,0,diagnostic);}finally{clearTimeout(timer);}}},{canIdentity:{uuid:mode==='uuid'?'000000000000':'11aa22bb33cc',nodeId:mode==='node'?65:64},debugRead:()=>0xfedcba98});
  let stops=0;const cancellation=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const deadline=performance.now()+3000;while(!diagnostic.includes('READY\n')){assert.ok(performance.now()<deadline);await delay(1);}
   if(mode==='cancel'||mode==='timeout')firmware.ignore('identify');
   if(mode==='cancel'){timer=setTimeout(()=>cancellation.abort(new Error('CAN bootstrap cancelled')),30);}
   const connecting=connectCAN('vcan-test','11aa22bb33cc',{async stopDevice(){stops++;},timeoutMs:mode==='timeout'?30:60000},cancellation.signal);
   if(mode==='match'){const session=await connecting;try{assert.equal(session.status.state,'ready');assert.equal(session.status.configured,false);session.clock.assertActive();const chunks=[];for await(const chunk of mcuDumpChunks(serialMcuDumpReader(session),{start:0xfffffff8,length:8},new AbortController().signal))chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),Buffer.from('98badcfe98badcfe','hex'));const payload=session.dictionary.encode('get_canbus_id',{}),admission:number[]=[],roundTrip:number[]=[];for(let i=0;i<106;i++){const start=performance.now(),pending=session.query(payload,'canbus_id',new AbortController().signal),accepted=performance.now()-start;const reply=await pending;assert.equal(reply.message.parameters.canbus_nodeid,64);if(i>=5){admission.push(accepted);roundTrip.push(performance.now()-start);}}const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[50],p95Ms:values[95]};};console.log(JSON.stringify({canQueryTiming:{warmups:5,samples:101,admission:stats(admission),roundTrip:stats(roundTrip),scope:'Virtual CAN with explicit 3ms peer waits, simulated firmware and real native queue; excludes device hardware and print throughput. Admission is synchronous query-call duration, not firmware execution.'}}));}finally{await session.stop();}}
   else await assert.rejects(connecting,mode==='cancel'?/CAN bootstrap cancelled/:mode==='timeout'?/timeout/i:/identity mismatch/);
   assert.equal(stops,1);assert.equal((diagnostic.match(/ASSIGNED/g)||[]).length,1);
  }finally{clearTimeout(timer);await firmware.close();}
 }
 const control=new AbortController();setTimeout(()=>control.abort(new Error('vcan cancel')),10);
 await assert.rejects(queryCanDevices(openCanDiscovery('vcan-test'),control.signal),(error:unknown)=>error instanceof Error&&error.name==='AbortError'&&error.cause===control.signal.reason);
 const receiving=queryCanDevices(openCanDiscovery('vcan-test'),new AbortController().signal);
 const linkDown=setTimeout(()=>command('ip',['link','set','dev','vcan-test','down']),10);
 try{await assert.rejects(receiving,/Read CAN response/);}finally{clearTimeout(linkDown);}
 command('ip',['link','set','dev','vcan-test','up']);
 const down=openCanDiscovery('vcan-test');command('ip',['link','set','dev','vcan-test','down']);await assert.rejects(queryCanDevices(down,new AbortController().signal),/Send CAN query/);
 const removed=openCanDiscovery('vcan-test');command('ip',['link','delete','dev','vcan-test']);await assert.rejects(queryCanDevices(removed,new AbortController().signal),/Send CAN query/);
 console.log('PASS: real SocketCAN discovery and serialqueue fragmentation/reassembly/ACK, CAN identity/session/dump, CLI, cancellation, down/remove errors');
}
if(process.argv[2]==='--inside')await inside(process.argv[3],process.argv[4],process.argv[5]);
else{
 const temporary=mkdtempSync(resolve(tmpdir(),'can-vcan-'));
 try{const peer=resolve(temporary,'peer'),serialPeer=resolve(temporary,'serial-peer'),firmwareBridge=resolve(temporary,'firmware-bridge');command(process.env.CC??'cc',['-O2','-Wall','-Wextra','-Werror',resolve(host,'test/fixtures/can-firmware-bridge.c'),'-o',firmwareBridge]);command(process.env.CC??'cc',['-O2','-Wall','-Wextra','-Werror',resolve(host,'test/fixtures/can-serial-peer.c'),'-o',serialPeer]);command(process.env.CC??'cc',['-O2','-Wall','-Wextra','-Werror',resolve(host,'test/fixtures/can-query-peer.c'),'-o',peer]);const r=spawnSync('unshare',['--user','--map-root-user','--net','env',`LD_PRELOAD=${process.env.LD_PRELOAD??''}`,`ASAN_OPTIONS=${process.env.ASAN_OPTIONS??''}`,process.execPath,script,'--inside',peer,serialPeer,firmwareBridge],{stdio:'inherit',timeout:20000,env:{...utilityEnv(),CAN_TEST_PARENT_NET:readlinkSync('/proc/self/ns/net'),CAN_TEST_PARENT_USER:readlinkSync('/proc/self/ns/user')}});assert.equal(r.status,0,String(r.error||r.signal||'vcan integration failed'));}finally{rmSync(temporary,{recursive:true,force:true});}
}
