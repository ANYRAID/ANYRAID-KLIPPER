import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {katapultPTY} from '../test/helpers/katapult-pty.ts';
const directory=await mkdtemp(join(tmpdir(),'usb-cli-bench-')),path=join(directory,'firmware.bin'),warmup=5,runs=11,samples:number[]=[];
try{
 await writeFile(path,Buffer.alloc(4093,0xaa));
 for(let i=0;i<warmup+runs;i++){
  const peer=katapultPTY({prime:true});try{const at=performance.now(),child=spawn(process.execPath,[fileURLToPath(new URL('../../scripts/katapult.ts',import.meta.url)),'--prime','-d',peer.path,'-f',path,'-v'],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});const elapsed=performance.now()-at;assert.equal(code,0,stderr);assert.match(stdout,/Programming Complete/);assert.equal(peer.commands.length,36);if(i>=warmup)samples.push(elapsed);}finally{await peer.close();}
 }
 const s=samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,warmup,runs,imageBytes:4093,commands:36,medianMs:s[Math.floor(runs/2)],p95Ms:s[Math.ceil(runs*.95)-1],scope:'Complete standalone Katapult child CLI startup, bounded file read, dictionary scan, real PTY priming/program/readback/close and process exit. Parent simulator and child reads poll at 1 ms. No Python full-CLI comparison, physical flash or printing.'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
