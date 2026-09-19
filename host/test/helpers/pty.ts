import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync,readSync,writeSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
const dir=mkdtempSync(resolve(tmpdir(),'anyraid-pty-')),output=resolve(dir,'pty.node');
const env={...process.env};delete env.LD_PRELOAD;delete env.ASAN_OPTIONS;
const compiled=spawnSync(process.env.CC??'cc',['-shared','-fPIC','-O2',`-I${process.env.NODE_INCLUDE??resolve(dirname(process.execPath),'../include/node')}`,fileURLToPath(new URL('pty.c',import.meta.url)),'-o',output],{encoding:'utf8',env});
if(compiled.status!==0){rmSync(dir,{recursive:true,force:true});throw new Error(compiled.stderr);}
const native=createRequire(import.meta.url)(output) as {pair():{fd:number;path:string};inspect(path:string):Record<string,number>};rmSync(dir,{recursive:true,force:true});
export const inspectPTY=native.inspect;
export function ptyPair(){
 const {fd,path}=native.pair();let closed=false;
 class Peer extends EventEmitter {write(data:Uint8Array){let offset=0;while(offset<data.length){const count=writeSync(fd,data,offset);if(count===0)throw new Error('PTY short write');offset+=count;}return true;}}
 const peer=new Peer(),buffer=Buffer.alloc(65536);
 const timer=setInterval(()=>{if(closed)return;try{const length=readSync(fd,buffer);if(length)peer.emit('data',Buffer.from(buffer.subarray(0,length)));}catch(error){if(!['EAGAIN','EIO'].includes((error as NodeJS.ErrnoException).code??''))throw error;}},1);
 return {fd,path,peer,async close(){if(!closed){closed=true;clearInterval(timer);closeSync(fd);}}};
}
