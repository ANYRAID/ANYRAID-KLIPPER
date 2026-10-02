import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {closeSync,readdirSync} from 'node:fs';
import {connectPipe} from '../src/protocol/pipe.ts';
import {ptyPair,inspectPTY} from './helpers/pty.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../build/serialqueue.node') as {openUART(path:string,baud:number,rts:boolean):number;openPipe(path:string):number};
test('character-device session excludes UART opens until duplicated ownership closes',async()=>{
 const pair=ptyPair();closeSync(native.openUART(pair.path,115200,true));const before=inspectPTY(pair.path),fw=await serialFirmware(pair);let stops=0;
 try{
  const session=await connectPipe(pair.path,{async stopDevice(){stops++;}},new AbortController().signal);
  try{assert.deepEqual(inspectPTY(pair.path),before);assert.throws(()=>{const fd=native.openUART(pair.path,250000,true);closeSync(fd);},/Lock UART/);}
  finally{await session.stop();}
  assert.equal(stops,1);closeSync(native.openUART(pair.path,250000,true));
 }finally{await fw.close();}
});
test('pipe and UART locks cover aliases and release after rejected opens',async()=>{
 const pair=ptyPair(),dir=await mkdtemp('/tmp/pipe-lock-');await symlink(pair.path,dir+'/alias');await writeFile(dir+'/regular','data');
 try{
  const before=readdirSync('/proc/self/fd').length,first=native.openPipe(pair.path);
  try{for(let i=0;i<20;i++){
   assert.throws(()=>native.openPipe(dir+'/alias'),/Lock pipe/);assert.throws(()=>native.openUART(dir+'/alias',250000,true),/Lock UART/);
   assert.throws(()=>native.openPipe(dir+'/regular'),/Inspect pipe/);assert.throws(()=>native.openPipe(pair.path+'\0extra'),/NUL/);assert.throws(()=>native.openPipe('relative'),/absolute/);
  }}finally{closeSync(first);}
  assert(readdirSync('/proc/self/fd').length<=before);
  const uart=native.openUART(pair.path,250000,true);try{assert.throws(()=>native.openPipe(dir+'/alias'),/Lock pipe/);}finally{closeSync(uart);}
  closeSync(native.openPipe(dir+'/alias'));
 }finally{await pair.close();await rm(dir,{recursive:true,force:true});}
});
test('cancelling pipe identification releases its lock after session cleanup',async()=>{
 const pair=ptyPair(),abort=new AbortController();let stops=0;closeSync(native.openUART(pair.path,250000,true));
 try{
  const pending=connectPipe(pair.path,{async stopDevice(){stops++;}},abort.signal),rejected=assert.rejects(pending,/cancel pipe/);await delay(15);abort.abort(new Error('cancel pipe'));await rejected;assert.equal(stops,1);closeSync(native.openPipe(pair.path));
 }finally{await pair.close();}
});
