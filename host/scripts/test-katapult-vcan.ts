import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {flashKatapultCAN,openKatapultCAN} from '../src/diagnostics/katapult-can.ts';
import {katapultFrame} from '../src/diagnostics/katapult.ts';
import {katapultSimulator} from '../bench/katapult-reference.ts';
const script=fileURLToPath(import.meta.url),host=fileURLToPath(new URL('..',import.meta.url));
function env(){const out={...process.env};delete out.LD_PRELOAD;delete out.ASAN_OPTIONS;return out;}
function command(name:string,args:string[]){const r=spawnSync(name,args,{env:env(),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr||String(r.error));}
async function inside(executable:string){
 assert.ok(process.env.KATAPULT_PARENT_NET&&process.env.KATAPULT_PARENT_USER);assert.notEqual(readlinkSync('/proc/self/ns/net'),process.env.KATAPULT_PARENT_NET);assert.notEqual(readlinkSync('/proc/self/ns/user'),process.env.KATAPULT_PARENT_USER);
 command('ip',['link','add','dev','vcan-test','type','vcan']);command('ip',['link','set','dev','vcan-test','up']);
 const samples:number[]=[];
 for(const mode of [...Array.from({length:16},()=> 'success'),'uuid','crc','cancel','timeout','down']){
  const peer=spawn(executable,[],{env:env(),stdio:['pipe','pipe','pipe']}),sim=katapultSimulator(256),seen:number[]=[];let diagnostic='',buffer:Buffer=Buffer.alloc(0),chain=Promise.resolve(),fault:unknown;
  peer.stderr.on('data',b=>diagnostic+=b);peer.stdin.on('error',()=>{});const ended=new Promise<number|null>((resolve,reject)=>{peer.once('error',reject);peer.once('close',resolve);});void ended.catch(()=>{});
  peer.stdout.on('data',(bytes:Buffer)=>{buffer=Buffer.concat([buffer,bytes]);while(buffer.length>=4){const length=buffer[3]*4+8;if(buffer.length<length)break;const frame=Buffer.from(buffer.subarray(0,length));buffer=buffer.subarray(length);seen.push(frame[2]);chain=chain.then(async()=>{if(mode==='timeout'||mode==='down')return;let reply:Buffer=Buffer.from(await sim.transport.exchange(frame,2000,new AbortController().signal));if(mode==='uuid'&&frame[2]===0x16){const payload=Buffer.from(reply.subarray(4,-4));payload[4]^=1;reply=katapultFrame(0xa0,payload);}if(mode==='crc')reply[reply.length-4]^=1;peer.stdin.write(reply);}).catch(error=>{fault=error;});}});
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const deadline=performance.now()+3000;while(!diagnostic.includes('READY\n')){assert.equal(peer.exitCode,null,diagnostic);assert.ok(performance.now()<deadline);await delay(1);}
   const at=performance.now();
   if(mode==='cancel'){timer=setTimeout(()=>controller.abort(new Error('cancel assignment')),20);await assert.rejects(flashKatapultCAN('vcan-test','112233445566',Buffer.alloc(513),controller.signal),/cancel assignment/);assert.equal(seen.length,0);}
   else if(mode==='timeout'||mode==='down'){const transport=await openKatapultCAN('vcan-test','112233445566',{},controller.signal);try{if(mode==='down')command('ip',['link','set','dev','vcan-test','down']);await assert.rejects(transport.exchange(katapultFrame(0x11),40,controller.signal),mode==='timeout'?/timed out/:/ENETDOWN/);}finally{transport.close();if(mode==='down')command('ip',['link','set','dev','vcan-test','up']);}}
   else{
    const work=flashKatapultCAN('vcan-test','112233445566',Buffer.alloc(4093,0xa5),controller.signal);
    if(mode==='success'){const result=await work;samples.push(performance.now()-at);assert.equal(result.blocks,16);assert.equal(seen.at(-1),0x15);assert.equal(seen[1],0x16);assert.equal(seen.length,36);}
    else{await assert.rejects(work,mode==='uuid'?/UUID/:/CRC/);assert.ok(!seen.includes(0x12));assert.ok(!seen.includes(0x15));}
   }
   assert.equal((diagnostic.match(/ASSIGNED/g)||[]).length,1);assert.equal(fault,undefined);
  }finally{clearTimeout(timer);await chain;peer.stdin.end();const kill=setTimeout(()=>peer.kill('SIGKILL'),2000);try{assert.equal(await ended,0,diagnostic);}finally{clearTimeout(kill);}}
 }
 const timing=samples.slice(5).sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,warmup:5,runs:11,imageBytes:4093,medianMs:timing[5],p95Ms:timing[10],scope:'Isolated real SocketCAN, exact one-target assignment, mandatory 500 ms assignment settle, UUID identity, full simulated firmware write/readback/complete; no physical bus/flash or printing.'}));
 console.log('PASS: Katapult vcan full flash, identity/CRC refusal, cancellation, timeout and link-down');
}
if(process.argv[2]==='--inside')await inside(process.argv[3]);else{
 const temporary=mkdtempSync(resolve(tmpdir(),'katapult-vcan-'));try{const peer=resolve(temporary,'bridge');command(process.env.CC??'cc',['-O2','-Wall','-Wextra','-Werror',resolve(host,'test/fixtures/katapult-can-bridge.c'),'-o',peer]);const r=spawnSync('unshare',['--user','--map-root-user','--net','env',`LD_PRELOAD=${process.env.LD_PRELOAD??''}`,`ASAN_OPTIONS=${process.env.ASAN_OPTIONS??''}`,process.execPath,script,'--inside',peer],{env:{...env(),KATAPULT_PARENT_NET:readlinkSync('/proc/self/ns/net'),KATAPULT_PARENT_USER:readlinkSync('/proc/self/ns/user')},stdio:'inherit',timeout:30000});assert.equal(r.status,0,String(r.error||r.signal));}finally{rmSync(temporary,{recursive:true,force:true});}
}
