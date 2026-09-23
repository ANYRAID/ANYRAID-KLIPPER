import assert from 'node:assert/strict';
import {openSync,closeSync,fstatSync,constants} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute} from 'node:path';
import {SerialSession,type SerialSessionOptions} from '../src/protocol/serial-session.ts';
import {connectPipe} from '../src/protocol/pipe.ts';
import {ptyPair} from '../test/helpers/pty.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const native=createRequire(import.meta.url)('../build/serialqueue.node') as {openUART(path:string,baud:number,rts:boolean):number};
// Previous unlocked implementation, retained only as this controlled PTY baseline.
async function unlocked(path:string,options:SerialSessionOptions,signal:AbortSignal){
 signal.throwIfAborted();options={...options};if(!isAbsolute(path)||path.includes('\0')||options.canClientId!==undefined||typeof options.stopDevice!=='function')throw new TypeError('Invalid pipe connection options');
 let fd=-1,session:SerialSession|undefined;
 try{fd=openSync(path,constants.O_RDWR|constants.O_NONBLOCK|constants.O_NOCTTY);if(!fstatSync(fd).isCharacterDevice())throw new Error('Pipe transport requires a character device');session=new SerialSession(fd,options);const owned=fd;fd=-1;closeSync(owned);await session.initialize(signal);return session;}
 catch(error){if(session)try{await session.stop(error);}catch{}throw error;}
 finally{if(fd>=0)closeSync(fd);}
}
const limits={wallMedianRatio:1.1,wallP95Ratio:1.2,wallSlackMs:10,cpuMedianRatio:1.5,cpuSlackMs:5},wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const pair=ptyPair();closeSync(native.openUART(pair.path,250000,true));const firmware=await serialFirmware(pair);let session:SerialSession|undefined,stops=0;
 try{
  const used=process.cpuUsage(),start=performance.now();session=await (mode?connectPipe:unlocked)(pair.path,{async stopDevice(){stops++;}},new AbortController().signal);
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(session.status.state,'ready');await session.stop();assert.equal(stops,1);
 }finally{await session?.stop();await firmware.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['unlockedBaseline','lockedPipe'],limits,timing,cpu:usage,scope:'Prepared real PTY open, identify and clock warmup; excludes fixture creation, close and physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.wallMedianRatio+limits.wallSlackMs);assert(timing[1].p95Ms<timing[0].p95Ms*limits.wallP95Ratio+limits.wallSlackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuMedianRatio+limits.cpuSlackMs);
