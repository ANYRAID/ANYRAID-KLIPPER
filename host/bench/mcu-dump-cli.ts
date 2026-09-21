import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ptyPair} from '../test/helpers/pty.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const directory=await mkdtemp(join(tmpdir(),'dump-cli-bench-')),samples:number[]=[];
try{for(let run=0;run<16;run++){
 const pair=ptyPair(),firmware=await serialFirmware(pair,{debugRead:()=>0xfedcba98}),file=join(directory,`${run}.bin`);
 try{const start=performance.now(),child=spawn(process.execPath,[fileURLToPath(new URL('../../scripts/dump_mcu.ts',import.meta.url)),'-l','0x400',pair.path,file]);let error='';child.stdout.resume();child.stderr.on('data',b=>error+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),10000);let code;try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);}const elapsed=performance.now()-start;assert.equal(code,0,error);const expected=Buffer.alloc(1024);for(let i=0;i<1024;i+=4)expected.writeUInt32LE(0xfedcba98,i);assert.deepEqual(await readFile(file),expected);if(run>=5)samples.push(elapsed);}finally{await firmware.close();}
}samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,bytes:1024,queries:256,warmups:5,runs:11,medianMs:samples[5],p95Ms:samples[10],scope:'Complete Node CLI subprocess through simulated UART PTY, default AVR leave sequence, dictionary/clock initialization, 256 ACKed reads, fsync and atomic output. PTY firmware has 1ms polling; excludes fixture setup and result verification. No physical flash, Python end-to-end comparator, or print throughput claim.'},null,2));}finally{await rm(directory,{recursive:true,force:true});}
