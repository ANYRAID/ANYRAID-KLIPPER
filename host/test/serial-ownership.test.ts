import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,writeFile,rm} from 'node:fs/promises';
import {openSync,closeSync,constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createUsbFlashSystem} from '../src/diagnostics/flash-usb-system.ts';
import {assertSerialAvailable,SerialInUseError} from '../src/diagnostics/serial-ownership.ts';
import {ptyPair} from './helpers/pty.ts';
test('ownership scan follows aliases, preserves exact inode identity and tolerates vanished proc entries',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'serial-owner-')),pair=ptyPair();try{await mkdir(join(directory,'42','fd'),{recursive:true});await mkdir(join(directory,'99'));await symlink('/missing',join(directory,'42','fd','3'));await symlink('/dev/null',join(directory,'42','fd','4'));const report=await assertSerialAvailable(pair.path,new AbortController().signal,directory);assert.equal(report.processes,1);assert.equal(report.descriptors,2);await symlink(pair.path,join(directory,'42','fd','5'));await assert.rejects(assertSerialAvailable(pair.path,new AbortController().signal,directory),e=>e instanceof SerialInUseError&&e.pid==='42');await assert.rejects(assertSerialAvailable(pair.path,AbortSignal.abort(new Error('cancel')),directory),/cancel/);const regular=join(directory,'file');await writeFile(regular,'');await assert.rejects(assertSerialAvailable(regular,new AbortController().signal,directory),/character/);}finally{await pair.close();await rm(directory,{recursive:true,force:true});}
});
test('actual /proc detects an uncooperative open PTY and prevents CLI commands before native locking',async()=>{
 const pair=ptyPair(),received:Buffer[]=[];pair.peer.on('data',(b:Buffer)=>received.push(b));const held=openSync(pair.path,constants.O_RDWR|constants.O_NOCTTY|constants.O_NONBLOCK);
 try{await assert.rejects(assertSerialAvailable(pair.path,new AbortController().signal),e=>e instanceof SerialInUseError&&e.pid===String(process.pid));
  const io=createUsbFlashSystem({repository:process.cwd(),async katapult(){}});await assert.rejects(io.enterBootloader(pair.path,new AbortController().signal),/in use by process/);
  for(const script of ['katapult.ts','flash_usb.ts']){const args=script==='katapult.ts'?['-d',pair.path,'-s']:['--katapult','-d',pair.path];const directory=await mkdtemp(join(tmpdir(),'occupied-cli-'));try{if(script==='flash_usb.ts'){const image=join(directory,'image.bin');await writeFile(image,Buffer.alloc(32));args.push(image);}const child=spawn(process.execPath,[fileURLToPath(new URL('../../scripts/'+script,import.meta.url)),...args],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,1);assert.match(stderr,/in use by process/);assert.equal(received.length,0);}finally{await rm(directory,{recursive:true,force:true});}}
 }finally{closeSync(held);await pair.close();}
});
