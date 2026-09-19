import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const baseline='cb85010e',temporary=new URL(`../src/protocol/.batch-baseline-${process.pid}.ts`,import.meta.url);
// Keep the old module's relative imports intact; never replace the live source.
writeFileSync(temporary,execFileSync('git',['show',`${baseline}:host/src/protocol/serial-session.ts`],{cwd:fileURLToPath(new URL('../..',import.meta.url))}),{flag:'wx'});
const resources:{session:SerialSession;fw:Awaited<ReturnType<typeof serialFirmware>>;transport:ReturnType<SerialSession['motionTransport']>;packets:Parameters<ReturnType<SerialSession['motionTransport']>['send']>[0];sent:number;enqueue:number[];ack:number[]}[]=[];
try{
 const Previous=(await import(temporary.href) as {SerialSession:typeof SerialSession}).SerialSession;
 for(const Constructor of [Previous,SerialSession]){const fw=await serialFirmware();let session:SerialSession|undefined;try{session=new Constructor(fw.fd,{async stopDevice(){}});await session.initialize(new AbortController().signal);await session.configure({oidCount:4,commands:[]},new AbortController().signal);const transport=session.motionTransport(['x']),data=Buffer.from(session.dictionary.encode('set_next_step_dir',{oid:3,dir:1}));resources.push({session,fw,transport,packets:Array.from({length:2000},()=>({id:'x',data,minClock:0n,reqClock:0n})),sent:0,enqueue:[],ack:[]});}catch(error){await session?.stop();await fw.close();throw error;}}
 for(let round=0;round<111;round++)for(const i of round%2?[1,0]:[0,1]){const r=resources[i],start=performance.now();await r.transport.send(r.packets);const enqueue=performance.now()-start;r.sent+=r.packets.length;await r.session.waitForAcknowledgements(new AbortController().signal);const acknowledged=performance.now()-start;assert.equal(r.fw.motion.length,r.sent);if(round>=10){r.enqueue.push(enqueue);r.ack.push(acknowledged);}}
 const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1]};};
 for(const r of resources){assert.equal(r.fw.motion.length,r.sent);assert.ok(r.fw.motion.every(m=>m.parameters.oid===3&&m.parameters.dir===1));}
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,baseline,messagesPerBatch:2000,warmups:10,samples:101,previous:{enqueue:stats(resources[0].enqueue),ack:stats(resources[0].ack)},current:{enqueue:stats(resources[1].enqueue),ack:stats(resources[1].ack)},scope:'Alternating live sessions using the previous SerialSession module and current dependencies; native queue, emulator, event-driven ACK snapshots. Not a hardware print deadline.'},null,2));
}finally{for(const r of resources){await r.session.stop();await r.fw.close();}rmSync(temporary,{force:true});}
