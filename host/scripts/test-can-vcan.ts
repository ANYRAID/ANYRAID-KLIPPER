// Real Linux SocketCAN integration, confined to a disposable user/net namespace.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {openCanDiscovery,queryCanDevices} from '../src/diagnostics/can-query.ts';
const script=fileURLToPath(import.meta.url),host=fileURLToPath(new URL('..',import.meta.url));
function utilityEnv(){const env={...process.env};delete env.LD_PRELOAD;delete env.ASAN_OPTIONS;return env;}
function command(name:string,args:string[]){const r=spawnSync(name,args,{encoding:'utf8',timeout:30000,env:name===process.execPath?process.env:utilityEnv()});assert.equal(r.status,0,r.stderr.slice(0,4000)||String(r.error||r.signal));return r.stdout;}
async function inside(peer:string){
 // Refuse interface changes unless both namespaces differ from the invoking host.
 assert.notEqual(readlinkSync('/proc/self/ns/net'),process.env.CAN_TEST_PARENT_NET);
 assert.notEqual(readlinkSync('/proc/self/ns/user'),process.env.CAN_TEST_PARENT_USER);
 assert.ok(process.env.CAN_TEST_PARENT_NET&&process.env.CAN_TEST_PARENT_USER);
 command('ip',['link','add','dev','vcan-test','type','vcan']);command('ip',['link','set','dev','vcan-test','up']);
 async function withPeer(run:()=>Promise<void>){
  const child=spawn(peer,[],{stdio:['ignore','pipe','pipe'],env:utilityEnv()});let stderr='';child.stderr.on('data',b=>stderr+=b);
  const ended=new Promise<number|null>((res,rej)=>{child.once('error',rej);child.once('close',res);});void ended.catch(()=>{});
  try{await new Promise<void>((res,rej)=>{let text='';const timer=setTimeout(()=>rej(new Error('Peer readiness timeout')),5000);child.stdout.on('data',b=>{text+=b;if(text.includes('READY\n')){clearTimeout(timer);res();}});void ended.then(()=>{clearTimeout(timer);rej(new Error('Peer exited before ready: '+stderr));},rej);});await run();assert.equal(await ended,0,stderr);}finally{if(child.exitCode===null)child.kill('SIGKILL');await ended;}
 }
 const native=createRequire(import.meta.url)(process.env.ANYRAID_CAN_QUERY_ADDON??'../build/can-query.node');
 await withPeer(async()=>{
  const h=native.open('vcan-test');try{native.sendQuery(h);assert.throws(()=>native.sendQuery(h),/already sent/);const frames=[];const deadline=performance.now()+300;while(performance.now()<deadline){let frame;while((frame=native.read(h))!==null)frames.push(frame);await delay(2);}assert.equal(frames.length,6,'kernel must exclude wrong ID, extended and RTR frames');assert.ok(frames.every(f=>f.id===0x3f1));assert.deepEqual([...frames[0].data],[32,0,0,0,0,0,0]);}finally{native.close(h);native.close(h);}assert.throws(()=>native.read(h),/closed/);
 });
 await withPeer(async()=>{
  const output=command(process.execPath,[resolve(host,'../scripts/canbus_query.ts'),'vcan-test']);
  assert.equal(output,'Found canbus_uuid=000000000000, Application: Klipper\nFound canbus_uuid=ffffffffffff, Application: CanBoot\nFound canbus_uuid=11aa22bb33cc, Application: Unknown\nTotal 3 uuids found\n');
 });
 const control=new AbortController();setTimeout(()=>control.abort(new Error('vcan cancel')),10);
 await assert.rejects(queryCanDevices(openCanDiscovery('vcan-test'),control.signal),(error:unknown)=>error instanceof Error&&error.name==='AbortError'&&error.cause===control.signal.reason);
 const receiving=queryCanDevices(openCanDiscovery('vcan-test'),new AbortController().signal);
 const linkDown=setTimeout(()=>command('ip',['link','set','dev','vcan-test','down']),10);
 try{await assert.rejects(receiving,/Read CAN response/);}finally{clearTimeout(linkDown);}
 command('ip',['link','set','dev','vcan-test','up']);
 const down=openCanDiscovery('vcan-test');command('ip',['link','set','dev','vcan-test','down']);await assert.rejects(queryCanDevices(down,new AbortController().signal),/Send CAN query/);
 const removed=openCanDiscovery('vcan-test');command('ip',['link','delete','dev','vcan-test']);await assert.rejects(queryCanDevices(removed,new AbortController().signal),/Send CAN query/);
 console.log('PASS: real SocketCAN query bytes, kernel filters, CLI, cancellation, down/remove errors');
}
if(process.argv[2]==='--inside')await inside(process.argv[3]);
else{
 const temporary=mkdtempSync(resolve(tmpdir(),'can-vcan-'));
 try{const peer=resolve(temporary,'peer');command(process.env.CC??'cc',['-O2','-Wall','-Wextra','-Werror',resolve(host,'test/fixtures/can-query-peer.c'),'-o',peer]);const r=spawnSync('unshare',['--user','--map-root-user','--net','env',`LD_PRELOAD=${process.env.LD_PRELOAD??''}`,`ASAN_OPTIONS=${process.env.ASAN_OPTIONS??''}`,process.execPath,script,'--inside',peer],{stdio:'inherit',timeout:20000,env:{...utilityEnv(),CAN_TEST_PARENT_NET:readlinkSync('/proc/self/ns/net'),CAN_TEST_PARENT_USER:readlinkSync('/proc/self/ns/user')}});assert.equal(r.status,0,String(r.error||r.signal||'vcan integration failed'));}finally{rmSync(temporary,{recursive:true,force:true});}
}
