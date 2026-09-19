import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeRobin,encodeChitu} from '../src/build/firmware.ts';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('Robin transforms only its bootloader window and is reversible without mutating input',()=>{
 const input=Buffer.alloc(40000,.25*256),output=encodeRobin(input);
 assert.deepEqual(output.subarray(0,320),input.subarray(0,320));assert.deepEqual(output.subarray(31040),input.subarray(31040));assert.notEqual(output[320],input[320]);assert.deepEqual(encodeRobin(output),input);
 assert.equal(encodeRobin(Buffer.alloc(100)).length,100);
});
test('Chitu preserves unusual three-byte padding, header, checksum and original input',()=>{
 for(const size of [0,1,2,3,2047,2048,2049,6143]) {
  const input=Buffer.alloc(size,0xa5),before=Buffer.from(input),result=encodeChitu(input),out=result.firmware;
  let padded=size;while(padded%2048)padded+=3;
  assert.equal(out.length,padded+12);assert.equal(out.readUInt32BE(0),0x443d2d3f);assert.equal(result.blocks,padded/2048);assert.deepEqual(input,before);
  let crc=0xef3d4323;for(let i=12;i<out.length;i+=4)crc^=out.readUInt32LE(i);assert.equal(out.readUInt32LE(8),crc>>>0);
 }
});
test('CLI handles spaces and same-path conversion; failures preserve existing output',()=>{
 const dir=mkdtempSync(join(tmpdir(),'anyraid-firmware-'));
 try {
  const input=join(dir,'input name.bin'),output=join(dir,'output name.bin');writeFileSync(input,Buffer.alloc(33000,7));writeFileSync(output,'keep');
  const script=fileURLToPath(new URL('../../scripts/update_mks_robin.mts',import.meta.url));
  const bad=spawnSync(process.execPath,[script,join(dir,'missing'),output]);assert.notEqual(bad.status,0);assert.equal(readFileSync(output,'utf8'),'keep');
  const before=readFileSync(input),ok=spawnSync(process.execPath,[script,input,input]);assert.equal(ok.status,0,ok.stderr?.toString());assert.deepEqual(readFileSync(input),encodeRobin(before));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
