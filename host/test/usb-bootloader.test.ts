import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {enterUsbBootloader} from '../src/diagnostics/usb-bootloader.ts';
import {ptyPair} from './helpers/pty.ts';
test('native USB bootloader follows exact ioctl order, preserves flags and closes every failed operation',()=>{
 const temporary=mkdtempSync(resolve(tmpdir(),'usb-native-')),addon=resolve(temporary,'touch.node');
 try{
  const sanitizer=process.env.ANYRAID_SERIALQUEUE_ADDON?.includes('-asan.')?'address,undefined':process.env.ANYRAID_SERIALQUEUE_ADDON?.includes('-ubsan.')?'undefined':undefined;
  const env={...process.env};delete env.LD_PRELOAD;delete env.ASAN_OPTIONS;
  const built=spawnSync(process.env.CC??'cc',['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror',`-I${process.env.NODE_INCLUDE??resolve(dirname(process.execPath),'../include/node')}`,fileURLToPath(new URL('fixtures/usb-bootloader.c',import.meta.url)),...sanitizer?[`-fsanitize=${sanitizer}`,'-fno-sanitize-recover=all']:[],'-o',addon],{encoding:'utf8',timeout:60000,env});assert.equal(built.status,0,built.stderr);
  const driver=String.raw`
const assert=require('node:assert/strict'),n=require(process.argv[1]);
n.configure(-1);n.touchUSBBootloader('/mock');assert.deepEqual(n.stats(),{steps:7,closed:1});
const stages=['Open','Lock','Raise','Read','Set','Lower','Close'];
for(let i=0;i<7;i++){n.configure(i);assert.throws(()=>n.touchUSBBootloader('/mock'),new RegExp(stages[i]+'.*Input/output error'));assert.equal(n.stats().closed,i===0?0:1);assert.equal(n.stats().steps,i===0?1:i===6?7:i+2);}
for(const path of ['',null,12,'relative','/mock\0bad','/'+ 'x'.repeat(4096)]){n.configure(-1);assert.throws(()=>n.touchUSBBootloader(path));assert.equal(n.stats().steps,0);}
`;
  const run=spawnSync(process.execPath,['-e',driver,addon],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);
 }finally{rmSync(temporary,{recursive:true,force:true});}
});
test('USB touch refuses unsupported modem lines and releases real PTY descriptor; pre-abort has no effects',async()=>{
 const pair=ptyPair();try{const before=readdirSync('/proc/self/fd').length;for(let i=0;i<20;i++)await assert.rejects(enterUsbBootloader(pair.path,new AbortController().signal),/Raise USB bootloader DTR/);assert.ok(readdirSync('/proc/self/fd').length<=before);await assert.rejects(enterUsbBootloader(pair.path,AbortSignal.abort(new Error('cancel touch'))),/cancel touch/);}finally{await pair.close();}
});
